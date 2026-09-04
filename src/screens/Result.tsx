/**
 * The three end-of-hand screens: showdown, hand result, game over.
 *
 * Showdown is the one place the host does something the others cannot — the app
 * never reads cards, so somebody has to say who won. The other phones see the
 * same pots read-only, which is what stops "who got the side pot?" from being
 * a matter of trust.
 */

import { useState } from 'react'
import type { Room } from '../../server/types'
import { PlayerRow } from '../components'
import { formatChips, type Derived } from '../derive'

export function Showdown({
  room,
  d,
  onAward,
}: {
  room: Room
  d: Derived
  onAward: (potIndex: number, winnerIds: string[]) => void
}) {
  const pots = room.pots ?? []

  return (
    <div className="screen pad-bottom">
      <h1 className="display" style={{ fontSize: 24, marginBottom: 8 }}>
        Showdown
      </h1>
      <p className="subtitle" style={{ fontSize: 13, marginBottom: 20 }}>
        {d.isHost
          ? 'Compare hands at the table, then tap the winner of each pot. Tap two names to split.'
          : 'Compare hands at the table. The host will award each pot.'}
      </p>

      {pots.map((_pot, index) => (
        <PotCard
          key={index}
          room={room}
          index={index}
          isHost={d.isHost}
          onAward={(winners) => onAward(index, winners)}
        />
      ))}

      {!d.isHost && (
        <div className="waiting" style={{ marginTop: 8 }}>
          <span className="dot" />
          Waiting for host to award…
        </div>
      )}
    </div>
  )
}

function PotCard({
  room,
  index,
  isHost,
  onAward,
}: {
  room: Room
  index: number
  isHost: boolean
  onAward: (winnerIds: string[]) => void
}) {
  const pot = room.pots![index]
  const [selected, setSelected] = useState<string[]>([])

  const nameOf = (id: string) => room.players.find((p) => p.id === id)?.name ?? '?'
  const title = index === 0 ? 'Main pot' : `Side pot ${index}`

  const toggle = (id: string) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((x) => x !== id) : [...current, id],
    )

  return (
    <div className="pot-card">
      <div className="pot-card-head">
        <span className="label">{title}</span>
        <span className="pot-card-amount num">{formatChips(room, pot.amount)}</span>
      </div>

      {pot.awarded ? (
        <div className="awarded">→ {pot.winners.map(nameOf).join(' & ')}</div>
      ) : isHost ? (
        <>
          <div className="pills">
            {pot.eligible.map((id) => (
              <button
                key={id}
                className={`pill${selected.includes(id) ? ' on' : ''}`}
                onClick={() => toggle(id)}
              >
                {nameOf(id)}
              </button>
            ))}
          </div>
          <button
            className="award"
            disabled={selected.length === 0}
            onClick={() => onAward(selected)}
          >
            Award pot
          </button>
        </>
      ) : (
        <div className="pills">
          {pot.eligible.map((id) => (
            <span key={id} className="pill" style={{ cursor: 'default' }}>
              {nameOf(id)}
            </span>
          ))}
        </div>
      )}
    </div>
  )
}

export function HandResult({
  room,
  d,
  onNext,
  onRebuy,
}: {
  room: Room
  d: Derived
  onNext: () => void
  onRebuy: (playerId: string, delta: number) => void
}) {
  const [banking, setBanking] = useState(false)

  return (
    <div className="screen pad-bottom">
      <div style={{ textAlign: 'center', padding: '12px 0 20px' }}>
        <div style={{ fontSize: 30, lineHeight: 1 }}>♠</div>
        <h1 className="display" style={{ fontSize: 22, lineHeight: 1.3, marginTop: 10 }}>
          {room.endMessage}
        </h1>
      </div>

      <div className="card">
        {room.players.map((p) => (
          <PlayerRow
            key={p.id}
            room={room}
            name={p.name}
            tag={p.out ? 'Busted' : p.seat === room.dealerSeat ? 'Dealer' : undefined}
            amount={p.stack}
            dim={p.out}
          />
        ))}
      </div>

      {d.isHost && (
        <div style={{ paddingTop: 12 }}>
          {banking ? (
            <RebuyPanel room={room} onRebuy={onRebuy} onClose={() => setBanking(false)} />
          ) : (
            <button className="btn dashed" onClick={() => setBanking(true)}>
              Adjust chips
            </button>
          )}
        </div>
      )}

      <div className="grow" style={{ paddingTop: 24 }}>
        {d.isHost ? (
          <button className="btn primary" onClick={onNext}>
            Next hand →
          </button>
        ) : (
          <div className="waiting" style={{ height: 56 }}>
            <span className="dot" />
            Waiting for next hand…
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Host banking between hands. Every change lands in the table log, so a rebuy
 * is something everyone sees rather than something the host does quietly.
 */
function RebuyPanel({
  room,
  onRebuy,
  onClose,
}: {
  room: Room
  onRebuy: (playerId: string, delta: number) => void
  onClose: () => void
}) {
  const amount = room.config.startingStack

  return (
    <div className="card" style={{ padding: 4 }}>
      {room.players.map((p) => (
        <div className="row" key={p.id} style={{ padding: '10px 12px' }}>
          <div className="row-name" style={{ fontSize: 14 }}>
            {p.name}
          </div>
          <div className="row-right" style={{ display: 'flex', gap: 6 }}>
            <button className="chip num" style={{ height: 34, width: 64 }} onClick={() => onRebuy(p.id, -amount)}>
              −{amount >= 1000 ? `${amount / 1000}k` : amount}
            </button>
            <button className="chip num" style={{ height: 34, width: 64 }} onClick={() => onRebuy(p.id, amount)}>
              +{amount >= 1000 ? `${amount / 1000}k` : amount}
            </button>
          </div>
        </div>
      ))}
      <button className="btn" style={{ height: 40, fontSize: 14, background: 'transparent', color: 'var(--ink-2)' }} onClick={onClose}>
        Done
      </button>
    </div>
  )
}

export function GameOver({ room, onNewGame }: { room: Room; onNewGame: () => void }) {
  return (
    <div className="screen center">
      <div style={{ textAlign: 'center' }}>
        <div className="glyph">♠</div>
        <h1 className="display" style={{ fontSize: 28, marginTop: 18, marginBottom: 8 }}>
          {room.endMessage}
        </h1>
        <p className="subtitle" style={{ fontSize: 14, marginBottom: 36 }}>
          takes the whole table
        </p>
        <button
          className="btn primary"
          style={{ width: 'auto', padding: '0 36px', margin: '0 auto' }}
          onClick={onNewGame}
        >
          New game
        </button>
      </div>
    </div>
  )
}
