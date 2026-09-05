/**
 * The room store and the rules about *who* may do *what*.
 *
 * `engine.ts` knows poker; this file knows that only the host starts the game,
 * that a tap carrying a stale version is a double-tap rather than a decision,
 * and that a room nobody has touched for four hours is over. Keeping the two
 * apart is what lets the engine be tested without a socket in sight.
 *
 * Rooms live in memory. A table is 2–9 people for an evening, so a Map plus a
 * TTL sweep is the whole persistence story — losing rooms on restart is
 * acceptable, and `REJOIN` covers the case that actually happens (a phone
 * locking, not a server dying).
 */

import {
  adjustStack,
  applyAction,
  awardPot,
  nextHand,
  RuleError,
  startHand,
} from './engine.js'
import {
  MAX_PLAYERS,
  MIN_PLAYERS,
  ROOM_TTL_MS,
  TURN_TIMEOUT_MS,
  type ActionKind,
  type ErrorCode,
  type Player,
  type Room,
  type RoomConfig,
} from './types.js'

/** No O/0 or I/1 — these get read aloud across a table and typed on phones. */
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const CODE_LENGTH = 6

export class RoomError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
  }
}

export class RoomStore {
  private rooms = new Map<string, Room>()

  /** Called whenever a room changes so the transport can broadcast it. */
  onChange: (room: Room) => void = () => {}

  /* ------------------------------------------------------------ lifecycle */

  get(code: string): Room {
    const room = this.rooms.get(normalizeCode(code))
    if (!room) throw new RoomError('ROOM_NOT_FOUND', 'No table with that code')
    return room
  }

  list(): Room[] {
    return [...this.rooms.values()]
  }

  /** Load rooms saved by a previous incarnation of the process. */
  hydrate(rooms: Room[]): void {
    for (const room of rooms) {
      // Nobody is connected to a freshly restored store; sockets re-mark
      // presence as they come back.
      for (const p of room.players) p.connected = false
      // Rooms created before card dealing existed remain valid virtual-chip
      // rooms when a Durable Object wakes up with an older saved payload.
      room.config.gameMode ??= 'virtualChips'
      room.board ??= []
      room.deck ??= []
      for (const p of room.players) p.holeCards ??= []
      this.rooms.set(room.code, room)
    }
  }

  private freshCode(): string {
    for (let attempt = 0; attempt < 500; attempt++) {
      let code = ''
      for (let i = 0; i < CODE_LENGTH; i++) {
        code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]
      }
      if (!this.rooms.has(code)) return code
    }
    throw new RoomError('BAD_REQUEST', 'Could not allocate a room code')
  }

  createRoom(playerId: string, name: string, config: RoomConfig): Room {
    const clean = validateConfig(config)
    const room: Room = {
      code: this.freshCode(),
      hostId: playerId,
      status: 'lobby',
      config: clean,
      board: [],
      deck: [],
      players: [seatPlayer(playerId, cleanName(name), 0, clean.startingStack)],
      dealerSeat: 0,
      sbSeat: 0,
      bbSeat: 0,
      street: 'preflop',
      handNo: 0,
      currentBet: 0,
      minRaise: clean.bigBlind,
      actingSeat: null,
      actedSeats: [],
      pots: null,
      endMessage: '',
      version: 1,
      updatedAt: new Date().toISOString(),
      log: [],
      turnDeadline: null,
    }
    this.rooms.set(room.code, room)
    return room
  }

  /**
   * Join a table, or step back into the seat you already had.
   *
   * Joining with a `playerId` that is already seated is a rejoin, not a second
   * player: that is what makes a browser refresh mid-hand harmless.
   */
  joinRoom(code: string, playerId: string, name: string): Room {
    const room = this.get(code)
    const existing = room.players.find((p) => p.id === playerId)
    if (existing) {
      existing.connected = true
      this.bump(room)
      return room
    }

    if (room.status !== 'lobby') {
      throw new RoomError('GAME_ALREADY_STARTED', 'That game has already started')
    }
    if (room.players.length >= MAX_PLAYERS) {
      throw new RoomError('ROOM_FULL', `Tables hold ${MAX_PLAYERS} players`)
    }
    const wanted = cleanName(name)
    if (room.players.some((p) => p.name.toLowerCase() === wanted.toLowerCase())) {
      throw new RoomError('NAME_TAKEN', 'Someone at this table already has that name')
    }

    room.players.push(
      seatPlayer(playerId, wanted, room.players.length, room.config.startingStack),
    )
    this.bump(room)
    return room
  }

  /** Reconnect after a drop. Silent — the seat and stack were never given up. */
  rejoin(code: string, playerId: string): Room {
    const room = this.get(code)
    const player = room.players.find((p) => p.id === playerId)
    if (!player) throw new RoomError('ROOM_NOT_FOUND', 'You are not seated at that table')
    player.connected = true
    room.turnDeadline = null // they are back; stop acting for them
    this.bump(room)
    return room
  }

  /**
   * Leave for good.
   *
   * In the lobby the seat disappears and the rest shuffle up. Mid-hand it
   * cannot: seats are positions at a table and the pot is built from them, so
   * a leaver folds and is marked busted, and their chips stay where they are.
   */
  leaveRoom(code: string, playerId: string): Room | null {
    const room = this.get(code)
    const index = room.players.findIndex((p) => p.id === playerId)
    if (index === -1) return room

    if (room.status === 'lobby') {
      room.players.splice(index, 1)
      room.players.forEach((p, i) => (p.seat = i))
      if (room.players.length === 0) {
        this.rooms.delete(room.code)
        return null
      }
      if (room.hostId === playerId) room.hostId = room.players[0].id
    } else {
      const player = room.players[index]
      player.folded = true
      player.out = true
      player.connected = false
      room.log.push(`${player.name} left the table`)
      if (room.actingSeat === index) {
        // They were holding everyone up. Fold for them and move on.
        try {
          applyAction(room, 'FOLD')
        } catch {
          room.actingSeat = null
        }
      }
    }
    this.bump(room)
    return room
  }

  setConnected(code: string, playerId: string, connected: boolean): Room | null {
    const room = this.rooms.get(normalizeCode(code))
    if (!room) return null
    const player = room.players.find((p) => p.id === playerId)
    if (!player || player.connected === connected) return null
    player.connected = connected

    // A disconnected player who is on the clock gets 45 seconds before the
    // server acts for them, so one dead phone cannot stall the table.
    if (!connected && room.actingSeat !== null && room.players[room.actingSeat].id === playerId) {
      room.turnDeadline = Date.now() + TURN_TIMEOUT_MS
    }
    if (connected) room.turnDeadline = null

    this.bump(room)
    return room
  }

  /* ---------------------------------------------------------------- play */

  startGame(code: string, playerId: string): Room {
    const room = this.get(code)
    this.requireHost(room, playerId)
    if (room.status !== 'lobby') {
      throw new RoomError('GAME_ALREADY_STARTED', 'That game has already started')
    }
    if (room.players.length < MIN_PLAYERS) {
      throw new RoomError('NOT_ENOUGH_PLAYERS', `Need at least ${MIN_PLAYERS} players to start`)
    }
    this.run(room, () => startHand(room, 0, 1))
    return room
  }

  /**
   * Play one action.
   *
   * The `version` and `handNo` the client was rendering come back with it. If
   * either has moved on, this tap was aimed at a screen that no longer exists —
   * a double-tap, or a slow network delivering a decision late — and rejecting
   * it is what stops it from folding whoever is next.
   */
  action(
    code: string,
    playerId: string,
    handNo: number,
    version: number,
    kind: ActionKind,
    raiseTo?: number,
  ): Room {
    const room = this.get(code)

    // Staleness is checked before anything else on purpose. A double-tap and a
    // genuinely out-of-turn tap both need rejecting, but they are different
    // events: the first is a thumb bouncing on a screen that has already moved
    // on, and the client should swallow it. Checking the turn first would
    // report every double-tap as "it is not your turn" — technically true by
    // then, and exactly the wrong thing to show someone.
    if (version !== room.version || handNo !== room.handNo) {
      throw new RoomError('STALE_VERSION', 'The table moved on — check the screen again')
    }
    if (room.status !== 'hand') throw new RoomError('NOT_YOUR_TURN', 'No hand is in progress')
    if (room.actingSeat === null || room.players[room.actingSeat].id !== playerId) {
      throw new RoomError('NOT_YOUR_TURN', 'It is not your turn')
    }
    this.run(room, () => applyAction(room, kind, raiseTo))
    return room
  }

  awardPot(code: string, playerId: string, potIndex: number, winnerIds: string[]): Room {
    const room = this.get(code)
    this.requireHost(room, playerId)
    if (room.status !== 'showdown') throw new RoomError('BAD_REQUEST', 'Nothing to award')
    this.run(room, () => awardPot(room, potIndex, winnerIds))
    return room
  }

  nextHand(code: string, playerId: string): Room {
    const room = this.get(code)
    this.requireHost(room, playerId)
    if (room.status !== 'handEnd') throw new RoomError('BAD_REQUEST', 'The hand is not over')
    this.run(room, () => nextHand(room))
    return room
  }

  /** Rebuys. Never mid-hand — the side pots are built from what is already in. */
  adjustStack(code: string, hostId: string, playerId: string, delta: number): Room {
    const room = this.get(code)
    this.requireHost(room, hostId)
    if (room.status !== 'lobby' && room.status !== 'handEnd' && room.status !== 'gameOver') {
      throw new RoomError('BAD_REQUEST', 'Rebuys only between hands')
    }
    if (!Number.isFinite(delta) || delta === 0) {
      throw new RoomError('BAD_REQUEST', 'Rebuy needs an amount')
    }
    this.run(room, () => adjustStack(room, playerId, Math.trunc(delta)))
    return room
  }

  /* --------------------------------------------------------------- timers */

  /**
   * Act for anyone who has run out their clock: check if it is free, fold if it
   * is not. Called on a tick from the server; the reason goes in the log so the
   * table can see the app did it, not the player.
   */
  sweepTurnTimers(now = Date.now()): void {
    for (const room of this.rooms.values()) {
      if (room.status !== 'hand' || room.turnDeadline === null || room.actingSeat === null) continue
      if (now < room.turnDeadline) continue

      const player = room.players[room.actingSeat]
      const free = room.currentBet - player.committed <= 0
      room.turnDeadline = null
      try {
        applyAction(room, free ? 'CHECK_CALL' : 'FOLD')
        room.log.push(`${player.name} timed out — ${free ? 'checked' : 'folded'} automatically`)
        room.lastAction = {
          playerId: player.id,
          kind: free ? 'TIMEOUT_CHECK' : 'TIMEOUT_FOLD',
          note: 'disconnected',
        }
        this.bump(room)
      } catch {
        room.turnDeadline = null
      }
    }
  }

  /** Drop rooms nobody has touched in four hours. */
  sweepExpired(now = Date.now()): void {
    for (const [code, room] of this.rooms) {
      if (now - new Date(room.updatedAt).getTime() > ROOM_TTL_MS) this.rooms.delete(code)
    }
  }

  /* -------------------------------------------------------------- private */

  private requireHost(room: Room, playerId: string): void {
    if (room.hostId !== playerId) {
      throw new RoomError('NOT_HOST', 'Only the host can do that')
    }
  }

  /** Run an engine call, translating its rule errors into wire errors. */
  private run(room: Room, fn: () => void): void {
    try {
      fn()
    } catch (err) {
      if (err instanceof RuleError) throw new RoomError(err.code, err.message)
      throw err
    }
    this.armTurnTimerIfNeeded(room)
    this.onChange(room)
  }

  /** If the next player to act is already offline, start their clock now. */
  private armTurnTimerIfNeeded(room: Room): void {
    if (room.status === 'hand' && room.actingSeat !== null) {
      const acting = room.players[room.actingSeat]
      room.turnDeadline = acting.connected ? null : Date.now() + TURN_TIMEOUT_MS
    } else {
      room.turnDeadline = null
    }
  }

  private bump(room: Room): void {
    room.version += 1
    room.updatedAt = new Date().toISOString()
    this.armTurnTimerIfNeeded(room)
    this.onChange(room)
  }
}

/* -------------------------------------------------------------- helpers */

function seatPlayer(id: string, name: string, seat: number, stack: number): Player {
  return {
    id,
    name,
    seat,
    stack,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    out: false,
    connected: true,
    holeCards: [],
  }
}

export function normalizeCode(code: string): string {
  return String(code ?? '')
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '') // people type the display form, "TBL-742"
}

function cleanName(name: string): string {
  const trimmed = String(name ?? '').trim().slice(0, 16)
  if (!trimmed) throw new RoomError('BAD_REQUEST', 'Pick a name first')
  return trimmed
}

const BLIND_PRESETS = [
  [1, 2],
  [2, 5],
  [5, 10],
  [10, 25],
]
const STACK_PRESETS = [500, 1000, 2000, 5000]

/**
 * Only the presets the UI offers are accepted. The client is not trusted to
 * send a sane config any more than it is trusted to compute a pot — a hand-
 * rolled message asking for a 0 big blind would divide by zero somewhere less
 * convenient than here.
 */
function validateConfig(config: RoomConfig): RoomConfig {
  const smallBlind = Number(config?.smallBlind)
  const bigBlind = Number(config?.bigBlind)
  const startingStack = Number(config?.startingStack)

  const blindsOk = BLIND_PRESETS.some(([sb, bb]) => sb === smallBlind && bb === bigBlind)
  const stackOk = STACK_PRESETS.includes(startingStack)
  if (!blindsOk || !stackOk) throw new RoomError('BAD_REQUEST', 'Unsupported table settings')

  const currency = config?.currency
  return {
    smallBlind,
    bigBlind,
    startingStack,
    currency: currency === '$' || currency === 'NT$' ? currency : 'chips',
    gameMode: config?.gameMode === 'texasHoldem' ? 'texasHoldem' : 'virtualChips',
  }
}

/**
 * Make the table safe to send to one phone. Hole cards are private until a
 * showdown, and the undealt deck is never a client concern. This copy is used
 * at the transport boundary, leaving the authoritative room untouched.
 */
export function viewForPlayer(room: Room, playerId: string): Room {
  const reveal = room.status === 'showdown' || room.status === 'handEnd'
  return {
    ...room,
    deck: [],
    board: [...room.board],
    players: room.players.map((player) => ({
      ...player,
      holeCards:
        player.id === playerId || (reveal && !player.folded && !player.out)
          ? [...player.holeCards]
          : [],
    })),
    pots: room.pots?.map((pot) => ({ ...pot, eligible: [...pot.eligible], winners: [...pot.winners] })) ?? null,
    log: [...room.log],
  }
}
