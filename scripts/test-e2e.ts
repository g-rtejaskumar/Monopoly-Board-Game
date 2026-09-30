/**
 * Two-browser end-to-end test: proves REAL multiplayer by driving two separate
 * browser contexts through the actual UI:
 *   1. Alice creates a room on the landing page
 *   2. Bob joins from a second browser with the room code
 *   3. Lobby rosters sync live to both browsers
 *   4. Alice starts; both land on the game board
 *   5. Only the active player sees Roll enabled; both see the same dice/turn
 *   6. Movement resolves, and the turn hands over to the phone with a working
 *      Roll button — the production two-device session that froze on
 *      "X is moving…" while the mover's pawn stayed on GO
 *   7. Every rendered 3D pawn equals the authoritative tile once settled
 *
 * Bob runs in a 390x844 touch viewport, so the desktop + phone production
 * combination (and the mobile layout) is covered end to end.
 *
 * Run with: npm run test:e2e  (dev servers must be running: npm run dev)
 */
import { chromium, type Browser, type Page } from 'playwright'

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

async function createGame(page: Page, name: string): Promise<string> {
  await page.goto(BASE)
  // force: the hero WebGL canvas causes intermittent main-thread GPU stalls that
  // break Playwright's actionability wait even though the buttons are clickable.
  await page.getByRole('button', { name: /Play With Friends/i }).click({ force: true })
  await page.getByPlaceholder('e.g. Maple').fill(name)
  await page.getByRole('button', { name: /Create Game/i }).click({ force: true })
  await page.waitForURL(/\/lobby\/[A-Z0-9]{6}/, { timeout: 20000 })
  const url = page.url()
  return url.split('/lobby/')[1] ?? ''
}

async function joinGame(page: Page, name: string, code: string): Promise<void> {
  // Invite-link flow: /?join=CODE pre-opens the join panel with the code filled.
  await page.goto(`${BASE}/?join=${code}`)
  await page.getByPlaceholder('e.g. Maple').fill(name)
  await page
    .getByRole('dialog', { name: 'Join a game' })
    .getByRole('button', { name: /Join Game/i })
    .click({ force: true })
  await page.waitForURL(/\/lobby\/[A-Z0-9]{6}/, { timeout: 15000 })
}

async function lobbyNames(page: Page): Promise<string[]> {
  await page.waitForSelector('.slot', { timeout: 10000 })
  return page.$$eval('.slot .slot-name', (els) => els.map((e) => e.textContent ?? ''))
}

async function main(): Promise<void> {
  console.log(`e2e test against ${BASE}\n`)
  const browser: Browser = await chromium.launch()

  // Two fully isolated browser contexts = two different browsers. Bob is an
  // Android-class phone: the exact mix that surfaced the movement/turn bug.
  const ctxA = await browser.newContext({ viewport: { width: 1440, height: 900 } })
  const ctxB = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  })
  const alice = await ctxA.newPage()
  const bob = await ctxB.newPage()

  for (const [label, page] of [
    ['alice', alice],
    ['bob', bob],
  ] as const) {
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') console.log(`[${label} console] ${m.text()}`)
    })
    page.on('pageerror', (e) => console.log(`[${label} pageerror] ${e.message}`))
  }

  /* ---------------- host creates ---------------- */
  const code = await createGame(alice, 'Alice')
  check('alice created a room via the UI', /^[A-Z0-9]{6}$/.test(code), code)

  await alice.waitForSelector('.room-code', { timeout: 10000 })
  const shownCode = (await alice.textContent('.room-code'))?.trim() ?? ''
  check('lobby shows the room code', shownCode === code, shownCode)

  /* ---------------- bob joins from a second browser ---------------- */
  await joinGame(bob, 'Bob', code)
  check('bob joined the same room via the code', pageUrlHas(bob.url(), code))

  /* ---------------- real-time lobby sync ---------------- */
  const aliceNames = await lobbyNames(alice)
  check('alice sees bob in her lobby in real time', aliceNames.some((n) => n?.includes('Bob')), JSON.stringify(aliceNames))
  const bobNames = await lobbyNames(bob)
  check('bob sees alice in his lobby', bobNames.some((n) => n?.includes('Alice')), JSON.stringify(bobNames))

  /* ---------------- bob readies up, then host starts ---------------- */
  await bob.getByRole('button', { name: /Ready up|I'm ready/i }).click()
  await alice
    .waitForSelector('.slot .ready-badge', { timeout: 10000 })
    .catch(() => check('ready badge propagated to host', false))
  check('ready badge propagated to the host lobby', true)

  await alice.getByRole('button', { name: /Start Game/i }).click()
  await alice.waitForURL(/\/play\//, { timeout: 15000 })
  await bob.waitForURL(/\/play\//, { timeout: 15000 })
  check('host started; both browsers navigated to the game', true)

  // 60s: first /play/ hit in dev compiles the GamePage+three chunk and inits
  // WebGL, which can exceed 30s on a busy machine.
  await alice.waitForSelector('.rail-player', { timeout: 60000 }).catch(async () => {
    console.log('[diag] alice URL:', alice.url())
    console.log('[diag] alice body:', (await alice.textContent('body'))?.slice(0, 400))
    await alice.screenshot({ path: '/tmp/alice-game.png', timeout: 8000 }).catch(() => {})
    throw new Error('alice never rendered the game rail')
  })
  await bob.waitForSelector('.rail-player', { timeout: 60000 }).catch(async () => {
    console.log('[diag] bob URL:', bob.url())
    console.log('[diag] bob body:', (await bob.textContent('body'))?.slice(0, 400))
    await bob.screenshot({ path: '/tmp/bob-game.png', timeout: 8000 }).catch(() => {})
    throw new Error('bob never rendered the game rail')
  })

  /* ---------------- same game state on both screens ---------------- */
  const aRail = await railText(alice)
  const bRail = await railText(bob)
  // railText returns name+cash pairs, so 2 players => 4 entries.
  check('both browsers see both players with cash', aRail.length === 4 && bRail.length === 4 && /1,500/.test(aRail.join(' ')) && /1,500/.test(bRail.join(' ')), JSON.stringify([aRail, bRail]))

  /* ---------------- turn gating ---------------- */
  const aTurn = (await alice.textContent('.turn-banner')) ?? ''
  const bTurn = (await bob.textContent('.turn-banner')) ?? ''
  const aliceActive = aTurn.includes('Your turn')
  const bobActive = bTurn.includes('Your turn')
  check('exactly one browser owns the first turn', aliceActive !== bobActive, `${aTurn} | ${bTurn}`)

  // The active player rolls; both must converge on the same dice.
  const activePage = aliceActive ? alice : bob
  const idlePage = aliceActive ? bob : alice
  const rollBtn = activePage.getByRole('button', { name: /Roll Dice/i })
  check('roll button only on the active browser', (await rollBtn.count()) === 1 && (await idlePage.getByRole('button', { name: /Roll Dice/i }).count()) === 0)
  // Space triggers the same roll path (keyboard shortcut), avoiding WebGL
  // hit-testing jank during first shader compilation.
  await activePage.keyboard.press('Space')
  await pageUrlHasDice(activePage, idlePage)

  /* ---------------- movement resolves + the turn hands over ---------------- */
  // The production bug: the mover's pawn never reached its tile and the other
  // player stayed parked on "X is moving…" forever. Both must now clear.
  await waitForTurnHandover(activePage, idlePage, 'first turn')

  /* ---------------- rendered pawn === authoritative position ---------------- */
  await checkPawnsMatchAuthority(alice, 'alice (desktop)')
  await checkPawnsMatchAuthority(bob, 'bob (phone)')

  /* ---------------- reverse direction: the phone now takes its turn ---------------- */
  const phoneHasTurn = await hasRollButton(bob)
  const nextActive = phoneHasTurn ? bob : alice
  const nextIdle = phoneHasTurn ? alice : bob
  check(`the ${phoneHasTurn ? 'phone' : 'desktop'} owns the handed-over turn`, await hasRollButton(nextActive), await rollButtonCounts(nextActive, nextIdle))
  await nextActive.keyboard.press('Space')
  await pageUrlHasDice(nextActive, nextIdle)
  await waitForTurnHandover(nextActive, nextIdle, 'second turn')
  await checkPawnsMatchAuthority(alice, 'alice after the reverse turn')
  await checkPawnsMatchAuthority(bob, 'bob after the reverse turn')

  /* ---------------- cleanup ---------------- */
  await browser.close()
  console.log(`\n${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

function pageUrlHas(url: string, code: string): boolean {
  return url.toUpperCase().includes(code)
}

async function railText(page: Page): Promise<string[]> {
  return page.$$eval('.rail-player .rail-name, .rail-player .rail-cash', (els) =>
    els.map((e) => e.textContent ?? ''),
  )
}

/**
 * Resolve whatever modal prompt is open (buy / event / auction / jail) with a
 * NATIVE DOM click. Buy/jail put buttons in .modal-actions; EventModal's
 * "Continue" is a direct child of .modal. Playwright's input pipeline is
 * skipped entirely: the hero WebGL canvas can stall the main thread ("GPU
 * stall due to ReadPixels"), which intermittently wedges synthetic input
 * dispatch even with force:true. Native clicks still reach React's event
 * system. Pass/continue-style buttons are preferred so an auction (whose
 * first button is an extending "Bid") resolves within one loop tick.
 */
async function clickModalButton(page: Page): Promise<void> {
  const clicked = await page.evaluate(() => {
    const g = globalThis as unknown as {
      document?: {
        querySelectorAll: (s: string) => ArrayLike<{ click: () => void; textContent?: string | null }>
      }
    }
    const buttons = Array.from(g.document?.querySelectorAll('.modal button:enabled') ?? [])
    if (buttons.length === 0) return null
    const pass = buttons.find((b) => /pass|continue|decline/i.test(b.textContent ?? ''))
    ;(pass ?? buttons[0]).click()
    return (pass ?? buttons[0]).textContent?.trim() ?? 'unknown'
  })
  if (clicked != null) await new Promise((r) => setTimeout(r, 400))
}

/**
 * Wait until both browsers agree on the server's dice result. Read from the
 * game log ("Alice rolled 9") — the deed dice row can be temporarily replaced
 * by the event modal or hidden during move animations. Poll until convergence.
 */
async function pageUrlHasDice(active: Page, idle: Page): Promise<void> {
  const readRoll = async (p: Page): Promise<string> => {
    try {
      // If an event/deed modal is open, dismiss it like a real player would.
      const cont = p.locator('.modal button:has-text("Continue")')
      if (await cont.count()) await cont.first().click({ force: true, timeout: 2000 }).catch(() => {})
      const entries = await p.locator('.log-entry').allTextContents()
      const rolls = entries.map((e) => e.trim()).filter((e) => /rolled \d+/.test(e))
      return rolls.at(-1)?.match(/rolled (\d+)/)?.[1] ?? ''
    } catch {
      return ''
    }
  }
  const deadline = Date.now() + 60_000
  let a = ''
  let b = ''
  while (Date.now() < deadline) {
    a = await readRoll(active)
    b = await readRoll(idle)
    if (a.length > 0 && a === b) break
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (a.length === 0 || a !== b) {
    console.log(`[diag] dice read failed on ${active.url()}`)
    console.log(`[diag] body: ${(await active.textContent('body'))?.slice(0, 300)}`)
  }
  check('both browsers received the same server dice roll', a.length > 0 && a === b, `"${a}" vs "${b}"`)
}

/* ------------------- movement / turn-handover regression ------------------- */

async function hasRollButton(page: Page): Promise<boolean> {
  return (await page.getByRole('button', { name: /Roll Dice/i }).count()) > 0
}

async function rollButtonCounts(a: Page, b: Page): Promise<string> {
  return `roll buttons: ${await a.getByRole('button', { name: /Roll Dice/i }).count()} / ${await b.getByRole('button', { name: /Roll Dice/i }).count()}`
}

/** The dev diagnostics overlay mirrors the store the UI renders from. */
async function diag(page: Page): Promise<{
  phase: string
  current: string
  you: string
  moving: string
  pending: string
  tileFor: (seat: number) => Promise<string | null>
} | null> {
  const el = page.locator('[data-testid="diag"]')
  if ((await el.count()) === 0) return null
  return {
    phase: (await el.getAttribute('data-phase')) ?? '',
    current: (await el.getAttribute('data-current')) ?? '',
    you: (await el.getAttribute('data-you')) ?? '',
    moving: (await el.getAttribute('data-moving')) ?? '',
    pending: (await el.getAttribute('data-pending')) ?? '',
    tileFor: async (seat: number) => {
      // getAttribute waits for the element to appear; a 2-player game has no
      // seats 2-7, so check existence first and return null when absent.
      const loc = page.locator(`.diag-player[data-seat="${seat}"]`).first()
      if ((await loc.count()) === 0) return null
      return (await loc.getAttribute('data-tile')) ?? null
    },
  }
}

/** Only the page whose seat is current may act (avoids clicking on a watcher). */
async function isActor(page: Page): Promise<boolean> {
  const d = await diag(page)
  return Boolean(d && d.current && d.you && d.current === d.you)
}

/**
 * Resolve whatever the acting player is being asked for (buy / pass / continue),
 * then wait for the turn to reach the other browser with a working Roll button.
 */
async function waitForTurnHandover(mover: Page, other: Page, label: string): Promise<void> {
  const deadline = Date.now() + 75_000
  let handed = false
  let lastMover = 'never-read'
  let lastOther = 'never-read'
  while (Date.now() < deadline) {
    // Behave like a real player: answer the prompt the acting seat is shown.
    for (const p of [mover, other]) {
      if (!(await isActor(p))) continue
      const d = await diag(p)
      if (p === mover) lastMover = JSON.stringify(d)
      else lastOther = JSON.stringify(d)
      if (p === mover && d?.phase === 'idle' && d.pending === '') {
        // Doubles grant the SAME player another roll (phase returns to idle
        // with the turn unchanged) — a real player would just roll again.
        // An open modal (pending event/buy) takes priority over rolling.
        await p.keyboard.press('Space')
        continue
      }
      await clickModalButton(p)
    }
    if (await hasRollButton(other)) {
      handed = true
      break
    }
    await new Promise((r) => setTimeout(r, 750))
  }
  check(`${label}: the turn hands over to the other browser`, handed, `mover=${lastMover} other=${lastOther}`)
  if (!handed) return

  const d = await diag(other)
  check(`${label}: the new player is shown an idle, actionable turn`, d?.phase === 'idle' && d.moving === '', JSON.stringify(d))
  const chip = (await other.locator('.turn-chip').first().textContent().catch(() => '')) ?? ''
  check(`${label}: nobody is stuck on "is moving…"`, !/is moving/i.test(chip), chip)

  const stuckMover = await diag(mover)
  check(`${label}: the finished player shows no movement state`, stuckMover?.moving === '', JSON.stringify(stuckMover))
}

/** The 3D pawn the player sees must sit on the server's tile once settled. */
async function checkPawnsMatchAuthority(page: Page, label: string): Promise<void> {
  const deadline = Date.now() + 20_000
  let problems: string[] = []
  let rendered: Record<string, number> = {}
  while (Date.now() < deadline) {
    problems = []
    const d = await diag(page)
    if (!d) {
      problems.push('no diagnostics overlay (is the dev build running?)')
      break
    }
    if (d.phase === 'moving' || d.moving !== '') {
      problems.push(`still moving (${d.moving})`)
      await new Promise((r) => setTimeout(r, 700))
      continue
    }
    // `window.__bqPawns` is published by the real 3D Pawn (dev builds only).
    rendered = await page.evaluate<Record<string, number>>(
      () => ((globalThis as { __bqPawns?: Record<string, number> }).__bqPawns ?? {}) as Record<string, number>,
    )
    for (let seat = 0; seat < 8; seat++) {
      const authority = await d.tileFor(seat)
      if (authority == null) continue
      const pawn = rendered[String(seat)]
      if (pawn == null) problems.push(`seat ${seat}: pawn never rendered`)
      else if (Math.abs(pawn - Number(authority)) > 0.05)
        problems.push(`seat ${seat}: pawn at ${pawn} but authoritative tile is ${authority}`)
    }
    if (problems.length === 0) break
    await new Promise((r) => setTimeout(r, 700))
  }
  check(`${label}: every rendered pawn matches its authoritative tile`, problems.length === 0, problems.join('; '))
}

main().catch((e) => {
  console.error('e2e test crashed:', e)
  process.exit(1)
})
