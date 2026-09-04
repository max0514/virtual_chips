/**
 * Cloudflare Workers entry point.
 *
 * Same shape as server/index.ts, different runtime: the Worker serves the
 * built client from static assets and hands /ws and /health to one Durable
 * Object, which holds every table in memory exactly the way the Node process
 * does. One object for all rooms is the same choice as "one machine" in
 * fly.toml — a room code has to resolve to the same store from every phone.
 */

import { DurableObject } from 'cloudflare:workers'

import { RoomStore, RoomError } from '../server/rooms.js'
import type { ClientMessage, Room, ServerMessage } from '../server/types.js'

export interface Env {
  TABLES: DurableObjectNamespace<Tables>
  ASSETS: Fetcher
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/ws' || url.pathname === '/health') {
      const stub = env.TABLES.getByName('global')
      return stub.fetch(request)
    }
    return env.ASSETS.fetch(request)
  },
} satisfies ExportedHandler<Env>

/* ------------------------------------------------------------------ tables */

interface Session {
  playerId?: string
  code?: string
  /** Last time this socket said anything. Silence past PING_TIMEOUT_MS = dead. */
  lastSeen: number
}

/** The client pings every 15s; three misses and the seat is marked away. */
const PING_TIMEOUT_MS = 45_000
const ROOMS_KEY = 'rooms'

export class Tables extends DurableObject<Env> {
  private store = new RoomStore()
  private sessions = new Map<WebSocket, Session>()
  private ticker: ReturnType<typeof setInterval> | null = null

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.store.onChange = (room) => this.broadcast(room)
    // Rooms are persisted so an idle eviction of this object (nobody connected
    // for a while) does not wipe a table between hands.
    ctx.blockConcurrencyWhile(async () => {
      const saved = await ctx.storage.get<Room[]>(ROOMS_KEY)
      if (saved) this.store.hydrate(saved)
      this.store.sweepExpired()
    })
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok', rooms: this.store.list().length })
    }

    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('Expected a WebSocket', { status: 426 })
    }

    const pair = new WebSocketPair()
    const [client, socket] = [pair[0], pair[1]]
    socket.accept()
    this.attach(socket)
    return new Response(null, { status: 101, webSocket: client })
  }

  /* ------------------------------------------------------------- sockets */

  private attach(socket: WebSocket): void {
    const session: Session = { lastSeen: Date.now() }
    this.sessions.set(socket, session)
    this.ensureTicker()

    socket.addEventListener('message', (event) => {
      session.lastSeen = Date.now()
      let msg: ClientMessage
      try {
        msg = JSON.parse(String(event.data))
      } catch {
        this.send(socket, { t: 'ERROR', code: 'BAD_REQUEST', message: 'Malformed message' })
        return
      }
      try {
        this.handleMessage(socket, session, msg)
      } catch (err) {
        this.fail(socket, err)
      }
    })

    const onClose = () => this.detach(socket, session)
    socket.addEventListener('close', onClose)
    socket.addEventListener('error', onClose)
  }

  private detach(socket: WebSocket, session: Session): void {
    if (!this.sessions.delete(socket)) return
    if (session.code && session.playerId) {
      // Only mark them away if this was their last open socket — a refresh
      // briefly has two, and the old one closing should not grey them out.
      const stillHere = [...this.sessions.values()].some(
        (s) => s.code === session.code && s.playerId === session.playerId,
      )
      if (!stillHere) {
        try {
          this.store.setConnected(session.code, session.playerId, false)
        } catch {
          /* room already gone */
        }
      }
    }
    if (this.sessions.size === 0) this.stopTicker()
  }

  private send(socket: WebSocket, message: ServerMessage): void {
    try {
      socket.send(JSON.stringify(message))
    } catch {
      /* already closed */
    }
  }

  private fail(socket: WebSocket, err: unknown): void {
    if (err instanceof RoomError) {
      this.send(socket, { t: 'ERROR', code: err.code, message: err.message })
      return
    }
    console.error('unexpected error handling message:', err)
    this.send(socket, { t: 'ERROR', code: 'BAD_REQUEST', message: 'Something went wrong' })
  }

  /** Push the room to everyone sitting at it, and write the store down. */
  private broadcast(room: Room): void {
    const payload = JSON.stringify({ t: 'STATE', room } satisfies ServerMessage)
    for (const [socket, session] of this.sessions) {
      if (session.code === room.code) {
        try {
          socket.send(payload)
        } catch {
          /* closing */
        }
      }
    }
    this.persist()
  }

  private persist(): void {
    // Fire and forget: storage writes from a DO are coalesced and the output
    // gate holds responses until they land, so nothing observable can race it.
    void this.ctx.storage.put(ROOMS_KEY, this.store.list())
  }

  /* --------------------------------------------------------------- timers */

  /**
   * Runs only while someone is connected. Turn timeouts only matter when there
   * is a table watching, and room expiry is also checked on wake-up.
   */
  private ensureTicker(): void {
    if (this.ticker) return
    this.ticker = setInterval(() => {
      const now = Date.now()
      for (const [socket, session] of this.sessions) {
        if (now - session.lastSeen > PING_TIMEOUT_MS) {
          try {
            socket.close(1001, 'timeout')
          } catch {
            /* ignore */
          }
          this.detach(socket, session)
        }
      }
      this.store.sweepTurnTimers(now)
      this.store.sweepExpired(now)
    }, 1_000)
  }

  private stopTicker(): void {
    if (this.ticker) clearInterval(this.ticker)
    this.ticker = null
    this.persist()
  }

  /* -------------------------------------------------------------- routing */

  private handleMessage(socket: WebSocket, session: Session, msg: ClientMessage): void {
    const store = this.store
    switch (msg.t) {
      case 'PING':
        this.send(socket, { t: 'PONG' })
        return

      case 'CREATE_ROOM': {
        const room = store.createRoom(msg.playerId, msg.name, msg.config)
        session.playerId = msg.playerId
        session.code = room.code
        this.send(socket, { t: 'STATE', room })
        this.persist()
        return
      }

      case 'JOIN_ROOM': {
        const room = store.joinRoom(msg.code, msg.playerId, msg.name)
        session.playerId = msg.playerId
        session.code = room.code
        this.send(socket, { t: 'STATE', room })
        this.broadcast(room)
        return
      }

      case 'REJOIN': {
        const room = store.rejoin(msg.code, msg.playerId)
        session.playerId = msg.playerId
        session.code = room.code
        this.send(socket, { t: 'STATE', room })
        return
      }

      case 'LEAVE_ROOM': {
        const room = store.leaveRoom(msg.code, msg.playerId)
        session.code = undefined
        if (room) this.broadcast(room)
        else this.persist()
        return
      }

      case 'START_GAME':
        store.startGame(msg.code, requirePlayer(session))
        return

      case 'ACTION':
        store.action(msg.code, requirePlayer(session), msg.handNo, msg.version, msg.kind, msg.raiseTo)
        return

      case 'AWARD_POT':
        store.awardPot(msg.code, requirePlayer(session), msg.potIndex, msg.winnerIds)
        return

      case 'NEXT_HAND':
        store.nextHand(msg.code, requirePlayer(session))
        return

      case 'ADJUST_STACK':
        store.adjustStack(msg.code, requirePlayer(session), msg.playerId, msg.delta)
        return

      default:
        this.send(socket, { t: 'ERROR', code: 'BAD_REQUEST', message: 'Unknown message' })
    }
  }
}

/** Identity comes from the socket, never from the message body. */
function requirePlayer(session: Session): string {
  if (!session.playerId) throw new RoomError('BAD_REQUEST', 'Join a table first')
  return session.playerId
}
