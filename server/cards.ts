/**
 * The small, deterministic part of the card engine used by live Texas
 * Hold'em tables. Cards are compact integers (0–51), which makes them cheap
 * to persist in the Durable Object and impossible to mistake for display text.
 */

import type { Card } from './types.js'

const RANKS = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A']
const SUITS = ['♠', '♥', '♦', '♣']
const CATEGORIES = [
  'High card',
  'Pair',
  'Two pair',
  'Trips',
  'Straight',
  'Flush',
  'Full house',
  'Quads',
  'Straight flush',
]

export function newDeck(): Card[] {
  return Array.from({ length: 52 }, (_, card) => card)
}

export function shuffledDeck(): Card[] {
  const deck = newDeck()
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[deck[i], deck[j]] = [deck[j], deck[i]]
  }
  return deck
}

export function cardLabel(card: Card): string {
  return `${RANKS[rankOf(card)]}${SUITS[suitOf(card)]}`
}

export function rankOf(card: Card): number {
  return 2 + (card >> 2)
}

export function suitOf(card: Card): number {
  return card & 3
}

export function isRed(card: Card): boolean {
  const suit = suitOf(card)
  return suit === 1 || suit === 2
}

/** Returns a sortable hand score, category first then the kickers. */
export function evaluate(cards: Card[]): number[] {
  const rankCounts = new Array<number>(15).fill(0)
  const suitCards: number[][] = [[], [], [], []]
  for (const card of cards) {
    const rank = rankOf(card)
    rankCounts[rank] += 1
    suitCards[suitOf(card)].push(rank)
  }

  const flush = suitCards.find((ranks) => ranks.length >= 5)
  if (flush) {
    const straightFlush = straightHigh(flush)
    if (straightFlush) return [8, straightFlush]
  }

  const quads: number[] = []
  const trips: number[] = []
  const pairs: number[] = []
  for (let rank = 14; rank >= 2; rank--) {
    if (rankCounts[rank] === 4) quads.push(rank)
    else if (rankCounts[rank] === 3) trips.push(rank)
    else if (rankCounts[rank] === 2) pairs.push(rank)
  }
  const kickers = (excluded: number[], count: number) => {
    const result: number[] = []
    for (let rank = 14; rank >= 2 && result.length < count; rank--) {
      if (!excluded.includes(rank)) {
        for (let n = 0; n < rankCounts[rank] && result.length < count; n++) result.push(rank)
      }
    }
    return result
  }

  if (quads.length) return [7, quads[0], ...kickers([quads[0]], 1)]
  if (trips.length && (pairs.length || trips.length > 1)) {
    return [6, trips[0], Math.max(pairs[0] ?? 0, trips[1] ?? 0)]
  }
  if (flush) return [5, ...flush.sort((a, b) => b - a).slice(0, 5)]
  const straight = straightHigh(cards.map(rankOf))
  if (straight) return [4, straight]
  if (trips.length) return [3, trips[0], ...kickers([trips[0]], 2)]
  if (pairs.length >= 2) return [2, pairs[0], pairs[1], ...kickers([pairs[0], pairs[1]], 1)]
  if (pairs.length) return [1, pairs[0], ...kickers([pairs[0]], 3)]
  return [0, ...kickers([], 5)]
}

export function compareHands(left: Card[], right: Card[]): number {
  const a = evaluate(left)
  const b = evaluate(right)
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0) ? 1 : -1
  }
  return 0
}

export function handName(cards: Card[]): string {
  return CATEGORIES[evaluate(cards)[0]]
}

function straightHigh(ranks: number[]): number {
  const unique = [...new Set(ranks)].sort((a, b) => b - a)
  if (unique[0] === 14) unique.push(1)
  let run = 1
  for (let i = 1; i < unique.length; i++) {
    if (unique[i] === unique[i - 1] - 1) {
      run += 1
      if (run >= 5) return unique[i] + 4
    } else {
      run = 1
    }
  }
  return 0
}
