/**
 * BoardQuest realtime server.
 * WebSocket endpoint: ws://host:8787/ws
 *
 * Handshake:
 *   client sends {t:'hello', name, playerId?} → server assigns or reconnects a player id
 *   then create/join; after that the server drives all game state.
 */
import { WebSocketServer } from 'ws'
import type { WebSocket } from 'ws'
import type { ClientMsg } from '../src/net/protocol'
import { RoomManager, log } from './rooms'

// Deploy note: this process must run on a host that permits long-lived WebSocket
// connections (Railway/Render/Fly/VPS/Docker). Set PORT to the host's
// required value; frontends connect with VITE_WS_URL=wss://<this-host>/ws (see README).
const PORT = Number(process.env.PORT || 8787)
// No `path` restriction: direct clients use /ws, the Vite dev proxy uses /boardquest-ws.
const wss = new WebSocketServer({ port: PORT })

interface Conn {
  ws: WebSocket
  playerId: string | null
  alive: boolean
}

const connections = new Set<Conn>()
const manager = new RoomManager()

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
const INTERVAL = 30_000
setInterval(() => {
  for (const conn of connections) {
    if (!conn.alive) {
      conn.ws.terminate()
      continue
    }
    conn.alive = false
    conn.ws.ping()
  }
}, INTERVAL)

wss.on('listening', () => {
  log(`realtime server listening on ws://localhost:${PORT}/ws`)
  if (!process.env.PORT) {
    log('tip: set PORT in production so your host routes traffic to this server')
  }
})
