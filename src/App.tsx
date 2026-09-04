/**
 * Screen switching and the send side of the wire.
 *
 * Which screen shows is a function of `room.status` plus whether this phone is
 * seated yet — there is no local navigation state to fall out of sync with the
 * table. The only exception is the two pre-room screens (host setup, join),
 * which exist before there is a room to have a status.
 */

import { useCallback, useEffect, useState } from 'react'
import type { RoomConfig } from '../server/types'
import { Phone, Toast } from './components'
import { derive } from './derive'
import { getPlayerId, rememberRoom, useConnection } from './net'
import { Home, HostSetup, Join } from './screens/Entry'
import { Lobby } from './screens/Lobby'
import { GameOver, HandResult, Showdown } from './screens/Result'
import { Table } from './screens/Table'

type Entry = 'home' | 'host' | 'join'

/** A shared link lands on /join/TBL742 — pull the code out and prefill it. */
function codeFromUrl(): string {
  const match = location.pathname.match(/^\/join\/([A-Za-z0-9]{6})\/?$/)
  return match ? match[1].toUpperCase() : ''
}

export default function App() {
  const playerId = getPlayerId()
  const { room, connected, error, pending, send, clearError, setRoom } = useConnection()
  const [entry, setEntry] = useState<Entry>(() => (codeFromUrl() ? 'join' : 'home'))
  const [linkCode] = useState(codeFromUrl)

  const d = derive(room, playerId)

  // Once the room is known the /join/CODE path has done its job. Clearing it
  // means a reload does not try to re-run the join.
  useEffect(() => {
    if (room && location.pathname.startsWith('/join/')) {
      history.replaceState(null, '', '/')
    }
  }, [room])

  // Keep the screen awake at the table. Phones going dark between hands is the
  // single most annoying thing about using one as a chip tray.
  useWakeLock(!!room && room.status !== 'lobby')

  const leave = useCallback(() => {
    if (room) send({ t: 'LEAVE_ROOM', code: room.code, playerId })
    rememberRoom(null)
    setRoom(null)
    setEntry('home')
  }, [room, playerId, send, setRoom])

  const create = (name: string, config: RoomConfig) =>
    send({ t: 'CREATE_ROOM', name, config, playerId })

  const join = (code: string, name: string) => send({ t: 'JOIN_ROOM', code, name, playerId })

  const act = (kind: 'FOLD' | 'CHECK_CALL' | 'RAISE', raiseTo?: number) => {
    if (!room) return
    // The version and hand number this screen was rendering ride along, so a
    // tap aimed at a stale screen is rejected instead of applied to whatever
    // the table has moved on to.
    send({
      t: 'ACTION',
      code: room.code,
      handNo: room.handNo,
      version: room.version,
      kind,
      raiseTo,
    })
  }

  const context = room ? (d.isHost ? 'Host' : 'Player') : 'Pocket Dealer'
  // A join error belongs under the code field, not in a toast that floats away.
  const joinError = !room && error ? error.message : null
  const toastError = room && error ? error.message : null

  return (
    <Phone context={context} online={connected}>
      {!room ? (
        entry === 'home' ? (
          <Home onHost={() => setEntry('host')} onJoin={() => setEntry('join')} />
        ) : entry === 'host' ? (
          <HostSetup onBack={() => setEntry('home')} onCreate={create} />
        ) : (
          <Join
            onBack={() => setEntry('home')}
            onJoin={join}
            error={joinError}
            initialCode={linkCode}
          />
        )
      ) : room.status === 'lobby' ? (
        <Lobby
          room={room}
          isHost={d.isHost}
          onStart={() => send({ t: 'START_GAME', code: room.code })}
          onLeave={leave}
        />
      ) : room.status === 'showdown' ? (
        <Showdown
          room={room}
          d={d}
          onAward={(potIndex, winnerIds) =>
            send({ t: 'AWARD_POT', code: room.code, potIndex, winnerIds })
          }
        />
      ) : room.status === 'handEnd' ? (
        <HandResult
          room={room}
          d={d}
          onNext={() => send({ t: 'NEXT_HAND', code: room.code })}
          onRebuy={(target, delta) =>
            send({ t: 'ADJUST_STACK', code: room.code, playerId: target, delta })
          }
        />
      ) : room.status === 'gameOver' ? (
        <GameOver room={room} onNewGame={leave} />
      ) : (
        <Table room={room} d={d} pending={pending} onAction={act} />
      )}

      {toastError && <Toast message={toastError} onDone={clearError} />}
    </Phone>
  )
}

/**
 * Hold a screen wake lock while a hand is live.
 *
 * Best-effort by design: Safari only grants it in a secure context and drops it
 * whenever the tab is backgrounded, so it is re-acquired on the way back. If
 * the browser says no, the app carries on and the phone dims as usual.
 */
function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active || !('wakeLock' in navigator)) return
    let lock: WakeLockSentinel | null = null
    let dropped = false

    const acquire = async () => {
      try {
        lock = await navigator.wakeLock.request('screen')
      } catch {
        /* denied — not worth telling anyone about */
      }
    }
    const reacquire = () => {
      if (!dropped && document.visibilityState === 'visible') void acquire()
    }

    void acquire()
    document.addEventListener('visibilitychange', reacquire)

    return () => {
      dropped = true
      document.removeEventListener('visibilitychange', reacquire)
      void lock?.release().catch(() => {})
    }
  }, [active])
}
