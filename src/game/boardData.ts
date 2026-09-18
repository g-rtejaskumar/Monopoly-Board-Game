/**
 * BoardQuest board definition — a complete 40-space property-trading board.
 * Classic structure (corners at 0/10/20/30, 9 spaces per side) with original
 * BoardQuest names, groups, prices and rent tables. Every renderer (3D tiles,
 * property cards) and the authoritative server read from this single dataset.
 */

export type TileType =
  | 'start'
  | 'property'
  | 'railroad'
  | 'utility'
  | 'chance'
  | 'community'
  | 'tax'
  | 'jail'
  | 'free-parking'
  | 'go-to-jail'

export type GroupId = 'brown' | 'skyblue' | 'pink' | 'orange' | 'red' | 'yellow' | 'green' | 'blue'

/** Group identity colors (tile headers, deeds, building tints). */
export const GROUP_COLORS: Record<GroupId, { hex: string; light: string; label: string }> = {
  brown: { hex: '#9c6b46', light: '#c39772', label: 'Brown' },
  skyblue: { hex: '#6fc3e8', light: '#a8ddf2', label: 'Sky' },
  pink: { hex: '#d972a0', light: '#eda6c4', label: 'Rose' },
  orange: { hex: '#ef9330', light: '#f7bd7f', label: 'Orange' },
  red: { hex: '#e05548', light: '#f0968d', label: 'Red' },
  yellow: { hex: '#f0c24b', light: '#f7dd96', label: 'Yellow' },
  green: { hex: '#43a86b', light: '#8ecba4', label: 'Green' },
  blue: { hex: '#4a6fd4', light: '#9ab0ea', label: 'Blue' },
}

export interface BoardTile {
  id: string
  index: number
  name: string
  type: TileType
  colorGroup?: GroupId
  /** Purchase price for property / railroad / utility. */
  price?: number
  /**
   * Rent table.
   *  - property: [base, 1 house, 2 houses, 3 houses, 4 houses, hotel]
   *  - railroad: [1 owned, 2 owned, 3 owned, 4 owned]
   *  - utility:  [dice × base, dice × with color set]
   */
  rent?: number[]
  mortgageValue?: number
  houseCost?: number
  hotelCost?: number
  /** Flat amount for tax tiles. */
  taxAmount?: number
}

/** Full property record shape (used by the property card UI). */
export interface PropertyData {
  id: string
  name: string
  colorGroup?: GroupId
  purchasePrice: number
  baseRent: number
  rentWithColorSet: number
  rentWithHouses: number[]
  rentWithHotel: number
  mortgageValue: number
  houseCost?: number
  hotelCost?: number
  /** Live state (mirrored from the server snapshot by the UI). */
  ownerId: string | null
  houses: number
  hotel: boolean
}

const P = (
  index: number,
  id: string,
  name: string,
  colorGroup: GroupId,
  price: number,
  rent: [number, number, number, number, number, number],
  houseCost: number,
): BoardTile => ({
  id,
  index,
  name,
  type: 'property',
  colorGroup,
  price,
  rent,
  mortgageValue: Math.round(price / 2),
  houseCost,
  hotelCost: houseCost,
})

const R = (index: number, id: string, name: string): BoardTile => ({
  id,
  index,
  name,
  type: 'railroad',
  price: 200,
  rent: [25, 50, 100, 200],
  mortgageValue: 100,
})

const U = (index: number, id: string, name: string): BoardTile => ({
  id,
  index,
  name,
  type: 'utility',
  price: 150,
  rent: [4, 10],
  mortgageValue: 75,
})

/** The complete 40-space loop, in movement order. */
export const TILES: BoardTile[] = [
  { id: 'start', index: 0, name: 'Start', type: 'start' },
  P(1, 'old-harbor', 'Old Harbor', 'brown', 60, [2, 10, 30, 90, 160, 250], 50),
  { id: 'community-1', index: 2, name: 'Community Fund', type: 'community' },
  P(3, 'fisherman-row', 'Fisherman Row', 'brown', 80, [4, 20, 60, 180, 320, 450], 50),
  { id: 'city-tax', index: 4, name: 'City Tax', type: 'tax', taxAmount: 200 },
  R(5, 'grand-terminal', 'Grand Terminal'),
  P(6, 'lighthouse-lane', 'Lighthouse Lane', 'skyblue', 100, [6, 30, 90, 270, 400, 550], 50),
  { id: 'chance-1', index: 7, name: 'Chance', type: 'chance' },
  P(8, 'bakery-square', 'Bakery Square', 'skyblue', 100, [6, 30, 90, 270, 400, 550], 50),
  P(9, 'cobble-court', 'Cobble Court', 'skyblue', 120, [8, 40, 100, 300, 450, 600], 50),
  { id: 'jail', index: 10, name: 'Jail', type: 'jail' },
  P(11, 'clocktower', 'Clocktower', 'pink', 140, [10, 50, 150, 450, 625, 750], 100),
  U(12, 'power-works', 'Power Works'),
  P(13, 'tinker-street', 'Tinker Street', 'pink', 140, [10, 50, 150, 450, 625, 750], 100),
  P(14, 'maple-market', 'Maple Market', 'pink', 160, [12, 60, 180, 500, 700, 900], 100),
  R(15, 'harbor-yards', 'Harbor Yards'),
  P(16, 'grand-arcade', 'Grand Arcade', 'orange', 180, [14, 70, 200, 550, 750, 950], 100),
  { id: 'community-2', index: 17, name: 'Community Fund', type: 'community' },
  P(18, 'printing-house', 'Printing House', 'orange', 180, [14, 70, 200, 550, 750, 950], 100),
  P(19, 'opera-garden', 'Opera Garden', 'orange', 200, [16, 80, 220, 600, 800, 1000], 100),
  { id: 'free-parking', index: 20, name: 'Free Parking', type: 'free-parking' },
  P(21, 'silversmith-way', 'Silversmith Way', 'red', 220, [18, 90, 250, 700, 875, 1050], 150),
  { id: 'chance-2', index: 22, name: 'Chance', type: 'chance' },
  P(23, 'apothecary', 'Apothecary', 'red', 220, [18, 90, 250, 700, 875, 1050], 150),
  P(24, 'observatory', 'Observatory', 'red', 240, [20, 100, 300, 750, 925, 1100], 150),
  R(25, 'kings-station', 'Kings Station'),
  P(26, 'canal-bridge', 'Canal Bridge', 'yellow', 260, [22, 110, 330, 800, 975, 1150], 150),
  P(27, 'tailor-alley', 'Tailor Alley', 'yellow', 260, [22, 110, 330, 800, 975, 1150], 150),
  U(28, 'waterworks', 'Waterworks'),
  P(29, 'university', 'University', 'yellow', 280, [24, 120, 360, 850, 1025, 1200], 150),
  { id: 'go-to-jail', index: 30, name: 'Go To Jail', type: 'go-to-jail' },
  P(31, 'glassworks', 'Glassworks', 'green', 300, [26, 130, 390, 900, 1100, 1275], 200),
  P(32, 'jewel-exchange', 'Jewel Exchange', 'green', 300, [26, 130, 390, 900, 1100, 1275], 200),
  { id: 'community-3', index: 33, name: 'Community Fund', type: 'community' },
  P(34, 'castle-keep', 'Castle Keep', 'green', 320, [28, 150, 450, 1000, 1200, 1400], 200),
  R(35, 'windmill-plaza', 'Windmill Plaza'),
  { id: 'chance-3', index: 36, name: 'Chance', type: 'chance' },
  P(37, 'marina-docks', 'Marina Docks', 'blue', 350, [35, 175, 500, 1100, 1300, 1500], 200),
  { id: 'luxury-tax', index: 38, name: 'Luxury Tax', type: 'tax', taxAmount: 100 },
  P(39, 'kings-promenade', 'Kings Promenade', 'blue', 400, [50, 200, 600, 1400, 1700, 2000], 200),
]

export function getTile(index: number): BoardTile | undefined {
  return TILES[index]
}

/** Tiles that trigger a draw (Chance / Community Fund). */
export const EVENT_INDICES: number[] = TILES.filter(
  (t) => t.type === 'chance' || t.type === 'community',
).map((t) => t.index)

export function isEventTile(index: number): boolean {
  return EVENT_INDICES.includes(index)
}

export function isCornerTile(index: number): boolean {
  return CORNER_INDICES.includes(index)
}

export function isOwnable(tile: BoardTile | undefined): boolean {
  return tile?.type === 'property' || tile?.type === 'railroad' || tile?.type === 'utility'
}

/** All tile indices belonging to a color group. */
export function groupTiles(group: GroupId): number[] {
  return TILES.filter((t) => t.colorGroup === group).map((t) => t.index)
}

export const GROUP_ORDER: GroupId[] = [
  'brown',
  'skyblue',
  'pink',
  'orange',
  'red',
  'yellow',
  'green',
  'blue',
]

/** Rent owed when landing on `index`, given buildings and the owner's monopoly. */
export function rentFor(index: number, buildings: number, hasMonopoly: boolean, diceTotal: number): number {
  const tile = TILES[index]
  if (!tile || !tile.rent) return 0
  if (tile.type === 'property') {
    if (buildings >= 5) return tile.rent[5]
    if (buildings > 0) return tile.rent[buildings]
    return hasMonopoly ? (tile.rent[0] ?? 0) * 2 : (tile.rent[0] ?? 0)
  }
  if (tile.type === 'railroad') {
    // buildings is repurposed by the server as "railroads owned by the owner"
    return tile.rent[Math.min(Math.max(buildings, 1), 4) - 1] ?? 25
  }
  if (tile.type === 'utility') {
    const mult = buildings >= 2 ? tile.rent[1] : tile.rent[0]
    return mult * Math.max(diceTotal, 1)
  }
  return 0
}

/* --------------------------- corner metadata --------------------------- */

export const CORNER_INDICES = [0, 10, 20, 30]
/** The JAIL corner tile (visiting / imprisoned). */
export const JAIL_INDEX = 10
export const CORNER_KINDS = ['start', 'jail', 'park', 'goto'] as const
export type CornerKind = (typeof CORNER_KINDS)[number]

export function cornerKindOf(index: number): CornerKind | null {
  const ci = CORNER_INDICES.indexOf(index)
  return ci >= 0 ? (CORNER_KINDS[ci] ?? null) : null
}
