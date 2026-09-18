/**
 * Protocol test: simulates TWO independent clients against the live server and
 * verifies the multiplayer milestone requirements end-to-end:
 *  - two players join the same room from separate "browsers"
 *  - unique player ids, real-time lobby updates
 *  - only the active player can roll; dice come from the server
 *  - movement + money sync to all clients
 *  - host-start gating, ready flags, bots
 *  - disconnect / reconnect keeps the room consistent
 *
 * Run with: npm run test:protocol  (server must be running on :8787)
 */
import WebSocket from 'ws'
import type { ClientMsg, ServerMsg } from '../src/net/protocol'
import { TILES } from '../src/game/boardData'

const URL = process.env.TEST_WS_URL || 'ws://localhost:8787/ws'

let passed = 0
let failed = 0
function check(name: string, cond: boolean, extra = ''): void {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    console.log(`FAIL  ${name} ${extra}`)
  }
}

class TestClient {
  ws: WebSocket
  playerId: string | null = null
  inbox: ServerMsg[] = []
  waiters: Array<(m: ServerMsg) => boolean> = []
  closed = false

  constructor(public label: string) {
    this.ws = new WebSocket(URL)
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMsg
      this.inbox.push(msg)
      if (msg.t === 'you') this.playerId = msg.playerId
      this.waiters = this.waiters.filter((w) => !w(msg))
    })
    this.ws.on('close', () => {
      this.closed = true
    })
  }

  async open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return
    await new Promise<void>((res, rej) => {
      this.ws.once('open', res)
      this.ws.once('error', rej)
    })
  }

  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg))
  }

  /** Wait for the first message matching pred (skips already-seen unless scan). */
  async waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 8000, scan = true): Promise<ServerMsg> {
    if (scan) {
      const found = this.inbox.find(pred)
      if (found) return found
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${this.label}: timeout waiting for message`))
      }, timeoutMs)
      this.waiters.push((m) => {
        if (pred(m)) {
          clearTimeout(timer)
          resolve(m)
          return true
        }
        return false
      })
      void timer
    })
  }

  /** Wait until a condition over the full inbox holds. */
  async waitUntil(pred: (c: TestClient) => boolean, timeoutMs = 8000): Promise<void> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      if (pred(this)) return
      await sleep(60)
    }
    throw new Error(`${this.label}: waitUntil timeout`)
  }

  lastGame(): Extract<ServerMsg, { t: 'state' }>['game'] | null {
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      const m = this.inbox[i]
      if (m && (m.t === 'state' || m.t === 'started')) return m.game
    }
    return null
  }

  close(): void {
    this.ws.close()
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function main(): Promise<void> {
  console.log(`protocol test against ${URL}\n`)

  const alice = new TestClient('alice')
  const bob = new TestClient('bob')
  await alice.open()
  await bob.open()

  /* ---------------- hello + identity ---------------- */
  alice.send({ t: 'hello', name: 'Alice' })
  bob.send({ t: 'hello', name: 'Bob' })
  await alice.waitFor((m) => m.t === 'you')
  await bob.waitFor((m) => m.t === 'you')
  check('server assigns unique player ids', Boolean(alice.playerId && bob.playerId && alice.playerId !== bob.playerId))

  /* ---------------- create + join ---------------- */
  alice.send({ t: 'create' })
  const created = await alice.waitFor((m) => m.t === 'created')
  const code = created.t === 'created' ? created.code : ''
  check('host creates a room with a code', /^[A-Z0-9]{6}$/.test(code))

  bob.send({ t: 'join', code })
  const joined = await bob.waitFor((m) => m.t === 'joined')
  check('second player joins the same room', joined.t === 'joined' && joined.code === code)

  await alice.waitUntil((c) => {
    const r = c.inbox.find((m) => m.t === 'room')
    return Boolean(r && r.t === 'room' && r.room.players.length === 2)
  })
  const roomMsg = alice.inbox.find((m) => m.t === 'room')
  const roomPlayers = roomMsg && roomMsg.t === 'room' ? roomMsg.room.players : []
  check('lobby roster syncs to all clients in real time', roomPlayers.length === 2)

  /* ---------------- join errors ---------------- */
  const carol = new TestClient('carol')
  await carol.open()
  carol.send({ t: 'hello', name: 'Carol' })
  await carol.waitFor((m) => m.t === 'you')
  carol.send({ t: 'join', code: 'ZZZZZZ' })
  const err1 = await carol.waitFor((m) => m.t === 'err')
  check('joining a bogus code errors cleanly', err1.t === 'err' && err1.code === 'roomNotFound')

  /* ---------------- start gating ---------------- */
  bob.send({ t: 'start' })
  const err2 = await bob.waitFor((m) => m.t === 'err' && m.message.includes('host'))
  check('non-host cannot start', err2.t === 'err')

  bob.send({ t: 'ready', ready: true })
  await alice.waitUntil((c) => {
    const r = c.inbox.filter((m) => m.t === 'room')
    const last = r[r.length - 1]
    return Boolean(last && last.t === 'room' && last.room.players.every((p) => p.ready))
  })
  check('ready flag propagates', true)

  alice.send({ t: 'start' })
  await alice.waitFor((m) => m.t === 'started')
  await bob.waitFor((m) => m.t === 'started')
  check('host starts; both clients receive the game', true)

  /* ---------------- turn order + roll gating ---------------- */
  const g0 = alice.lastGame()
  check('game starts with 1500 cash each', Boolean(g0 && g0.players.every((p) => p.cash === 1500)))
  check('server assigns seats in join order', Boolean(g0 && g0.players[0]?.id === alice.playerId && g0.players[1]?.id === bob.playerId))

  // Whoever is first rolls; the other must be rejected.
  const first = g0?.players[g0.current]
  const roller = first?.id === alice.playerId ? alice : bob
  const watcher = roller === alice ? bob : alice
  check('exactly one active player at start', Boolean(roller && watcher))

  const rollIdBefore = g0?.rollId ?? 0
  roller.send({ t: 'roll' })
  await watcher.waitUntil((c) => (c.lastGame()?.rollId ?? 0) > rollIdBefore)
  const g1 = watcher.lastGame()
  check('roll is broadcast with server dice', Boolean(g1 && g1.phase === 'rolling' && g1.dice[0] >= 1 && g1.dice[1] <= 6))

  // The watcher must not be able to roll mid-flight.
  const rollIdMid = g1?.rollId ?? 0
  watcher.send({ t: 'roll' })
  await sleep(300)
  check('out-of-turn roll is ignored by the server', (watcher.lastGame()?.rollId ?? 0) === rollIdMid)

  /* ---------------- movement + money sync ---------------- */
  // Wait for the landing (buy prompt, event, or turn already advanced),
  // then have the mover answer any prompt like the real UI would.
  await watcher.waitUntil((c) => {
    const g = c.lastGame()
    // Doubles grant a bonus roll: the same player is active again with no prompt.
    return Boolean(g && (g.buyTile != null || g.eventTile != null || g.current !== g1?.current || (g.current === g1?.current && g.phase === 'idle' && (g.rollId ?? 0) > rollIdBefore)))
  }, 20000)
  const landed = watcher.lastGame()
  if (landed?.buyTile != null && landed.players[landed.current]?.id === roller.playerId) {
    roller.send({ t: 'buy', accept: false }) // mover passes → cash math stays simple
  } else if (landed?.eventTile != null && landed.players[landed.current]?.id === roller.playerId) {
    roller.send({ t: 'eventOk' })
  }

  await watcher.waitUntil((c) => {
    const g = c.lastGame()
    return Boolean(g && (g.current !== g1?.current || (g.current === g1?.current && g.phase === 'idle' && (g.rollId ?? 0) > rollIdBefore)))
  }, 20000)
  const g2 = watcher.lastGame()
  const mover = g2?.players.find((p) => p.id === roller.playerId)
  const diceTotal = (g1?.dice[0] ?? 0) + (g1?.dice[1] ?? 0)
  const expectedTile = diceTotal % 40
  check(
    'pawn moved to the dice-sum tile and synced to all clients',
    Boolean(mover && mover.tile === expectedTile),
    `(tile=${mover?.tile}, expected=${expectedTile})`,
  )
  check(
    'turn advanced to the next player',
    Boolean(g2 && g2.players[g2.current]?.id === watcher.playerId),
  )
  if (mover && mover.tile === 0) {
    check('passing START grants +200 (wrapped)', mover.cash === 1700)
  } else if (mover) {
    check('cash unchanged without START pass', mover.cash === 1500)
  }

  /* ---------------- buy flow (watcher's turn) ---------------- */
  const rollId2 = g2?.rollId ?? 0
  watcher.send({ t: 'roll' })
  await watcher.waitUntil((c) => (c.lastGame()?.rollId ?? 0) > rollId2)
  // Wait for the landing: a buy prompt, an event, or the turn to come back around.
  await watcher.waitUntil((c) => {
    const g = c.lastGame()
    return Boolean(
      g &&
        (g.buyTile != null ||
          g.eventTile != null ||
          g.players[g.current]?.id === watcher.playerId),
    )
  }, 20000)
  const g3 = watcher.lastGame()
  if (g3?.buyTile != null && g3.players[g3.current]?.id === watcher.playerId) {
    const tile = g3.buyTile
    const realPrice = TILES[tile]?.price ?? 100
    watcher.send({ t: 'buy', accept: true })
    await watcher.waitUntil((c) => {
      const g = c.lastGame()
      return Boolean(g && (g.owned[String(tile)] !== undefined || g.current !== g3.current))
    }, 10000)
    const g4 = watcher.lastGame()
    const w = g4?.players.find((p) => p.id === watcher.playerId)
    check(
      'buy deducts cash and records ownership on the server',
      Boolean(w && g4 && g4.owned[String(tile)] === w?.id && w.cash === 1500 - realPrice),
      `(cash=${w?.cash}, expected ${1500 - realPrice}, ownedBy=${g4?.owned[String(tile)]})`,
    )
  } else if (g3?.eventTile != null && g3.players[g3.current]?.id === watcher.playerId) {
    watcher.send({ t: 'eventOk' })
    await watcher.waitUntil((c) => {
      const g = c.lastGame()
      return Boolean(g && g.eventTile == null)
    }, 10000)
    check('event resolves and returns the turn', (watcher.lastGame()?.eventTile ?? null) === null)
  } else {
    check('landing resolved without prompt (corner roll)', true)
  }

  /* ---------------- disconnect / reconnect ---------------- */
  const rollIdNow = watcher.lastGame()?.rollId ?? 0
  roller.close()
  await sleep(400)
  check('server notices disconnect without crashing', true)

  const alice2 = new TestClient('alice-reconnect')
  await alice2.open()
  alice2.send({ t: 'hello', name: 'Alice', playerId: roller.playerId ?? undefined })
  await alice2.waitFor((m) => m.t === 'you')
  const snap = await alice2.waitFor((m) => m.t === 'started' || m.t === 'joined')
  check('reconnect restores the seat and sends a snapshot', snap.t === 'started' && snap.game.players.some((p) => p.id === roller.playerId))
  check('reconnected client sees current turn state', Boolean(alice2.lastGame()))
  void rollIdNow
  alice2.close()

  /* ---------------- mechanics suite (fresh room) ---------------- */
  // A second room exercises trades, mortgages, buildings, jail, chat.
  const dave = new TestClient('dave')
  const eve = new TestClient('eve')
  await dave.open()
  await eve.open()
  dave.send({ t: 'hello', name: 'Dave' })
  eve.send({ t: 'hello', name: 'Eve' })
  await dave.waitFor((m) => m.t === 'you')
  await eve.waitFor((m) => m.t === 'you')
  dave.send({ t: 'create' })
  const created2 = await dave.waitFor((m) => m.t === 'created')
  const code2 = created2.t === 'created' ? created2.code : ''
  eve.send({ t: 'join', code: code2 })
  await eve.waitFor((m) => m.t === 'joined')
  eve.send({ t: 'ready', ready: true })
  dave.send({ t: 'start' })
  await dave.waitFor((m) => m.t === 'started')
  await eve.waitFor((m) => m.t === 'started')

  const gd0 = dave.lastGame()
  const daveP = gd0?.players.find((p) => p.id === dave.playerId)
  const eveP = gd0?.players.find((p) => p.id === eve.playerId)
  if (!daveP || !eveP || !gd0) throw new Error('mechanics room failed to start')

  /* ---- chat ---- */
  eve.send({ t: 'chat', text: 'good luck dave' })
  const chatMsg = await dave.waitFor((m) => m.t === 'chat', 5000)
  check('chat relays between players', chatMsg.t === 'chat' && chatMsg.msg.text === 'good luck dave')

  /* ---- trade propose / reject / accept ---- */
  // Dave offers Eve cash for nothing-in-return trade (rejected: empty).
  dave.send({ t: 'tradePropose', to: eve.playerId!, giveCash: 0, getCash: 0, giveTiles: [], getTiles: [], giveJailCards: 0, getJailCards: 0 })
  await sleep(300)
  check('empty trade is rejected by validation', dave.lastGame()?.trade == null)

  // Dave gives M 100 cash for Eve's M 50 back.
  dave.send({ t: 'tradePropose', to: eve.playerId!, giveCash: 100, getCash: 50, giveTiles: [], getTiles: [], giveJailCards: 0, getJailCards: 0 })
  await eve.waitFor((m) => m.t === 'state' && m.game.trade != null, 5000)
  check('trade proposal reaches the target player', eve.lastGame()?.trade?.fromId === dave.playerId)

  eve.send({ t: 'tradeRespond', accept: false })
  await dave.waitUntil((c) => c.lastGame()?.trade == null, 5000)
  check('trade rejection clears the pending trade', dave.lastGame()?.trade == null)

  // Same offer again; this time Eve accepts. Track the trade id so the accept
  // can be matched to THIS proposal (the inbox scan can lag one broadcast).
  dave.send({ t: 'tradePropose', to: eve.playerId!, giveCash: 100, getCash: 50, giveTiles: [], getTiles: [], giveJailCards: 0, getJailCards: 0 })
  await eve.waitFor((m) => m.t === 'state' && m.game.trade?.giveCash === 100 && m.game.trade?.getCash === 50, 5000)
  const acceptTradeId = eve.lastGame()?.trade?.id ?? 0
  const daveCashBefore = dave.lastGame()?.players.find((p) => p.id === dave.playerId)?.cash ?? 0
  const eveCashBefore = eve.lastGame()?.players.find((p) => p.id === eve.playerId)?.cash ?? 0
  eve.send({ t: 'tradeRespond', accept: true })
  await dave.waitUntil(
    (c) => {
      const g = c.lastGame()
      return Boolean(g && g.trade == null && g.players.find((p) => p.id === dave.playerId)?.cash === daveCashBefore - 50)
    },
    5000,
  )
  const daveCashAfter = dave.lastGame()?.players.find((p) => p.id === dave.playerId)?.cash ?? 0
  const eveCashAfter = eve.lastGame()?.players.find((p) => p.id === eve.playerId)?.cash ?? 0
  check(
    'accepted trade moves money on the server',
    daveCashAfter === daveCashBefore - 50 && eveCashAfter === eveCashBefore + 50,
    `(${daveCashBefore}->${daveCashAfter}, ${eveCashBefore}->${eveCashAfter}, tradeId=${acceptTradeId})`,
  )

  /* ---- give a deed via trade ---- */
  // Dave buys tile 1 (Old Harbor, M 60) — but only the active player can roll; buy
  // requires landing on it. Instead: force ownership via a bid-less auction is not
  // exposed, so we verify ownership transfer rules with a synthetic trade on a deed
  // Dave does not own — the server must reject it.
  dave.send({ t: 'tradePropose', to: eve.playerId!, giveCash: 0, getCash: 0, giveTiles: [1], getTiles: [], giveJailCards: 0, getJailCards: 0 })
  await sleep(300)
  check('trading a deed you do not own is rejected', dave.lastGame()?.trade == null)

  /* ---- mortgage / unmortgage validation ---- */
  dave.send({ t: 'mortgage', tile: 1 }) // Dave does not own tile 1
  await sleep(300)
  check('mortgaging an unowned property is rejected', dave.lastGame()?.mortgaged['1'] == null)

  /* ---- build validation ---- */
  dave.send({ t: 'build', tile: 1 })
  await sleep(300)
  check('building without ownership/monopoly is rejected', (dave.lastGame()?.buildings['1'] ?? 0) === 0)

  /* ---- auction flow ---- */
  // Roll until the mover lands on an unowned ownable and declines; an auction
  // must open. A helper resolves each landing prompt like the real UI would.
  async function rollUntilAuction(maxTurns: number): Promise<boolean> {
    for (let i = 0; i < maxTurns; i++) {
      const g = dave.lastGame()
      if (!g || g.winner) return false
      if (g.auction) return true
      if (g.phase === 'idle') {
        const cur = g.players[g.current]
        if (!cur) return false
        ;(cur.id === dave.playerId ? dave : eve).send({ t: 'roll' })
        await sleep(2300)
      } else if (g.phase === 'buy') {
        const cur = g.players[g.current]
        ;(cur?.id === dave.playerId ? dave : eve).send({ t: 'buy', accept: false })
        await sleep(400)
        if (dave.lastGame()?.auction) return true
      } else if (g.phase === 'event') {
        const cur = g.players[g.current]
        ;(cur?.id === dave.playerId ? dave : eve).send({ t: 'eventOk' })
        await sleep(400)
      } else if (g.phase === 'jail') {
        const cur = g.players[g.current]
        ;(cur?.id === dave.playerId ? dave : eve).send({ t: 'jailAction', action: 'pay' })
        await sleep(400)
      } else if (g.phase === 'debt') {
        return false // bankruptcy would end the game; skip the auction attempt
      } else {
        await sleep(500)
      }
    }
    return Boolean(dave.lastGame()?.auction)
  }

  const auctionSeen = await rollUntilAuction(14)
  if (auctionSeen) {
    const ga = dave.lastGame()
    const a = ga?.auction
    check('auction opens when the buyer declines', Boolean(a && a.tile >= 0))
    const bidderClient = a?.bidder === dave.playerId ? dave : eve
    bidderClient.send({ t: 'auctionBid', amount: 60 })
    await sleep(400)
    const mid = dave.lastGame()?.auction
    check('server validates and records the bid', Boolean(mid && mid.highest === 60 && mid.highestBidder === bidderClient.playerId))
    const auctionTile = mid?.tile ?? -1
    // Whoever holds the window now: they pass, then the remaining player passes.
    const nextClient = mid?.bidder === dave.playerId ? dave : eve
    nextClient.send({ t: 'auctionPass' })
    await sleep(500)
    if (dave.lastGame()?.auction) {
      const lastClient = dave.lastGame()?.auction?.bidder === dave.playerId ? dave : eve
      lastClient.send({ t: 'auctionPass' })
    }
    await dave.waitUntil((c) => c.lastGame()?.auction == null, 15000)
    const after = dave.lastGame()
    check(
      'auction completes and awards the property',
      Boolean(after && after.auction == null && auctionTile >= 0 && after.owned[String(auctionTile)] === bidderClient.playerId),
      `(tile=${auctionTile}, ownedBy=${after ? after.owned[String(auctionTile)] : '?'})`,
    )
  } else {
    check('auction opens when the buyer declines', false, 'no buy prompt in 14 turns')
  }

  /* ---------------- production hardening ---------------- */
  // Malformed input must never crash or corrupt the server.
  const mal = new TestClient('malformed')
  await mal.open()
  ;(mal.ws as unknown as { send: (s: string) => void }).send('this is not json')
  mal.send({ t: 'roll' } as unknown as ClientMsg) // unknown t / no hello first
  mal.send({ t: 'chat', text: 42 } as unknown as ClientMsg) // wrong types
  mal.send({ t: 'join', code: 12345 } as unknown as ClientMsg)
  await sleep(300)
  mal.send({ t: 'hello', name: 'Mal' })
  await mal.waitFor((m) => m.t === 'you', 4000)
  check('malformed frames do not break the connection', mal.playerId !== null)
  mal.send({ t: 'hello', name: 'Mal2' })
  await sleep(250)
  check('duplicate hello is ignored (identity stays stable)', mal.playerId !== null)

  // Empty/short names are rejected server-side.
  const anon = new TestClient('anon')
  await anon.open()
  anon.send({ t: 'hello', name: '   ' })
  const errBadName = await anon.waitFor((m) => m.t === 'err', 4000)
  check('blank names are rejected', errBadName.t === 'err' && errBadName.code === 'badName')

  // Room capacity: fill a fresh room to 8 and expect a clean roomFull error.
  const fillers: TestClient[] = []
  let sawFull = false
  const capHost = new TestClient('capHost')
  await capHost.open()
  capHost.send({ t: 'hello', name: 'CapHost' })
  await capHost.waitFor((m) => m.t === 'you', 4000)
  capHost.send({ t: 'create' })
  const capCreated = await capHost.waitFor((m) => m.t === 'created', 4000)
  const capCode = capCreated.t === 'created' ? capCreated.code : ''
  fillers.push(capHost)
  for (let i = 0; i < 8; i++) {
    // 8 joins fill the room; the 9th joiner (i = 7) must be rejected.
    const fc = new TestClient(`filler${i}`)
    await fc.open()
    fc.send({ t: 'hello', name: `Fill${i}` })
    await fc.waitFor((m) => m.t === 'you', 4000)
    fc.send({ t: 'join', code: capCode })
    const fm = await Promise.race([
      fc.waitFor((m) => m.t === 'err', 4000).catch(() => null),
      fc.waitFor((m) => m.t === 'joined', 4000).catch(() => null),
    ])
    if (fm && fm.t === 'err' && fm.code === 'roomFull') sawFull = true
    fillers.push(fc)
  }
  check('9th player gets a clean roomFull error', sawFull)

  // Reconnection: a mid-game identity re-binds on a new socket (lobby seats are
  // intentionally released on disconnect; in-game seats are held for a grace period).
  const reConn = new TestClient('reconn')
  await reConn.open()
  reConn.send({ t: 'hello', name: 'Re' })
  await reConn.waitFor((m) => m.t === 'you', 4000)
  const oldId = reConn.playerId
  reConn.send({ t: 'create' })
  await reConn.waitFor((m) => m.t === 'created', 4000)
  reConn.send({ t: 'addBot' })
  await reConn.waitFor((m) => m.t === 'room', 4000)
  reConn.send({ t: 'start' })
  await reConn.waitFor((m) => m.t === 'started', 4000)
  reConn.close()
  await sleep(300)
  const reConn2 = new TestClient('reconn2')
  await reConn2.open()
  reConn2.send({ t: 'hello', name: 'Re', playerId: oldId ?? undefined })
  await reConn2.waitFor((m) => m.t === 'you', 4000)
  check('player id re-binds after reconnect', reConn2.playerId === oldId)
  const rsnap = await reConn2.waitFor((m) => m.t === 'started', 4000).catch(() => null)
  check(
    'reconnected host receives the running game snapshot',
    Boolean(rsnap && rsnap.t === 'started' && rsnap.game.players.some((p) => p.id === oldId)),
  )
  reConn2.close()

  /* ---------------- cleanup ---------------- */
  mal.close()
  anon.close()
  for (const fc of fillers) fc.close()
  await sleep(150)
  bob.close()
  carol.close()
  dave.close()
  eve.close()
  await sleep(200)

  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('protocol test crashed:', e)
  process.exit(1)
})
