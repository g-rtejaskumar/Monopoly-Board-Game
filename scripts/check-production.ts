/**
 * BoardQuest production connectivity check (scripts/check-production.ts).
 *
 * Read-only: it performs a health GET and one hello handshake on the real
 * deployed server. It never creates rooms, never sends game actions, and
 * never mutates production state.
 *
 * Usage:
 *   npm run check:prod                          # uses the URLs below
 *   BQ_PROD_URL=https://my-service.onrender.com npm run check:prod
 *
 * Note: this is a manually run command — network access may not exist in CI.
 * A failing check here is NOT a build failure on Vercel.
 */
import https from 'node:https'
import http from 'node:http'
import WebSocket from 'ws'

const PROD_HTTP = (process.env.BQ_PROD_URL || 'https://monopoly-board-game.onrender.com').replace(/\/$/, '')
const PROD_WS = PROD_HTTP.replace(/^http/, 'ws') + '/ws'

let pass = 0
let fail = 0

function report(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    pass++
    console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ''}`)
  } else {
    fail++
    console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

function getHealth(url: string, timeoutMs = 10_000): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http
    const req = mod.get(url, { timeout: timeoutMs }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }))
    })
    req.on('timeout', () => {
      req.destroy(new Error('timeout'))
    })
    req.on('error', reject)
  })
}

function wsHandshake(url: string, timeoutMs = 12_000): Promise<{ ok: boolean; detail: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(url)
    const done = (ok: boolean, detail = ''): void => {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
      resolve({ ok, detail })
    }
    ws.on('open', () => ws.send(JSON.stringify({ t: 'hello', name: 'prod-check' })))
    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(String(data))
        if (msg.t === 'you' && typeof msg.playerId === 'string') {
          done(true, `playerId ${msg.playerId.slice(0, 8)}…`)
        }
      } catch {
        /* ignore */
      }
    })
    ws.on('error', (e: Error) => done(false, e.message))
    setTimeout(() => done(false, 'timeout'), timeoutMs)
  })
}

console.log(`Production check against: ${PROD_HTTP}\n`)

// 1) Health endpoint (Render cold starts can take ~50s on free tiers).
let healthStatus = 0
let healthBody = ''
for (let attempt = 1; attempt <= 2; attempt++) {
  try {
    const r = await getHealth(`${PROD_HTTP}/health`, 60_000)
    healthStatus = r.status
    healthBody = r.body
    break
  } catch (e) {
    if (attempt === 2) report('Health endpoint reachable', false, String(e))
    else console.log('  … retrying (possible cold start)')
  }
}

const healthOk = healthStatus === 200
let healthJson: Record<string, unknown> = {}
try {
  healthJson = JSON.parse(healthBody)
} catch {
  /* handled below */
}
report('Health endpoint: PASS', healthOk && healthJson.ok === true, `HTTP ${healthStatus}`)
report(
  'Health payload shape (ok/service/status/timestamp)',
  healthJson.service === 'boardquest-server' &&
    healthJson.status === 'healthy' &&
    typeof healthJson.timestamp === 'string',
)
report(
  'Health endpoint exposes no secrets/internals',
  !/port|env|room|player|token|key|secret/i.test(JSON.stringify(healthJson)),
)

// 2) Root endpoint must respond (not necessarily 200 JSON — just reachable).
try {
  const root = await getHealth(PROD_HTTP, 30_000)
  report('Root endpoint reachable', root.status > 0 && root.status < 500, `HTTP ${root.status}`)
} catch (e) {
  report('Root endpoint reachable', false, String(e))
}

// 3) WebSocket handshake on /ws.
console.log('')
const ws = await wsHandshake(PROD_WS)
report('WebSocket handshake: PASS', ws.ok, ws.detail)
report('Production configuration: PASS', healthOk && ws.ok)

console.log(`\nProduction check: ${pass} passed, ${fail} failed`)
process.exit(fail === 0 ? 0 : 1)
