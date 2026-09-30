/**
 * A BoardStore implementation driven by authoritative server snapshots.
 *
 * Movement is a *view* of server state, never a replacement for it:
 *
 *   roll broadcast   (phase 'rolling', pawns not yet moved) -> dice animation
 *   landing broadcast(phase 'buy'|'event'|'jail'|'auction'|'debt'|'idle')
 *                                                           -> pawn hop
 *
 * Design rules that keep the pawn and the server in agreement:
 *   1. `latest` always holds the newest authoritative snapshot, and every
 *      rendered value is re-derived from it — no incremental merging, so a
 *      snapshot arriving mid-animation can never leave stale local state behind.
 *   2. A hop is only in flight while `anim` is set. When it ends, the store
 *      falls back to the snapshot's own tile, so the pawn ALWAYS eventually
 *      equals the authoritative position (never left at GO).
 *   3. The hop ends when the server confirms the destination tile (plus a
 *      safety timer), and `phase` returns to 'idle' with it — so a turn can
 *      never appear stuck at "X is moving…" for the next player.
 */
import { PLAYER_COLORS } from '../game/types'
import type { PlayerColor } from '../game/types'
import { BOARD_SIZE } from './protocol'
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

/** A pawn hop in progress: an interpolation between two authoritative tiles. */
export interface BoardMoveAnim {
  seat: number
  from: number
  to: number
  /** Date.now() when the hop starts (after the dice settle). */
  start: number
  /** Hop duration in ms — the 3D pawn derives its progress from it. */
  dur: number
}

export interface BoardStateShape {
  players: BoardPlayer[]
  current: number
  phase: BoardPhase
  dice: [number, number]
  rollTrigger: number
  rolledAt: number
  moveAnim: BoardMoveAnim | null
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

/* ------------------------------ animation timing ------------------------------ */
// These mirror the server's move schedule (rooms.ts rollAndMove) so the local
// hop finishes at the same moment the landing snapshot is published.

/** Dice tumble before the pawn starts hopping. */
const ROLL_SETTLE_MS = 1150
const HOP_BASE_MS = 260
const HOP_PER_TILE_MS = 150
/** Safety net: never hold a hop open longer than its duration plus this. */
const HOP_GRACE_MS = 4000
/** Window in which a confirmed hop suppresses a duplicate sync-hop. */
const HOP_DEDUPE_MS = 10_000

/**
 * Browser timers, resolved through globalThis so this module needs no DOM lib
 * types — the server typecheck and the Node regression suite both import it. In
 * the app it is simply `window`.
 */
interface TimerHost {
  setTimeout: (fn: () => void, ms?: number) => number
  clearTimeout: (id: number) => void
}
function timerHost(): TimerHost {
  const g = globalThis as unknown as { window?: TimerHost }
  return g.window ?? (globalThis as unknown as TimerHost)
}

function hopDuration(from: number, to: number): number {
  const steps = to >= from ? to - from : to + BOARD_SIZE - from
  return HOP_BASE_MS + steps * HOP_PER_TILE_MS
}

function emptyState(): BoardStateShape {
  return {
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

  /** Newest authoritative snapshot — the single source of truth for the board. */
  let latest: GameSnapshot | null = null
  let lastRollId = -1
  let rollTrigger = 0
  let last: { diceTotal: number; seat: number } | null = null

  /** In-flight hop. One at a time: the game moves exactly one pawn per turn. */
  let anim: (BoardMoveAnim & { stage: 'rolling' | 'moving' }) | null = null
  let settleTimer: number | null = null
  let graceTimer: number | null = null
  /** The tile each pawn is visually standing on, keyed by seat. */
  const rendered = new Map<number, number>()
  /** Last hop we finished, so a late landing snapshot cannot replay it. */
  let finishedHop: { seat: number; to: number; at: number } | null = null

  const store: BoardStoreShape = {
    get: () => {
      if (!state) state = emptyState()
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

  function clearTimers(): void {
    const timers = timerHost()
    if (settleTimer !== null) {
      timers.clearTimeout(settleTimer)
      settleTimer = null
    }
    if (graceTimer !== null) {
      timers.clearTimeout(graceTimer)
      graceTimer = null
    }
  }

  /**
   * Re-derive the whole visual state from `latest`. Deriving instead of merging
   * is what makes an animation and an interleaved snapshot deterministic: the
   * authoritative values are always the ones the server last sent, and only the
   * in-flight hop is layered on top.
   */
  function buildState(): BoardStateShape {
    if (!latest) return emptyState()
    const next = fromSnapshot(latest)
    next.rollTrigger = rollTrigger
    next.last = last
    if (anim) {
      next.phase = anim.stage
      next.moveAnim =
        anim.stage === 'moving'
          ? { seat: anim.seat, from: anim.from, to: anim.to, start: anim.start, dur: anim.dur }
          : null
    } else {
      next.phase = 'idle'
      next.moveAnim = null
    }
    for (const p of next.players) {
      rendered.set(p.seat, anim && anim.seat === p.seat ? anim.to : p.tile)
    }
    return next
  }

  function emit(): void {
    state = buildState()
    notify()
  }

  /** End the in-flight hop: from here the pawn sits on the authoritative tile. */
  function finishAnim(): void {
    if (!anim) return
    const done = anim
    clearTimers()
    anim = null
    finishedHop = { seat: done.seat, to: done.to, at: Date.now() }
    emit()
  }

  function armGrace(): void {
    const timers = timerHost()
    if (graceTimer !== null) timers.clearTimeout(graceTimer)
    const wait = (anim?.dur ?? 0) + HOP_GRACE_MS
    graceTimer = timers.setTimeout(() => {
      graceTimer = null
      finishAnim()
    }, wait)
  }

  /**
   * Start hopping a pawn from `from` to `to`. `settleMs` is the dice tumble that
   * precedes the hop for a real roll; server-driven syncs (card moves, jail,
   * a roll we missed) hop immediately.
   */
  function runHop(seat: number, from: number, to: number, settleMs: number, withDice: boolean): void {
    clearTimers()
    anim = {
      seat,
      from,
      to,
      start: Date.now() + settleMs,
      dur: hopDuration(from, to),
      stage: withDice ? 'rolling' : 'moving',
    }
    emit()
    if (settleMs > 0) {
      settleTimer = timerHost().setTimeout(() => {
        settleTimer = null
        if (!anim) return
        anim.stage = 'moving'
        anim.start = Date.now()
        emit()
        armGrace()
      }, settleMs)
    } else {
      armGrace()
    }
  }

  function onServerMsg(g: GameSnapshot): void {
    const previous = latest
    latest = g

    const isNewRoll = g.rollId !== lastRollId && g.phase === 'rolling'
    lastRollId = g.rollId

    if (isNewRoll) {
      const mover = g.players[g.current]
      if (mover) {
        const from = mover.tile
        const total = (g.dice[0] || 1) + (g.dice[1] || 1)
        const to = (from + total) % BOARD_SIZE
        rollTrigger += 1
        last = { diceTotal: total, seat: mover.seat }
        runHop(mover.seat, from, to, ROLL_SETTLE_MS, true)
        return
      }
    }

    if (anim) {
      const owner = g.players.find((p) => p.seat === anim?.seat)
      if (owner) {
        // The server moved this pawn somewhere other than where the hop was
        // heading (Go To Jail, a card that relocates): hop on to the REAL tile.
        if (owner.tile !== anim.from && owner.tile !== anim.to) {
          runHop(anim.seat, anim.to, owner.tile, 0, false)
          return
        }
        // Destination confirmed and the hop has played out → release the state
        // so `phase` returns to 'idle' and the next player can act.
        if (owner.tile === anim.to && anim.stage === 'moving' && Date.now() - anim.start >= anim.dur) {
          finishAnim()
          return
        }
      }
    } else if (previous) {
      // No roll involved, yet a pawn is standing somewhere new (card movement,
      // jail, or a roll broadcast we missed while reconnecting). Animate it so
      // every client eventually shows the authoritative position.
      for (const p of g.players) {
        const shown = rendered.get(p.seat)
        if (shown === undefined || shown === p.tile) continue
        if (
          finishedHop &&
          finishedHop.seat === p.seat &&
          finishedHop.to === p.tile &&
          Date.now() - finishedHop.at < HOP_DEDUPE_MS
        ) {
          break // this move was already animated by the hop that just finished
        }
        runHop(p.seat, shown, p.tile, 0, false)
        return
      }
    }

    emit()
  }

  return { store, onServerMsg }
}
