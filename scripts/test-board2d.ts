/**
 * Board2D regression suite (no browser required).
 *
 * Covers the parts of the 2D-board redesign that can be proven headlessly:
 *   1. the board renders all 40 authoritative tiles, each with a label
 *   2. tile coordinates map correctly (rects stay on the board, corners and
 *      edges are where they should be, colour bands face the centre)
 *   3. token tile -> coordinate conversion stays inside its tile for 1..8 players
 *   4. token movement animation never alters game state
 *   5. the pawn ends on the authoritative tile once the hop resolves
 *
 * Visual/layout checks at real viewports live in scripts/test-ui.ts.
 *
 * Run with: npm run test:board2d
 */
import { TILES, GROUP_COLORS, getTile } from '../src/game/boardData'
import {
  CORNER_SIZE,
  SIDE_LEN,
  TILE_RECTS,
  bandEdge,
  tileRect,
  toWorld,
  tokenSpotUV,
  tokenSpot,
  WORLD_SIZE,
} from '../src/board/geometry'
import { createNetBoardStore } from '../src/net/netBoardStore'
import type { GameSnapshot } from '../src/net/protocol'
import { BOARD_SIZE } from '../src/net/protocol'

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

const EPS = 1e-9

/* ---------------------------- 1. every tile exists --------------------------- */

check('the board defines exactly 40 tiles', TILES.length === 40, String(TILES.length))
check(
  'tile indices are unique and contiguous 0..39',
  TILES.every((t, i) => t.index === i) && new Set(TILES.map((t) => t.index)).size === 40,
)
check('every tile has a non-empty label', TILES.every((t) => t.name.trim().length > 0))
check(
  'every ownable tile has a price; every property has a group + rent table',
  TILES.every((t) => {
    if (t.type === 'property') return Boolean(t.price && t.colorGroup && t.rent?.length === 6)
    if (t.type === 'railroad') return Boolean(t.price && t.rent?.length === 4)
    if (t.type === 'utility') return Boolean(t.price && t.rent?.length === 2)
    return true
  }),
)
check(
  'the four corners are Start / Jail / Free Parking / Go To Jail',
  [0, 10, 20, 30].every((i) => bandEdge(i) === null) &&
    getTile(0)?.type === 'start' &&
    getTile(10)?.type === 'jail' &&
    getTile(20)?.type === 'free-parking' &&
    getTile(30)?.type === 'go-to-jail',
)
check(
  'all eight property groups are used by at least two tiles',
  (Object.keys(GROUP_COLORS) as Array<keyof typeof GROUP_COLORS>).every(
    (g) => TILES.filter((t) => t.colorGroup === g).length >= 2,
  ),
)

/* ------------------------- 2. tile coordinates map right --------------------- */

check('geometry provides a rect for all 40 tiles', TILE_RECTS.length === 40)
check(
  'every tile rect lies fully inside the board',
  TILE_RECTS.every((r) => r.u >= -EPS && r.v >= -EPS && r.u + r.w <= 1 + EPS && r.v + r.h <= 1 + EPS),
)
check(
  'corner tiles are square and CORNER_SIZE wide',
  [0, 10, 20, 30].every((i) => {
    const r = tileRect(i)
    return Math.abs(r.w - CORNER_SIZE) < EPS && Math.abs(r.h - CORNER_SIZE) < EPS
  }),
)
check(
  'street tiles have SIDE_LEN along their edge',
  TILES.filter((t) => bandEdge(t.index) !== null).every((t) => {
    const r = tileRect(t.index)
    const horizontal = r.side === 'bottom' || r.side === 'top'
    return Math.abs((horizontal ? r.w : r.h) - SIDE_LEN) < EPS
  }),
)
check('corner 0 sits bottom-right', (() => {
  const r = tileRect(0)
  return r.u + r.w > 0.99 && r.v + r.h > 0.99
})())
check('corner 10 sits bottom-left', (() => {
  const r = tileRect(10)
  return r.u < 0.01 && r.v + r.h > 0.99
})())
check('corner 20 sits top-left', (() => {
  const r = tileRect(20)
  return r.u < 0.01 && r.v < 0.01
})())
check('corner 30 sits top-right', (() => {
  const r = tileRect(30)
  return r.u + r.w > 0.99 && r.v < 0.01
})())
check(
  'tile 1 is adjacent to corner 0 on the bottom edge',
  Math.abs(tileRect(1).u + tileRect(1).w - tileRect(0).u) < EPS,
)
check(
  'tile 9 is adjacent to corner 10 on the bottom edge',
  Math.abs(tileRect(9).u - (tileRect(10).u + tileRect(10).w)) < EPS,
)
check(
  'colour bands face the board centre',
  bandEdge(1) === 'top' &&
    bandEdge(11) === 'right' &&
    bandEdge(21) === 'bottom' &&
    bandEdge(31) === 'left',
)
check(
  'no two tile rects overlap',
  TILE_RECTS.every((a, i) =>
    TILE_RECTS.every((b, j) => {
      if (i === j) return true
      const gap = a.u + a.w <= b.u + EPS || b.u + b.w <= a.u + EPS || a.v + a.h <= b.v + EPS || b.v + b.h <= a.v + EPS
      return gap
    }),
  ),
)
check(
  'tiles plus the open centre exactly fill the 1x1 playfield',
  (() => {
    const tilesArea = TILE_RECTS.reduce((sum, r) => sum + r.w * r.h, 0)
    const centre = (1 - 2 * CORNER_SIZE) * (1 - 2 * CORNER_SIZE)
    return Math.abs(tilesArea + centre - 1) < 1e-9
  })(),
  String(TILE_RECTS.reduce((sum, r) => sum + r.w * r.h, 0)),
)

/* ---------------------- 3. token tile -> coordinate mapping ------------------ */

let tokenProblems: string[] = []
for (let tile = 0; tile < BOARD_SIZE; tile++) {
  for (let count = 1; count <= 8; count++) {
    const r = tileRect(tile)
    for (let slot = 0; slot < count; slot++) {
      const p = tokenSpotUV(tile, slot, count)
      const inside =
        p.u >= r.u - 1e-6 && p.u <= r.u + r.w + 1e-6 && p.v >= r.v - 1e-6 && p.v <= r.v + r.h + 1e-6
      if (!inside) tokenProblems.push(`tile ${tile} slot ${slot}/${count} → ${p.u.toFixed(3)},${p.v.toFixed(3)}`)
    }
  }
}
check('every token slot lands inside its own tile (1..8 players)', tokenProblems.length === 0, tokenProblems.slice(0, 4).join('; '))

const distinct = new Set<string>()
for (let slot = 0; slot < 8; slot++) {
  const p = tokenSpotUV(0, slot, 8)
  distinct.add(`${p.u.toFixed(4)},${p.v.toFixed(4)}`)
}
check('eight tokens on one tile occupy eight distinct spots', distinct.size === 8, String(distinct.size))

check(
  'world coordinates match the normalized mapping 1:1',
  (() => {
    const w = toWorld(0.25, 0.75)
    return Math.abs(w.x - (0.25 - 0.5) * WORLD_SIZE) < EPS && Math.abs(w.z - (0.75 - 0.5) * WORLD_SIZE) < EPS
  })(),
)
check(
  'the board centre maps to the world origin',
  (() => {
    const w = toWorld(0.5, 0.5)
    return Math.abs(w.x) < EPS && Math.abs(w.z) < EPS
  })(),
)
check(
  'tokenSpot (3D) and tokenSpotUV (DOM) agree — the two layers cannot drift',
  [0, 7, 13, 24, 31, 39].every((tile) =>
    [0, 3, 7].every((slot) => {
      const world = tokenSpot(tile, slot, 8)
      const uv = tokenSpotUV(tile, slot, 8)
      return Math.abs(world.x - toWorld(uv.u, uv.v).x) < EPS && Math.abs(world.z - toWorld(uv.u, uv.v).z) < EPS
    }),
  ),
)

/* ------------------ 4/5. animation never alters authoritative state ---------- */

function snapshot(over: Partial<GameSnapshot>): GameSnapshot {
  return {
    code: 'TEST',
    players: [
      { id: 'a', name: 'Alice', color: '#f5a83c', seat: 0, tile: 0, cash: 1500, isBot: false, connected: true },
      { id: 'b', name: 'Bob', color: '#4ea3ff', seat: 1, tile: 0, cash: 1500, isBot: false, connected: true },
    ],
    current: 0,
    turn: 1,
    phase: 'idle',
    dice: [1, 1],
    rollId: 0,
    rolledAt: 0,
    doubles: 0,
    owned: {},
    buildings: {},
    mortgaged: {},
    buyTile: null,
    eventTile: null,
    eventText: null,
    debt: null,
    trade: null,
    auction: null,
    log: [],
    winner: null,
    ...over,
  }
}

{
  const { store, onServerMsg } = createNetBoardStore()
  onServerMsg(snapshot({}))
  onServerMsg(snapshot({ phase: 'rolling', rollId: 1, dice: [3, 4], rolledAt: Date.now() }))

  const during = store.get()
  // The dice tumble first (phase 'rolling', no hop yet); the hop is armed behind it.
  check('a roll broadcast puts the table into the rolling state', during.phase === 'rolling' && during.moveAnim === null)
  check(
    'the hop does not move the authoritative tile',
    during.players[0]!.tile === 0 && during.players[1]!.tile === 0,
    `tiles ${during.players[0]!.tile}/${during.players[1]!.tile}`,
  )

  const total = 3 + 4
  onServerMsg(snapshot({ phase: 'idle', rollId: 1, dice: [3, 4], players: [
    { id: 'a', name: 'Alice', color: '#f5a83c', seat: 0, tile: total, cash: 1500, isBot: false, connected: true },
    { id: 'b', name: 'Bob', color: '#4ea3ff', seat: 1, tile: 0, cash: 1500, isBot: false, connected: true },
  ] }))

  const after = store.get()
  check(
    'the pawn ends on the authoritative tile after the hop resolves',
    after.players[0]!.tile === total,
    `tile ${after.players[0]!.tile} expected ${total}`,
  )
  check('the store keeps exactly one entry per player after movement', after.players.length === 2)
  check(
    'no duplicate seats appear after a move',
    new Set(after.players.map((p) => p.seat)).size === after.players.length,
  )
}

{
  // Reconnect: a fresh client adopts the authoritative positions with no hop
  // and no stuck "moving" phase.
  const { store, onServerMsg } = createNetBoardStore()
  onServerMsg(
    snapshot({
      players: [
        { id: 'a', name: 'Alice', color: '#f5a83c', seat: 0, tile: 17, cash: 900, isBot: false, connected: true },
        { id: 'b', name: 'Bob', color: '#4ea3ff', seat: 1, tile: 24, cash: 800, isBot: true, connected: true },
      ],
      current: 1,
      phase: 'idle',
    }),
  )
  const s = store.get()
  check('reconnect adopts authoritative tiles with no hop in flight', s.moveAnim === null && s.phase === 'idle')
  check('reconnect shows every player exactly once', s.players.length === 2)
  check('reconnect positions match the snapshot', s.players[0]!.tile === 17 && s.players[1]!.tile === 24)
}

{
  // Ownership/buildings are derived from player ids, so a mid-animation
  // snapshot can never leave a stale owner behind.
  const { store, onServerMsg } = createNetBoardStore()
  onServerMsg(snapshot({ owned: { '6': 'b' }, buildings: { '6': 3 } }))
  const s = store.get()
  check('ownership is derived into a renderable colour', s.owned[6] === 'sky')
  check('buildings are derived into a renderable count', s.buildings[6] === 3)
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed > 0 ? 1 : 0)
