/**
 * The hand engine. Ported from the prototype's `Component` class, which is a
 * correct reference implementation of betting, min-raise, all-in and side pots.
 *
 * Everything here is a pure function over a `Room`: it takes the room, mutates
 * it, and returns nothing interesting. The server is the only caller. The
 * client never runs any of this — it renders whatever `STATE` it is handed.
 * That is the whole anti-cheat story, and it is why this file has no imports
 * from the transport layer.
 *
 * Two places deliberately differ from the prototype, both flagged in the
 * handoff as prototype shortcuts rather than intended behaviour:
 *
 *   - Odd chips on a split pot go to the winner closest to the left of the
 *     dealer, not to whichever name the host happened to tap first.
 *   - An all-in that is smaller than a full raise bumps `currentBet` but does
 *     not reset `actedSeats`, so it does not re-open betting for players who
 *     have already acted. They still owe the difference; they just do not get
 *     handed a fresh re-raise.
 */

import type { ActionKind, Player, Pot, Room, Street } from './types.js'
import { compareHands, handName, shuffledDeck } from './cards.js'

const STREETS: Street[] = ['preflop', 'flop', 'turn', 'river', 'showdown']

export class RuleError extends Error {
  constructor(
    readonly code: 'NOT_YOUR_TURN' | 'ILLEGAL_RAISE' | 'NOT_ENOUGH_PLAYERS',
    message: string,
  ) {
    super(message)
  }
}

/* --------------------------------------------------------------- seat maths */

/**
 * The next seat clockwise from `from`. Always skips busted players; skips
 * folded and all-in players too when `skipDone` is set, which is what you want
 * when looking for someone who still has a decision to make.
 *
 * Returns `from` itself if it runs the whole way round without a match — the
 * callers all check for that case by other means (an `actives` count) before
 * relying on the answer.
 */
export function nextSeat(players: Player[], from: number, skipDone = false): number {
  const n = players.length
  let j = from
  for (let step = 0; step < n; step++) {
    j = (j + 1) % n
    const p = players[j]
    if (p.out) continue
    if (skipDone && (p.folded || p.allIn)) continue
    return j
  }
  return from
}

/** Seats still in the hand: not folded, not busted. All-in players count. */
export function activeSeats(players: Player[]): number[] {
  return players.map((_, i) => i).filter((i) => !players[i].folded && !players[i].out)
}

/** Total chips wagered this hand, across every street. */
export function potTotal(players: Player[]): number {
  return players.reduce((sum, p) => sum + p.total, 0)
}

/**
 * What is actually sitting in the middle right now — the number the table
 * screen shows.
 *
 * Which side of this you are on depends on whether the pots have been built
 * yet. While betting is live there are no pots, so the middle is simply
 * everything people have put in. From showdown onwards the pots are the truth
 * and the per-player `total` fields go stale: an uncalled bet is handed back to
 * its owner's stack the moment the pots are built, and nothing rewinds their
 * `total`. Summing totals then would count those chips twice — once on the
 * stack, once in the middle.
 */
export function chipsInMiddle(room: Room): number {
  if (room.pots) {
    return room.pots.filter((pot) => !pot.awarded).reduce((sum, pot) => sum + pot.amount, 0)
  }
  return potTotal(room.players)
}

function formatChips(room: Room, n: number): string {
  const prefix = room.config.currency === 'chips' ? '' : room.config.currency
  return prefix + n.toLocaleString('en-US')
}

function touch(room: Room): void {
  room.version += 1
  room.updatedAt = new Date().toISOString()
}

function note(room: Room, line: string): void {
  room.log.push(line)
  // A table plays maybe a few hundred events an evening; keeping the tail is
  // enough for "wait, what just happened" and keeps the payload small.
  if (room.log.length > 200) room.log.splice(0, room.log.length - 200)
}

/** Move chips from a stack into the pot, capped at what the player actually has. */
function commit(player: Player, amount: number): number {
  const paid = Math.max(0, Math.min(amount, player.stack))
  player.stack -= paid
  player.committed += paid
  player.total += paid
  if (player.stack === 0) player.allIn = true
  return paid
}

/* ------------------------------------------------------------- starting out */

/**
 * Deal a new hand: reset per-hand state, post the blinds, and work out who is
 * first to act.
 *
 * Heads-up is the special case people get wrong: with exactly two players the
 * dealer posts the small blind and acts first pre-flop. With three or more the
 * seat after the dealer posts it.
 */
export function startHand(room: Room, dealerSeat: number, handNo: number): void {
  const alive = room.players.filter((p) => !p.out).length
  if (alive < 2) throw new RuleError('NOT_ENOUGH_PLAYERS', 'Need at least 2 players with chips')

  for (const p of room.players) {
    p.committed = 0
    p.total = 0
    p.allIn = false
    p.folded = p.out // busted players are folded for every downstream check
    p.holeCards = []
  }

  room.board = []
  room.deck = room.config.gameMode === 'texasHoldem' ? shuffledDeck() : []
  if (room.config.gameMode === 'texasHoldem') {
    for (const player of room.players) {
      if (!player.out) player.holeCards = [room.deck.pop()!, room.deck.pop()!]
    }
  }

  const { smallBlind, bigBlind } = room.config
  room.dealerSeat = dealerSeat
  room.sbSeat = alive === 2 ? dealerSeat : nextSeat(room.players, dealerSeat)
  room.bbSeat = nextSeat(room.players, room.sbSeat)

  const sbPaid = commit(room.players[room.sbSeat], smallBlind)
  const bbPaid = commit(room.players[room.bbSeat], bigBlind)

  room.status = 'hand'
  room.street = 'preflop'
  room.handNo = handNo
  room.currentBet = bigBlind
  room.minRaise = bigBlind
  room.actedSeats = []
  room.pots = null
  room.endMessage = ''
  room.turnDeadline = null
  room.actingSeat = nextSeat(room.players, room.bbSeat, true)
  room.lastAction = undefined

  note(
    room,
    `Hand ${handNo} — ${room.players[room.sbSeat].name} posts ${formatChips(room, sbPaid)}, ` +
      `${room.players[room.bbSeat].name} posts ${formatChips(room, bbPaid)}`,
  )
  touch(room)
}

/* --------------------------------------------------------------- the action */

/** What the acting player owes to stay in. */
export function toCall(room: Room, seat: number): number {
  return Math.max(0, room.currentBet - room.players[seat].committed)
}

/** Cheapest legal full raise, clamped to what the player can actually put in. */
export function raiseMin(room: Room, seat: number): number {
  const p = room.players[seat]
  return Math.min(room.currentBet + room.minRaise, p.committed + p.stack)
}

/** A raise can never be more than everything the player has. */
export function raiseMax(room: Room, seat: number): number {
  const p = room.players[seat]
  return p.committed + p.stack
}

/**
 * Apply one action for whoever is currently to act, then advance the hand.
 *
 * `raiseTo` is a *total* for the street, not an increment — the same number the
 * slider shows. This matches how people say it out loud ("raise to 80").
 */
export function applyAction(room: Room, kind: ActionKind, raiseTo?: number): void {
  const seat = room.actingSeat
  if (seat === null) throw new RuleError('NOT_YOUR_TURN', 'No one is to act right now')
  const player = room.players[seat]

  if (kind === 'FOLD') {
    player.folded = true
    room.lastAction = { playerId: player.id, kind }
    note(room, `${player.name} folds`)
  } else if (kind === 'CHECK_CALL') {
    const owed = toCall(room, seat)
    const paid = commit(player, owed)
    room.actedSeats.push(seat)
    room.lastAction = { playerId: player.id, kind, amount: paid }
    if (owed === 0) note(room, `${player.name} checks`)
    else if (player.allIn) note(room, `${player.name} calls all-in for ${formatChips(room, paid)}`)
    else note(room, `${player.name} calls ${formatChips(room, paid)}`)
  } else {
    const target = validateRaise(room, seat, raiseTo)
    commit(player, target - player.committed)
    const reached = player.committed

    if (reached > room.currentBet) {
      const increment = reached - room.currentBet
      const isFullRaise = increment >= room.minRaise
      if (isFullRaise) {
        room.minRaise = increment
        // A full raise puts everyone back on the clock.
        room.actedSeats = [seat]
      } else {
        // A short all-in. It raises the price of staying in, but it does not
        // re-open the betting, so nobody who already acted gets a fresh raise.
        room.actedSeats.push(seat)
      }
      room.currentBet = reached
    } else {
      // Only reachable as an all-in for less than the current bet — a call.
      room.actedSeats.push(seat)
    }

    room.lastAction = { playerId: player.id, kind, amount: reached }
    if (player.allIn) note(room, `${player.name} is all-in for ${formatChips(room, reached)}`)
    else note(room, `${player.name} raises to ${formatChips(room, reached)}`)
  }

  room.turnDeadline = null
  advance(room)
  touch(room)
}

/**
 * A raise is legal if it is at least a full min-raise, or if it is the player
 * shoving every chip they have. The second clause is what makes a short all-in
 * legal even though it is under the minimum.
 */
function validateRaise(room: Room, seat: number, raiseTo: number | undefined): number {
  const max = raiseMax(room, seat)
  const min = raiseMin(room, seat)
  if (typeof raiseTo !== 'number' || !Number.isFinite(raiseTo)) {
    throw new RuleError('ILLEGAL_RAISE', 'Raise needs an amount')
  }

  // Snap to the small-blind grid so the slider cannot produce odd chip amounts,
  // but never let rounding push the number past the player's whole stack.
  const step = room.config.smallBlind
  let target = Math.min(max, Math.round(raiseTo / step) * step)

  const isAllIn = target >= max
  if (isAllIn) target = max
  if (!isAllIn && target < min) {
    throw new RuleError(
      'ILLEGAL_RAISE',
      `Raise to at least ${formatChips(room, min)}, or go all-in for ${formatChips(room, max)}`,
    )
  }
  if (target <= room.players[seat].committed) {
    throw new RuleError('ILLEGAL_RAISE', 'Raise has to be more than you already put in')
  }
  return target
}

/**
 * Hand the turn to the next player who owes a decision; if nobody does, close
 * the street and move on. This is the piece that decides when a hand is over.
 */
function advance(room: Room): void {
  const players = room.players
  const stillIn = activeSeats(players)

  // Everyone folded to one player: no showdown, the pot is theirs.
  if (stillIn.length === 1) {
    const winner = players[stillIn[0]]
    const pot = potTotal(players)
    winner.stack += pot
    for (const p of players) {
      p.committed = 0
      p.total = 0
    }
    room.pots = null
    room.actingSeat = null
    room.endMessage = `${winner.name} wins ${formatChips(room, pot)}`
    room.status = 'handEnd'
    note(room, room.endMessage)
    return
  }

  const owesDecision = (seat: number): boolean => {
    const p = players[seat]
    if (p.folded || p.out || p.allIn) return false
    return p.committed < room.currentBet || !room.actedSeats.includes(seat)
  }

  // Look for someone left to act on this street, starting from whoever just went.
  const from = room.actingSeat ?? room.dealerSeat
  for (let step = 1; step <= players.length; step++) {
    const seat = (from + step) % players.length
    if (owesDecision(seat)) {
      room.actingSeat = seat
      return
    }
  }

  closeStreet(room)
}

/** Everyone has matched and acted: sweep the bets in and deal the next street. */
function closeStreet(room: Room): void {
  const players = room.players
  const canStillAct = activeSeats(players).filter((i) => !players[i].allIn)

  for (const p of players) p.committed = 0
  room.currentBet = 0
  room.minRaise = room.config.bigBlind
  room.actedSeats = []

  const isRiver = room.street === 'river'
  // Fewer than two players can still put chips in, so the rest of the betting
  // is a formality — run it out and go straight to comparing hands.
  if (isRiver || canStillAct.length < 2) {
    dealToBoard(room, 5)
    toShowdown(room)
    return
  }

  room.street = STREETS[STREETS.indexOf(room.street) + 1]
  dealToBoard(room, room.street === 'flop' ? 3 : room.street === 'turn' || room.street === 'river' ? 1 : 0)
  // Post-flop the first live seat after the dealer acts first.
  room.actingSeat = nextSeat(players, room.dealerSeat, true)
  note(room, `— ${labelFor(room.street)} —`)
}

function labelFor(street: Street): string {
  return { preflop: 'Pre-flop', flop: 'Flop', turn: 'Turn', river: 'River', showdown: 'Showdown' }[
    street
  ]
}

function toShowdown(room: Room): void {
  room.street = 'showdown'
  room.actingSeat = null
  room.turnDeadline = null
  room.pots = buildPots(room.players)

  // A pot only one player is eligible for is an uncalled bet coming back. No
  // point asking the host to award it.
  for (const pot of room.pots) {
    if (pot.eligible.length === 1) {
      const seat = room.players.findIndex((p) => p.id === pot.eligible[0])
      room.players[seat].stack += pot.amount
      pot.winners = [...pot.eligible]
      pot.awarded = true
      note(room, `${room.players[seat].name} takes back ${formatChips(room, pot.amount)}`)
    }
  }

  if (room.pots.every((pot) => pot.awarded)) {
    finishHand(room)
  } else if (room.config.gameMode === 'texasHoldem') {
    for (let index = 0; index < room.pots.length; index++) {
      const pot = room.pots[index]
      if (!pot.awarded) awardPot(room, index, winningIds(room, pot))
    }
  } else {
    room.status = 'showdown'
    note(room, '— Showdown —')
  }
}

/** Deal public board cards only in the card-dealing game mode. */
function dealToBoard(room: Room, count: number): void {
  if (room.config.gameMode !== 'texasHoldem') return
  while (room.board.length < 5 && count-- > 0) room.board.push(room.deck.pop()!)
}

/** Every eligible player is evaluated independently for each main/side pot. */
function winningIds(room: Room, pot: Pot): string[] {
  let best: number[] | null = null
  let winners: string[] = []
  for (const id of pot.eligible) {
    const player = room.players.find((candidate) => candidate.id === id)!
    const cards = [...player.holeCards, ...room.board]
    if (!best || compareHands(cards, best) > 0) {
      best = cards
      winners = [id]
    } else if (compareHands(cards, best) === 0) {
      winners.push(id)
    }
  }
  if (winners.length) {
    const names = winners.map((id) => room.players.find((player) => player.id === id)!.name)
    const winner = room.players.find((player) => player.id === winners[0])!
    note(room, `${names.join(' & ')} show ${handName([...winner.holeCards, ...room.board])}`)
  }
  return winners
}

/* ---------------------------------------------------------------- side pots */

/**
 * Split the chips into a main pot and however many side pots the all-ins call
 * for.
 *
 * The levels are the distinct amounts players put in over the hand, ascending.
 * Each level peels off one layer: every player contributes whatever they have
 * between the previous level and this one, and the players eligible to win that
 * layer are the ones who did not fold and reached it. Adjacent layers with the
 * same eligible set are merged so the host does not get asked to award two pots
 * that are really one.
 *
 * Folded players' chips still land in the layers — they lost them — but they
 * are never eligible to win any of them.
 */
export function buildPots(players: Player[]): Pot[] {
  const levels = [...new Set(players.filter((p) => p.total > 0).map((p) => p.total))].sort(
    (a, b) => a - b,
  )

  const pots: Pot[] = []
  let previous = 0

  for (const level of levels) {
    let amount = 0
    for (const p of players) amount += Math.max(0, Math.min(p.total, level) - previous)

    const eligible = players
      .filter((p) => !p.folded && !p.out && p.total >= level)
      .map((p) => p.id)

    if (amount > 0) {
      const last = pots[pots.length - 1]
      if (last && last.eligible.join() === eligible.join()) last.amount += amount
      else pots.push({ amount, eligible, winners: [], awarded: false })
    }
    previous = level
  }

  return pots
}

/* ---------------------------------------------------------------- the payout */

/**
 * Pay out one pot. The app never reads cards — players compare hands at the
 * table and the host taps who won, tapping more than one name for a split.
 *
 * Odd chips go to the winner closest to the dealer's left, which is the actual
 * card-room rule. The prototype gave them to whoever was tapped first, which
 * made the result depend on the order the host's thumb moved.
 */
export function awardPot(room: Room, potIndex: number, winnerIds: string[]): void {
  const pot = room.pots?.[potIndex]
  if (!pot || pot.awarded) return

  const winners = winnerIds.filter((id) => pot.eligible.includes(id))
  if (winners.length === 0) return

  const share = Math.floor(pot.amount / winners.length)
  let remainder = pot.amount - share * winners.length

  const oddChipOrder = seatsFromDealerLeft(room).filter((seat) =>
    winners.includes(room.players[seat].id),
  )

  for (const id of winners) {
    const seat = room.players.findIndex((p) => p.id === id)
    room.players[seat].stack += share
  }
  if (remainder > 0 && oddChipOrder.length > 0) {
    room.players[oddChipOrder[0]].stack += remainder
    remainder = 0
  }

  pot.winners = winners
  pot.awarded = true

  const names = winners.map((id) => room.players.find((p) => p.id === id)!.name)
  note(
    room,
    `${names.join(' & ')} ${names.length > 1 ? 'split' : 'wins'} ${formatChips(room, pot.amount)}` +
      (potIndex === 0 ? '' : ` (side pot ${potIndex})`),
  )

  if (room.pots!.every((p) => p.awarded)) finishHand(room)
  touch(room)
}

/** Seats in payout order: the dealer's left first, all the way round. */
function seatsFromDealerLeft(room: Room): number[] {
  const n = room.players.length
  return Array.from({ length: n }, (_, k) => (room.dealerSeat + 1 + k) % n)
}

function finishHand(room: Room): void {
  const pots = room.pots ?? []
  const names = [
    ...new Set(pots.flatMap((p) => p.winners.map((id) => room.players.find((x) => x.id === id)!.name))),
  ]
  const total = pots.reduce((sum, p) => sum + p.amount, 0)

  room.endMessage =
    names.length === 0
      ? 'Pots returned'
      : names.length > 1
        ? `${names.join(' & ')} win the pots`
        : `${names[0]} wins ${formatChips(room, total)}`

  for (const p of room.players) {
    p.total = 0
    p.committed = 0
  }
  room.status = 'handEnd'
  room.actingSeat = null
  room.turnDeadline = null
}

/* -------------------------------------------------------------- next hand */

/** Bust anyone who ran out, move the button, and deal again. */
export function nextHand(room: Room): void {
  for (const p of room.players) {
    if (p.stack === 0) p.out = true
  }
  const alive = room.players.filter((p) => !p.out)

  if (alive.length < 2) {
    room.status = 'gameOver'
    room.actingSeat = null
    room.endMessage = alive.length === 1 ? `${alive[0].name} wins it all` : 'Everyone is out'
    note(room, room.endMessage)
    touch(room)
    return
  }

  startHand(room, nextSeat(room.players, room.dealerSeat), room.handNo + 1)
}

/**
 * Host banking: hand someone chips, or take some back. Only between hands —
 * changing a stack mid-hand would break the side-pot maths, which is built from
 * what people have already put in.
 */
export function adjustStack(room: Room, playerId: string, delta: number): void {
  const player = room.players.find((p) => p.id === playerId)
  if (!player) return

  const before = player.stack
  player.stack = Math.max(0, player.stack + delta)
  if (player.stack > 0) player.out = false

  const moved = player.stack - before
  if (moved === 0) return

  room.lastAction = { playerId, kind: 'ADJUST', amount: moved }
  note(
    room,
    `Host ${moved > 0 ? 'adds' : 'removes'} ${formatChips(room, Math.abs(moved))} ` +
      `${moved > 0 ? 'to' : 'from'} ${player.name}`,
  )
  touch(room)
}
