/**
 * Movement & turn-sync regression suite (scripts/test-movement.ts).
 *
 * Reproduces the REAL production two-device bug:
 *   Player A rolls 5 → lands on tile 5 → buys → turn passes to B, but
 *   (a) A's 3D pawn stayed on GO, and
 *   (b) B's UI froze on "A is moving…" so B could never take a turn.
 *
 * Part 1 drives the client store (src/net/netBoardStore.ts) on a virtual clock
 * with handcrafted authoritative snapshots, so every movement edge case is
 * deterministic. Part 2 spawns the REAL server with pinned dice and checks that
 * two independent clients agree on the authoritative state throughout the flow.
 *
 * Run: npm run test:movement
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import WebSocket from 'ws'
import type { ClientMsg, ServerMsg, GameSnapshot, GamePlayer } from '../src/net/protocol'
import { createNetBoardStore } from '../src/net/netBoardStore'
import type { BoardStoreShape } from '../src/net/netBoardStore'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ok  ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ============================================================================
 * Part 1 — client store on a virtual clock
 * ========================================================================== */

/** Controllable clock: netBoardStore only needs window.setTimeout/clearTimeout. */
let clock = 0
let timerSeq = 0
const timers = new Map<number, { at: number; fn: () => void }>()
const realDateNow = Date.now

function installVirtualClock(): void {
  Date.now = () => clock
  const g = globalThis as unknown as { window: Record<string, unknown> }
  g.window = {
    setTimeout: (fn: () => void, ms?: number) => {
      const id = ++timerSeq
      timers.set(id, { at: clock + (ms ?? 0), fn })
      return id
    },
    clearTimeout: (id: number) => {
      timers.delete(id)
    },
  }
}

/** Advance the clock, firing any timers that fall due (in time order). */
function advance(ms: number): void {
  const target = clock + ms
  for (;;) {
    let nextId = -1
    let nextAt = Number.POSITIVE_INFINITY
    for (const [id, t] of timers) {
      if (t.at <= target && t.at < nextAt) {
        nextAt = t.at
        nextId = id
      }
    }
    if (nextId < 0) break
    const t = timers.get(nextId)
    timers.delete(nextId)
    if (!t) break
    clock = t.at
    t.fn()
  }
  clock = target
}

const ALICE = { id: 'A', name: 'Alice', color: '#f5a83c' }
const BOB = { id: 'B', name: 'Bob', color: '#3a97cf' }

function player(o: { id: string; name: string; color: string }, seat: number, tile: number, cash = 1500): GamePlayer {
  return { id: o.id, name: o.name, color: o.color, seat, tile, cash, isBot: false, connected: true }
}

function mkGame(o: {
  tiles: [number, number]
  current: number
  phase: GameSnapshot['phase']
  dice?: [number, number]
  rollId?: number
  turn?: number
  owned?: Record<string, string>
  buyTile?: number | null
  eventTile?: number | null
  doubles?: number
}): GameSnapshot {
  return {
    code: 'TEST01',
    players: [player(ALICE, 0, o.tiles[0]), player(BOB, 1, o.tiles[1])],
    current: o.current,
    turn: o.turn ?? 1,
    phase: o.phase,
    dice: o.dice ?? [1, 1],
    rollId: o.rollId ?? 0,
    rolledAt: 0,
    doubles: o.doubles ?? 0,
    owned: o.owned ?? {},
    buildings: {},
    mortgaged: {},
    buyTile: o.buyTile ?? null,
    eventTile: o.eventTile ?? null,
    eventText: null,
    debt: null,
    trade: null,
    auction: null,
    log: [],
    winner: null,
  }
}

interface Trace {
  phase: string
  current: number
  animSeat: number | null
  animTo: number | null
  tiles: number[]
}

/** Wrap a store so every emitted state is recorded — the UI sees exactly these. */
function observe(store: BoardStoreShape): { trace: Trace[] } {
  const trace: Trace[] = []
  const record = (): void => {
    const s = store.get()
    trace.push({
      phase: s.phase,
      current: s.current,
      animSeat: s.moveAnim?.seat ?? null,
      animTo: s.moveAnim?.to ?? null,
      tiles: s.players.map((p) => p.tile),
    })
  }
  store.subscribe(record)
  return { trace }
}

/** Where the pawn is drawn: mid-hop it is heading to moveAnim.to, else the authoritative tile. */
function pawnTile(store: BoardStoreShape, seat: number): number {
  const s = store.get()
  if (s.moveAnim && s.moveAnim.seat === seat) return s.moveAnim.to
  return s.players.find((p) => p.seat === seat)?.tile ?? -1
}

/** Mirrors GamePage's roll gate for the net store. */
function canRoll(store: BoardStoreShape, seat: number): boolean {
  const s = store.get()
  return s.current === seat && s.phase === 'idle' && s.eventTile == null && s.buyTile == null
}

function testClientStore(): void {
  console.log('\n— Part 1: client pawn/turn state machine (virtual clock) —')

  /* ---------- A) the exact production sequence ---------- */
  {
    const a = createNetBoardStore()
    const b = createNetBoardStore()
    const obsA = observe(a.store)
    const obsB = observe(b.store)

    // Game start: both pawns on GO, A to roll.
    a.onServerMsg(mkGame({ tiles: [0, 0], current: 0, phase: 'idle' }))
    b.onServerMsg(mkGame({ tiles: [0, 0], current: 0, phase: 'idle' }))
    check('start: pawns sit on GO and the board is idle', pawnTile(a.store, 0) === 0 && a.store.get().phase === 'idle')
    check('start: it is A who may roll', canRoll(a.store, 0) && !canRoll(a.store, 1))

    // A rolls 5 (dice 2+3). The roll broadcast carries the dice but NOT the move.
    const roll = mkGame({ tiles: [0, 0], current: 0, phase: 'rolling', dice: [2, 3], rollId: 1 })
    a.onServerMsg(roll)
    b.onServerMsg(roll)
    check('roll: A sees the dice come from the server', a.store.get().dice[0] === 2 && a.store.get().dice[1] === 3)
    check('roll: pawn still on GO while the dice settle', pawnTile(a.store, 0) === 0)
    check('roll: A may not roll twice', !canRoll(a.store, 0))

    // Dice settle (1150ms) → the hop to tile 5 begins, lasting 260 + 5*150 ms.
    advance(1150)
    check('move: hop targets the server tile 5', a.store.get().moveAnim?.to === 5, JSON.stringify(a.store.get().moveAnim))
    check('move: hop starts at GO', a.store.get().moveAnim?.from === 0)
    check('move: hop duration matches the server schedule', a.store.get().moveAnim?.dur === 1010, String(a.store.get().moveAnim?.dur))
    check('move: B is told A is moving', b.store.get().phase === 'moving')

    // A snapshot arriving mid-hop (another player's build/mortgage broadcast)
    // must never restart or cancel the animation — that reset the pawn to GO.
    const startBefore = a.store.get().moveAnim?.start
    const mid = mkGame({ tiles: [0, 0], current: 0, phase: 'rolling', dice: [2, 3], rollId: 1 })
    a.onServerMsg(mid)
    check('move: a mid-hop snapshot does not restart the hop', a.store.get().moveAnim?.start === startBefore, `${startBefore} -> ${a.store.get().moveAnim?.start}`)
    check('move: a mid-hop snapshot does not rewind the pawn to GO', pawnTile(a.store, 0) === 5)
    advance(500)

    // Landing broadcast: the server has applied the move and opened the buy prompt.
    const landing = mkGame({ tiles: [5, 0], current: 0, phase: 'buy', dice: [2, 3], rollId: 1, buyTile: 5 })
    a.onServerMsg(landing)
    b.onServerMsg(landing)
    check('landing: authoritative tile is 5', a.store.get().players[0]?.tile === 5)
    check('landing: the buy prompt belongs to A', a.store.get().buyTile === 5 && a.store.get().phase !== 'idle')
    check('landing: A cannot roll while the buy prompt is open', !canRoll(a.store, 0))

    // A buys. The server resolves the landing and passes the turn.
    advance(700)
    const afterBuy = mkGame({
      tiles: [5, 0],
      current: 1,
      phase: 'idle',
      dice: [2, 3],
      rollId: 1,
      owned: { 5: 'A' },
      turn: 2,
    })
    a.onServerMsg(afterBuy)
    advance(1)
    b.onServerMsg(afterBuy)

    check('buy: A’s pawn rests on the authoritative tile 5', pawnTile(a.store, 0) === 5 && a.store.get().moveAnim === null)
    check('buy: movement state is fully cleared', a.store.get().phase === 'idle' && a.store.get().moveAnim === null)
    check('buy: the property renders as owned by A', a.store.get().owned[5] === 'amber', JSON.stringify(a.store.get().owned))
    check('turn: B is now the current player', a.store.get().current === 1 && b.store.get().current === 1)
    check('turn: B is not shown "A is moving…"', b.store.get().phase === 'idle' && b.store.get().moveAnim === null)
    check('turn: B can roll', canRoll(b.store, 1))
    check('turn: A cannot act out of turn', !canRoll(a.store, 0))

    // The freeze was: a client holding "moving" while the current player moved on.
    const stuck = obsA.trace.concat(obsB.trace).filter((t) => t.phase === 'moving' && t.current !== 0)
    check('no client ever shows "moving" for a non-moving player', stuck.length === 0, JSON.stringify(stuck.slice(0, 2)))
    const neverMoving = obsA.trace.every((t) => t.phase !== 'moving' || t.animSeat === 0)
    check('moving phase always belongs to the animating seat', neverMoving)

    // B rolls too: the pawn of the OTHER player must animate on A's screen.
    const rollB = mkGame({
      tiles: [5, 0],
      current: 1,
      phase: 'rolling',
      dice: [4, 2],
      rollId: 2,
      owned: { 5: 'A' },
      turn: 2,
    })
    a.onServerMsg(rollB)
    advance(1150)
    check('opponent move: A animates B’s pawn', a.store.get().moveAnim?.seat === 1 && a.store.get().moveAnim?.to === 6, JSON.stringify(a.store.get().moveAnim))
    check('opponent move: A’s own pawn is untouched', pawnTile(a.store, 0) === 5)
    const landingB = mkGame({ tiles: [5, 6], current: 1, phase: 'idle', dice: [4, 2], rollId: 2, owned: { 5: 'A' }, turn: 3 })
    advance(1160)
    a.onServerMsg(landingB)
    check('opponent move: B’s pawn settles on tile 6', pawnTile(a.store, 1) === 6 && a.store.get().moveAnim === null)
  }

  /* ---------- B) refresh / reconnect during movement ---------- */
  {
    const fresh = createNetBoardStore()
    fresh.onServerMsg(mkGame({ tiles: [5, 0], current: 0, phase: 'buy', dice: [2, 3], rollId: 1, buyTile: 5 }))
    check('refresh mid-movement: pawn appears on the authoritative tile', pawnTile(fresh.store, 0) === 5)
    check('refresh mid-movement: no stale animation is replayed', fresh.store.get().moveAnim === null && fresh.store.get().phase === 'idle')
    check('refresh mid-movement: the pending buy prompt is preserved', fresh.store.get().buyTile === 5)
  }

  /* ---------- C) a roll we never saw (tile changed with no new rollId) ---------- */
  {
    const c = createNetBoardStore()
    c.onServerMsg(mkGame({ tiles: [0, 0], current: 0, phase: 'idle', rollId: 1 }))
    c.onServerMsg(mkGame({ tiles: [5, 0], current: 0, phase: 'buy', rollId: 1, buyTile: 5, dice: [2, 3] }))
    check('missed roll: a server-driven hop is synthesised', c.store.get().moveAnim?.from === 0 && c.store.get().moveAnim?.to === 5, JSON.stringify(c.store.get().moveAnim))
    advance(1010)
    c.onServerMsg(mkGame({ tiles: [5, 0], current: 1, phase: 'idle', rollId: 1, turn: 2 }))
    check('missed roll: the pawn still reaches the authoritative tile', pawnTile(c.store, 0) === 5 && c.store.get().moveAnim === null)
  }

  /* ---------- D) passing GO (wrap-around) ---------- */
  {
    const d = createNetBoardStore()
    d.onServerMsg(mkGame({ tiles: [38, 0], current: 0, phase: 'idle' }))
    d.onServerMsg(mkGame({ tiles: [38, 0], current: 0, phase: 'rolling', dice: [2, 3], rollId: 1 }))
    advance(1150)
    check('passing GO: the hop wraps 38 → 3', d.store.get().moveAnim?.from === 38 && d.store.get().moveAnim?.to === 3, JSON.stringify(d.store.get().moveAnim))
    check('passing GO: hop length covers the wrap', d.store.get().moveAnim?.dur === 260 + 5 * 150)
    advance(1010)
    d.onServerMsg(mkGame({ tiles: [3, 0], current: 1, phase: 'idle', dice: [2, 3], rollId: 1, turn: 2 }))
    check('passing GO: the pawn lands on tile 3', pawnTile(d.store, 0) === 3 && d.store.get().moveAnim === null)
  }

  /* ---------- E) redirected landing (Go To Jail teleports the pawn) ---------- */
  {
    const e = createNetBoardStore()
    e.onServerMsg(mkGame({ tiles: [0, 0], current: 0, phase: 'idle' }))
    e.onServerMsg(mkGame({ tiles: [0, 0], current: 0, phase: 'rolling', dice: [2, 3], rollId: 1 }))
    advance(1150)
    advance(1010)
    // Server applied the roll and immediately jailed the mover instead of tile 5.
    const jailed = mkGame({ tiles: [10, 0], current: 1, phase: 'idle', dice: [2, 3], rollId: 1, turn: 2 })
    e.onServerMsg(jailed)
    e.onServerMsg(jailed)
    check('go to jail: the hop is retargeted to the jail tile', pawnTile(e.store, 0) === 10, JSON.stringify(e.store.get().moveAnim))
    advance(2000)
    e.onServerMsg(jailed)
    check('go to jail: the pawn settles on tile 10 and the turn is B’s', pawnTile(e.store, 0) === 10 && e.store.get().moveAnim === null && e.store.get().current === 1)
  }

  /* ---------- F) card movement (no dice at all) ---------- */
  {
    const f = createNetBoardStore()
    f.onServerMsg(mkGame({ tiles: [7, 0], current: 0, phase: 'event', rollId: 1, eventTile: 7 }))
    f.onServerMsg(mkGame({ tiles: [24, 0], current: 0, phase: 'idle', rollId: 1 }))
    check('card move: the pawn is animated to the new tile', f.store.get().moveAnim?.from === 7 && f.store.get().moveAnim?.to === 24, JSON.stringify(f.store.get().moveAnim))
    advance(4000)
    f.onServerMsg(mkGame({ tiles: [24, 0], current: 1, phase: 'idle', rollId: 1, turn: 2 }))
    check('card move: the pawn rests on the card destination', pawnTile(f.store, 0) === 24 && f.store.get().moveAnim === null)
  }

  /* ---------- G) doubles grant a second hop ---------- */
  {
    const g = createNetBoardStore()
    g.onServerMsg(mkGame({ tiles: [0, 0], current: 0, phase: 'idle' }))
    g.onServerMsg(mkGame({ tiles: [0, 0], current: 0, phase: 'rolling', dice: [3, 3], rollId: 1, doubles: 1 }))
    advance(1150)
    check('doubles: first hop targets tile 6', g.store.get().moveAnim?.to === 6)
    g.onServerMsg(mkGame({ tiles: [6, 0], current: 0, phase: 'idle', dice: [3, 3], rollId: 1, doubles: 1 }))
    advance(1)
    g.onServerMsg(mkGame({ tiles: [6, 0], current: 0, phase: 'rolling', dice: [2, 2], rollId: 2, doubles: 2 }))
    advance(1150)
    check('doubles: the bonus roll hops again from tile 6', g.store.get().moveAnim?.from === 6 && g.store.get().moveAnim?.to === 10, JSON.stringify(g.store.get().moveAnim))
    advance(900)
    g.onServerMsg(mkGame({ tiles: [10, 0], current: 1, phase: 'idle', dice: [2, 2], rollId: 2, turn: 2 }))
    check('doubles: the pawn ends on tile 10 with no animation left', pawnTile(g.store, 0) === 10 && g.store.get().moveAnim === null)
  }

  /* ---------- H) jail roll that stays in jail (no pawn movement) ---------- */
  {
    const h = createNetBoardStore()
    h.onServerMsg(mkGame({ tiles: [10, 0], current: 0, phase: 'idle' }))
    // A failed jail attempt: rollId bumps but phase is 'jail'.
    h.onServerMsg(mkGame({ tiles: [10, 0], current: 0, phase: 'jail', dice: [5, 2], rollId: 1 }))
    check('jail: a failed jail roll does not animate the pawn', h.store.get().moveAnim === null && pawnTile(h.store, 0) === 10)
    check('jail: B cannot act while A is stuck in jail', !canRoll(h.store, 1))
    h.onServerMsg(mkGame({ tiles: [10, 0], current: 1, phase: 'idle', dice: [5, 2], rollId: 1, turn: 2 }))
    check('jail: the turn passes cleanly to B', h.store.get().phase === 'idle' && canRoll(h.store, 1))
  }
}

/* ============================================================================
 * Part 2 — real server, two independent clients
 * ========================================================================== */

class Peer {
  ws: WebSocket
  playerId = ''
  inbox: ServerMsg[] = []
  states: GameSnapshot[] = []

  constructor(
    public label: string,
    url: string,
  ) {
    this.ws = new WebSocket(url)
    this.ws.on('message', (data) => {
      const msg = JSON.parse(String(data)) as ServerMsg
      if (msg.t === 'you') this.playerId = msg.playerId
      if (msg.t === 'state' || msg.t === 'started') this.states.push(msg.game)
      this.inbox.push(msg)
    })
  }

  open(): Promise<void> {
    if (this.ws.readyState === WebSocket.OPEN) return Promise.resolve()
    return new Promise((res, rej) => {
      this.ws.once('open', res)
      this.ws.once('error', rej)
    })
  }

  send(msg: ClientMsg): void {
    this.ws.send(JSON.stringify(msg))
  }

  async waitFor(pred: (m: ServerMsg) => boolean, timeoutMs = 10_000): Promise<ServerMsg> {
    const hit = this.inbox.find(pred)
    if (hit) return hit
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const tick = (): void => {
        const found = this.inbox.find(pred)
        if (found) return resolve(found)
        if (Date.now() > deadline) return reject(new Error(`${this.label}: timeout`))
        setTimeout(tick, 50)
      }
      tick()
    })
  }

  async waitUntil(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (!pred()) {
      if (Date.now() > deadline) throw new Error(`${this.label}: waitUntil timeout`)
      await sleep(60)
    }
  }

  last(): GameSnapshot {
    return this.states[this.states.length - 1] as GameSnapshot
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function waitForPort(port: number, timeoutMs = 30_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const attempt = (): void => {
      const s = net.connect({ port, host: '127.0.0.1' })
      s.once('connect', () => {
        s.destroy()
        resolve()
      })
      s.once('error', () => {
        s.destroy()
        if (Date.now() - started > timeoutMs) reject(new Error(`port ${port} never opened`))
        else setTimeout(attempt, 250)
      })
    }
    attempt()
  })
}

function agreement(a: GameSnapshot, b: GameSnapshot): string[] {
  const problems: string[] = []
  if (a.current !== b.current) problems.push(`current ${a.current} vs ${b.current}`)
  if (a.phase !== b.phase) problems.push(`phase ${a.phase} vs ${b.phase}`)
  if (a.buyTile !== b.buyTile) problems.push(`buyTile ${a.buyTile} vs ${b.buyTile}`)
  if (a.eventTile !== b.eventTile) problems.push(`eventTile ${a.eventTile} vs ${b.eventTile}`)
  if (Boolean(a.debt) !== Boolean(b.debt)) problems.push('debt differs')
  if (Boolean(a.auction) !== Boolean(b.auction)) problems.push('auction differs')
  for (let i = 0; i < Math.max(a.players.length, b.players.length); i++) {
    const pa = a.players[i]
    const pb = b.players[i]
    if (!pa || !pb) {
      problems.push(`roster size differs`)
      break
    }
    if (pa.tile !== pb.tile) problems.push(`${pa.name} tile ${pa.tile} vs ${pb.tile}`)
    if (pa.cash !== pb.cash) problems.push(`${pa.name} cash ${pa.cash} vs ${pb.cash}`)
    if (pa.seat !== pb.seat) problems.push(`${pa.name} seat differs`)
  }
  const oa = Object.entries(a.owned).sort().join(',')
  const ob = Object.entries(b.owned).sort().join(',')
  if (oa !== ob) problems.push(`ownership ${oa} vs ${ob}`)
  return problems
}

async function part2(): Promise<void> {
  console.log('\n— Part 2: real server, two clients, pinned dice —')

  const port = 20000 + Math.floor(Math.random() * 20000)
  const serverOut = { text: '' }
  const server = spawn('npx', ['tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port), BQ_FORCE_DICE: '2,3' },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  server.stdout.on('data', (d: Buffer) => (serverOut.text += d.toString()))
  server.stderr.on('data', (d: Buffer) => (serverOut.text += d.toString()))

  const kill = (): void => {
    if (process.platform === 'win32' && server.pid) {
      try {
        spawn('taskkill', ['/PID', String(server.pid), '/T', '/F'], { stdio: 'ignore' })
      } catch {
        /* already gone */
      }
    } else {
      server.kill('SIGKILL')
    }
  }

  try {
    await waitForPort(port)
    check('server boots for the movement test', true)

    const url = `ws://127.0.0.1:${port}/ws`
    const alice = new Peer('alice', url)
    const bob = new Peer('bob', url)
    await alice.open()
    await bob.open()
    alice.send({ t: 'hello', name: 'Alice' })
    bob.send({ t: 'hello', name: 'Bob' })
    await alice.waitFor((m) => m.t === 'you')
    await bob.waitFor((m) => m.t === 'you')

    alice.send({ t: 'create' })
    const created = await alice.waitFor((m) => m.t === 'created')
    const code = created.t === 'created' ? created.code : ''
    bob.send({ t: 'join', code })
    await bob.waitFor((m) => m.t === 'joined')
    bob.send({ t: 'ready', ready: true })
    await alice.waitUntil(() => {
      const r = alice.inbox.filter((m) => m.t === 'room')
      const last = r[r.length - 1]
      return Boolean(last && last.t === 'room' && last.room.players.length === 2 && last.room.players.every((p) => p.ready))
    })
    alice.send({ t: 'start' })
    await alice.waitFor((m) => m.t === 'started')
    await bob.waitFor((m) => m.t === 'started')

    const aliceSeat = alice.last().players.findIndex((p) => p.id === alice.playerId)
    const bobSeat = bob.last().players.findIndex((p) => p.id === bob.playerId)
    check('two clients are seated in the same game', aliceSeat === 0 && bobSeat === 1)

    /* ---- A rolls the pinned 5 ---- */
    alice.send({ t: 'roll' })
    const rollMsg = await alice.waitFor((m) => m.t === 'state' && m.game.phase === 'rolling')
    const rollGame = rollMsg.t === 'state' ? rollMsg.game : null
    check('roll: server broadcasts phase "rolling" with the pinned dice', Boolean(rollGame && rollGame.dice[0] === 2 && rollGame.dice[1] === 3))
    check('roll: the pawn has NOT moved yet in the roll broadcast', rollGame?.players[aliceSeat]?.tile === 0)
    check('roll: the mover is still the current player', rollGame?.current === aliceSeat)

    /* ---- landing: tile 5 + buy prompt ---- */
    await alice.waitUntil(() => alice.last().phase === 'buy')
    await bob.waitUntil(() => bob.last().phase === 'buy')
    const landA = alice.last()
    const landB = bob.last()
    check('landing: A.position === 5 on the authoritative server', landA.players[aliceSeat]?.tile === 5, String(landA.players[aliceSeat]?.tile))
    check('landing: both clients agree on the landing', agreement(landA, landB).length === 0, agreement(landA, landB).join('; '))
    check('landing: the buy prompt is open on tile 5', landA.buyTile === 5 && landB.buyTile === 5)
    check('landing: B is told it is NOT their turn to act', landB.players[landB.current]?.id === alice.playerId)

    /* ---- A buys ---- */
    alice.send({ t: 'buy', accept: true })
    await alice.waitUntil(() => alice.last().current === bobSeat && alice.last().phase === 'idle')
    await bob.waitUntil(() => bob.last().current === bobSeat && bob.last().phase === 'idle')
    const buyA = alice.last()
    const buyB = bob.last()
    check('buy: A owns tile 5', buyA.owned['5'] === alice.playerId)
    check('buy: A is not bankrupt and not moving', !buyA.players[aliceSeat]?.bankrupt)
    check('buy: the pending action is fully cleared', buyA.buyTile === null && buyA.eventTile === null && !buyA.debt && !buyA.auction)
    check('buy: B is the current player', buyB.current === bobSeat && buyB.players[buyB.current]?.id === bob.playerId)
    check('buy: movement state is NOT in progress', buyA.phase !== 'moving' && buyB.phase !== 'moving')
    check('buy: both clients agree after the purchase', agreement(buyA, buyB).length === 0, agreement(buyA, buyB).join('; '))

    /* ---- the freeze regression: no snapshot may leave B waiting on A ---- */
    const everyState = alice.states.concat(bob.states)
    const movingSnaps = everyState.filter((s) => s.phase === 'moving')
    check('no snapshot ever reports phase "moving" (the freeze state)', movingSnaps.length === 0, `${movingSnaps.length} found`)
    const stuck = everyState.filter((s) => s.players[s.current]?.id === bob.playerId && s.buyTile !== null)
    check('B is never made current while an action is still pending', stuck.length === 0)

    /* ---- B can actually take their turn ---- */
    bob.send({ t: 'roll' })
    await bob.waitUntil(() => bob.last().phase === 'rolling' && bob.last().current === bobSeat, 10_000)
    check('B can roll — the turn is not frozen', bob.last().phase === 'rolling' && bob.last().current === bobSeat)
    await alice.waitUntil(() => alice.last().phase === 'rolling' && alice.last().current === bobSeat, 10_000)
    check('A sees B’s roll in real time', alice.last().rollId === bob.last().rollId)
    check('A’s own pawn is unmoved by B’s roll', alice.last().players[aliceSeat]?.tile === 5)

    await bob.waitUntil(() => bob.last().phase !== 'rolling', 10_000)
    check('B’s move resolves deterministically', bob.last().phase !== 'moving')
    check('clients agree after B’s move', agreement(alice.last(), bob.last()).length === 0, agreement(alice.last(), bob.last()).join('; '))

    check('server stayed up through the whole flow', !/uncaughtException|FATAL/i.test(serverOut.text))

    alice.ws.close()
    bob.ws.close()
    await sleep(200)
  } finally {
    kill()
  }
}

/* ================================== main ================================== */

async function main(): Promise<void> {
  installVirtualClock()
  testClientStore()
  Date.now = realDateNow
  await part2()

  console.log(`\nmovement: ${passed} passed, ${failed} failed`)
  if (failed > 0) {
    failures.forEach((f) => console.log(`  - ${f}`))
  }
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('movement test crashed:', e)
  process.exit(1)
})
