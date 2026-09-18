/**
 * WebSocket URL resolution + validation for BoardQuest.
 *
 * Contract (see README "Deploy BoardQuest"):
 *  - `VITE_WS_URL` is a BUILD-TIME variable (baked into the Vite bundle).
 *  - Valid values start with ws:// or wss:// and are used verbatim.
 *  - PRODUCTION: no dev fallback. An unset/invalid URL is a CONFIG ERROR —
 *    the UI shows a clear message and never silently dials the Vite proxy
 *    (which doesn't exist on static hosting like Vercel).
 *  - DEVELOPMENT (vite dev server): if VITE_WS_URL is unset, fall back to the
 *    documented same-origin proxy `/boardquest-ws` → ws://localhost:8787.
 *
 * This module is deliberately dependency-free and side-effect-free so it can
 * be unit-tested from scripts/test-deploy.ts.
 */

/** Where the Vite dev proxy forwards WebSocket traffic. */
export const DEV_PROXY_PATH = '/boardquest-ws'

/** Canonical WS path served by server/index.ts. */
export const SERVER_WS_PATH = '/ws'

export type WsUrlCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string }

/**
 * Validate a configured WebSocket URL.
 *  - accepts ws:// and wss:// (any path, used verbatim)
 *  - rejects http(s)://, blank values, and malformed URLs
 *  - collapses an accidental trailing "/ws/" and avoids /ws/ws double paths
 */
export function validateWsUrl(raw: string | undefined | null): WsUrlCheck {
  const value = (raw ?? '').trim()
  if (value.length === 0) return { ok: false, reason: 'empty' }

  // Scheme must be ws:// or wss:// — http(s) would create an EventSource-style
  // request, not a WebSocket, and browsers reject it silently otherwise.
  if (/^https?:\/\//i.test(value)) {
    return { ok: false, reason: 'scheme must be ws:// or wss://, not http(s)://' }
  }
  if (!/^wss?:\/\//i.test(value)) {
    return { ok: false, reason: 'malformed URL (expected ws://host/path or wss://host/path)' }
  }

  try {
    const parsed = new URL(value)
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      return { ok: false, reason: `scheme must be ws:// or wss:// (got ${parsed.protocol})` }
    }
    if (parsed.host.length === 0) {
      return { ok: false, reason: 'missing host' }
    }
    let path = parsed.pathname
    // Guard against accidental double paths like /ws/ws — collapse the duplicate
    // segment while preserving an intentional custom path verbatim otherwise.
    if (/\/ws\/ws\/?$/i.test(path)) {
      path = path.replace(/\/ws\/?$/i, '')
    }
    path = path !== '/' && path.endsWith('/') ? path.slice(0, -1) : path
    const search = parsed.search // preserved exactly (rare but harmless)
    const rebuilt = `${parsed.protocol}//${parsed.host}${path === '/' ? '' : path}${search}`
    return { ok: true, url: rebuilt }
  } catch {
    return { ok: false, reason: 'malformed URL (failed to parse)' }
  }
}

/** True when the app was built for production (vite build), false under vite dev. */
export function isProduction(): boolean {
  try {
    return (import.meta as { env?: { PROD?: boolean } }).env?.PROD === true
  } catch {
    return false
  }
}

export interface ResolvedWsUrl {
  /** A usable URL to connect to. */
  url: string
  /** Which branch produced it. */
  source: 'env' | 'dev-proxy'
  /** When set, the configuration is broken and `url` must NOT be dialed. */
  configError: string | null
}

/**
 * Resolve the endpoint the client should connect to.
 * Never logs the URL contents beyond what is needed for debugging; the value
 * is not a secret (VITE_* vars are public by design).
 */
export function resolveWsUrl(envValue: string | undefined | null, prod: boolean): ResolvedWsUrl {
  const trimmed = (envValue ?? '').trim()
  if (trimmed.length > 0) {
    const check = validateWsUrl(trimmed)
    if (check.ok) return { url: check.url, source: 'env', configError: null }
    // A value was provided but invalid — that is always a config error, in any
    // environment. Never fall back silently from an explicitly broken config.
    return {
      url: '',
      source: 'env',
      configError: `VITE_WS_URL is invalid: ${check.reason}`,
    }
  }
  if (prod) {
    return {
      url: '',
      source: 'env',
      configError:
        'VITE_WS_URL is not set. In production the multiplayer endpoint must be configured at build time (Vercel → Settings → Environment Variables, e.g. wss://your-render-service.onrender.com/ws) — then redeploy.',
    }
  }
  // Dev only: same-origin Vite proxy. Intentionally unreachable in prod builds.
  // Uses globalThis indirection so this module also typechecks under the
  // server tsconfig (no DOM lib) — it never runs there.
  const loc = browserLocation()
  const proto = loc?.protocol === 'https:' ? 'wss:' : 'ws:'
  const host = loc?.host ?? 'localhost:5173'
  return { url: `${proto}//${host}${DEV_PROXY_PATH}`, source: 'dev-proxy', configError: null }
}

/** The browser location, or null outside a browser (kept DOM-lib-free). */
function browserLocation(): { protocol: string; host: string } | null {
  const g = globalThis as unknown as { window?: { location?: { protocol: string; host: string } } }
  return g.window?.location ?? null
}
