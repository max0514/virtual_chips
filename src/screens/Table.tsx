/**
 * The table. Pot at the top, seats down the middle, your action bar pinned to
 * the bottom.
 *
 * The action buttons render only when it is actually your turn — everyone else
 * gets the waiting panel. That is not just presentation: it is the same rule
 * the server enforces, shown twice so the phone never offers a tap that would
 * be rejected.
 */

import { useEffect, useMemo, useState } from 'react'
import type { Card, Room } from '../../server/types'
import { CountUp } from '../components'
import {
  displayCode,
  formatChips,
  seatRole,
  seatStatus,
  STREET_LABEL,
  type Derived,
} from '../derive'

export function Table({
  room,
  d,
  pending,
  onAction,
}: {
  room: Room
  d: Derived
  pending: boolean
  onAction: (kind: 'FOLD' | 'CHECK_CALL' | 'RAISE', raiseTo?: number) => void
}) {
  const [raiseOpen, setRaiseOpen] = useState(false)

  // Close the raise sheet whenever the turn moves on, so it can never be left
  // hanging open over somebody else's decision.
  useEffect(() => {
    if (!d.isMyTurn) setRaiseOpen(false)
  }, [d.isMyTurn, room.handNo, room.street])

  // A short buzz when the table comes round to you. Android only; iOS Safari
  // has no vibrate, and that is fine — the screen already changed.
  useEffect(() => {
    if (d.isMyTurn) navigator.vibrate?.(30)
  }, [d.isMyTurn])

  return (
    <div className="screen flush" style={{ display: 'flex', flexDirection: 'column' }}>
      <div className="meta-row">
        <span className="num">{displayCode(room.code)}</span>
        <span className="street-pill">{STREET_LABEL[room.street]}</span>
        <span className="num">HAND {room.handNo}</span>
      </div>

      <div className="pot">
        <span className="label">Pot</span>
        <div className="pot-amount num">
          <CountUp value={d.pot} format={(n) => formatChips(room, n)} />
        </div>
        <div className="pot-blinds num">
          Blinds {room.config.smallBlind} / {room.config.bigBlind}
        </div>
      </div>

      {room.config.gameMode === 'texasHoldem' && <Board cards={room.board} />}

      <div className="seats-scroll">
        <div className="seats">
          {room.players.map((p, seat) => {
            const role = seatRole(room, seat)
            const acting = room.actingSeat === seat
            return (
              <div
                key={p.id}
                className={`seat${acting ? ' acting' : ''}${p.folded || p.out ? ' done' : ''}`}
              >
                <div className={`badge${role ? '' : ' empty'}`}>{role || '·'}</div>
                <div className="seat-main">
                  <div className="seat-name">
                    <span>
                      {p.name}
                      {seat === d.mySeat && ' (you)'}
                    </span>
                    {acting && <span className="dot" />}
                    {!p.connected && !p.out && <span className="dot off" title="Disconnected" />}
                  </div>
                  <div className="seat-sub num">{seatStatus(room, p)}</div>
                </div>
                {p.committed > 0 && (
                  <div className="seat-bet num">{formatChips(room, p.committed)}</div>
                )}
                {room.config.gameMode === 'texasHoldem' && !p.folded && !p.out && (
                  <div className="seat-cards" aria-label={`${p.name}'s cards`}>
                    {p.holeCards.length ? p.holeCards.map((card) => <PlayingCard key={card} card={card} compact />) : <><CardBack /><CardBack /></>}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>

      {room.log.length > 0 && (
        <div className="log">
          {room.log.slice(-3).map((line, i) => (
            <div key={`${room.version}-${i}`}>{line}</div>
          ))}
        </div>
      )}

      <ActionBar
        room={room}
        d={d}
        pending={pending}
        raiseOpen={raiseOpen}
        setRaiseOpen={setRaiseOpen}
        onAction={onAction}
      />
    </div>
  )
}

function ActionBar({
  room,
  d,
  pending,
  raiseOpen,
  setRaiseOpen,
  onAction,
}: {
  room: Room
  d: Derived
  pending: boolean
  raiseOpen: boolean
  setRaiseOpen: (open: boolean) => void
  onAction: (kind: 'FOLD' | 'CHECK_CALL' | 'RAISE', raiseTo?: number) => void
}) {
  if (!d.me) {
    return (
      <div className="actionbar">
        <div className="waiting">Watching this hand</div>
      </div>
    )
  }

  const callLabel = d.canCheck
    ? 'Check'
    : d.toCall >= d.me.stack
      ? `All-in ${formatChips(room, d.me.stack)}`
      : `Call ${formatChips(room, d.toCall)}`

  return (
    <div className="actionbar">
      <div className="stack-row">
        <div>
          <div className="label">Your stack</div>
          <div className="stack-amount num">{formatChips(room, d.me.stack)}</div>
        </div>
        {d.isMyTurn && !d.canCheck && (
          <div className="to-call num">To call {formatChips(room, d.toCall)}</div>
        )}
      </div>

      {room.config.gameMode === 'texasHoldem' && d.me.holeCards.length > 0 && (
        <div className="your-cards">
          <span className="label">Your cards</span>
          <div className="playing-cards">
            {d.me.holeCards.map((card) => <PlayingCard key={card} card={card} />)}
          </div>
        </div>
      )}

      {raiseOpen && d.isMyTurn ? (
        <RaiseSheet
          room={room}
          d={d}
          onCancel={() => setRaiseOpen(false)}
          onRaise={(to) => {
            setRaiseOpen(false)
            onAction('RAISE', to)
          }}
        />
      ) : d.me.out ? (
        <div className="waiting">You are out</div>
      ) : d.me.folded ? (
        <div className="waiting">You folded this hand</div>
      ) : d.isMyTurn ? (
        <div className="actions">
          <button className="act fold" disabled={pending} onClick={() => onAction('FOLD')}>
            Fold
          </button>
          <button className="act call num" disabled={pending} onClick={() => onAction('CHECK_CALL')}>
            {callLabel}
          </button>
          <button
            className="act raise"
            disabled={pending || !d.canRaise}
            onClick={() => setRaiseOpen(true)}
          >
            {room.currentBet > 0 ? 'Raise' : 'Bet'}
          </button>
        </div>
      ) : (
        <div className="waiting">
          <span className="dot" />
          {d.me.allIn ? "You're all-in" : `Waiting for ${d.actingName ?? '…'}…`}
        </div>
      )}
    </div>
  )
}

function Board({ cards }: { cards: Card[] }) {
  return (
    <div className="board">
      <span className="label">Board</span>
      <div className="playing-cards">
        {Array.from({ length: 5 }, (_, index) => cards[index] === undefined ? <CardBack key={index} /> : <PlayingCard key={cards[index]} card={cards[index]} />)}
      </div>
    </div>
  )
}

export function PlayingCard({ card, compact = false }: { card: Card; compact?: boolean }) {
  const rank = ['', '', '2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'][2 + (card >> 2)]
  const suit = ['♠', '♥', '♦', '♣'][card & 3]
  return <span className={`playing-card${compact ? ' compact' : ''}${(card & 3) === 1 || (card & 3) === 2 ? ' red' : ''}`}>{rank}<small>{suit}</small></span>
}

function CardBack() {
  return <span className="card-back" aria-hidden="true" />
}

/**
 * The raise slider.
 *
 * Steps in small blinds, starts at the minimum, and clamps every preset into
 * the legal range so a half-pot bet on a short stack becomes a shove rather
 * than an illegal number the server would bounce.
 */
function RaiseSheet({
  room,
  d,
  onCancel,
  onRaise,
}: {
  room: Room
  d: Derived
  onCancel: () => void
  onRaise: (to: number) => void
}) {
  const step = room.config.smallBlind
  const clamp = (value: number) =>
    Math.max(d.raiseMin, Math.min(d.raiseMax, Math.round(value / step) * step))

  const [to, setTo] = useState(() => clamp(d.raiseMin))

  const presets = useMemo(() => {
    const pot = d.pot + d.toCall
    return [
      { label: 'Min', value: d.raiseMin },
      { label: '½ pot', value: clamp(room.currentBet + pot / 2) },
      { label: 'Pot', value: clamp(room.currentBet + pot) },
      { label: 'All-in', value: d.raiseMax },
    ]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [d.pot, d.toCall, d.raiseMin, d.raiseMax, room.currentBet])

  return (
    <div className="raise-sheet">
      <div className="raise-amount num">{formatChips(room, to)}</div>

      <input
        className="slider"
        type="range"
        min={d.raiseMin}
        max={d.raiseMax}
        step={step}
        value={to}
        onChange={(e) => setTo(clamp(Number(e.target.value)))}
        aria-label="Raise amount"
      />

      <div className="presets">
        {presets.map((preset) => (
          <button
            key={preset.label}
            className="preset num"
            // A preset that lands on the number you are already at is not worth
            // a tap, but it is never *illegal* — clamping already saw to that.
            disabled={preset.value === to}
            onClick={() => setTo(clamp(preset.value))}
          >
            {preset.label}
          </button>
        ))}
      </div>

      <div className="raise-confirm">
        <button className="cancel" onClick={onCancel}>
          Cancel
        </button>
        <button className="go num" onClick={() => onRaise(to)}>
          {to >= d.raiseMax ? `All-in ${formatChips(room, to)}` : `Raise to ${formatChips(room, to)}`}
        </button>
      </div>
    </div>
  )
}
