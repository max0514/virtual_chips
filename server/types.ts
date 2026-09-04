/**
 * The vocabulary of a table. Shared verbatim by the server and the client —
 * the client imports these as types only, so there is exactly one definition
 * of what a room looks like and the two halves cannot drift apart.
 */

export type Street = 'preflop' | 'flop' | 'turn' | 'river' | 'showdown'

export type RoomStatus = 'lobby' | 'hand' | 'showdown' | 'handEnd' | 'gameOver'

export type Currency = 'chips' | '$' | 'NT$'

export interface RoomConfig {
  smallBlind: number
  bigBlind: number
  startingStack: number
  currency: Currency
}

export interface Player {
  id: string
  name: string
  /** Fixed for the session. Seat order is table order. */
  seat: number
  stack: number
  /** Chips put in on the CURRENT street. */
  committed: number
  /** Chips put in during the WHOLE hand. This is what drives side pots. */
  total: number
  folded: boolean
  allIn: boolean
  /** Busted — no longer dealt in. */
  out: boolean
  /** Socket presence. Cosmetic: a disconnected player keeps their seat and stack. */
  connected: boolean
}

export interface Pot {
  amount: number
  /** playerIds who can win it. */
  eligible: string[]
  /** Set at award time. */
  winners: string[]
  awarded: boolean
}

export type ActionKind = 'FOLD' | 'CHECK_CALL' | 'RAISE'

export interface LastAction {
  playerId: string
  kind: ActionKind | 'POST_BLIND' | 'AWARD' | 'ADJUST' | 'TIMEOUT_FOLD' | 'TIMEOUT_CHECK'
  amount?: number
  /** Filled in for host banking actions and timeouts so the table can see why. */
  note?: string
}

export interface Room {
  /** 6 chars from an unambiguous alphabet. Case-insensitive on input. */
  code: string
  hostId: string
  status: RoomStatus
  config: RoomConfig
  players: Player[]
  dealerSeat: number
  sbSeat: number
  bbSeat: number
  street: Street
  handNo: number
  /** Highest `committed` this street. */
  currentBet: number
  /** Size of the last raise; the next raise must be at least this much more. */
  minRaise: number
  /** null when no one is to act. */
  actingSeat: number | null
  /** Seats that have acted since the last raise. */
  actedSeats: number[]
  /** Built at showdown. */
  pots: Pot[] | null
  lastAction?: LastAction
  /** Set when a hand ends, e.g. "Rosa wins 480". */
  endMessage: string
  /** Increments on every mutation. Clients echo it back so stale taps are rejected. */
  version: number
  updatedAt: string
  /** Visible log of every hand event, newest last. Host banking shows up here. */
  log: string[]
  /**
   * Epoch ms when the acting player's 45s timer expires, or null when no timer
   * is running. Only armed while the acting player is disconnected.
   */
  turnDeadline: number | null
}

/* ---------------------------------------------------------------- messages */

export type ErrorCode =
  | 'ROOM_NOT_FOUND'
  | 'ROOM_FULL'
  | 'NAME_TAKEN'
  | 'NOT_YOUR_TURN'
  | 'ILLEGAL_RAISE'
  | 'STALE_VERSION'
  | 'NOT_HOST'
  | 'GAME_ALREADY_STARTED'
  | 'NOT_ENOUGH_PLAYERS'
  | 'BAD_REQUEST'

export type ClientMessage =
  | { t: 'CREATE_ROOM'; name: string; config: RoomConfig; playerId: string }
  | { t: 'JOIN_ROOM'; code: string; name: string; playerId: string }
  | { t: 'REJOIN'; code: string; playerId: string }
  | { t: 'LEAVE_ROOM'; code: string; playerId: string }
  | { t: 'START_GAME'; code: string }
  | {
      t: 'ACTION'
      code: string
      handNo: number
      version: number
      kind: ActionKind
      raiseTo?: number
    }
  | { t: 'AWARD_POT'; code: string; potIndex: number; winnerIds: string[] }
  | { t: 'NEXT_HAND'; code: string }
  | { t: 'ADJUST_STACK'; code: string; playerId: string; delta: number }
  | { t: 'PING' }

export type ServerMessage =
  | { t: 'STATE'; room: Room }
  | { t: 'ERROR'; code: ErrorCode; message: string }
  | { t: 'PONG' }

export const MAX_PLAYERS = 9
export const MIN_PLAYERS = 2
/** A disconnected player gets this long to act before the server acts for them. */
export const TURN_TIMEOUT_MS = 45_000
/** Rooms expire this long after their last mutation. */
export const ROOM_TTL_MS = 4 * 60 * 60 * 1000
