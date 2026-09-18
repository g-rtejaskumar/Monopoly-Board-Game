/**
 * A BoardStore implementation driven by authoritative server snapshots.
 * Preserves the get/set/subscribe interface the 3D scene expects while
 * deriving animations from the server's two-broadcast flow:
 *   1) roll broadcast (phase 'rolling', pawns not yet moved) -> dice animation
 *   2) landing broadcast (tile/cash/buy/event/turn applied) -> pawn hop
 */
import { PLAYER_COLORS } from '../game/types'
import type { PlayerColor } from '../game/types'
import type { GameSnapshot, GamePlayer } from './protocol'

export interface BoardPlayer {
  id: string
  name: string
  seat: number
  color: PlayerColor
  tile: number
  cash: number
  connected?: boolean
  isBot?: boolean
  inJail?: boolean
  jailTurns?: number
  getOutCards?: number
  bankrupt?: boolean
}

export type BoardPhase = 'idle' | 'rolling' | 'moving'

export interface BoardStateShape {
  players: BoardPlayer[]
  current: number
  phase: BoardPhase
  dice: [number, number]
  rollTrigger: number
  rolledAt: number
  moveAnim: { seat: number; from: number; to: number; start: number } | null
  last: { diceTotal: number; seat: number } | null
  eventTile: number | null
  buyTile: number | null
  /** tile index -> owner color (derived from server owner ids). */
  owned: Record<number, PlayerColor>
  /** tile index -> house count (5 == hotel). */
  buildings: Record<number, number>
  /** tile index -> true while mortgaged. */
  mortgaged: Record<number, true>
  log: Array<{ id: number; text: string; color: PlayerColor }>
}

export interface BoardStoreShape {
  get: () => BoardStateShape
  set: (fn: (s: BoardStateShape) => void) => void
  subscribe: (l: () => void) => () => void
}

function asColor(hex: string): PlayerColor {
  const entries = Object.entries(PLAYER_COLORS) as Array<[PlayerColor, { hex: string }]>
  const found = entries.find((pair) => pair[1].hex.toLowerCase() === hex.toLowerCase())
  return found ? found[0] : 'amber'
}

function fromSnapshot(g: GameSnapshot): BoardStateShape {
  const players = g.players.map((p: GamePlayer, i: number) => ({
    id: p.id,
    name: p.name,
    seat: typeof p.seat === 'number' ? p.seat : i,
    color: asColor(p.color),
    tile: p.tile,
    cash: p.cash,
    connected: p.connected,
    isBot: p.isBot,
    inJail: p.inJail ?? false,
    jailTurns: p.jailTurns ?? 0,
    getOutCards: p.getOutCards ?? 0,
    bankrupt: p.bankrupt ?? false,
  }))
  // Server keys ownership by player id — derive tile colors for rendering.
  const colorOfId = new Map<string, PlayerColor>(players.map((p) => [p.id, p.color]))
  const owned: Record<number, PlayerColor> = {}
  for (const pair of Object.entries(g.owned || {})) {
    const color = colorOfId.get(pair[1])
    if (color) owned[Number(pair[0])] = color
  }
  const buildings: Record<number, number> = {}
  for (const pair of Object.entries(g.buildings || {})) {
    const n = Number(pair[1])
    if (n > 0) buildings[Number(pair[0])] = n
  }
  const mortgaged: Record<number, true> = {}
  for (const key of Object.keys(g.mortgaged || {})) {
    mortgaged[Number(key)] = true
  }
  const log = (g.log || []).slice(-40).map((e) => ({
    id: e.id,
    text: e.text,
    color: asColor(e.color),
  }))
  return {
    players,
    current: g.current,
    phase: 'idle',
    dice: [g.dice[0] || 1, g.dice[1] || 1],
    rollTrigger: 0,
    rolledAt: g.rolledAt || 0,
    moveAnim: null,
    last: null,
    eventTile: g.eventTile,
    buyTile: g.buyTile,
    owned,
    buildings,
    mortgaged,
    log,
  }
}

export function createNetBoardStore(): {
  store: BoardStoreShape
  onServerMsg: (g: GameSnapshot) => void
} {
  let state: BoardStateShape | null = null
  const subs = new Set<() => void>()
  const notify = () => {
    subs.forEach((l) => l())
  }

  let lastRollId = -1
  let moveTimer: number | null = null
  let animating: { seat: number; from: number; to: number } | null = null

  const store: BoardStoreShape = {
    get: () => {
      if (!state) {
        state = {
          players: [],
          current: 0,
          phase: 'idle',
          dice: [1, 1],
          rollTrigger: 0,
          rolledAt: 0,
          moveAnim: null,
          last: null,
          eventTile: null,
          buyTile: null,
          owned: {},
          buildings: {},
          mortgaged: {},
          log: [],
        }
      }
      return state
    },
    set: (fn) => {
      if (!state) return
      fn(state)
      notify()
    },
    subscribe: (l) => {
      subs.add(l)
      return () => {
        subs.delete(l)
      }
    },
  }

  function clearMoveTimer(): void {
    if (moveTimer !== null) {
      window.clearTimeout(moveTimer)
      moveTimer = null
    }
  }

  function onServerMsg(g: GameSnapshot): void {
    const prev = state

    // First snapshot ever: adopt as-is.
    if (!prev) {
      state = fromSnapshot(g)
      lastRollId = g.rollId
      notify()
      return
    }

    const isNewRoll = g.rollId !== lastRollId && g.phase === 'rolling'

    if (isNewRoll) {
      // Dice broadcast: pawns have not moved yet in this snapshot.
      lastRollId = g.rollId
      const current = g.players[g.current]
      const seat = current ? current.seat : 0
      const mover = prev.players.find((p) => p.seat === seat)
      const from = mover ? mover.tile : 0
      const total = (g.dice[0] || 1) + (g.dice[1] || 1)
      const to = (from + total) % 40

      const next = fromSnapshot(g)
      next.phase = 'rolling'
      next.rollTrigger = prev.rollTrigger + 1
      next.rolledAt = Date.now()
      next.last = { diceTotal: total, seat }
      next.moveAnim = null
      state = next
      notify()

      // Animate the pawn locally after the dice settle. The server landing
      // snapshot will confirm the final tile shortly after the hop finishes.
      clearMoveTimer()
      animating = { seat, from, to }
      moveTimer = window.setTimeout(() => {
        moveTimer = null
        if (!state || !animating) return
        state.phase = 'moving'
        state.moveAnim = {
          seat: animating.seat,
          from: animating.from,
          to: animating.to,
          start: Date.now(),
        }
        notify()
      }, 1150)
      return
    }

    if (g.rollId !== lastRollId) {
      // A roll we missed (e.g. reconnect): adopt the snapshot without animation.
      lastRollId = g.rollId
      clearMoveTimer()
      animating = null
      state = fromSnapshot(g)
      notify()
      return
    }

    // Same roll: landing/resolution snapshot. Confirm pawn position and merge.
    const next = fromSnapshot(g)
    if (animating) {
      const target = animating
      const mover = next.players.find((p) => p.seat === target.seat)
      if (mover && mover.tile === target.to) {
        // Preserve the in-flight hop so visuals stay smooth until it completes.
        next.moveAnim = prev.moveAnim
        next.phase = prev.phase === 'moving' || prev.phase === 'rolling' ? prev.phase : next.phase
      } else {
        animating = null
      }
    }
    if (moveTimer !== null && prev.phase === 'rolling') {
      next.phase = 'rolling'
    }
    state = next
    notify()
  }

  return { store, onServerMsg }
}
