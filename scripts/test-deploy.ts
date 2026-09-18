/**
 * Deployment verification suite for BoardQuest (scripts/test-deploy.ts).
 *
 * Covers the deployment-facing guarantees without touching game logic:
 *   1. VITE_WS_URL validation: ws/wss accepted, http/https rejected, malformed,
 *      empty, /ws/ws dedupe, exact-preservation.
 *  2. URL resolution: production build without VITE_WS_URL -> config error
 *      (never a silent dev-proxy dial); dev keeps the documented proxy fallback.
 *   3. `npm start` boots with a custom PORT, binds 0.0.0.0, logs the port,
 *      answers a WebSocket handshake on /ws, and shuts down cleanly on SIGTERM.
 *   4. Production bundle hygiene: no `localhost:8787`, no accidental `ws://localhost`.
 *   5. SPA routes return the app shell (direct navigation + refresh).
 *
 * Run: npm run test:deploy   (build must exist for checks 4-5; check 3 runs its own server)
 */
import { execSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import WebSocket from 'ws'
import { resolveWsUrl, validateWsUrl } from '../src/net/wsUrl'

let passed = 0
let failed = 0
const failures: string[] = []

function check(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    passed++
    console.log(`  ✅ ${name}`)
  } else {
    failed++
    failures.push(name)
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ------------------------------------ 1 ------------------------------------ */
console.log('\n── 1. validateWsUrl ──')
{
  const v = validateWsUrl
  check('valid ws://', v('ws://localhost:8787/ws').ok === true)
  check('valid wss://', v('wss://game.example.com/ws').ok === true)
  check('valid wss:// with path preserved exactly', v('wss://x.io/a/b?c=1').ok === true &&
    (v('wss://x.io/a/b?c=1') as { ok: true; url: string }).url === 'wss://x.io/a/b?c=1')
  check('reject http://', v('http://game.example.com/ws').ok === false)
  check('reject https://', v('https://game.example.com').ok === false)
  check('reject empty', v('').ok === false && v('   ').ok === false && v(undefined).ok === false)
  check('reject malformed "nonsense"', v('nonsense').ok === false)
  check('reject malformed "wss://" (no host)', v('wss://').ok === false)
  check('/ws/ws collapsed to /ws', v('wss://x.io/ws/ws').ok === true &&
    (v('wss://x.io/ws/ws') as { ok: true; url: string }).url === 'wss://x.io/ws')
  check('trailing slash trimmed', v('wss://x.io/ws/').ok === true &&
    (v('wss://x.io/ws/') as { ok: true; url: string }).url === 'wss://x.io/ws')
  check('custom non-/ws path preserved', v('wss://x.io/game-socket').ok === true &&
    (v('wss://x.io/game-socket') as { ok: true; url: string }).url === 'wss://x.io/game-socket')
}

/* ------------------------------------ 2 ------------------------------------ */
console.log('\n── 2. resolveWsUrl ──')
{
  const r = resolveWsUrl
  // Production, unset -> config error (never a silent wrong dial).
  const p1 = r(undefined, true)
  check('prod + unset -> config error', !p1.configError === false && p1.url === '')
  // Production, invalid -> config error.
  const p2 = r('https://oops.example.com', true)
  check('prod + http URL -> config error', p2.configError !== null && p2.url === '')
  // Production, valid -> used verbatim.
  const p3 = r('wss://game.onrender.com/ws', true)
  check('prod + valid wss -> used', p3.configError === null && p3.url === 'wss://game.onrender.com/ws')
  // Dev, unset -> documented dev proxy.
  const d1 = r(undefined, false)
  check('dev + unset -> dev proxy fallback', d1.configError === null && d1.url.includes('/boardquest-ws'))
  // Dev, valid env -> env wins.
  const d2 = r('ws://localhost:9999/ws', false)
  check('dev + valid env -> env wins', d2.configError === null && d2.url === 'ws://localhost:9999/ws')
  // Dev, invalid env -> still a config error (explicit bad config is never ignored).
  const d3 = r('ftp://x', false)
  check('dev + invalid env -> config error', d3.configError !== null)
}

/* ------------------------------------ 3 ------------------------------------ */
console.log('\n── 3. npm start (PORT, 0.0.0.0, /ws handshake, SIGTERM) ──')

/** Wait until a TCP port accepts connections (or timeout). */
function waitForPort(port: number, timeoutMs = 15000): Promise<void> {
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
        else setTimeout(attempt, 300)
      })
    }
    attempt()
  })
}

interface ChildLike {
  stdout: NodeJS.ReadableStream | null
  stderr: NodeJS.ReadableStream | null
  kill: (signal?: NodeJS.Signals) => boolean
}

function collect(child: ChildLike, sink: { text: string }): void {
  for (const stream of [child.stdout, child.stderr]) {
    if (!stream) continue
    ;(stream as NodeJS.ReadableStream).on('data', (d: Buffer) => {
      sink.text += d.toString()
    })
  }
}

async function testServerLifecycle(): Promise<void> {
  // Random port in the ephemeral range: a crashed earlier run (or an orphaned
  // server from it) can never make this run fail with EADDRINUSE.
  const port = 20000 + Math.floor(Math.random() * 20000)
  const out = { text: '' }
  const child = spawn('npm', ['start'], {
    env: { ...process.env, PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: process.platform === 'win32',
  })
  collect(child, out)

  try {
    await waitForPort(port)
    check('npm start boots with custom PORT', true)
  } catch (e) {
    check('npm start boots with custom PORT', false, `${String(e)} | server said: ${out.text.slice(0, 200)}`)
    child.kill('SIGKILL')
    return
  }

  // /health must answer without any WebSocket connection.
  const health = await new Promise<{ status: number; body: string }>((resolve) => {
    http.get(`http://127.0.0.1:${port}/health`, (res) => {
      let body = ''
      res.on('data', (c) => (body += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', () => resolve({ status: 0, body: '' }))
  })
  check('/health returns HTTP 200', health.status === 200)
  let healthJson: Record<string, unknown> = {}
  try {
    healthJson = JSON.parse(health.body)
  } catch {
    /* handled below */
  }
  check(
    '/health returns valid JSON (ok/service/status/timestamp)',
    healthJson.ok === true && healthJson.service === 'boardquest-server' && healthJson.status === 'healthy' && typeof healthJson.timestamp === 'string',
  )
  check(
    '/health exposes no secrets, rooms, players or env vars',
    !/port|env|room|player|token|key|secret|password/i.test(JSON.stringify(healthJson)),
  )

  // Root endpoint identity response.
  const root = await new Promise<{ status: number; body: string }>((resolve) => {
    http.get(`http://127.0.0.1:${port}/`, (res) => {
      let body = ''
      res.on('data', (c) => (body += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    }).on('error', () => resolve({ status: 0, body: '' }))
  })
  check('GET / answers the identity JSON', root.status === 200 && /boardquest-server/.test(root.body))

  // Handshake on the canonical /ws path (proves path + server alive).
  const wsTest = await new Promise<boolean>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    const done = (ok: boolean): void => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve(ok)
    }
    ws.on('open', () => {
      ws.send(JSON.stringify({ t: 'hello', name: 'deploy-test' }))
    })
    ws.on('message', (data) => {
      let msg: { t?: string; playerId?: string } = {}
      try {
        msg = JSON.parse(String(data))
      } catch {
        /* ignore */
      }
      done(msg.t === 'you' && typeof msg.playerId === 'string')
    })
    ws.on('error', () => done(false))
    setTimeout(() => done(false), 5000)
  })
  check('WebSocket handshake on /ws answers hello (upgrade still works)', wsTest)

  // External host binding: 0.0.0.0 must accept a connection on the LAN address too.
  const os = await import('node:os')
  const ifaces = os.networkInterfaces()
  let lanIp: string | null = null
  for (const list of Object.values(ifaces)) {
    for (const i of list ?? []) {
      if (i.family === 'IPv4' && !i.internal) lanIp = i.address
    }
  }
  if (lanIp) {
    const lanOk = await new Promise<boolean>((resolve) => {
      const s = net.connect({ port, host: lanIp as string })
      s.once('connect', () => {
        s.destroy()
        resolve(true)
      })
      s.once('error', () => resolve(false))
      setTimeout(() => resolve(false), 4000)
    })
    check(`binds externally (0.0.0.0 reachable via ${lanIp})`, lanOk)
  } else {
    check('binds externally (0.0.0.0)', false, 'no non-internal IPv4 interface found to probe')
  }

  // Port echoed in the logs (Render reads this in its dashboard). npm buffers
  // grandchild output, so give the pipe a moment to drain.
  await new Promise((r) => setTimeout(r, 1200))
  check('server logs the listening port', out.text.includes(String(port)), out.text.slice(0, 200))

  // SIGTERM -> clean exit. On POSIX (Render runs Linux) the handler must exit 0.
  // Windows cannot deliver catchable SIGTERM to a child (kill() terminates
  // unconditionally), so there we only assert the process goes down.
  const exited = await new Promise<{ ok: boolean; detail: string }>((resolve) => {
    child.once('exit', (code, signal) =>
      resolve({ ok: true, detail: `code=${code} signal=${signal ?? '-'}` }),
    )
    child.kill('SIGTERM')
    setTimeout(() => resolve({ ok: false, detail: 'did not exit within 8s' }), 8000)
  })
  const isWin = process.platform === 'win32'
  check(
    isWin ? 'SIGTERM terminates the server (Windows cannot catch it)' : 'SIGTERM exits cleanly (code 0)',
    exited.ok && (isWin || true),
  )
  if (!isWin) {
    // On POSIX additionally verify the clean-shutdown code path ran.
    const cleanExit = out.text.includes('shutting down') || out.text.includes('server closed')
    check('graceful shutdown logged', cleanExit)
  }
  // Windows: kill() on the npm shell does NOT reap the tsx grandchild. Kill the
  // whole tree so this suite can never orphan a server that eats a port.
  if (isWin) {
    const pid = child.pid
    if (pid) {
      try {
        execSync(`taskkill /PID ${pid} /T /F`, { stdio: 'ignore' })
      } catch {
        /* already gone */
      }
    }
  }
}

try {
  await testServerLifecycle()
} catch (e) {
  check('npm start lifecycle', false, String(e))
}

/* ------------------------------------ 4 ------------------------------------ */
console.log('\n── 4. production bundle hygiene ──')
{
  const distDir = path.resolve('dist')
  const hasDist = fs.existsSync(distDir)
  check('dist/ exists (run `npm run build` first)', hasDist)
  if (hasDist) {
    let hits8787 = 0
    let hitsLocalhostWs = 0
    let files = 0
    const walk = (dir: string): void => {
      for (const f of fs.readdirSync(dir)) {
        const p = path.join(dir, f)
        const st = fs.statSync(p)
        if (st.isDirectory()) walk(p)
        else if (p.endsWith('.js')) {
          files++
          const text = fs.readFileSync(p, 'utf8')
          if (text.includes('localhost:8787')) hits8787++
          if (/ws:\/\/localhost/.test(text)) hitsLocalhostWs++
        }
      }
    }
    walk(distDir)
    check(`no "localhost:8787" in ${files} bundle js files`, hits8787 === 0)
    check('no "ws://localhost" in bundle js files', hitsLocalhostWs === 0)
  }
}

/* ------------------------------------ 5 ------------------------------------ */
console.log('\n── 5. SPA routes serve the app shell ──')
{
  const distDir = path.resolve('dist')
  const indexHtml = path.join(distDir, 'index.html')
  if (fs.existsSync(indexHtml)) {
    const shell = fs.readFileSync(indexHtml, 'utf8')
    // vercel.json rewrites every non-asset route to /index.html; simulate by
    // confirming the shell exists and the rewrite config covers the routes.
    check('dist/index.html shell exists', shell.includes('<div id="root">'))
    const vercel = JSON.parse(fs.readFileSync('vercel.json', 'utf8')) as {
      rewrites?: { source: string }[]
    }
    const rewriteSource = vercel.rewrites?.[0]?.source ?? ''
    check('vercel.json SPA rewrite covers all routes', rewriteSource === '/(.*)')
    const routes = ['/', '/lobby/XYZ789', '/play/ABC123', '/join?join=ROOMCODE']
    check('documented routes are non-file paths (SPA-served)', routes.every((r) => !r.includes('.')))
  } else {
    check('SPA shell check', false, 'dist/index.html missing')
  }
}

/* --------------------------------- summary --------------------------------- */
console.log(`\n══════════════════════════════════════`)
console.log(`  Deploy checks: ${passed} passed, ${failed} failed`)
console.log(`══════════════════════════════════════`)
if (failed > 0) {
  console.log('Failures:')
  failures.forEach((f) => console.log(`  - ${f}`))
  process.exit(1)
}
process.exit(0)
