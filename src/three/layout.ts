/**
 * Board layout math — 40-tile square loop.
 * Corners at indices 0, 10, 20, 30 (counter-clockwise from the bottom-right
 * START corner), with 9 street tiles per side.
 */

export const BOARD_HALF = 7.5 // half-size of the board slab (15-unit square tabletop)
export const CORNER_SIZE = 1.9
export const TILE_W = (2 * BOARD_HALF - 2 * CORNER_SIZE) / 9 // street tile width (~1.24)
export const TILE_D = CORNER_SIZE // street tile depth (toward the center, like the physical game)
export const BOARD_TOP = 0 // top surface of the slab

export const CORNER_INDICES = [0, 10, 20, 30]

/** [x, z] center of each of the 40 tiles on the board plane (y = up). */
export const TILE_POS: Array<[number, number]> = (() => {
  const positions: Array<[number, number]> = []
  const edge = BOARD_HALF - CORNER_SIZE / 2 // corner center offset (6.55)
  const inner = BOARD_HALF - CORNER_SIZE - TILE_W / 2 // first street center
  const step = TILE_W

  // 0: START corner (bottom-right)
  positions.push([edge, edge])
  // 1-9: bottom side, moving left
  for (let m = 0; m < 9; m++) positions.push([inner - m * step, BOARD_HALF - TILE_D / 2])
  // 10: JAIL corner (bottom-left)
  positions.push([-edge, edge])
  // 11-19: left side, moving up
  for (let m = 0; m < 9; m++) positions.push([-(BOARD_HALF - TILE_D / 2), inner - m * step])
  // 20: PARK corner (top-left)
  positions.push([-edge, -edge])
  // 21-29: top side, moving right
  for (let m = 0; m < 9; m++) positions.push([-(inner - m * step), -(BOARD_HALF - TILE_D / 2)])
  // 30: GO TO JAIL corner (top-right)
  positions.push([edge, -edge])
  // 31-39: right side, moving down
  for (let m = 0; m < 9; m++) positions.push([BOARD_HALF - TILE_D / 2, -(inner - m * step)])

  return positions
})()

/** Where a pawn of `seat` (0-7) stands on tile `index` (slightly inside the tile). */
export function pawnSpot(index: number, seat: number): [number, number] {
  const [x, z] = TILE_POS[index]
  const isCorner = CORNER_INDICES.includes(index)
  const inset = isCorner ? 0.3 : TILE_D / 2 - 0.45

  // inward direction (toward board center)
  const len = Math.max(Math.hypot(x, z), 0.0001)
  const ix = -x / len
  const iz = -z / len
  // perpendicular direction (along the side)
  const px = -iz
  const pz = ix

  // fan the seats out along the side, with slight depth stagger
  const along = (seat - 1.5) * 0.3
  const depth = inset + (seat % 2 === 0 ? -0.06 : 0.1)

  return [x + px * along + ix * depth, z + pz * along + iz * depth]
}

/** Optional per-tile rotation (radians) for decorative props. */
export function tileFacingCenterRotation(index: number): number {
  const [x, z] = TILE_POS[index]
  return Math.atan2(-x, -z) // face the board center
}

export const SIDE_ROTS = [0, -Math.PI / 2, Math.PI, Math.PI / 2] // south, west, north, east
export const CORNER_ROTS = [Math.PI / 4, -Math.PI / 4, -3 * (Math.PI / 4), 3 * (Math.PI / 4)]

export function sideOfTile(index: number): 0 | 1 | 2 | 3 {
  if (index < 10) return 0
  if (index < 20) return 1
  if (index < 30) return 2
  return 3
}

/** Y rotation that aligns a tile's texture with its side of the board. */
export function tileRotationY(index: number): number {
  const ci = CORNER_INDICES.indexOf(index)
  if (ci >= 0) return CORNER_ROTS[ci] ?? 0
  return SIDE_ROTS[sideOfTile(index)] ?? 0
}
