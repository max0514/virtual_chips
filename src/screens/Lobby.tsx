/** The waiting room: the code to read out, who has arrived, and the start button. */

import { useState } from 'react'
import { MIN_PLAYERS, type Room } from '../../server/types'
import { PlayerRow } from '../components'
import { displayCode, formatChips } from '../derive'

export function Lobby({
  room,
  isHost,
  onStart,
  onLeave,
}: {
  room: Room
  isHost: boolean
  onStart: () => void
  onLeave: () => void
}) {
  const enough = room.players.length >= MIN_PLAYERS

  return (
    <div className="screen pad-bottom">
      <div className="code-block">
        <span className="label">Room code</span>
        <div className="code-value num">{displayCode(room.code)}</div>
        <div className="code-meta num">
          Blinds {room.config.smallBlind} / {room.config.bigBlind} · Stack{' '}
          {formatChips(room, room.config.startingStack)}
        </div>
        <div className="code-meta" style={{ marginTop: 4 }}>
          {room.config.gameMode === 'texasHoldem' ? 'Texas Hold’em · app deals the cards' : 'Virtual chips · bring your own cards'}
        </div>
      </div>

      <div className="card">
        {room.players.map((p) => (
          <PlayerRow
            key={p.id}
            room={room}
            name={p.name}
            tag={p.id === room.hostId ? 'Host' : undefined}
            amount={p.stack}
          />
        ))}
      </div>

      <div style={{ paddingTop: 10 }}>
        <ShareCode code={room.code} />
      </div>

      <div className="grow" style={{ paddingTop: 24 }}>
        {isHost ? (
          <>
            {!enough && (
              <div className="hint" style={{ marginBottom: 10 }}>
                Need at least {MIN_PLAYERS} players to start
              </div>
            )}
            <button className="btn primary" disabled={!enough} onClick={onStart}>
              {room.config.gameMode === 'texasHoldem' ? 'Deal first hand' : 'Start game'}
            </button>
          </>
        ) : (
          <div className="waiting" style={{ height: 56 }}>
            <span className="dot" />
            Waiting for host to start…
          </div>
        )}
        <button
          className="btn"
          style={{ height: 44, color: 'var(--ink-2)', fontSize: 14, background: 'transparent' }}
          onClick={onLeave}
        >
          Leave table
        </button>
      </div>
    </div>
  )
}

/**
 * Hands the code to the next person.
 *
 * Web Share where it exists (every iPhone, which is the point), clipboard
 * otherwise, and the code stays on screen above regardless — reading six
 * characters across a table is the fallback that always works.
 */
function ShareCode({ code }: { code: string }) {
  const [copied, setCopied] = useState(false)
  const url = `${location.origin}/join/${code}`

  const share = async () => {
    const data = { title: 'Pocket Dealer', text: `Join my table — code ${displayCode(code)}`, url }
    try {
      if (navigator.share) {
        await navigator.share(data)
        return
      }
      await navigator.clipboard.writeText(url)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // A cancelled share sheet lands here too, which is not worth saying anything about.
    }
  }

  return (
    <button className="btn dashed" onClick={share}>
      {copied ? 'Link copied' : 'Share room code'}
    </button>
  )
}
