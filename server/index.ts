/**
 * BoardQuest realtime server.
 *
 *   GET /health   → lightweight JSON liveness probe (no auth, no secrets)
 *   GET /         → simple JSON identity response
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

function routeHttp(req: IncomingMessage, res: ServerResponse): void {
  const path = (req.url ?? '/').split('?')[0]
  if (req.method !== 'GET') {
    res.writeHead(405, JSON_HEADERS)
    res.end(JSON.stringify({ ok: false, error: 'method_not_allowed' }))
    return
  }
  if (path === '/health') {
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify(healthPayload()))
    return
  }
  if (path === '/') {
    res.writeHead(200, JSON_HEADERS)
    res.end(JSON.stringify({ service: 'boardquest-server', status: 'running' }))
    return
  }
  res.writeHead(404, JSON_HEADERS)
  res.end(JSON.stringify({ ok: false, error: 'not_found' }))
}

/* ---------------------------------- servers ------------------------------------ */

const wss = new WebSocketServer({ noServer: true })
const server = http.createServer(routeHttp)

// WebSocket upgrade: accept upgrades exactly as before (no path restriction —
// direct clients use /ws, the Vite dev proxy forwards /boardquest-ws).
server.on('upgrade', (req, socket, head) => {
  wss.handleUpgrade(req, socket as never, head, (ws) => {
    wss.emit('connection', ws, req)
  })
})

interface Conn {
  ws: WebSocket
  playerId: string | null
  alive: boolean
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
  const conn: Conn = { ws, playerId: null, alive: true }
  connections.add(conn)

  ws.on('message', (data) => {
    let msg: ClientMsg
    try {
      msg = JSON.parse(String(data)) as ClientMsg
    } catch {
      return
    }
    handle(conn, msg)
  })

  ws.on('pong', () => {
    conn.alive = true
  })

  ws.on('close', () => {
    connections.delete(conn)
    if (conn.playerId) manager.leave(conn.playerId)
  })

  ws.on('error', () => {
    /* socket errors are handled by close */
  })
})

function handle(conn: Conn, msg: ClientMsg): void {
  switch (msg.t) {
    case 'hello': {
      if (conn.playerId) return
      const name = String(msg.name ?? '')
      // Reconnect path: client presents a previous playerId.
      if (msg.playerId && manager.reconnect(String(msg.playerId), (m) => send(conn, m))) {
        conn.playerId = String(msg.playerId)
        log(`reconnected player ${conn.playerId}`)
        return
      }
      const res = manager.hello(name, (m) => send(conn, m))
      if ('error' in res) {
        send(conn, { t: 'err', code: res.error, message: res.message })
        return
      }
      conn.playerId = res.playerId
      send(conn, { t: 'you', playerId: res.playerId, name })
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
        giveCash: Number(msg.giveCash ?? 0),
        getCash: Number(msg.getCash ?? 0),
        giveTiles: Array.isArray(msg.giveTiles) ? msg.giveTiles.map(Number) : [],
        getTiles: Array.isArray(msg.getTiles) ? msg.getTiles.map(Number) : [],
        giveJailCards: Number(msg.giveJailCards ?? 0),
        getJailCards: Number(msg.getJailCards ?? 0),
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
      manager.auctionBid(conn.playerId, Number(msg.amount ?? 0))
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
      manager.leave(conn.playerId)
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
      conn.ws.terminate() // 'close' fires → connections.delete + manager.leave cleanup
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
