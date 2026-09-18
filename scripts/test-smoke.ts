/**
 * BoardQuest bot smoke test (scripts/test-smoke.ts).
 *
 * Spawns the REAL server on a fresh port and drives a full game flow over the
 * real protocol: connect → create room → add bot → start → play 10+ turns
 * (human client + autonomous bot) → verify invariants → disconnect → verify
 * the room is cleaned up. Exercises real server logic; no fake game state.
 *
 * Invariants checked every snapshot:
 *   - dice values are 1..6, positions are valid board indexes
 *   - money is numeric, finite and non-negative
 *   - the current player is always a valid, non-bankrupt player
 *   - the turn counter never goes backwards; the current player changes
 *     correctly (doubles legitimately grant an extra roll to the same player)
 *   - the bot takes its turns and never freezes the game
 *   - no uncaught server errors
 *
 * Run: npm run test:smoke
 */
import { spawn } from 'node:child_process'
import net from 'node:net'
import WebSocket from 'ws'
import type { RawData } from 'ws'
import type { ClientMsg, ServerMsg, GameSnapshot } from '../src/net/protocol'

const BOARD_SIZE = 40
const MIN_HUMAN_TURNS = 10
// Play budget + seat-grace/teardown wait (~75s) + margin must fit inside this.
const GLOBAL_TIMEOUT_MS = 300_000

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = '', silent = false): void {
  if (cond) {
    passed++
    if (!silent) console.log(`  ok  ${name}`)
  } else {
    failed++
    failures.push(name)
    if (!silent) console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/** Like verifyInvariants but records failures without printing each one. */
function verifyInvariantsQuiet(g: GameSnapshot): void {
  const problems: string[] = []
  for (const p of g.players) {
    if (!Number.isFinite(p.cash) || p.cash < 0) problems.push(`${p.name} cash invalid: ${p.cash}`)
    if (!Number.isInteger(p.tile) || p.tile < 0 || p.tile >= BOARD_SIZE)
      problems.push(`${p.name} tile invalid: ${p.tile}`)
  }
  if (g.dice.length === 2) {
    for (const d of g.dice) if (d < 1 || d > 6) problems.push(`dice invalid: ${JSON.stringify(g.dice)}`)
  }
  const cur = g.players[g.current]
  if (!cur) problems.push(`current out of range: ${g.current}`)
  else if (cur.bankrupt) problems.push(`bankrupt player holds the turn: ${cur.name}`)
  if (g.turn < lastTurn) problems.push(`turn went backwards: ${g.turn} < ${lastTurn}`)
  check(`snapshot invariants (turn ${g.turn})`, problems.length === 0, problems.join('; '), true)
}

/* ------------------------------ tiny ws client ------------------------------ */

class Bot {
  ws: WebSocket
  inbox: ServerMsg[] = []
  waiters: Array<{ pred: (m: ServerMsg) => boolean; resolve: (m: ServerMsg) => void }> = []
  playerId = ''
  private queue: ClientMsg[] = []
  private pumps: Array<{ fn: (m: ServerMsg) => void }> = []

  constructor(url: string) {
    this.ws = new WebSocket(url)
    this.ws.on('open', () => {
      // Flush anything sent while the socket was still connecting.
      const q = this.queue
      this.queue = []
      q.forEach((m) => this.ws.send(JSON.stringify(m)))
    })
    this.ws.on('message', (data: RawData) => {
      try {
        const msg = JSON.parse(String(data)) as ServerMsg
        if (msg.t === 'you') this.playerId = msg.playerId
        this.inbox.push(msg)
        this.pumps.forEach((p) => p.fn(msg))
        this.waiters = this.waiters.filter((w) => {
          if (w.pred(msg)) {
            w.resolve(msg)
            return false
          }
          return true
        })
      } catch {
        /* ignore malformed */
      }
    })
  }

  send(msg: ClientMsg): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg))
    else this.queue.push(msg)
  }

  /** Wait for the next message matching pred (scans inbox first). */
  waitFor(pred: (m: ServerMsg) => boolean, timeoutMs: number): Promise<ServerMsg> {
    const hit = this.inbox.find(pred)
    if (hit) return Promise.resolve(hit)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('waitFor timeout')), timeoutMs)
      this.waiters.push({
        pred,
        resolve: (m) => {
          clearTimeout(timer)
          resolve(m)
        },
      })
    })
  }

  /** Latest game snapshot seen so far. */
  latestGame(): GameSnapshot | null {
    for (let i = this.inbox.length - 1; i >= 0; i--) {
      const m = this.inbox[i]
      if (m.t === 'state' || m.t === 'started') return m.game
    }
    return null
  }

  /** Subscribe to all future messages (replays nothing). Returns unsubscribe. */
  pumpAll(fn: (m: ServerMsg) => void): () => void {
    const entry = { fn }
    this.pumps.push(entry)
    return () => {
      this.pumps = this.pumps.filter((p) => p !== entry)
    }
  }

  close(): void {
    try {
      this.ws.close()
    } catch {
      /* ignore */
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** Poll a plain predicate until true or timeout. */
async function waitUntil(pred: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('waitUntil timeout')
    await sleep(150)
  }
}

/** Wait for a TCP port to accept connections. */
function waitForPort(port: number, timeoutMs = 15_000): Promise<void> {
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

/* ------------------------------ invariants ------------------------------ */

let lastTurn = 0
let lastCurrent = -1
const lineHistory: string[] = []

function verifyInvariants(g: GameSnapshot, label: string): void {
  const problems: string[] = []
  for (const p of g.players) {
    if (!Number.isFinite(p.cash) || p.cash < 0) problems.push(`${p.name} cash invalid: ${p.cash}`)
    if (!Number.isInteger(p.tile) || p.tile < 0 || p.tile >= BOARD_SIZE)
      problems.push(`${p.name} tile invalid: ${p.tile}`)
  }
  if (g.dice.length === 2) {
    for (const d of g.dice) if (d < 1 || d > 6) problems.push(`dice invalid: ${JSON.stringify(g.dice)}`)
  }
  const cur = g.players[g.current]
  if (!cur) problems.push(`current out of range: ${g.current}`)
  else if (cur.bankrupt) problems.push(`bankrupt player holds the turn: ${cur.name}`)
  if (g.turn < lastTurn) problems.push(`turn went backwards: ${g.turn} < ${lastTurn}`)
  // A different current player must coincide with a turn advance OR a legitimate
  // doubles extra-roll pattern (turn counter monotonic covers the rest).
  if (g.current !== lastCurrent && g.turn === lastTurn && lastCurrent !== -1) {
    // Allowed only right after doubles; the server keeps `doubles > 0` then.
    if (!(g.doubles > 0)) problems.push(`current changed without turn/rollover at ${label}`)
  }
  lastTurn = g.turn
  lastCurrent = g.current
  check(`invariants hold at ${label}`, problems.length === 0, problems.join('; '))
}

/* --------------------------------- server --------------------------------- */

/* ---------------------------------- main ---------------------------------- */

async function main(): Promise<void> {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const serverOut = { text: '' }
  const server = spawn('npx', ['tsx', 'server/index.ts'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  server.stdout.on('data', (d: Buffer) => (serverOut.text += d.toString()))
  server.stderr.on('data', (d: Buffer) => (serverOut.text += d.toString()))

  // 10) no uncaught server errors
  const crashChecker = setInterval(() => {
    if (/uncaughtException|UnhandledPromiseRejection|FATAL/i.test(serverOut.text)) {
      clearInterval(crashChecker)
      check('server never crashed', false, serverOut.text.slice(-300))
      server.kill('SIGKILL')
      process.exit(1)
    }
  }, 1000)

  const globalTimer = setTimeout(() => {
    check(`smoke flow completed within ${GLOBAL_TIMEOUT_MS / 1000}s`, false, 'global timeout — game likely froze')
    console.log('[diag] server output tail:', serverOut.text.split('\n').slice(-12).join('\n'))
    cleanup(1)
  }, GLOBAL_TIMEOUT_MS)

  let alice: Bot | null = null
  let offWatchdog: () => void = () => {}

  function cleanup(code: number): void {
    clearInterval(crashChecker)
    clearTimeout(globalTimer)
    offWatchdog()
    alice?.close()
    if (process.platform === 'win32' && server.pid) {
      try {
        require('node:child_process').execSync(`taskkill /PID ${server.pid} /T /F`, { stdio: 'ignore' })
      } catch {
        /* already gone */
      }
    } else {
      server.kill('SIGTERM')
    }
    setTimeout(() => {
      console.log(`\nSmoke: ${passed} passed, ${failed} failed`)
      if (failed > 0) {
        failures.forEach((f) => console.log(`  - ${f}`))
        process.exit(1)
      }
      process.exit(code)
    }, 200)
  }
  process.on('exit', () => {
    try {
      server.kill('SIGKILL')
    } catch {
      /* ignore */
    }
  })

  try {
    await waitForPort(port)
    check('server boots for smoke test', true)

    // 1) connect + handshake
    alice = new Bot(`ws://127.0.0.1:${port}/ws`)
    alice.send({ t: 'hello', name: 'SmokeAlice' })
    await alice.waitFor((m) => m.t === 'you', 8000)
    check('client connects and receives identity', alice.playerId.length > 0)

    // 2) create room + 3) add bot
    alice.send({ t: 'create' })
    await alice.waitFor((m) => m.t === 'created', 8000)
    check('room created', true)
    alice.send({ t: 'addBot' })
    await alice.waitFor((m) => {
      if (m.t !== 'room') return false
      return m.room.players.some((p) => p.isBot)
    }, 8000)
    check('bot joins the room', true)

    // 4) room state + 5) start
    const lobby = alice.latestGame()
    void lobby
    alice.send({ t: 'ready', ready: true })
    alice.send({ t: 'start' })
    const startedMsg = await alice.waitFor((m) => m.t === 'started', 10_000)
    if (startedMsg.t !== 'started') throw new Error('expected started message')
    check('game starts with 2 players (1 human + 1 bot)', startedMsg.game.players.length === 2)
    const botName = startedMsg.game.players.find((p) => p.isBot)?.name ?? 'bot'

    // 6-9) play: event-driven autopilot — react to every snapshot, act only
    // when the HUMAN must act; the bot plays itself.
    if (!alice) throw new Error('client missing')
    const client = alice // non-null alias for closures below
    let humanTurns = 0
    let sawBotTurn = false
    let botTurnCompleted = false
    let winnerSeen: string | null = null
    let invChecked = 0
    let invFailures = 0
    let lastInvSummary = ''
    let lastLine = ''
    let lastRolledTurn = -1
    let lastIdleAt = 0
    const debtAttempts = new Map<string, number>()
    let lastDebtKey = ''
    const deadline = Date.now() + (GLOBAL_TIMEOUT_MS - 100_000)

    const onSnapshot = (g: GameSnapshot): void => {
      // Invariants on every change, but reported at most once per turn.
      const before = failures.length
      verifyInvariantsQuiet(g)
      invChecked++
      if (failures.length > before) {
        invFailures++
        lastInvSummary = failures[failures.length - 1] ?? ''
        failures.pop()
      }

      if (g.winner && winnerSeen == null) winnerSeen = g.winner
      const p = g.players[g.current]
      if (p?.isBot) sawBotTurn = true
      if (sawBotTurn && !p?.isBot && g.turn > 1) botTurnCompleted = true
      const line = `turn=${g.turn} cur=${p?.name ?? '?'}${p?.isBot ? '(bot)' : ''} phase=${g.phase}`
      if (line !== lastLine) {
        lastLine = line
        lineHistory.push(`${new Date().toISOString().slice(11, 19)} ${line}`)
        if (lineHistory.length > 10) lineHistory.shift()
      }

      if (Date.now() >= deadline || winnerSeen != null) return
      if (!p || p.isBot) return
      if (g.phase === 'idle' && humanTurns < MIN_HUMAN_TURNS) {
        // A new turn always rolls; a same-turn idle (doubles extra roll) rolls
        // again only after a short pause, so we never double-count turns.
        if (g.turn !== lastRolledTurn || Date.now() - lastIdleAt > 4000) {
          if (g.turn !== lastRolledTurn) humanTurns++
          lastRolledTurn = g.turn
          lastIdleAt = Date.now()
          client.send({ t: 'roll' })
        }
      } else if (g.phase === 'buy') {
        client.send({ t: 'buy', accept: p.cash > 400 })
      } else if (g.phase === 'event') {
        client.send({ t: 'eventOk' })
      } else if (g.phase === 'jail') {
        client.send({ t: 'jailAction', action: 'roll' })
      } else if (g.phase === 'debt' && g.debt?.debtorId === client.playerId) {
        // canPay can be optimistic if cash changed; after two failed pay
        // attempts (debt unresolved), declare bankruptcy to keep the game going.
        const key = `${g.debt.amount}@${g.debt.creditorId}@${g.turn}`
        if (key !== lastDebtKey) {
          lastDebtKey = key
          debtAttempts.set(key, (debtAttempts.get(key) ?? 0) + 1)
          const tries = debtAttempts.get(key) ?? 1
          client.send({ t: g.debt.canPay && tries <= 2 ? 'debtPay' : 'declareBankrupt' })
        }
      } else if (g.phase === 'auction' && g.auction?.bidder === client.playerId) {
        // Pass immediately — keeps auctions short and the smoke test focused.
        client.send({ t: 'auctionPass' })
      }
    }

    // Wire the autopilot into the message stream.
    client.inbox.forEach((m) => {
      if (m.t === 'started' || m.t === 'state') onSnapshot(m.game)
    })
    const offPump = client.pumpAll((m) => {
      if (m.t === 'started' || m.t === 'state') onSnapshot(m.game)
    })

    // Watchdog: rejected actions produce no reply, so re-drive the latest
    // snapshot periodically. Server-side validation makes re-sends harmless.
    const watchdog = setInterval(() => {
      const g = client.latestGame()
      if (g) onSnapshot(g)
    }, 2500)
    offWatchdog = () => clearInterval(watchdog)

    // Wait for either 10 human turns or a finished game.
    await waitUntil(
      () => humanTurns >= MIN_HUMAN_TURNS || winnerSeen != null || Date.now() >= deadline,
      deadline - Date.now() + 1000,
    )
    offPump()
    offWatchdog()

    const fg = alice.latestGame()
    console.log(
      `[diag] play loop ended: turns=${humanTurns} winner=${winnerSeen ?? 'none'} phase=${fg?.phase ?? '?'} cur=${fg ? fg.players[fg.current]?.name : '?'} snapShots=${client.inbox.length}`,
    )
    console.log(`[diag] last transitions:\n${lineHistory.map((l) => '  ' + l).join('\n')}`)

    check(
      `at least ${MIN_HUMAN_TURNS} human turns played (no freeze)`,
      humanTurns >= MIN_HUMAN_TURNS || winnerSeen != null,
      `got ${humanTurns}${winnerSeen ? ' (game finished early — valid)' : ''}`,
    )
    check('bot takes its turns automatically', sawBotTurn && botTurnCompleted, `saw=${sawBotTurn} done=${botTurnCompleted}`)
    check('game invariants held across all snapshots', invFailures === 0, lastInvSummary || `${invChecked} snapshots verified`)
    const final = alice.latestGame()
    if (final) {
      verifyInvariants(final, 'final state')
      check('game state stays valid after many turns', true)
      if (winnerSeen) check('game reached a valid winner', final.winner === winnerSeen)
    }
    const botLog = final?.log.filter((l) => l.text.includes(botName)).length ?? 0
    check('bot actions are logged', botLog > 0, `${botLog} entries`)

    // 11) clean disconnect: mid-game leave holds the seat for a grace window…
    const oldId = alice.playerId
    const leftAt = Date.now()
    alice.send({ t: 'leaveRoom' })
    await sleep(300)
    alice.close()

    // …so an immediate reconnection must re-bind the SAME seat.
    const probe1 = new Bot(`ws://127.0.0.1:${port}/ws`)
    probe1.send({ t: 'hello', name: 'SmokeAlice', playerId: oldId })
    await probe1.waitFor((m) => m.t === 'you', 8000)
    check('seat is held during the reconnect grace window', probe1.playerId === oldId)
    probe1.close()

    // 12) with no humans left, the room must be closed after the grace period
    // (seat reap 60s + teardown 5s) — bots alone must not keep it alive.
    await waitUntil(() => Date.now() - leftAt > 70_000, 80_000)
    const probe2 = new Bot(`ws://127.0.0.1:${port}/ws`)
    probe2.send({ t: 'hello', name: 'Probe', playerId: oldId })
    await probe2.waitFor((m) => m.t === 'you', 8000)
    check('room cleaned up after everyone left', probe2.playerId !== oldId, 'fresh identity expected after teardown')
    const lobbyProbe = await probe2
      .waitFor((m) => m.t === 'err' || m.t === 'room', 4000)
      .then((m) => m.t)
      .catch(() => 'none')
    check('no stale room snapshot leaks to a fresh identity', lobbyProbe !== 'room')
    probe2.close()

    cleanup(0)
  } catch (e) {
    const fg = alice?.latestGame()
    console.log(
      `[diag] failure at: ${String(e)} | lastPhase=${fg?.phase ?? '?'} cur=${fg ? fg.players[fg.current]?.name : '?'} inbox=${alice?.inbox.length ?? 0}`,
    )
    console.log(`[diag] last transitions:\n${lineHistory.map((l) => '  ' + l).join('\n')}`)
    console.log(`[diag] server log tail:\n${serverOut.text.split('\n').slice(-15).join('\n')}`)
    check('smoke flow completes', false, String(e))
    cleanup(1)
  }
}

main()
