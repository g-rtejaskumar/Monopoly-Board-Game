/**
 * BoardQuest client networking: a single WebSocket to the realtime server
 * with automatic hello handshake, reconnect with a persisted playerId,
 * and a small pub/sub for server pushes.
 */
import type { ClientMsg, ServerMsg } from './protocol'
import { resolveWsUrl } from './wsUrl'
import type { ResolvedWsUrl } from './wsUrl'

const ID_KEY = 'boardquest.net.identity.v2'

/**
 * Resolve the realtime WebSocket endpoint.
 *
 * Order of precedence:
 *  1. VITE_WS_URL env var (build time) — validated strictly (ws:// or wss:// only)
 *  2. Dev only: same-origin /boardquest-ws, which the Vite dev server proxies to ws://localhost:8787
 *
 * PRODUCTION never falls back to the dev proxy: an unset/invalid VITE_WS_URL is a
 * configuration error surfaced in the UI (ConnBanner), not a silent wrong dial.
 * See src/net/wsUrl.ts and README "Deploy BoardQuest".
 */
function resolveEndpoint(): ResolvedWsUrl {
  const env = import.meta.env?.VITE_WS_URL as string | undefined
  return resolveWsUrl(env, IS_PROD)
}

/** True when the app was built for production (vite build). */
export const IS_PROD = import.meta.env?.PROD === true
/** Message to show when the WebSocket configuration itself is broken (prod). */
export function getConfigError(): string | null {
  return resolveEndpoint().configError
}

/** Failed attempts before the client reports the server as unreachable. */
const UNREACHABLE_AFTER_FAILURES = 4

export interface NetIdentity {
  playerId: string
  name: string
}

export function loadNetIdentity(): NetIdentity | null {
  try {
    const raw = localStorage.getItem(ID_KEY)
    if (!raw) return null
    const p = JSON.parse(raw) as Partial<NetIdentity>
    if (!p || typeof p.playerId !== 'string' || typeof p.name !== 'string') return null
    return { playerId: p.playerId, name: p.name }
  } catch {
    return null
  }
}

export function saveNetIdentity(id: NetIdentity): void {
  try {
    localStorage.setItem(ID_KEY, JSON.stringify(id))
  } catch {
    /* non-fatal */
  }
}

export function clearNetIdentity(): void {
  try {
    localStorage.removeItem(ID_KEY)
  } catch {
    /* non-fatal */
  }
}

type Listener = (msg: ServerMsg) => void

export type NetStatus = 'connecting' | 'open' | 'closed' | 'unreachable' | 'config-error'

export class NetClient {
  private ws: WebSocket | null = null
  private listeners = new Set<Listener>()
  private statusListeners = new Set<(s: NetStatus) => void>()
  private queue: ClientMsg[] = []
  private helloSent = false
  private reconnectDelay = 700
  private reconnectTimer: number | null = null
  /** Failed connection attempts since the last successful open. */
  private failures = 0
  /** Kept for callers that close the socket intentionally. */
  private closedByUs = false

  name = ''
  identity: NetIdentity | null = null
  status: NetStatus = 'closed'

  constructor(name: string) {
    this.name = name
    this.identity = loadNetIdentity()
  }

  connect(): void {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return
    }
    this.closedByUs = false
    // A broken configuration is not a connection problem: surface it immediately
    // and never pretend to be connecting/reconnecting to a wrong endpoint.
    const cfg = resolveEndpoint()
    if (cfg.configError) {
      this.setStatus('config-error')
      return
    }
    this.setStatus('connecting')
    const url = cfg.url
    let ws: WebSocket
    try {
      ws = new WebSocket(url)
    } catch {
      this.failures += 1
      this.evaluateUnreachable()
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    ws.onopen = () => {
      this.reconnectDelay = 700
      this.failures = 0
      this.helloSent = false
      this.sendHello()
      this.setStatus('open')
      // flush anything queued while connecting
      const q = this.queue
      this.queue = []
      q.forEach((m) => this.send(m))
    }

    ws.onmessage = (ev) => {
      let msg: ServerMsg
      try {
        msg = JSON.parse(String(ev.data)) as ServerMsg
      } catch {
        return
      }
      if (msg.t === 'you') {
        this.identity = { playerId: msg.playerId, name: this.name }
        saveNetIdentity(this.identity)
      }
      this.listeners.forEach((l) => l(msg))
    }

    ws.onclose = () => {
      this.setStatus('closed')
      if (!this.closedByUs) {
        this.failures += 1
        this.evaluateUnreachable()
        this.scheduleReconnect()
      }
    }

    ws.onerror = () => {
      /* close handler deals with it */
    }
  }

  private sendHello(): void {
    if (this.helloSent) return
    this.helloSent = true
    this.rawSend({ t: 'hello', name: this.name, playerId: this.identity?.playerId })
  }

  /** After several failed attempts, surface that the server cannot be reached. */
  private evaluateUnreachable(): void {
    if (this.failures >= UNREACHABLE_AFTER_FAILURES) this.setStatus('unreachable')
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer != null) return
    const delay = this.reconnectDelay
    this.reconnectDelay = Math.min(this.reconnectDelay * 1.6, 6000)
    this.reconnectTimer = window.setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private rawSend(msg: ClientMsg): boolean {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg))
      return true
    }
    return false
  }

  send(msg: ClientMsg): void {
    if (!this.rawSend(msg)) this.queue.push(msg)
  }

  /** Forget the old identity (used on hard errors like a taken/invalid seat). */
  resetIdentity(): void {
    this.identity = null
    clearNetIdentity()
  }

  close(): void {
    this.closedByUs = true
    if (this.reconnectTimer != null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.ws?.close()
    this.ws = null
    this.setStatus('closed')
  }

  onMessage(l: Listener): () => void {
    this.listeners.add(l)
    return () => this.listeners.delete(l)
  }

  onStatus(l: (s: NetStatus) => void): () => void {
    this.statusListeners.add(l)
    l(this.status)
    return () => this.statusListeners.delete(l)
  }

  private setStatus(s: NetStatus): void {
    this.status = s
    this.statusListeners.forEach((l) => l(s))
  }
}

/** Singleton per browser tab. */
let client: NetClient | null = null

export function getNet(name?: string): NetClient {
  if (!client) client = new NetClient(name ?? loadNetIdentity()?.name ?? 'Player')
  return client
}

export function destroyNet(): void {
  client?.close()
  client = null
}
