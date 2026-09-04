/**
 * The handoff's definition of done, run against a real server over real
 * sockets:
 *
 *   "Three phones join one room code; a hand plays out with a raise, a call, a
 *    fold, and an all-in that creates a side pot; the host awards both pots;
 *    chips reconcile (total chips in play is constant except for rebuys); one
 *    phone can background/kill the browser mid-hand and rejoin at the same
 *    seat."
 *
 * The engine tests cover the poker. These cover the things only a server can
 * get wrong: who is allowed to do what, what happens when two taps race, and
 * whether a dropped phone comes back to the same chips.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { WebSocket } from 'ws'
import { createServer, type Server } from 'node:http'
import { WebSocketServer } from 'ws'
import { RoomStore, RoomError } from './rooms.js'
import type { ClientMessage, Room, ServerMessage } from './types.js'

/* ------------------------------------------------------------ test harness */

let http: Server
let wss: WebSocketServer
let store: RoomStore
let port: number

/**
 * A stand-in for one phone: sends messages, remembers the last room it was
 * shown, and lets a test wait for the next state or error.
 */
class Phone {
  socket!: WebSocket
  room: Room | null = null
  errors: Array<{ code: string; message: string }> = []
  private waiters: Array<(m: ServerMessage) => void> = []

  constructor(readonly id: string) {}

  async open(): Promise<void> {
    this.socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    await new Promise<void>((resolve, reject) => {
      this.socket.once('open', () => resolve())
      this.socket.once('error', reject)
    })
    this.socket.on('message', (raw) => {
      const msg: ServerMessage = JSON.parse(String(raw))
      if (msg.t === 'STATE') this.room = msg.room
      if (msg.t === 'ERROR') this.errors.push({ code: msg.code, message: msg.message })
      for (const w of this.waiters.splice(0)) w(msg)
    })
  }

  send(message: ClientMessage): void {
    this.socket.send(JSON.stringify(message))
  }

  /** Send and wait for whatever the server says back. */
  async ask(message: ClientMessage): Promise<ServerMessage> {
    const next = this.next()
    this.send(message)
    return next
  }

  next(): Promise<ServerMessage> {
    return new Promise((resolve) => this.waiters.push(resolve))
  }

  close(): void {
    this.socket.close()
  }

  get me() {
    return this.room?.players.find((p) => p.id === this.id) ?? null
  }
}

/** Wait for every phone to see the same version of the room. */
async function settle(phones: Phone[], version: number, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (phones.every((p) => (p.room?.version ?? -1) >= version)) return
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(
    `phones did not reach version ${version}: ${phones.map((p) => p.room?.version).join(',')}`,
  )
}

const chipsInPlay = (room: Room): number =>
  room.players.reduce((sum, p) => sum + p.stack, 0) +
  (room.pots
    ? room.pots.filter((p) => !p.awarded).reduce((s, p) => s + p.amount, 0)
    : room.players.reduce((sum, p) => sum + p.total, 0))

const seatOf = (room: Room, name: string) => room.players.findIndex((p) => p.name === name)
const actingName = (room: Room) =>
  room.actingSeat === null ? null : room.players[room.actingSeat].name

beforeAll(async () => {
  store = new RoomStore()
  http = createServer()
  wss = new WebSocketServer({ server: http, path: '/ws' })

  const sockets = new Map<WebSocket, { playerId?: string; code?: string }>()

  store.onChange = (room) => {
    const payload = JSON.stringify({ t: 'STATE', room })
    for (const [socket, session] of sockets) {
      if (session.code === room.code && socket.readyState === socket.OPEN) socket.send(payload)
    }
  }

  wss.on('connection', (socket) => {
    const session: { playerId?: string; code?: string } = {}
    sockets.set(socket, session)

    socket.on('message', (raw) => {
      const msg: ClientMessage = JSON.parse(String(raw))
      const reply = (m: ServerMessage) => socket.send(JSON.stringify(m))
      const need = () => {
        if (!session.playerId) throw new RoomError('BAD_REQUEST', 'Join a table first')
        return session.playerId
      }
      try {
        switch (msg.t) {
          case 'CREATE_ROOM': {
            const room = store.createRoom(msg.playerId, msg.name, msg.config)
            session.playerId = msg.playerId
            session.code = room.code
            reply({ t: 'STATE', room })
            break
          }
          case 'JOIN_ROOM': {
            const room = store.joinRoom(msg.code, msg.playerId, msg.name)
            session.playerId = msg.playerId
            session.code = room.code
            reply({ t: 'STATE', room })
            break
          }
          case 'REJOIN': {
            const room = store.rejoin(msg.code, msg.playerId)
            session.playerId = msg.playerId
            session.code = room.code
            reply({ t: 'STATE', room })
            break
          }
          case 'START_GAME':
            store.startGame(msg.code, need())
            break
          case 'ACTION':
            store.action(msg.code, need(), msg.handNo, msg.version, msg.kind, msg.raiseTo)
            break
          case 'AWARD_POT':
            store.awardPot(msg.code, need(), msg.potIndex, msg.winnerIds)
            break
          case 'NEXT_HAND':
            store.nextHand(msg.code, need())
            break
          case 'ADJUST_STACK':
            store.adjustStack(msg.code, need(), msg.playerId, msg.delta)
            break
          case 'LEAVE_ROOM': {
            const room = store.leaveRoom(msg.code, msg.playerId)
            session.code = undefined
            if (room) store.onChange(room)
            break
          }
          default:
            break
        }
      } catch (err) {
        if (err instanceof RoomError) reply({ t: 'ERROR', code: err.code, message: err.message })
        else throw err
      }
    })

    socket.on('close', () => {
      const { code, playerId } = session
      sockets.delete(socket)
      if (code && playerId) {
        const stillHere = [...sockets.values()].some(
          (s) => s.code === code && s.playerId === playerId,
        )
        if (!stillHere) {
          try {
            store.setConnected(code, playerId, false)
          } catch {
            /* room gone */
          }
        }
      }
    })
  })

  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve))
  port = (http.address() as { port: number }).port
})

afterAll(async () => {
  wss.close()
  await new Promise<void>((resolve) => http.close(() => resolve()))
})

/** Seat three phones at one table and start the hand. */
async function threeHanded(stacks?: [number, number, number]) {
  const ming = new Phone('id-ming')
  const alex = new Phone('id-alex')
  const sam = new Phone('id-sam')
  await Promise.all([ming.open(), alex.open(), sam.open()])

  await ming.ask({
    t: 'CREATE_ROOM',
    name: 'Ming',
    playerId: ming.id,
    config: { smallBlind: 5, bigBlind: 10, startingStack: 1000, currency: 'chips' },
  })
  const code = ming.room!.code

  await alex.ask({ t: 'JOIN_ROOM', code, name: 'Alex', playerId: alex.id })
  await sam.ask({ t: 'JOIN_ROOM', code, name: 'Sam', playerId: sam.id })

  const phones = [ming, alex, sam]
  await settle(phones, ming.room!.version)

  if (stacks) {
    // Rebuys are the supported way to set up an uneven table.
    for (const [i, target] of stacks.entries()) {
      const player = ming.room!.players[i]
      ming.send({
        t: 'ADJUST_STACK',
        code,
        playerId: player.id,
        delta: target - player.stack,
      })
      await ming.next()
    }
  }

  ming.send({ t: 'START_GAME', code })
  await ming.next()
  await settle(phones, ming.room!.version)

  return { ming, alex, sam, phones, code }
}

/** Act as whoever is currently on the clock. */
async function actNow(
  phones: Phone[],
  code: string,
  kind: 'FOLD' | 'CHECK_CALL' | 'RAISE',
  raiseTo?: number,
) {
  const room = phones[0].room!
  const name = actingName(room)!
  const phone = phones.find((p) => p.me?.name === name)!
  phone.send({ t: 'ACTION', code, handNo: room.handNo, version: room.version, kind, raiseTo })
  await phone.next()
  await settle(phones, room.version + 1)
  return phone
}

/* -------------------------------------------------------------------- tests */

describe('rooms', () => {
  it('three phones join one code and all see the same table', async () => {
    const { ming, alex, sam, phones, code } = await threeHanded()

    expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/)
    for (const phone of phones) {
      expect(phone.room!.code).toBe(code)
      expect(phone.room!.players.map((p) => p.name)).toEqual(['Ming', 'Alex', 'Sam'])
      expect(phone.room!.status).toBe('hand')
    }
    // Everyone sees the same version of the truth.
    expect(new Set(phones.map((p) => p.room!.version)).size).toBe(1)
    expect(ming.room!.hostId).toBe(ming.id)
    expect(alex.me!.seat).toBe(1)
    expect(sam.me!.seat).toBe(2)

    phones.forEach((p) => p.close())
  })

  it('rejects a duplicate name and a bad code', async () => {
    const ming = new Phone('id-a')
    const clash = new Phone('id-b')
    await Promise.all([ming.open(), clash.open()])

    await ming.ask({
      t: 'CREATE_ROOM',
      name: 'Ming',
      playerId: ming.id,
      config: { smallBlind: 5, bigBlind: 10, startingStack: 1000, currency: 'chips' },
    })
    const code = ming.room!.code

    await clash.ask({ t: 'JOIN_ROOM', code, name: 'ming', playerId: clash.id })
    expect(clash.errors.at(-1)!.code).toBe('NAME_TAKEN')

    await clash.ask({ t: 'JOIN_ROOM', code: 'ZZZZZZ', name: 'Nadia', playerId: clash.id })
    expect(clash.errors.at(-1)!.code).toBe('ROOM_NOT_FOUND')

    ming.close()
    clash.close()
  })

  it('only the host can start, award, or adjust chips', async () => {
    const { ming, alex, phones, code } = await threeHanded()

    alex.send({ t: 'NEXT_HAND', code })
    await alex.next()
    expect(alex.errors.at(-1)!.code).toBe('NOT_HOST')

    alex.send({ t: 'ADJUST_STACK', code, playerId: alex.id, delta: 100_000 })
    await alex.next()
    expect(alex.errors.at(-1)!.code).toBe('NOT_HOST')
    // The cheeky rebuy did not land.
    expect(ming.room!.players[1].stack).toBeLessThanOrEqual(1000)

    phones.forEach((p) => p.close())
  })
})

describe('playing a hand', () => {
  it('runs raise, call, fold, all-in, side pot, and both awards', async () => {
    // Sam is short, so calling the raise puts him in for less and splits the pot.
    const { ming, alex, sam, phones, code } = await threeHanded([1000, 1000, 120])
    const start = chipsInPlay(ming.room!)
    expect(start).toBe(2120)

    // Seats: Ming dealer, Alex SB, Sam BB. Ming acts first pre-flop.
    expect(actingName(ming.room!)).toBe('Ming')

    await actNow(phones, code, 'RAISE', 200) // a raise
    expect(ming.room!.currentBet).toBe(200)

    await actNow(phones, code, 'CHECK_CALL') // Alex calls
    await actNow(phones, code, 'CHECK_CALL') // Sam calls all-in for 120

    expect(sam.me!.allIn).toBe(true)
    expect(chipsInPlay(ming.room!)).toBe(start)

    // Flop: Alex is first to act after the dealer.
    expect(ming.room!.street).toBe('flop')
    expect(actingName(ming.room!)).toBe('Alex')

    await actNow(phones, code, 'RAISE', 400) // Alex bets
    await actNow(phones, code, 'FOLD') // Ming folds

    // Alex is the only one who can still act, so it runs out to showdown.
    const showdown = ming.room!
    expect(showdown.status).toBe('showdown')
    expect(showdown.pots).toHaveLength(2)

    // Main pot: 120 x 3 = 360, contested by Alex and Sam (Ming folded).
    expect(showdown.pots![0].amount).toBe(360)
    expect(showdown.pots![0].eligible).toHaveLength(2)
    // Side pot: Alex's uncalled money comes straight back — one eligible player.
    const returned = showdown.pots![1]
    expect(returned.eligible).toEqual([alex.id])
    expect(returned.awarded).toBe(true)

    expect(chipsInPlay(showdown)).toBe(start)

    // The host awards the contested pot; the others only watch.
    sam.send({ t: 'AWARD_POT', code, potIndex: 0, winnerIds: [sam.id] })
    await sam.next()
    expect(sam.errors.at(-1)!.code).toBe('NOT_HOST')

    ming.send({ t: 'AWARD_POT', code, potIndex: 0, winnerIds: [sam.id] })
    await ming.next()
    await settle(phones, ming.room!.version)

    expect(ming.room!.status).toBe('handEnd')
    expect(sam.me!.stack).toBe(360)
    // Chips reconcile: nothing was created or destroyed all hand.
    expect(chipsInPlay(ming.room!)).toBe(start)
    for (const phone of phones) expect(chipsInPlay(phone.room!)).toBe(start)

    phones.forEach((p) => p.close())
  })

  it('splits a pot between two winners', async () => {
    const { ming, alex, sam, phones, code } = await threeHanded()
    const start = chipsInPlay(ming.room!)

    await actNow(phones, code, 'RAISE', 1000) // Ming shoves
    await actNow(phones, code, 'CHECK_CALL') // Alex calls
    await actNow(phones, code, 'CHECK_CALL') // Sam calls

    ming.send({ t: 'AWARD_POT', code, potIndex: 0, winnerIds: [ming.id, alex.id] })
    await ming.next()
    await settle(phones, ming.room!.version)

    expect(ming.me!.stack).toBe(1500)
    expect(alex.me!.stack).toBe(1500)
    expect(sam.me!.stack).toBe(0)
    expect(chipsInPlay(ming.room!)).toBe(start)

    phones.forEach((p) => p.close())
  })
})

describe('taps that should not count', () => {
  it('rejects an action from someone whose turn it is not', async () => {
    const { ming, alex, phones, code } = await threeHanded()
    const room = ming.room!
    expect(actingName(room)).toBe('Ming')

    alex.send({ t: 'ACTION', code, handNo: room.handNo, version: room.version, kind: 'FOLD' })
    await alex.next()

    expect(alex.errors.at(-1)!.code).toBe('NOT_YOUR_TURN')
    expect(ming.room!.players[seatOf(ming.room!, 'Alex')].folded).toBe(false)

    phones.forEach((p) => p.close())
  })

  it('rejects a double-tap instead of applying it to the next player', async () => {
    const { ming, phones, code } = await threeHanded()
    const room = ming.room!
    const stale = { handNo: room.handNo, version: room.version }

    // First tap lands.
    ming.send({ t: 'ACTION', code, ...stale, kind: 'FOLD' })
    await ming.next()
    await settle(phones, room.version + 1)
    expect(actingName(ming.room!)).toBe('Alex')

    // The same tap arriving twice carries a version the table has moved past.
    ming.send({ t: 'ACTION', code, ...stale, kind: 'FOLD' })
    await ming.next()

    expect(ming.errors.at(-1)!.code).toBe('STALE_VERSION')
    // Crucially, Alex did not get folded by Ming's second tap.
    expect(ming.room!.players[seatOf(ming.room!, 'Alex')].folded).toBe(false)
    expect(actingName(ming.room!)).toBe('Alex')

    phones.forEach((p) => p.close())
  })

  it('rejects an illegal raise', async () => {
    const { ming, phones, code } = await threeHanded()
    const room = ming.room!

    ming.send({
      t: 'ACTION',
      code,
      handNo: room.handNo,
      version: room.version,
      kind: 'RAISE',
      raiseTo: 15, // under the min-raise, and not a shove
    })
    await ming.next()

    expect(ming.errors.at(-1)!.code).toBe('ILLEGAL_RAISE')
    expect(ming.room!.currentBet).toBe(10)

    phones.forEach((p) => p.close())
  })
})

describe('a phone that drops', () => {
  it('comes back to the same seat and stack mid-hand', async () => {
    const { ming, alex, sam, phones, code } = await threeHanded()

    await actNow(phones, code, 'RAISE', 60) // Ming raises
    const alexSeat = alex.me!.seat
    const alexStack = alex.me!.stack
    const before = chipsInPlay(ming.room!)

    // Alex's phone dies mid-hand.
    alex.close()
    await new Promise((r) => setTimeout(r, 60))
    expect(ming.room!.players[alexSeat].connected).toBe(false)
    // The seat and the chips stay exactly where they were.
    expect(ming.room!.players[alexSeat].stack).toBe(alexStack)
    expect(ming.room!.players[alexSeat].folded).toBe(false)
    // And the table still owes them a decision.
    expect(actingName(ming.room!)).toBe('Alex')

    // Same playerId comes back — that is what makes it the same seat.
    const returning = new Phone(alex.id)
    await returning.open()
    await returning.ask({ t: 'REJOIN', code, playerId: alex.id })

    expect(returning.me!.seat).toBe(alexSeat)
    expect(returning.me!.stack).toBe(alexStack)
    expect(returning.me!.connected).toBe(true)
    expect(chipsInPlay(returning.room!)).toBe(before)

    // And they can act as if nothing happened.
    const room = returning.room!
    returning.send({
      t: 'ACTION',
      code,
      handNo: room.handNo,
      version: room.version,
      kind: 'CHECK_CALL',
    })
    await returning.next()
    expect(returning.errors).toHaveLength(0)

    ming.close()
    sam.close()
    returning.close()
  })

  it('acts for a disconnected player once their clock runs out', async () => {
    const { ming, alex, sam, phones, code } = await threeHanded()
    await actNow(phones, code, 'RAISE', 60) // Ming raises, Alex is on the clock

    alex.close()
    await new Promise((r) => setTimeout(r, 60))
    expect(ming.room!.turnDeadline).not.toBeNull()

    // Wind the clock forward rather than waiting 45 real seconds. The version
    // has to be captured first: the broadcast is a real socket round trip, so
    // waiting on the post-sweep number would be satisfied by what these phones
    // are already holding.
    const before = ming.room!.version
    store.sweepTurnTimers(Date.now() + 46_000)
    await settle([ming, sam], before + 1)

    // Alex owed 60 to stay in, so the timeout folds rather than checks.
    const alexSeat = seatOf(ming.room!, 'Alex')
    expect(ming.room!.players[alexSeat].folded).toBe(true)
    expect(ming.room!.log.some((line) => line.includes('timed out'))).toBe(true)
    expect(actingName(ming.room!)).toBe('Sam')

    ming.close()
    sam.close()
  })
})
