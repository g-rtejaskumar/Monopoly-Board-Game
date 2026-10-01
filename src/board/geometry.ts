/**
 * BoardQuest board geometry — the SINGLE source of truth for where every one of
 * the 40 tiles lives on the board.
 *
 * Coordinates are normalized board space: `u` runs 0 (left) → 1 (right) and `v`
 * runs 0 (top) → 1 (bottom). Every consumer derives from these numbers, so the
 * DOM board, the 3D token overlay, house/hotel placement, tile hover, click and
 * highlight can never disagree with one another:
 *
 *   tile index ──► normalized rect ──► CSS position   (Board2D)
 *                                   └► world (x, z)    (BoardOverlay3D)
 *
 * Classic 40-space loop with corners at 0 (bottom-right), 10 (bottom-left),
 * 20 (top-left), 30 (top-right) and nine street tiles per side.
 */

/** Depth of a corner square as a fraction of the board. */
export const CORNER_SIZE = 0.13
/** Length of one street tile along its edge. */
export const SIDE_LEN = (1 - 2 * CORNER_SIZE) / 9
/** Index of the four corner tiles. */
export const CORNERS = [0, 10, 20, 30] as const

export type BoardSide = 'bottom' | 'left' | 'top' | 'right' | 'corner'

/** A tile's footprint in normalized board space (top-left origin). */
export interface TileRect {
  /** Left edge (0..1). */
  u: number
  /** Top edge (0..1). */
  v: number
  /** Width as a fraction of the board. */
  w: number
  /** Height as a fraction of the board. */
  h: number
  /** Centre point. */
  cx: number
  cy: number
  /** Which edge of the board the tile belongs to. */
  side: BoardSide
}

function sideOf(index: number): BoardSide {
  if (index % 10 === 0) return 'corner'
  if (index < 10) return 'bottom'
  if (index < 20) return 'left'
  if (index < 30) return 'top'
  return 'right'
}

function rectFor(index: number): TileRect {
  const C = CORNER_SIZE
  const S = SIDE_LEN
  const side = sideOf(index)

  switch (side) {
    case 'corner': {
      // 0 bottom-right, 10 bottom-left, 20 top-left, 30 top-right
      const u = index === 0 || index === 30 ? 1 - C : 0
      const v = index === 0 || index === 10 ? 1 - C : 0
      return { u, v, w: C, h: C, cx: u + C / 2, cy: v + C / 2, side }
    }
    case 'bottom': {
      // 1..9 run right → left, hugging the bottom edge.
      const k = index - 1
      const u = 1 - C - (k + 1) * S
      const v = 1 - C
      return { u, v, w: S, h: C, cx: u + S / 2, cy: v + C / 2, side }
    }
    case 'left': {
      // 11..19 run bottom → top, hugging the left edge.
      const k = index - 11
      const v = 1 - C - (k + 1) * S
      const u = 0
      return { u, v, w: C, h: S, cx: u + C / 2, cy: v + S / 2, side }
    }
    case 'top': {
      // 21..29 run left → right, hugging the top edge.
      const k = index - 21
      const u = C + k * S
      const v = 0
      return { u, v, w: S, h: C, cx: u + S / 2, cy: v + C / 2, side }
    }
    default: {
      // 31..39 run top → bottom, hugging the right edge.
      const k = index - 31
      const u = 1 - C
      const v = C + k * S
      return { u, v, w: C, h: S, cx: u + C / 2, cy: v + S / 2, side }
    }
  }
}

/** Normalized footprint of all 40 tiles, indexed by tile number. */
export const TILE_RECTS: TileRect[] = Array.from({ length: 40 }, (_, i) => rectFor(i))

export function tileRect(index: number): TileRect {
  return TILE_RECTS[((index % 40) + 40) % 40]!
}

export function tileCenter(index: number): { u: number; v: number } {
  const r = tileRect(index)
  return { u: r.cx, v: r.cy }
}

/**
 * Which edge of a street tile carries the colour band. The band faces the
 * centre of the board (like a real board) so names/prices stay on the outer
 * half and are never covered by the band.
 */
export function bandEdge(index: number): 'top' | 'bottom' | 'left' | 'right' | null {
  switch (sideOf(index)) {
    case 'bottom':
      return 'top'
    case 'left':
      return 'right'
    case 'top':
      return 'bottom'
    case 'right':
      return 'left'
    default:
      return null
  }
}

/* --------------------------------- world ---------------------------------- */

/**
 * Size of the board in 3D world units. The overlay camera is configured so the
 * square obeys the same 0..1 mapping as the DOM board: a point at normalized
 * (u, v) on the ground plane (y = 0) projects to exactly that spot on screen.
 */
export const WORLD_SIZE = 10

/** Normalized board point → world plane coordinates (y stays 0). */
export function toWorld(u: number, v: number): { x: number; z: number } {
  return { x: (u - 0.5) * WORLD_SIZE, z: (v - 0.5) * WORLD_SIZE }
}

/** World height of the tile surface tokens stand on. */
export const TOKEN_TOP = 0.06

export interface TokenSpot {
  x: number
  z: number
  /** Slight per-slot lift so stacked tokens are readable from above. */
  y: number
}

/**
 * Where the `slot`-th of `count` players standing on `index` should sit, in
 * normalized board space. Tokens fan across the tile's long axis and are
 * nudged toward the OUTER edge, away from the colour band and the name/price,
 * so they never hide information.
 */
export function tokenSpotUV(index: number, slot: number, count: number): { u: number; v: number } {
  const r = tileRect(index)
  const maxCount = Math.max(count, 1)
  // Scale a token to ~38% of the board's tile length, clamped for legibility.
  const spread = 0.62 // fraction of the tile's long axis used by the fan

  // Long axis: horizontal for top/bottom tiles, vertical for left/right.
  const horizontal = r.side === 'bottom' || r.side === 'top'
  const long = horizontal ? r.w : r.h
  const short = horizontal ? r.h : r.w

  const rows = maxCount > 4 ? 2 : 1
  const perRow = rows === 1 ? maxCount : Math.ceil(maxCount / 2)
  const row = rows === 1 ? 0 : Math.floor(slot / perRow)
  const col = rows === 1 ? slot : slot % perRow
  const colsInRow = rows === 1 ? maxCount : Math.min(perRow, maxCount - row * perRow)

  const along = colsInRow <= 1 ? 0 : (col / (colsInRow - 1) - 0.5) * long * spread
  // Negative offset = toward the outer edge (band sits on the inner edge).
  const across = (rows === 1 ? 0 : row - 0.5) * short * 0.34 + short * 0.06

  let u = r.cx
  let v = r.cy
  if (horizontal) {
    u += along
    v += r.side === 'bottom' ? across : -across
  } else {
    v += along
    u += r.side === 'left' ? across : -across
  }

  return { u, v }
}

/** World-space variant of {@link tokenSpotUV}. */
export function tokenSpot(index: number, slot: number, count: number): TokenSpot {
  const { u, v } = tokenSpotUV(index, slot, count)
  const w = toWorld(u, v)
  return { x: w.x, z: w.z, y: TOKEN_TOP }
}

/** Centre of a building slot on an owned street (houses/hotels sit on the outer edge). */
export function buildingSpot(index: number, offset = 0): { x: number; z: number } {
  const r = tileRect(index)
  const horizontal = r.side === 'bottom' || r.side === 'top'
  const along = offset * (horizontal ? r.w : r.h) * 0.3
  let u = r.cx
  let v = r.cy
  if (horizontal) {
    u += along
    v += (r.side === 'bottom' ? 1 : -1) * r.h * 0.3
  } else {
    v += along
    u += (r.side === 'left' ? 1 : -1) * r.w * 0.3
  }
  const w = toWorld(u, v)
  return { x: w.x, z: w.z }
}

/** Camera distance chosen so the WORLD_SIZE square exactly fills a square viewport. */
export const OVERLAY_CAM_DIST = 9
/** Vertical field of view (degrees) that makes the board exactly fill the canvas. */
export function overlayFovDeg(): number {
  return (2 * Math.atan(WORLD_SIZE / 2 / OVERLAY_CAM_DIST) * 180) / Math.PI
}
