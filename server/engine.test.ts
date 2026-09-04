/**
 * Engine tests. The handoff names five cases that have to hold before any UI
 * gets wired up — heads-up blinds, a min-raise re-raise, a short call all-in, a
 * three-way side pot, and everyone folding — so those are here first, with the
 * chip-conservation invariant checked alongside them.
 *
 * Chip conservation is the one that catches real bugs: no matter what happens,
 * the chips on the table plus the chips in the pot must equal what everyone
 * started with. A pot that pays out twice or an all-in that loses a chip to
 * rounding shows up here and nowhere else.
 */

import { describe, expect, it } from 'vitest'
import {
  activeSeats,
  applyAction,
  awardPot,
  buildPots,
  chipsInMiddle,
  nextHand,
  potTotal,
  raiseMin,
  RuleError,
  startHand,
} from './engine.js'
import type { Player, Room, RoomConfig } from './types.js'

const CONFIG: RoomConfig = {
  smallBlind: 5,
  bigBlind: 10,
  startingStack: 1000,
  currency: 'chips',
}

function makePlayer(name: string, seat: number, stack: number): Player {
  return {
    id: `p${seat}`,
    name,
    seat,
    stack,
    committed: 0,
    total: 0,
    folded: false,
    allIn: false,
    out: false,
    connected: true,
  }
}

function makeRoom(names: string[], stacks?: number[], config: RoomConfig = CONFIG): Room {
  return {
    code: 'TBL742',
    hostId: 'p0',
    status: 'lobby',
    config,
    players: names.map((n, i) => makePlayer(n, i, stacks?.[i] ?? config.startingStack)),
    dealerSeat: 0,
    sbSeat: 0,
    bbSeat: 0,
    street: 'preflop',
    handNo: 0,
    currentBet: 0,
    minRaise: 0,
    actingSeat: null,
    actedSeats: [],
    pots: null,
    endMessage: '',
    version: 0,
    updatedAt: new Date(0).toISOString(),
    log: [],
    turnDeadline: null,
  }
}

/** Chips on stacks + chips in the middle. Must never change during a hand. */
function chipsInPlay(room: Room): number {
  return room.players.reduce((sum, p) => sum + p.stack, 0) + chipsInMiddle(room)
}

const seatOf = (room: Room, name: string) => room.players.findIndex((p) => p.name === name)
const acting = (room: Room) => room.players[room.actingSeat!].name

describe('blinds', () => {
  it('heads-up: the dealer posts the small blind and acts first pre-flop', () => {
    const room = makeRoom(['Ming', 'Alex'])
    startHand(room, 0, 1)

    expect(room.sbSeat).toBe(0)
    expect(room.bbSeat).toBe(1)
    expect(room.players[0].committed).toBe(5)
    expect(room.players[1].committed).toBe(10)
    // Heads-up the small blind acts first pre-flop, which is the dealer.
    expect(acting(room)).toBe('Ming')
    expect(room.currentBet).toBe(10)
    expect(room.minRaise).toBe(10)
  })

  it('three-handed: the seat after the dealer posts the small blind', () => {
    const room = makeRoom(['Ming', 'Alex', 'Sam'])
    startHand(room, 0, 1)

    expect(room.sbSeat).toBe(1)
    expect(room.bbSeat).toBe(2)
    // First to act pre-flop is the seat after the big blind — back to the dealer.
    expect(acting(room)).toBe('Ming')
  })

  it('a blind larger than the stack puts that player all-in, not into debt', () => {
    const room = makeRoom(['Ming', 'Alex'], [1000, 4])
    startHand(room, 0, 1)

    expect(room.players[1].stack).toBe(0)
    expect(room.players[1].committed).toBe(4)
    expect(room.players[1].allIn).toBe(true)
    expect(chipsInPlay(room)).toBe(1004)
  })
})

describe('betting', () => {
  it('a re-raise has to clear the last raise, and re-opens the action', () => {
    const room = makeRoom(['Ming', 'Alex', 'Sam'])
    startHand(room, 0, 1)

    // Ming raises to 30. That is a raise of 20 over the big blind.
    applyAction(room, 'RAISE', 30)
    expect(room.currentBet).toBe(30)
    expect(room.minRaise).toBe(20)
    // Everyone owes a fresh decision after a full raise.
    expect(room.actedSeats).toEqual([0])

    // Alex cannot re-raise to 40: that is only +10, under the 20 min-raise.
    expect(() => applyAction(room, 'RAISE', 40)).toThrow(RuleError)
    expect(room.currentBet).toBe(30)

    // 50 is legal — exactly a full re-raise.
    applyAction(room, 'RAISE', 50)
    expect(room.currentBet).toBe(50)
    expect(room.minRaise).toBe(20)
    expect(room.actedSeats).toEqual([1])
  })

  it('checking round the table ends the street and moves to the flop', () => {
    const room = makeRoom(['Ming', 'Alex', 'Sam'])
    startHand(room, 0, 1)

    applyAction(room, 'CHECK_CALL') // Ming calls 10
    applyAction(room, 'CHECK_CALL') // Alex completes to 10
    applyAction(room, 'CHECK_CALL') // Sam checks the big blind

    expect(room.street).toBe('flop')
    expect(room.currentBet).toBe(0)
    expect(room.minRaise).toBe(10)
    expect(room.players.every((p) => p.committed === 0)).toBe(true)
    // Post-flop the first live seat after the dealer acts.
    expect(acting(room)).toBe('Alex')
    expect(potTotal(room.players)).toBe(30)
  })

  it('a short all-in raises the price but does not re-open the betting', () => {
    // Seats: Ming (dealer), Alex (SB), Sam (BB, short), Yuki. Sam's whole stack
    // reaches 40 — over the 30 bet, but 10 short of the 50 a full raise needs.
    const room = makeRoom(['Ming', 'Alex', 'Sam', 'Yuki'], [1000, 1000, 40, 1000])
    startHand(room, 0, 1)

    applyAction(room, 'RAISE', 30) // Yuki makes it 30; min-raise is now 20
    applyAction(room, 'CHECK_CALL') // Ming calls 30
    applyAction(room, 'CHECK_CALL') // Alex calls 30
    expect(room.actedSeats).toEqual([3, 0, 1])

    expect(room.actingSeat).toBe(seatOf(room, 'Sam'))
    applyAction(room, 'RAISE', 999) // clamps to Sam's whole stack
    expect(room.players[2].allIn).toBe(true)
    expect(room.players[2].committed).toBe(40)

    // The price to stay in goes up to 40...
    expect(room.currentBet).toBe(40)
    // ...but 40 is only +10 on a 20 min-raise, so it is not a full raise: the
    // minimum stays where it was and nobody's earlier action is wiped.
    expect(room.minRaise).toBe(20)
    expect(room.actedSeats).toEqual([3, 0, 1, 2])

    // Everyone still owes the extra 10, so the street stays open.
    expect(room.street).toBe('preflop')
    expect(acting(room)).toBe('Yuki')
    // And a re-raise is still measured off the old min-raise, not off 40 - 30.
    expect(raiseMin(room, room.actingSeat!)).toBe(60)
    expect(chipsInPlay(room)).toBe(3040)
  })

  it('rejects a raise that is neither a full raise nor a shove', () => {
    const room = makeRoom(['Ming', 'Alex'])
    startHand(room, 0, 1)
    expect(() => applyAction(room, 'RAISE', 15)).toThrow(/at least/)
  })
})

describe('everyone folds', () => {
  it('awards the pot immediately with no showdown', () => {
    const room = makeRoom(['Ming', 'Alex', 'Sam'])
    startHand(room, 0, 1)

    applyAction(room, 'RAISE', 40) // Ming
    applyAction(room, 'FOLD') // Alex
    applyAction(room, 'FOLD') // Sam

    expect(room.status).toBe('handEnd')
    expect(room.pots).toBeNull()
    expect(room.actingSeat).toBeNull()
    // Ming put in 40, collected the 40 + 5 + 10 in the middle.
    expect(room.players[0].stack).toBe(1015)
    expect(room.endMessage).toBe('Ming wins 55')
    expect(chipsInPlay(room)).toBe(3000)
  })
})

describe('side pots', () => {
  it('builds a main pot and one side pot for a three-way all-in', () => {
    // Short stack shoves 100, the other two go to 300 each.
    const players = [
      { ...makePlayer('Ming', 0, 0), total: 300 },
      { ...makePlayer('Alex', 1, 0), total: 300 },
      { ...makePlayer('Sam', 2, 0), total: 100, allIn: true },
    ]
    const pots = buildPots(players)

    expect(pots).toHaveLength(2)
    // Main pot: 100 from each of the three.
    expect(pots[0].amount).toBe(300)
    expect(pots[0].eligible).toEqual(['p0', 'p1', 'p2'])
    // Side pot: the extra 200 each from the two deep stacks.
    expect(pots[1].amount).toBe(400)
    expect(pots[1].eligible).toEqual(['p0', 'p1'])
  })

  it('leaves a folded player money in the pot but never eligible for it', () => {
    const players = [
      { ...makePlayer('Ming', 0, 0), total: 300 },
      { ...makePlayer('Alex', 1, 0), total: 300 },
      { ...makePlayer('Sam', 2, 0), total: 100, folded: true },
    ]
    const pots = buildPots(players)

    // Sam folding means both layers can only be won by Ming and Alex, so they
    // merge: there is no side pot to separate when nobody is shut out of one.
    expect(pots).toHaveLength(1)
    expect(pots[0].amount).toBe(700)
    expect(pots[0].eligible).toEqual(['p0', 'p1'])
    // Sam's 100 is in there; Sam cannot win any of it.
    expect(pots[0].eligible).not.toContain('p2')
  })

  it('merges adjacent layers that the same players can win', () => {
    const players = [
      { ...makePlayer('Ming', 0, 0), total: 200 },
      { ...makePlayer('Alex', 1, 0), total: 300 },
    ]
    // Two levels, but the top layer has one eligible player, so it splits.
    const pots = buildPots(players)
    expect(pots).toHaveLength(2)
    expect(pots[0].amount).toBe(400)
    expect(pots[1].amount).toBe(100)
    expect(pots[1].eligible).toEqual(['p1'])
  })

  it('plays a real three-way all-in through to the side pot', () => {
    const room = makeRoom(['Ming', 'Alex', 'Sam'], [500, 500, 100])
    startHand(room, 0, 1)

    applyAction(room, 'RAISE', 500) // Ming shoves
    applyAction(room, 'CHECK_CALL') // Alex calls all-in
    applyAction(room, 'CHECK_CALL') // Sam calls for his last 100

    // Nobody can act any more, so it runs straight out to showdown.
    expect(room.status).toBe('showdown')
    expect(room.street).toBe('showdown')
    expect(room.pots).toHaveLength(2)
    expect(room.pots![0].amount).toBe(300) // 100 x 3
    expect(room.pots![1].amount).toBe(800) // 400 x 2
    expect(chipsInPlay(room)).toBe(1100)
  })

  it('returns an uncalled bet without asking the host to award it', () => {
    const room = makeRoom(['Ming', 'Alex'], [1000, 200])
    startHand(room, 0, 1)

    applyAction(room, 'RAISE', 1000) // Ming shoves 1000
    applyAction(room, 'CHECK_CALL') // Alex can only call 200

    // The 800 Alex could not cover comes straight back to Ming.
    const side = room.pots!.find((p) => p.eligible.length === 1)!
    expect(side.amount).toBe(800)
    expect(side.awarded).toBe(true)
    expect(room.players[0].stack).toBe(800)
    expect(chipsInPlay(room)).toBe(1200)
  })
})

describe('awarding', () => {
  it('splits a pot evenly and gives the odd chip to the dealer’s left', () => {
    const room = makeRoom(['Ming', 'Alex', 'Sam'], [500, 500, 100])
    startHand(room, 0, 1) // dealer seat 0
    applyAction(room, 'RAISE', 500)
    applyAction(room, 'CHECK_CALL')
    applyAction(room, 'CHECK_CALL')

    // Main pot is 300 split three ways = 100 each, no remainder. Rig an odd one.
    room.pots![0].amount = 301
    awardPot(room, 0, ['p0', 'p1', 'p2'])

    // Dealer is seat 0, so the odd chip goes to seat 1 — the dealer's left.
    expect(room.players[1].stack).toBe(101)
    expect(room.players[0].stack).toBe(100)
    expect(room.players[2].stack).toBe(100)
  })

  it('ignores a winner who is not eligible for that pot', () => {
    const room = makeRoom(['Ming', 'Alex', 'Sam'], [500, 500, 100])
    startHand(room, 0, 1)
    applyAction(room, 'RAISE', 500)
    applyAction(room, 'CHECK_CALL')
    applyAction(room, 'CHECK_CALL')

    // Sam (p2) is not eligible for the side pot — only p0 and p1 are.
    awardPot(room, 1, ['p2'])
    expect(room.pots![1].awarded).toBe(false)
    expect(room.players[2].stack).toBe(0)
  })

  it('moves to handEnd once every pot is awarded', () => {
    const room = makeRoom(['Ming', 'Alex', 'Sam'], [500, 500, 100])
    startHand(room, 0, 1)
    applyAction(room, 'RAISE', 500)
    applyAction(room, 'CHECK_CALL')
    applyAction(room, 'CHECK_CALL')

    awardPot(room, 0, ['p2'])
    expect(room.status).toBe('showdown')
    awardPot(room, 1, ['p0'])

    expect(room.status).toBe('handEnd')
    expect(chipsInPlay(room)).toBe(1100)
    expect(room.players[2].stack).toBe(300)
    expect(room.players[0].stack).toBe(800)
  })
})

describe('hand to hand', () => {
  it('busts the empty stacks, moves the button, and deals again', () => {
    const room = makeRoom(['Ming', 'Alex', 'Sam'], [500, 500, 100])
    startHand(room, 0, 1)
    applyAction(room, 'RAISE', 500)
    applyAction(room, 'CHECK_CALL')
    applyAction(room, 'CHECK_CALL')
    awardPot(room, 0, ['p0'])
    awardPot(room, 1, ['p0'])

    nextHand(room)

    expect(room.players[2].out).toBe(true) // Sam is busted
    expect(room.players[1].out).toBe(true) // so is Alex
    expect(room.status).toBe('gameOver')
    expect(room.endMessage).toBe('Ming wins it all')
  })

  it('skips busted seats when moving the button', () => {
    const room = makeRoom(['Ming', 'Alex', 'Sam', 'Yuki'])
    room.players[1].out = true
    room.dealerSeat = 0

    nextHand(room)

    expect(room.dealerSeat).toBe(2) // seat 1 is out, so the button jumps it
    expect(room.status).toBe('hand')
    expect(room.handNo).toBe(1)
  })

  it('keeps the total chips constant across a whole hand', () => {
    const room = makeRoom(['Ming', 'Alex', 'Sam', 'Yuki'])
    const start = chipsInPlay(room)
    startHand(room, 0, 1)

    applyAction(room, 'RAISE', 40)
    applyAction(room, 'CHECK_CALL')
    applyAction(room, 'FOLD')
    applyAction(room, 'CHECK_CALL')
    expect(room.street).toBe('flop')
    expect(chipsInPlay(room)).toBe(start)

    applyAction(room, 'CHECK_CALL')
    applyAction(room, 'RAISE', 100)
    applyAction(room, 'FOLD')
    applyAction(room, 'CHECK_CALL')
    expect(room.street).toBe('turn')
    expect(chipsInPlay(room)).toBe(start)
  })
})

describe('all-in run-out', () => {
  it('skips the remaining streets when fewer than two players can act', () => {
    const room = makeRoom(['Ming', 'Alex'], [300, 300])
    startHand(room, 0, 1)

    applyAction(room, 'RAISE', 300) // Ming shoves pre-flop
    applyAction(room, 'CHECK_CALL') // Alex calls all-in

    // No more decisions to make, so the flop/turn/river are just cards on the
    // table — the app goes straight to asking who won.
    expect(room.street).toBe('showdown')
    expect(room.status).toBe('showdown')
    expect(activeSeats(room.players)).toHaveLength(2)
    expect(room.pots![0].amount).toBe(600)
  })
})
