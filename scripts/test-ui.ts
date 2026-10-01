/**
 * Real-browser viewport validation for the 2D-board redesign.
 *
 * Drives an actual game (host + bot) and inspects the rendered board at every
 * required viewport, asserting the things a player would notice:
 *   - the board is completely visible and never causes horizontal scrolling
 *   - all 40 tiles render, each with an accessible label
 *   - tile text stays above a legible minimum at whatever size the board is
 *   - the action dock (and the Roll button) is always inside the viewport
 *   - tapping a tile opens its property card
 *   - the mobile info sheet opens with Players / Property / Log panes
 *   - reduced-motion mode still renders the full board
 *
 * Run with: npm run test:ui   (dev servers must be running: npm run dev)
 */
import { chromium, type Browser, type Page } from 'playwright'
import { TILE_RECTS, tokenSpotUV } from '../src/board/geometry'

const BASE = process.env.TEST_BASE_URL || 'http://localhost:5173'

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

interface Probe {
  tiles: number
  labelled: number
  announce: string
  board: { top: number; left: number; right: number; bottom: number; width: number; height: number } | null
  dock: { top: number; bottom: number; width: number } | null
  abbrMode: boolean
  textSize: number
  tileWidth: number
  scrollW: number
  innerW: number
  innerH: number
}

interface Paint {
  band: string
  canvas: number
  pawns: number
}

async function paint(page: Page): Promise<Paint> {
  return page.evaluate(() => {
    const g = globalThis as unknown as {
      document?: { querySelector: (s: string) => unknown; querySelectorAll: (s: string) => ArrayLike<unknown> }
      getComputedStyle?: (el: unknown) => { backgroundImage: string; backgroundColor: string }
      __bqPawns?: Record<number, number>
    }
    const bandEl = g.document!.querySelector('.bq-tile .bq-band')
    const style = bandEl && g.getComputedStyle ? g.getComputedStyle(bandEl) : null
    return {
      band: style ? `${style.backgroundImage}|${style.backgroundColor}` : '',
      canvas: Array.from(g.document!.querySelectorAll('.bq-overlay canvas')).length,
      pawns: Object.keys(g.__bqPawns ?? {}).length,
    }
  })
}

async function probe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const g = globalThis as unknown as {
      document?: {
        documentElement: { scrollWidth: number }
        querySelector: (s: string) => unknown
        querySelectorAll: (s: string) => ArrayLike<unknown>
      }
      innerWidth: number
      innerHeight: number
      getComputedStyle?: (el: unknown) => { fontSize: string; display: string }
    }
    const d = g.document!
    type Box = { top: number; left: number; right: number; bottom: number; width: number; height: number }
    type Measured = { getBoundingClientRect: () => Box }
    // NOTE: no intermediate helper functions here — the dev runner's transform
    // injects a name helper that does not exist inside the browser context.
    const boardEl = d.querySelector('.bq-board') as Measured | null
    const board = boardEl ? boardEl.getBoundingClientRect() : null
    const dockEl = d.querySelector('[data-testid="action-dock"]') as Measured | null
    const dock = dockEl ? dockEl.getBoundingClientRect() : null
    const tileEl = d.querySelector('.bq-tile') as Measured | null
    const abbrEl = d.querySelector('.bq-abbr')
    const nameEl = d.querySelector('.bq-name')
    const abbr = abbrEl && g.getComputedStyle ? g.getComputedStyle(abbrEl) : null
    const name = nameEl && g.getComputedStyle ? g.getComputedStyle(nameEl) : null
    const abbrShown = abbr ? abbr.display !== 'none' : false
    return {
      tiles: Array.from(d.querySelectorAll('.bq-tile')).length,
      labelled: Array.from(d.querySelectorAll('.bq-tile[aria-label]')).length,
      announce:
        (d.querySelector('[data-testid="turn-announce"]') as { textContent?: string } | null)
          ?.textContent ?? '',
      board,
      dock,
      abbrMode: abbrShown,
      textSize: abbrShown ? parseFloat(abbr!.fontSize) : parseFloat(name?.fontSize ?? '0'),
      tileWidth: tileEl ? tileEl.getBoundingClientRect().width : 0,
      scrollW: d.documentElement.scrollWidth,
      innerW: g.innerWidth,
      innerH: g.innerHeight,
    }
  })
}

const VIEWPORTS: Array<{ label: string; width: number; height: number }> = [
  { label: 'desktop 1440x900', width: 1440, height: 900 },
  { label: 'laptop 1280x720', width: 1280, height: 720 },
  { label: 'tablet 768x1024', width: 768, height: 1024 },
  { label: 'phone 390x844', width: 390, height: 844 },
  { label: 'phone 430x932', width: 430, height: 932 },
  { label: 'phone landscape 844x390', width: 844, height: 390 },
]

async function main(): Promise<void> {
  console.log(`ui viewport test against ${BASE}\n`)
  const browser: Browser = await chromium.launch()
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const page = await ctx.newPage()
  page.on('pageerror', (e) => console.log(`[pageerror] ${e.message}`))

  // --- create a real game with a bot so a turn is live ---
  await page.goto(BASE)
  await page.getByRole('button', { name: /Play With Friends/i }).click({ force: true })
  await page.getByPlaceholder('e.g. Maple').fill('UI Tester')
  await page.getByRole('button', { name: /Create Game/i }).click({ force: true })
  await page.waitForURL(/\/lobby\/[A-Z0-9]{6}/, { timeout: 20000 })

  await page.locator('.add-bot').first().click({ force: true })
  await page.waitForTimeout(600)
  await page.getByRole('button', { name: /Start Game/i }).click({ force: true })
  await page.waitForURL(/\/play\//, { timeout: 20000 })
  await page.waitForSelector('.bq-board', { timeout: 60000 })
  await page.waitForTimeout(1200)

  check('the 2D board mounted', (await page.locator('.bq-board').count()) === 1)

  const firstPaint = await paint(page)
  check(
    'the board stylesheet is applied (colour bands are painted)',
    firstPaint.band.includes('gradient'),
    firstPaint.band,
  )
  check('the isolated 3D overlay canvas mounted', firstPaint.canvas === 1, String(firstPaint.canvas))
  check(
    'the 3D pawns are rendering on the board',
    firstPaint.pawns > 0,
    `${firstPaint.pawns} pawns published`,
  )

  /* ------------------------- every required viewport ------------------------- */
  for (const vp of VIEWPORTS) {
    await page.setViewportSize({ width: vp.width, height: vp.height })
    await page.waitForTimeout(450)
    const m = await probe(page)
    const b = m.board
    check(`${vp.label}: renders all 40 tiles`, m.tiles === 40, String(m.tiles))
    check(`${vp.label}: every tile has an accessible label`, m.labelled === 40, String(m.labelled))
    check(
      `${vp.label}: the board is completely visible`,
      Boolean(b) && b!.top >= -1 && b!.left >= -1 && b!.bottom <= m.innerH + 1 && b!.right <= m.innerW + 1,
      JSON.stringify(b),
    )
    check(
      `${vp.label}: no horizontal page scrolling`,
      m.scrollW <= m.innerW + 1,
      `scrollWidth ${m.scrollW} vs ${m.innerW}`,
    )
    check(
      `${vp.label}: the action dock is inside the viewport`,
      Boolean(m.dock) && m.dock!.top >= -1 && m.dock!.bottom <= m.innerH + 1,
      JSON.stringify(m.dock),
    )
    check(
      `${vp.label}: tile text stays legible (${m.abbrMode ? 'compact' : 'full'} mode, ${m.textSize.toFixed(1)}px)`,
      m.textSize >= 7,
      `${m.textSize.toFixed(2)}px on ${b?.width.toFixed(0)}px board`,
    )
    check(`${vp.label}: the board is a usable size (${(b?.width ?? 0).toFixed(0)}px)`, (b?.width ?? 0) >= 240)
    const roll = await page.getByRole('button', { name: /Roll Dice/i }).count()
    check(`${vp.label}: the Roll button is visible on your turn`, roll === 1, String(roll))
    check(
      `${vp.label}: the turn is announced to screen readers`,
      m.announce.toUpperCase().includes('YOUR TURN'),
      m.announce,
    )
  }

  /* ------------------- geometry vs the rendered DOM board -------------------- */
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.waitForTimeout(450)

  const domRects = await page.evaluate(() => {
    const g = globalThis as unknown as {
      document?: {
        querySelector: (s: string) => unknown
        querySelectorAll: (s: string) => ArrayLike<unknown>
      }
    }
    type Box = { left: number; top: number; width: number; height: number }
    const innerEl = g.document!.querySelector('.bq-board-inner') as { getBoundingClientRect: () => Box } | null
    if (!innerEl) return {} as Record<string, { u: number; v: number; w: number; h: number }>
    const inner = innerEl.getBoundingClientRect()
    const out: Record<string, { u: number; v: number; w: number; h: number }> = {}
    const tiles = Array.from(g.document!.querySelectorAll('.bq-tile')) as Array<{
      getAttribute: (n: string) => string | null
      getBoundingClientRect: () => Box
    }>
    for (const el of tiles) {
      const r = el.getBoundingClientRect()
      out[el.getAttribute('data-tile') ?? '?'] = {
        u: (r.left - inner.left) / inner.width,
        v: (r.top - inner.top) / inner.height,
        w: r.width / inner.width,
        h: r.height / inner.height,
      }
    }
    return out
  })

  const rectProblems: string[] = []
  for (let i = 0; i < 40; i++) {
    const geo = TILE_RECTS[i]!
    const dom = domRects[String(i)]
    if (!dom) {
      rectProblems.push(`tile ${i} not rendered`)
      continue
    }
    if (
      Math.abs(dom.u - geo.u) > 0.006 ||
      Math.abs(dom.v - geo.v) > 0.006 ||
      Math.abs(dom.w - geo.w) > 0.01 ||
      Math.abs(dom.h - geo.h) > 0.01
    ) {
      rectProblems.push(`tile ${i}: dom u${dom.u.toFixed(3)} v${dom.v.toFixed(3)} vs geometry u${geo.u.toFixed(3)} v${geo.v.toFixed(3)}`)
    }
  }
  check(
    'the rendered DOM board matches the geometry source of truth for all 40 tiles',
    rectProblems.length === 0,
    rectProblems.slice(0, 3).join('; '),
  )

  /* --------------- 3D overlay projects onto the 2D board exactly ------------- */
  const screens = await page.evaluate(() => {
    const g = globalThis as unknown as {
      __bqPawnScreen?: Record<string, { x: number; y: number; tile: number; slot: number; count: number }>
    }
    return g.__bqPawnScreen ?? {}
  })
  const alignProblems: string[] = []
  for (const [seat, s] of Object.entries(screens)) {
    const expected = tokenSpotUV(s.tile, s.slot, s.count)
    const dx = Math.abs(s.x - expected.u)
    const dy = Math.abs(s.y - expected.v)
    if (dx > 0.015 || dy > 0.015) {
      alignProblems.push(
        `seat ${seat}: 3D projected ${s.x.toFixed(3)},${s.y.toFixed(3)} vs board ${expected.u.toFixed(3)},${expected.v.toFixed(3)}`,
      )
    }
  }
  check(
    'the 3D overlay projects every token exactly onto its 2D tile',
    alignProblems.length === 0 && Object.keys(screens).length > 0,
    alignProblems.join('; ') || 'no pawns published',
  )

  /* --------------------------- property card on tap -------------------------- */
  await page.locator('.bq-tile[data-tile="6"]').click({ force: true })
  await page.waitForTimeout(350)
  check(
    'clicking a tile shows its property card',
    (await page.locator('.deed-block').innerText()).includes('Lighthouse Lane'),
  )

  /* ------------------------- mobile sheet + tabs ---------------------------- */
  await page.setViewportSize({ width: 390, height: 844 })
  await page.waitForTimeout(450)
  await page.locator('.bq-tile[data-tile="6"]').click({ force: true })
  await page.waitForTimeout(450)
  check(
    'tapping a tile on a phone opens the property sheet',
    (await page.locator('.side-rail.mobile-open').count()) === 1 &&
      (await page.locator('.sheet-pane.is-active.deed-block').count()) === 1,
  )
  const sheetText = await page.locator('.side-rail').innerText()
  check('the property sheet shows the tapped property', sheetText.includes('Lighthouse Lane'), sheetText.slice(0, 120))

  await page.getByRole('tab', { name: /Players/i }).click({ force: true })
  await page.waitForTimeout(300)
  check(
    'the Players tab opens the player list',
    (await page.locator('.sheet-pane.is-active.players-block').count()) === 1,
  )
  await page.getByRole('tab', { name: /Log/i }).click({ force: true })
  await page.waitForTimeout(300)
  check(
    'the Log tab opens the game log',
    (await page.locator('.sheet-pane.is-active.log-block').count()) === 1,
  )
  await page.locator('.sheet-close').click({ force: true })
  await page.waitForTimeout(350)
  check(
    'the sheet closes again',
    (await page.locator('.side-rail.mobile-open').count()) === 0,
  )

  /* ------------------------------ touch targets ------------------------------ */
  const smallTargets = await page.evaluate(() => {
    const g = globalThis as unknown as {
      document?: { querySelectorAll: (s: string) => ArrayLike<unknown> }
    }
    type Box = { width: number; height: number }
    // Board tiles are inherently grid-limited on a 370px-wide phone; the 44px
    // rule applies to the controls the player must hit (the action dock).
    const els = Array.from(g.document!.querySelectorAll('.action-dock button, .sheet-tab, .sheet-close'))
    return els
      .map((e) => (e as { getBoundingClientRect?: () => Box }).getBoundingClientRect?.() ?? { width: 0, height: 0 })
      .filter((r) => r.height > 0 && r.width > 0 && r.height < 44).length
  })
  check(
    'primary mobile controls meet the 44px touch-target rule',
    smallTargets === 0,
    `${smallTargets} undersized controls`,
  )

  /* ----------------------------- reduced motion ------------------------------ */
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.waitForTimeout(400)
  const rm = await probe(page)
  check('reduced-motion mode still renders all 40 tiles', rm.tiles === 40, String(rm.tiles))
  check(
    'reduced-motion mode still shows the Roll button',
    (await page.getByRole('button', { name: /Roll Dice/i }).count()) === 1,
  )
  await page.emulateMedia({ reducedMotion: 'no-preference' })

  await browser.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

main().catch((e) => {
  console.error('ui test crashed:', e)
  process.exit(1)
})
