/**
 * Shared board-store contract.
 *
 * The 2D board and the 3D overlay both read from this interface, so the same
 * component tree can be driven by the authoritative network store
 * (`netBoardStore`) or by the local practice-mode store (`demoBoard`) without
 * either renderer knowing which one it was handed.
 *
 * Nothing here mutates game rules — it is purely the shape of what the UI reads.
 */
import type { PlayerColor } from '../game/types'

export interface ScenePlayer {
  id: string
  name: string
  seat: number
  color: PlayerColor
  /** Chosen playing piece id (optional in practice/demo mode). */
  token?: string
  tile: number
  cash: number
  connected?: boolean
  isBot?: boolean
  inJail?: boolean
  jailTurns?: number
  getOutCards?: number
  bankrupt?: boolean
}

/** A pawn hop in flight: an interpolation between two authoritative tiles. */
export interface SceneAnim {
  seat: number
  from: number
  to: number
  /** Date.now() when the hop starts (after the dice settle). */
  start: number
  /** Hop duration in ms. */
  dur?: number
}

export type ScenePhase = 'idle' | 'rolling' | 'moving'

export interface SceneLogEntry {
  id: number
  text: string
  color: PlayerColor
}

export interface SceneState {
  players: ScenePlayer[]
  current: number
  phase: ScenePhase
  dice: [number, number]
  rollTrigger: number
  rolledAt: number
  moveAnim: SceneAnim | null
  last: { diceTotal: number; seat: number } | null
  eventTile: number | null
  buyTile: number | null
  /** tile index -> owner colour (derived from the server's owner ids). */
  owned: Record<number, PlayerColor>
  /** tile index -> house count (5 == hotel). */
  buildings: Record<number, number>
  /** tile index -> true while mortgaged. */
  mortgaged: Record<number, true>
  log: SceneLogEntry[]
}

/** Read-only store: every renderer needs only this. */
export interface SceneStore {
  get: () => SceneState
  subscribe: (l: () => void) => () => void
}

/** Writable store used by practice mode (the net store is driven by snapshots). */
export interface BoardStore extends SceneStore {
  set: (fn: (s: SceneState) => void) => void
}
