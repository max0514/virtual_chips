/**
 * Everything the screens need that is not literally a field on `Room`.
 *
 * All of it is derived per render from the state the server sent. None of it is
 * stored, and none of it is authoritative: `raiseMin` here decides whether to
 * grey out a button, while the identical rule on the server decides whether the
 * raise is legal. The screen being wrong costs a rejected tap, not a wrong pot.
 */

import type { Player, Room, Street } from '../server/types'

export function formatChips(room: Room | null, amount: number): string {
  const currency = room?.config.currency ?? 'chips'
  const prefix = currency === 'chips' ? '' : currency
  return prefix + amount.toLocaleString('en-US')
}

export const STREET_LABEL: Record<Street, string> = {
  preflop: 'Pre-flop',
  flop: 'Flop',
  turn: 'Turn',
  river: 'River',
  showdown: 'Showdown',
}

export interface Derived {
  me: Player | null
  mySeat: number
  isMyTurn: boolean
  isHost: boolean
  toCall: number
  canCheck: boolean
  raiseMin: number
  raiseMax: number
  canRaise: boolean
  pot: number
  actingName: string | null
}

export function derive(room: Room | null, playerId: string): Derived {
  const empty: Derived = {
    me: null,
    mySeat: -1,
    isMyTurn: false,
    isHost: false,
    toCall: 0,
    canCheck: false,
    raiseMin: 0,
    raiseMax: 0,
    canRaise: false,
    pot: 0,
    actingName: null,
  }
  if (!room) return empty

  const mySeat = room.players.findIndex((p) => p.id === playerId)
  const me = mySeat >= 0 ? room.players[mySeat] : null

  const toCall = me ? Math.max(0, room.currentBet - me.committed) : 0
  const raiseMax = me ? me.committed + me.stack : 0
  const raiseMin = me ? Math.min(room.currentBet + room.minRaise, raiseMax) : 0

  return {
    me,
    mySeat,
    isMyTurn: room.status === 'hand' && room.actingSeat === mySeat && mySeat >= 0,
    isHost: room.hostId === playerId,
    toCall,
    canCheck: toCall <= 0,
    raiseMin,
    raiseMax,
    // Nothing to raise with once calling would already put you all-in.
    canRaise: !!me && raiseMax > room.currentBet && me.stack > 0,
    pot: chipsInMiddle(room),
    actingName: room.actingSeat === null ? null : room.players[room.actingSeat].name,
  }
}

/**
 * The number on the POT counter.
 *
 * Mirrors the server's own rule: before showdown the middle is everything
 * people have put in; once the pots exist they are the truth, because an
 * uncalled bet has already gone back to its owner's stack while their `total`
 * still records it.
 */
export function chipsInMiddle(room: Room): number {
  if (room.pots) {
    return room.pots.filter((pot) => !pot.awarded).reduce((sum, pot) => sum + pot.amount, 0)
  }
  return room.players.reduce((sum, p) => sum + p.total, 0)
}

/** What the sub-line under a name says. */
export function seatStatus(room: Room, player: Player): string {
  if (player.out) return 'Out'
  if (player.folded) return 'Folded'
  if (player.allIn) return 'All-in'
  return formatChips(room, player.stack)
}

/** D / SB / BB, or nothing — the circle stays either way to keep rows aligned. */
export function seatRole(room: Room, seat: number): string {
  if (room.status === 'lobby') return ''
  if (seat === room.dealerSeat) return 'D'
  if (seat === room.sbSeat) return 'SB'
  if (seat === room.bbSeat) return 'BB'
  return ''
}

export const initial = (name: string): string => name.trim().charAt(0).toUpperCase() || '?'

/** Room codes are stored bare and shown grouped: TBL742 reads as TBL-742. */
export const displayCode = (code: string): string =>
  code.length === 6 ? `${code.slice(0, 3)}-${code.slice(3)}` : code
