/** Small shared pieces: the phone shell, the status bar, rows, toasts. */

import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Room } from '../server/types'
import { formatChips, initial } from './derive'

export function Phone({
  context,
  online,
  children,
}: {
  context: string
  online: boolean
  children: ReactNode
}) {
  return (
    <div className="stage">
      <div className="phone">
        {!online && <div className="offline">Reconnecting…</div>}
        <StatusBar context={context} />
        {children}
      </div>
    </div>
  )
}

/**
 * The design's status bar: time on the left, what this screen is on the right.
 *
 * The mocked-up 9:41 becomes the real clock in a browser tab, and disappears
 * entirely once the app is installed to the home screen — iOS draws its own
 * status bar directly above the web view, and two clocks a few pixels apart
 * looks like a bug rather than a design.
 */
function StatusBar({ context }: { context: string }) {
  const installed = useInstalled()
  const [now, setNow] = useState(() => clockLabel())

  useEffect(() => {
    if (installed) return
    const id = setInterval(() => setNow(clockLabel()), 20_000)
    return () => clearInterval(id)
  }, [installed])

  return (
    <div className="statusbar">
      <span className="num">{installed ? '' : now}</span>
      <span>{context}</span>
    </div>
  )
}

function clockLabel(): string {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

/** True when running from the home screen rather than in browser chrome. */
function useInstalled(): boolean {
  const [installed] = useState(() => {
    const standalone = window.matchMedia?.('(display-mode: standalone)').matches
    // iOS Safari predates display-mode and has always used its own flag.
    const ios = (navigator as { standalone?: boolean }).standalone
    return !!standalone || !!ios
  })
  return installed
}

export function Header({ title, onBack }: { title: string; onBack: () => void }) {
  return (
    <div className="header-row">
      <button className="back" onClick={onBack} aria-label="Back">
        ←
      </button>
      <h1 className="title">{title}</h1>
    </div>
  )
}

/** A name row with an avatar and a right-aligned amount — lobby and standings. */
export function PlayerRow({
  room,
  name,
  tag,
  amount,
  dim,
}: {
  room: Room
  name: string
  tag?: string
  amount: number
  dim?: boolean
}) {
  return (
    <div className={`row${dim ? ' dim' : ''}`}>
      <div className="avatar">{initial(name)}</div>
      <div className="row-name">
        <span>{name}</span>
        {tag && <span className="tag">{tag}</span>}
      </div>
      <div className="row-right num">{formatChips(room, amount)}</div>
    </div>
  )
}

/** Transient error above the action bar. Clears itself after three seconds. */
export function Toast({ message, onDone }: { message: string; onDone: () => void }) {
  const done = useRef(onDone)
  done.current = onDone
  useEffect(() => {
    const id = setTimeout(() => done.current(), 3000)
    return () => clearTimeout(id)
  }, [message])
  return (
    <div className="toast" role="alert">
      {message}
    </div>
  )
}

/**
 * A number that counts to its new value over 200ms.
 *
 * Purely so the pot reads as chips moving rather than a figure being replaced —
 * it is the one place the design asks for motion.
 *
 * The animation is an enhancement and is treated as one. `requestAnimationFrame`
 * does not run in a backgrounded tab, so a phone that is face-down or locked
 * when the pot changes would otherwise come back showing the old number — a
 * decoration silently turning into a lie about how much money is in the middle.
 * Anything that cannot animate right now snaps straight to the value instead:
 * a hidden tab, reduced motion, or a browser without rAF at all.
 */
export function CountUp({ value, format }: { value: number; format: (n: number) => string }) {
  const [shown, setShown] = useState(value)
  const from = useRef(value)

  useEffect(() => {
    const settle = () => {
      from.current = value
      setShown(value)
    }

    const cannotAnimate =
      document.hidden ||
      typeof requestAnimationFrame !== 'function' ||
      window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

    if (cannotAnimate || from.current === value) {
      settle()
      return
    }

    const start = from.current
    let frame = 0
    const t0 = performance.now()
    const tick = (t: number) => {
      const k = Math.min(1, (t - t0) / 200)
      const eased = 1 - (1 - k) * (1 - k)
      setShown(Math.round(start + (value - start) * eased))
      if (k < 1) frame = requestAnimationFrame(tick)
      else settle()
    }
    frame = requestAnimationFrame(tick)

    // Backstop: if the tab is hidden part-way through, the frames stop coming
    // and the count-up would strand itself between the two numbers.
    const giveUp = setTimeout(settle, 600)

    return () => {
      cancelAnimationFrame(frame)
      clearTimeout(giveUp)
    }
  }, [value])

  return <>{format(shown)}</>
}
