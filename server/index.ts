/**
 * BoardQuest realtime server.
 *
 *   GET|HEAD /health → lightweight liveness probe (no auth, no secrets)
 *   GET|HEAD /       → simple JSON identity response
 *   WS   /ws      → realtime game socket (the Vite dev proxy also forwards /boardquest-ws)
 *
 * One HTTP server hosts both the JSON routes and the WebSocket upgrade —
 * there is intentionally no second port or second process.
 *
 * Handshake:
 *   client sends {t:'hello', name, playerId?} → server assigns or reconnects a player id
 *   then create/join; after that the server drives all game state.
 */
import http from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { ClientMsg } from '../src/net/protocol'
import { isTokenId } from '../src/net/protocol'
import { RoomManager, log, setManagerRef } from './rooms'

// Deploy note (Render and similar hosts): this process must run on a host that
// permits long-lived WebSocket connections. Render injects PORT automatically;
// local development falls back to 8787. Frontends connect with
// VITE_WS_URL=wss://<this-host>/ws (see README "Deploy BoardQuest").
const PORT = Number(process.env.PORT || 8787)
const HOST = '0.0.0.0' // externally reachable on PaaS hosts; localhost-only would fail there

/* --------------------------------- HTTP routes --------------------------------- */

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** Health payload: deliberately minimal — no env vars, rooms, players or internals. */
function healthPayload(): Record<string, unknown> {
  return {
    ok: true,
    service: 'boardquest-server',
    status: 'healthy',
    timestamp: new Date().toISOString(),
  }
}

/**
 * Write a JSON response. HEAD is served exactly like GET (same status + headers,
 * including content-length) but with no body, as RFC 9110 requires — this is what
 * lets UptimeRobot's free HTTP monitor, which sends HEAD, keep working.
 */
function sendJson(res: ServerResponse, status: number, payload: unknown, headOnly: boolean): void {
  const body = JSON.stringify(payload)
  res.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  res.end(headOnly ? undefined : body)
}

function routeHttp(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0]
  const method = req.method ?? 'GET'
  const headOnly = method === 'HEAD'
  if (method !== 'GET' && !headOnly) {
    sendJson(res, 405, { ok: false, error: 'method_not_allowed' }, false)
    return
  }
  if (path === '/health') {
    sendJson(res, 200, healthPayload(), headOnly)
    return
  }
  if (path === '/') {
    sendJson(res, 200, { service: 'boardquest-server', status: 'running' }, headOnly)
    return
  }
  sendJson(res, 404, { ok: false, error: 'not_found' }, headOnly)
}

/* ---------------------------------- servers ------------------------------------ */

const wss = new WebSocketServer({ noServer: true })
const server = http.createServer(routeHttp)

// WebSocket upgrade: accept /ws (direct clients) and /boardquest-ws (the Vite
// dev proxy forwards that path here). Everything else is rejected before the
// socket is ever handed to the game layer.
const WS_PATHS = new Set(['/ws', '/boardquest-ws'])
server.on('upgrade', (req, socket, head) => {
  const path = (req.url ?? '/').split('?')[0]
  if (!WS_PATHS.has(path)) {
    log(`ws upgrade rejected for path ${path || '(none)'}`)
    socket.destroy()
    return
  }
  wss.handleUpgrade(req, socket as never, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

interface Conn {
  ws: WebSocket
  playerId: string | null
  alive: boolean
  /** Stable per-connection sink: the manager compares sink identity to detect
   * stale transports, so this MUST be created once per connection. */
  sink: (msg: unknown) => void
}

const connections = new Set<Conn>()
const manager = new RoomManager()
// Let engine timers (zombie-room teardown) close rooms through the manager.
setManagerRef({
  hasRoom: (code) => manager.hasRoom(code),
  closeRoom: (code, reason) => manager.closeRoom(code, reason),
})

function send(conn: Conn, msg: unknown): void {
  if (conn.ws.readyState === 1) {
    conn.ws.send(JSON.stringify(msg))
  }
}

wss.on('connection', (ws: WebSocket) => {
  const conn: Conn = { ws, playerId: null, alive: true, sink: () => {} }
  conn.sink = (msg: unknown) => send(conn, msg)
  connections.add(conn)
  log(`ws connected (${connections.size} online)`)

  ws.on('message', (data) => {
    let msg: ClientMsg
    try {
      msg = JSON.parse(String(data)) as ClientMsg
    } catch {
      return
    }
    try {
      handle(conn, msg)
    } catch (e) {
      // A bad frame from one client must never take down the process.
      log(`handler error for ${conn.playerId ?? 'unknown'}: ${e instanceof Error ? e.message : String(e)}`)
      try {
        ws.close()
      } catch {
        /* already closing */
      }
    }
  })

  ws.on('pong', () => {
    conn.alive = true
  })

  ws.on('close', () => {
    connections.delete(conn)
    log(`ws disconnected (${connections.size} online)`)
    // Only the connection that currently OWNS the seat may trigger leave().
    // A refresh opens the new socket before the old one's close fires; the
    // stale close must not disconnect the freshly re-bound player.
    if (conn.playerId) manager.leaveIfActive(conn.playerId, conn.sink)
  })

  ws.on('error', (err) => {
    log(`ws error on ${conn.playerId ?? 'new socket'}: ${err.message}`)
    /* close follows; cleanup happens there */
  })
})

/* ------------------------- client message validation ------------------------- */

const NAME_RE = /^[\p{L}\p{N}][\p{L}\p{N} _.-]{0,20}$/u
const CODE_RE = /^[A-Z0-9]{1,6}$/

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

/** Cheap shape checks before anything reaches the engine. */
function sanitizeClientMsg(msg: ClientMsg): ClientMsg | null {
  switch (msg.t) {
    case 'hello':
    case 'setName':
      return typeof msg.name === 'string' && NAME_RE.test(msg.name.trim()) ? msg : null
    case 'join':
      return typeof msg.code === 'string' && CODE_RE.test(msg.code.toUpperCase()) ? msg : null
    case 'selectToken':
      return isTokenId(msg.token) ? msg : null
    case 'ready':
      return typeof msg.ready === 'boolean' ? msg : null
    case 'build':
    case 'sellBuilding':
    case 'mortgage':
    case 'unmortgage':
      return Number.isInteger(msg.tile) && msg.tile >= 0 && msg.tile < 40 ? msg : null
    case 'jailAction':
      return msg.action === 'pay' || msg.action === 'card' || msg.action === 'roll' ? msg : null
    case 'auctionBid':
      return isFiniteNumber(msg.amount) ? msg : null
    case 'tradePropose': {
      const okCash = isFiniteNumber(msg.giveCash) && isFiniteNumber(msg.getCash)
      const okTiles =
        Array.isArray(msg.giveTiles) &&
        Array.isArray(msg.getTiles) &&
        msg.giveTiles.concat(msg.getTiles).every((n) => Number.isInteger(n) && n >= 0 && n < 40)
      return okCash && okTiles ? msg : null
    }
    case 'chat':
      return typeof msg.text === 'string' ? msg : null
    default:
      return msg
  }
}

function handle(conn: Conn, raw: ClientMsg): void {
  const msg = sanitizeClientMsg(raw)
  if (!msg) {
    // Failed hello shapes get their specific code so the client UI can explain;
    // everything else is a generic rejection. Nothing is silently swallowed.
    send(conn, {
      t: 'err',
      code: raw.t === 'hello' ? 'badName' : 'badPhase',
      message: raw.t === 'hello' ? 'Name must be 2–20 letters, numbers or spaces.' : 'That action was not understood by the server.',
    })
    return
  }
  switch (msg.t) {
    case 'hello': {
      if (conn.playerId) return
      const name = String(msg.name ?? '')
      // Reconnect path: client presents a previous playerId. If the old socket
      // is still winding down, this rebinds the seat onto THIS connection.
      if (msg.playerId && manager.reconnect(String(msg.playerId), conn.sink)) {
        conn.playerId = String(msg.playerId)
        log(`reconnected player ${conn.playerId}`)
        return
      }
      const res = manager.hello(name, conn.sink)
      if ('error' in res) {
        send(conn, { t: 'err', code: res.error, message: res.message })
        return
      }
      conn.playerId = res.playerId
      send(conn, { t: 'you', playerId: res.playerId, name })
      return
    }
    case 'setName': {
      if (!conn.playerId) return
      const res = manager.setName(conn.playerId, String(msg.name ?? ''))
      if ('error' in res) send(conn, { t: 'err', code: res.error, message: res.message })
      return
    }
    case 'selectToken': {
      if (!conn.playerId) return
      const res = manager.selectToken(conn.playerId, msg.token)
      if ('error' in res) send(conn, { t: 'err', code: res.error, message: res.message })
      return
    }
    case 'create': {
      if (!conn.playerId) return
      const res = manager.create(conn.playerId)
      if ('error' in res) {
        send(conn, { t: 'err', code: res.error, message: res.message })
        return
      }
      manager.sendSnapshot(conn.playerId)
      return
    }
    case 'join': {
      if (!conn.playerId) return
      const res = manager.join(conn.playerId, String(msg.code ?? ''))
      if ('error' in res) {
        send(conn, { t: 'err', code: res.error, message: res.message })
        return
      }
      manager.sendSnapshot(conn.playerId)
      return
    }
    case 'ready': {
      if (!conn.playerId) return
      manager.setReady(conn.playerId, Boolean(msg.ready))
      return
    }
    case 'addBot': {
      if (!conn.playerId) return
      const res = manager.addBot(conn.playerId)
      if ('error' in res) send(conn, { t: 'err', code: res.error, message: res.message })
      return
    }
    case 'start': {
      if (!conn.playerId) return
      const res = manager.start(conn.playerId)
      if ('error' in res) send(conn, { t: 'err', code: res.error, message: res.message })
      return
    }
    case 'roll': {
      if (!conn.playerId) return
      manager.roll(conn.playerId)
      return
    }
    case 'buy': {
      if (!conn.playerId) return
      manager.buy(conn.playerId, Boolean(msg.accept))
      return
    }
    case 'eventOk': {
      if (!conn.playerId) return
      manager.eventOk(conn.playerId)
      return
    }
    case 'build': {
      if (!conn.playerId) return
      manager.build(conn.playerId, Number(msg.tile))
      return
    }
    case 'sellBuilding': {
      if (!conn.playerId) return
      manager.sellBuilding(conn.playerId, Number(msg.tile))
      return
    }
    case 'mortgage': {
      if (!conn.playerId) return
      manager.mortgage(conn.playerId, Number(msg.tile))
      return
    }
    case 'unmortgage': {
      if (!conn.playerId) return
      manager.unmortgage(conn.playerId, Number(msg.tile))
      return
    }
    case 'jailAction': {
      if (!conn.playerId) return
      manager.jailAction(conn.playerId, msg.action)
      return
    }
    case 'tradePropose': {
      if (!conn.playerId) return
      manager.tradePropose(conn.playerId, String(msg.to ?? ''), {
        giveCash: Math.trunc(Number(msg.giveCash ?? 0)),
        getCash: Math.trunc(Number(msg.getCash ?? 0)),
        giveTiles: Array.isArray(msg.giveTiles) ? msg.giveTiles.map(Number) : [],
        getTiles: Array.isArray(msg.getTiles) ? msg.getTiles.map(Number) : [],
        giveJailCards: Math.trunc(Number(msg.giveJailCards ?? 0)),
        getJailCards: Math.trunc(Number(msg.getJailCards ?? 0)),
      })
      return
    }
    case 'tradeRespond': {
      if (!conn.playerId) return
      manager.tradeRespond(conn.playerId, Boolean(msg.accept))
      return
    }
    case 'tradeCancel': {
      if (!conn.playerId) return
      manager.tradeCancel(conn.playerId)
      return
    }
    case 'auctionBid': {
      if (!conn.playerId) return
      manager.auctionBid(conn.playerId, Math.trunc(Number(msg.amount ?? 0)))
      return
    }
    case 'auctionPass': {
      if (!conn.playerId) return
      manager.auctionPass(conn.playerId)
      return
    }
    case 'debtPay': {
      if (!conn.playerId) return
      manager.debtPay(conn.playerId)
      return
    }
    case 'declareBankrupt': {
      if (!conn.playerId) return
      manager.declareBankrupt(conn.playerId)
      return
    }
    case 'playAgain': {
      if (!conn.playerId) return
      const res = manager.playAgain(conn.playerId)
      if ('error' in res) send(conn, { t: 'err', code: res.error, message: res.message })
      return
    }
    case 'chat': {
      if (!conn.playerId) return
      manager.chat(conn.playerId, String(msg.text ?? ''))
      return
    }
    case 'leaveRoom': {
      if (!conn.playerId) return
      // An explicit leave is immediate (the seat is forfeited, the room is not
      // held open for a reconnect). Only a socket drop keeps the grace seat.
      manager.leave(conn.playerId, true)
      return
    }
    default:
      return
  }
}

/* ---------------------------------- heartbeat ---------------------------------- */
// Ping every INTERVAL; terminate connections that missed the previous pong.
// BQ_HEARTBEAT_MS overrides the interval for tests (min 5s to avoid traffic abuse).
const INTERVAL = Math.max(5_000, Number(process.env.BQ_HEARTBEAT_MS || 30_000))
let heartbeatTimer: NodeJS.Timeout | null = setInterval(() => {
  for (const conn of connections) {
    if (!conn.alive) {
      conn.ws.terminate() // 'close' fires → connections.delete + manager cleanup
      continue
    }
    conn.alive = false
    conn.ws.ping()
  }
}, INTERVAL)

server.listen(PORT, HOST, () => {
  log(`realtime server listening on ws://${HOST}:${PORT}/ws`)
  log(`health endpoint: http://${HOST}:${PORT}/health`)
  log(process.env.PORT ? `using PORT from environment (${PORT})` : 'PORT not set — dev default 8787')
  log('WebSocket path: /ws (the Vite dev proxy also forwards /boardquest-ws here)')
})

/* --------------------------------- error guards -------------------------------- */
// An unhandled rejection must log loudly, but a single slipped throw should not
// take down every live room on a busy server.
process.on('uncaughtException', (err) => {
  log(`uncaughtException: ${err.stack ?? err.message}`)
})
process.on('unhandledRejection', (reason) => {
  log(`unhandledRejection: ${reason instanceof Error ? reason.stack : String(reason)}`)
})

/* ------------------------------ graceful shutdown ------------------------------ */
// Render and other PaaS send SIGTERM before stopping a service: clear the
// heartbeat, close the listener, terminate sockets, exit cleanly.
function shutdown(signal: string): void {
  log(`${signal} received — shutting down (rooms are in-memory and will be cleared)`)
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer)
    heartbeatTimer = null
  }
  server.close(() => {
    log('server closed')
    process.exit(0)
  })
  // Don't wait on idle game sockets: terminate them all now.
  for (const conn of connections) {
    try {
      conn.ws.terminate()
    } catch {
      /* already closed */
    }
  }
  // Failsafe if close callback stalls.
  setTimeout(() => process.exit(0), 3000).unref()
}
const shutdownSignals: NodeJS.Signals[] = ['SIGTERM', 'SIGINT']
shutdownSignals.forEach((sig) => process.on(sig, () => shutdown(sig)))
