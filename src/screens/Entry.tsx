/** Home, host setup and join — the three screens before there is a table. */

import { useState } from 'react'
import type { RoomConfig } from '../../server/types'
import { Header } from '../components'

const BLINDS: Array<[number, number]> = [
  [1, 2],
  [2, 5],
  [5, 10],
  [10, 25],
]
const STACKS = [500, 1000, 2000, 5000]

export function Home({ onHost, onJoin }: { onHost: () => void; onJoin: () => void }) {
  return (
    <div className="screen center">
      <div className="glyph">♠</div>
      <h1 className="display" style={{ marginTop: 18, marginBottom: 8 }}>
        Pocket
        <br />
        Dealer
      </h1>
      <p className="subtitle" style={{ marginBottom: 36 }}>
        The chips live here.
        <br />
        The cards stay on the table.
      </p>
      <div className="btn-stack">
        <button className="btn primary" onClick={onHost}>
          Host a game
        </button>
        <button className="btn secondary" onClick={onJoin}>
          Join with code
        </button>
      </div>
    </div>
  )
}

export function HostSetup({
  onBack,
  onCreate,
}: {
  onBack: () => void
  onCreate: (name: string, config: RoomConfig) => void
}) {
  const [name, setName] = useState('')
  const [blinds, setBlinds] = useState(2) // 5 / 10
  const [stack, setStack] = useState(1) // 1,000

  const ready = name.trim().length > 0

  return (
    <div className="screen pad-bottom">
      <Header title="Host a game" onBack={onBack} />

      <div className="sections">
        <div className="section">
          <span className="label">Your name</span>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ming"
            maxLength={16}
            autoComplete="nickname"
            autoFocus
          />
        </div>

        <div className="section">
          <span className="label">Blinds</span>
          <div className="chip-grid">
            {BLINDS.map(([sb, bb], i) => (
              <button
                key={i}
                className={`chip num${i === blinds ? ' on' : ''}`}
                onClick={() => setBlinds(i)}
              >
                {sb} / {bb}
              </button>
            ))}
          </div>
        </div>

        <div className="section">
          <span className="label">Starting stack</span>
          <div className="chip-grid">
            {STACKS.map((value, i) => (
              <button
                key={value}
                className={`chip num${i === stack ? ' on' : ''}`}
                onClick={() => setStack(i)}
              >
                {value >= 1000 ? `${value / 1000}k` : value}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grow" style={{ paddingTop: 24 }}>
        <button
          className="btn primary"
          disabled={!ready}
          onClick={() =>
            onCreate(name.trim(), {
              smallBlind: BLINDS[blinds][0],
              bigBlind: BLINDS[blinds][1],
              startingStack: STACKS[stack],
              currency: 'chips',
            })
          }
        >
          Create room
        </button>
      </div>
    </div>
  )
}

export function Join({
  onBack,
  onJoin,
  error,
  initialCode,
}: {
  onBack: () => void
  onJoin: (code: string, name: string) => void
  error: string | null
  initialCode: string
}) {
  const [code, setCode] = useState(initialCode)
  const [name, setName] = useState('')

  const cleanCode = code.replace(/[^A-Za-z0-9]/g, '').toUpperCase()
  const ready = cleanCode.length === 6 && name.trim().length > 0

  return (
    <div className="screen pad-bottom">
      <Header title="Join a game" onBack={onBack} />

      <div className="sections">
        <div className="section">
          <span className="label">Room code</span>
          <input
            className="field code num"
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            placeholder="TBL742"
            maxLength={7}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            inputMode="text"
            autoFocus={!initialCode}
          />
          {error && <div className="error-line">{error}</div>}
        </div>

        <div className="section">
          <span className="label">Your name</span>
          <input
            className="field"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Alex"
            maxLength={16}
            autoComplete="nickname"
            autoFocus={!!initialCode}
          />
        </div>
      </div>

      <div className="grow" style={{ paddingTop: 24 }}>
        <button
          className="btn primary"
          disabled={!ready}
          onClick={() => onJoin(cleanCode, name.trim())}
        >
          Join table
        </button>
      </div>
    </div>
  )
}
