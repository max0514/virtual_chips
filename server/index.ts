/**
 * The whole back end: one HTTP server that serves the built client and speaks
 * WebSocket at /ws.
 *
 * One process and one port is a deliberate choice. Everything about playing
 * this game with friends comes down to handing them a single URL — a tunnel, a
 * Render box, a laptop on the same wifi — and two ports would mean two of
 * everything to expose and keep in sync.
 */

import { createReadStream, existsSync, statSync } from 'node:fs'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { extname, join, normalize, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WebSocketServer, type WebSocket } from 'ws'

import { RoomStore, RoomError, viewForPlayer } from './rooms.js'
import type { ClientMessage, Room, ServerMessage } from './types.js'

const PORT = Number(process.env.PORT ?? 8787)
const HOST = process.env.HOST ?? '0.0.0.0'

const here = fileURLToPath(new URL('.', import.meta.url))
// `npm run build` puts the client in build/web and this file in build/server.
const WEB_ROOT = resolve(here, '../web')

const store = new RoomStore()

/* ------------------------------------------------------------- connections */

/** Which socket belongs to which seat, so a drop can be attributed. */
interface Session {
  playerId?: string
  code?: string
  alive: boolean
}

const sessions = new Map<WebSocket, Session>()

function send(socket: WebSocket, message: ServerMessage): void {
  if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(message))
}

function fail(socket: WebSocket, err: unknown): void {
  if (err instanceof RoomError) {
    send(socket, { t: 'ERROR', code: err.code, message: err.message })
    return
  }
  console.error('unexpected error handling message:', err)
  send(socket, { t: 'ERROR', code: 'BAD_REQUEST', message: 'Something went wrong' })
}

/** Push the room to everyone sitting at it. */
function broadcast(room: Room): void {
  for (const [socket, session] of sessions) {
    if (session.code === room.code && session.playerId && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify({ t: 'STATE', room: viewForPlayer(room, session.playerId) } satisfies ServerMessage))
    }
  }
}

function sendRoom(socket: WebSocket, room: Room, playerId: string): void {
  send(socket, { t: 'STATE', room: viewForPlayer(room, playerId) })
}

store.onChange = broadcast

/* ---------------------------------------------------------------- routing */

function handleMessage(socket: WebSocket, session: Session, msg: ClientMessage): void {
  switch (msg.t) {
    case 'PING':
      send(socket, { t: 'PONG' })
      return

    case 'CREATE_ROOM': {
      const room = store.createRoom(msg.playerId, msg.name, msg.config)
      session.playerId = msg.playerId
      session.code = room.code
      sendRoom(socket, room, msg.playerId)
      return
    }

    case 'JOIN_ROOM': {
      const room = store.joinRoom(msg.code, msg.playerId, msg.name)
      session.playerId = msg.playerId
      session.code = room.code
      // joinRoom only broadcasts when something changed; a plain rejoin of an
      // already-seated player needs the state pushed to this socket regardless.
      sendRoom(socket, room, msg.playerId)
      broadcast(room)
      return
    }

    case 'REJOIN': {
      const room = store.rejoin(msg.code, msg.playerId)
      session.playerId = msg.playerId
      session.code = room.code
      sendRoom(socket, room, msg.playerId)
      return
    }

    case 'LEAVE_ROOM': {
      const room = store.leaveRoom(msg.code, msg.playerId)
      session.code = undefined
      if (room) broadcast(room)
      return
    }

    case 'START_GAME':
      store.startGame(msg.code, requirePlayer(session))
      return

    case 'ACTION':
      store.action(
        msg.code,
        requirePlayer(session),
        msg.handNo,
        msg.version,
        msg.kind,
        msg.raiseTo,
      )
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
      send(socket, { t: 'ERROR', code: 'BAD_REQUEST', message: 'Unknown message' })
  }
}

/**
 * Identity comes from the socket, never from the message body.
 *
 * A client that sends `{t:'ACTION', playerId:'someone-else'}` should not be
 * able to act for someone else, so the playerId in an action message is simply
 * not read — the one bound to this connection at join time is the only one that
 * counts.
 */
function requirePlayer(session: Session): string {
  if (!session.playerId) throw new RoomError('BAD_REQUEST', 'Join a table first')
  return session.playerId
}

/* ------------------------------------------------------------ static files */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
}

function serveStatic(req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://localhost')

  if (url.pathname === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ status: 'ok', rooms: store.list().length }))
    return
  }

  if (!existsSync(WEB_ROOT)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('Client not built yet. Run `npm run build`, or use `npm run dev` for development.')
    return
  }

  // Resolve inside WEB_ROOT and check afterwards: "/../../etc/passwd" normalizes
  // to something outside the root, and this is the line that catches it.
  const requested = normalize(join(WEB_ROOT, decodeURIComponent(url.pathname)))
  const isFile = requested.startsWith(WEB_ROOT) && existsSync(requested) && statSync(requested).isFile()

  // Anything that is not a real file is the single-page app: /join/ABC123 has
  // to load index.html rather than 404.
  const file = isFile ? requested : join(WEB_ROOT, 'index.html')
  const type = MIME[extname(file)] ?? 'application/octet-stream'

  // Hashed asset filenames can be cached hard; index.html must never be, or a
  // deploy leaves phones on the old bundle talking to the new server.
  const immutable = isFile && requested.includes(`${'assets'}/`)
  res.writeHead(200, {
    'content-type': type,
    'cache-control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
  })
  createReadStream(file).pipe(res)
}

/* ------------------------------------------------------------------- boot */

const server = createServer(serveStatic)
const wss = new WebSocketServer({ server, path: '/ws' })

wss.on('connection', (socket) => {
  const session: Session = { alive: true }
  sessions.set(socket, session)

  socket.on('message', (raw) => {
    let msg: ClientMessage
    try {
      msg = JSON.parse(String(raw))
    } catch {
      send(socket, { t: 'ERROR', code: 'BAD_REQUEST', message: 'Malformed message' })
      return
    }
    try {
      handleMessage(socket, session, msg)
    } catch (err) {
      fail(socket, err)
    }
  })

  socket.on('pong', () => {
    session.alive = true
  })

  socket.on('close', () => {
    sessions.delete(socket)
    if (session.code && session.playerId) {
      // Only mark them away if this was their last open socket — a refresh
      // briefly has two, and the old one closing should not grey them out.
      const stillHere = [...sessions.values()].some(
        (s) => s.code === session.code && s.playerId === session.playerId,
      )
      if (!stillHere) {
        try {
          store.setConnected(session.code, session.playerId, false)
        } catch {
          /* room already gone */
        }
      }
    }
  })

  socket.on('error', () => socket.terminate())
})

/**
 * Drop sockets that stopped answering. Without this a phone that goes into a
 * tunnel leaves a half-open connection that never fires 'close', so the table
 * shows them as present and the turn timer never starts.
 */
const heartbeat = setInterval(() => {
  for (const [socket, session] of sessions) {
    if (!session.alive) {
      socket.terminate()
      continue
    }
    session.alive = false
    socket.ping()
  }
}, 15_000)

const timers = setInterval(() => {
  store.sweepTurnTimers()
  store.sweepExpired()
}, 1_000)

server.listen(PORT, HOST, () => {
  console.log(`Pocket Dealer on http://${HOST}:${PORT}  (ws://${HOST}:${PORT}/ws)`)
  if (!existsSync(WEB_ROOT)) console.log('Client not built — run `npm run dev` or `npm run build`.')
})

function shutdown(): void {
  clearInterval(heartbeat)
  clearInterval(timers)
  wss.close()
  server.close(() => process.exit(0))
  // Do not wait forever on sockets that will not close.
  setTimeout(() => process.exit(0), 2_000).unref()
}

process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)
