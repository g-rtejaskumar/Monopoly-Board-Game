/**
 * Two-browser end-to-end test: proves REAL multiplayer by driving two separate
 * browser contexts through the actual UI:
 *   1. Alice creates a room on the landing page
 *   2. Bob joins from a second browser with the room code
 *   3. Lobby rosters sync live to both browsers
 *   4. Alice starts; both land on the game board
 *   5. Only the active player sees Roll enabled; both see the same dice/turn
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
  await page.getByRole('button', { name: /Play With Friends/i }).click()
  await page.getByPlaceholder('e.g. Maple').fill(name)
  await page.getByRole('button', { name: /Create Game/i }).click()
  await page.waitForURL(/\/lobby\/[A-Z0-9]{6}/, { timeout: 15000 })
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
    .click()
  await page.waitForURL(/\/lobby\/[A-Z0-9]{6}/, { timeout: 15000 })
}

async function lobbyNames(page: Page): Promise<string[]> {
  await page.waitForSelector('.slot', { timeout: 10000 })
  return page.$$eval('.slot .slot-name', (els) => els.map((e) => e.textContent ?? ''))
}

async function main(): Promise<void> {
  console.log(`e2e test against ${BASE}\n`)
  const browser: Browser = await chromium.launch()

  // Two fully isolated browser contexts = two different browsers.
  const ctxA = await browser.newContext()
  const ctxB = await browser.newContext()
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

  await alice.waitForSelector('.rail-player', { timeout: 30000 }).catch(async () => {
    console.log('[diag] alice URL:', alice.url())
    console.log('[diag] alice body:', (await alice.textContent('body'))?.slice(0, 400))
    await alice.screenshot({ path: '/tmp/alice-game.png', timeout: 8000 }).catch(() => {})
    throw new Error('alice never rendered the game rail')
  })
  await bob.waitForSelector('.rail-player', { timeout: 30000 }).catch(async () => {
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

/** Wait until both browsers agree on the dice values shown in the toast/log. */
async function pageUrlHasDice(active: Page, idle: Page): Promise<void> {
  const readDice = async (p: Page): Promise<string> => {
    try {
      await p.waitForSelector('.deed-dice', { timeout: 20000 })
      return (await p.textContent('.deed-dice'))?.trim() ?? ''
    } catch {
      console.log(`[diag] dice read failed on ${p.url()}`)
      console.log(`[diag] body: ${(await p.textContent('body'))?.slice(0, 300)}`)
      return ''
    }
  }
  const a = await readDice(active)
  const b = await readDice(idle)
  check('both browsers received the same server dice roll', a.length > 0 && a === b, `"${a}" vs "${b}"`)
}

main().catch((e) => {
  console.error('e2e test crashed:', e)
  process.exit(1)
})
