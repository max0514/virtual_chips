/**
 * The socket, and the small amount of state that is genuinely the client's.
 *
 * Everything about the game comes down the wire in `STATE` messages and is
 * stored as-is. The client keeps exactly three things of its own: who this
 * phone is (`playerId`), which table it was last at (`roomCode`), and whether a
 * tap is currently in flight. Nothing about chips is ever stored here — if this
 * file thinks it knows a stack size, that is a bug.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClientMessage, ErrorCode, Room, ServerMessage } from '../server/types'

const PLAYER_KEY = 'pocket-dealer:playerId'
const ROOM_KEY = 'pocket-dealer:roomCode'

/**
 * A stable id for this phone, so closing the browser mid-hand and coming back
 * lands in the same seat. Survives reloads; it is not a login.
 *
 * Resolved once per page load and then held in memory. Reading localStorage on
 * every call would make identity something that can change mid-session — which
 * is exactly what happens with two tabs open on one browser profile, where the
 * second tab's id silently becomes the first tab's too. Whoever this page is,
 * it is that person until it reloads.
 */
let cachedPlayerId: string | null = null

export function getPlayerId(): string {
  if (cachedPlayerId) return cachedPlayerId
  let id = safeGet(PLAYER_KEY)
  if (!id) {
    id = globalThis.crypto?.randomUUID?.() ?? `p-${Math.random().toString(36).slice(2)}-${Date.now()}`
    safeSet(PLAYER_KEY, id)
  }
  cachedPlayerId = id
  return id
}

export const getLastRoom = (): string | null => safeGet(ROOM_KEY)
export const rememberRoom = (code: string | null): void =>
  code ? safeSet(ROOM_KEY, code) : safeRemove(ROOM_KEY)

/* Private browsing and locked-down Safari both throw on localStorage. Losing
 * the id costs a rejoin, not a crash. */
function safeGet(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function safeSet(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* ignore */
  }
}
function safeRemove(key: string): void {
  try {
    localStorage.removeItem(key)
  } catch {
    /* ignore */
  }
}

function socketUrl(): string {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}

export interface Connection {
  room: Room | null
  connected: boolean
  error: { code: ErrorCode; message: string } | null
  /** True from the moment an action is sent until the next STATE arrives. */
  pending: boolean
  send: (message: ClientMessage) => void
  clearError: () => void
  setRoom: (room: Room | null) => void
}

export function useConnection(): Connection {
  const [room, setRoom] = useState<Room | null>(null)
  const [connected, setConnected] = useState(false)
  const [error, setError] = useState<Connection['error']>(null)
  const [pending, setPending] = useState(false)

  const socketRef = useRef<WebSocket | null>(null)
  const queue = useRef<ClientMessage[]>([])
  const retry = useRef(0)
  const roomCode = useRef<string | null>(null)
  /**
   * Which connection attempt is the live one.
   *
   * A closing socket must not be able to schedule a reconnect once a newer
   * attempt exists, or the app ends up holding two sockets and applying two
   * streams of state. A single "closed" boolean is not enough to express that:
   * React StrictMode tears the effect down and immediately sets it back up, so
   * the old socket's onclose fires *after* the flag has been cleared by the new
   * run. Each attempt captures its own generation instead and only acts if it
   * is still current.
   */
  const generation = useRef(0)

  // Kept in a ref as well as state: the reconnect handler needs the current
  // code without re-running the whole effect (and tearing down the socket)
  // every time the room updates.
  roomCode.current = room?.code ?? null

  const connect = useCallback(() => {
    const mine = generation.current
    const socket = new WebSocket(socketUrl())
    socketRef.current = socket

    socket.onopen = () => {
      if (mine !== generation.current) {
        socket.close()
        return
      }
      retry.current = 0
      setConnected(true)
      // Coming back from a drop: take the seat again before anything queued.
      const code = roomCode.current ?? getLastRoom()
      if (code) {
        socket.send(JSON.stringify({ t: 'REJOIN', code, playerId: getPlayerId() }))
      }
      for (const message of queue.current.splice(0)) socket.send(JSON.stringify(message))
      // Browsers cannot send protocol-level pings, so the keepalive is a
      // message. The server treats 45s of silence as a dropped phone.
      const keepalive = setInterval(() => {
        if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ t: 'PING' }))
        else clearInterval(keepalive)
      }, 15_000)
    }

    socket.onmessage = (event) => {
      if (mine !== generation.current) return
      let message: ServerMessage
      try {
        message = JSON.parse(event.data)
      } catch {
        return
      }

      if (message.t === 'STATE') {
        setRoom(message.room)
        rememberRoom(message.room.code)
        setPending(false)
        setError(null)
      } else if (message.t === 'ERROR') {
        setPending(false)
        // A rejoin for a table that has expired is not worth a red banner —
        // it just means there is nothing to go back to.
        if (message.code === 'ROOM_NOT_FOUND' && !roomCode.current) {
          rememberRoom(null)
          return
        }
        // A stale action is a double-tap or a slow network delivering a
        // decision late. The server already ignored it and the next STATE is
        // on its way, so telling anyone would be noise about a non-event.
        if (message.code === 'STALE_VERSION') return
        setError({ code: message.code, message: message.message })
      }
    }

    socket.onclose = () => {
      if (mine !== generation.current) return
      setConnected(false)
      socketRef.current = null
      // Back off, but never so far that a phone coming out of a pocket waits
      // more than a couple of seconds.
      const wait = Math.min(2000, 250 * 2 ** retry.current++)
      setTimeout(() => {
        if (mine === generation.current) connect()
      }, wait)
    }

    socket.onerror = () => socket.close()
  }, [])

  useEffect(() => {
    connect()

    // iOS suspends sockets when Safari backgrounds. Coming back to the app
    // should reconnect immediately rather than waiting for a heartbeat.
    const wake = () => {
      if (document.visibilityState === 'visible' && !socketRef.current) {
        retry.current = 0
        connect()
      }
    }
    document.addEventListener('visibilitychange', wake)
    window.addEventListener('online', wake)

    return () => {
      // Retiring this generation is what stops the socket being torn down here
      // from reconnecting itself a moment later.
      generation.current += 1
      document.removeEventListener('visibilitychange', wake)
      window.removeEventListener('online', wake)
      socketRef.current?.close()
      socketRef.current = null
    }
  }, [connect])

  const send = useCallback((message: ClientMessage) => {
    // Actions block the buttons until the server answers, which is what stops
    // a double-tap from folding the next player.
    if (message.t === 'ACTION') setPending(true)

    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
    else queue.current.push(message)
  }, [])

  const clearError = useCallback(() => setError(null), [])

  return { room, connected, error, pending, send, clearError, setRoom }
}
