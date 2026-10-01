/**
 * Board2D — the fixed, readable 2D board.
 *
 * Pure DOM + CSS (no raster image, no 3D camera). Every one of the 40 tiles is
 * generated from the authoritative tile data and positioned from the single
 * geometry source of truth in `./geometry`, so the board can never disagree
 * with the token overlay, the property card or the game log.
 *
 * The board is always readable and interactive even if WebGL is unavailable:
 * tokens and buildings fall back to DOM markers (`showDomTokens`).
 */
import type { CSSProperties, ReactNode } from 'react'
import { TILES, GROUP_COLORS, getTile } from '../game/boardData'
import type { BoardTile, GroupId } from '../game/boardData'
import { PLAYER_COLORS } from '../game/types'
import type { PlayerColor } from '../game/types'
import { bandEdge, tileRect, tokenSpotUV } from './geometry'
import type { SceneState } from './types'
import './Board2D.css'

/** Large, recognisable icon language for the special (non-property) tiles. */
const TILE_ICON: Record<string, string> = {
  start: '🏁',
  jail: '⛓️',
  'free-parking': '🅿️',
  'go-to-jail': '🚔',
  chance: '❓',
  community: '🎁',
  tax: '💸',
  railroad: '🚂',
  utility: '💡',
}

/** Short labels for the corners/specials so they stay legible when small. */
const TILE_SHORT: Record<string, string> = {
  start: 'START',
  jail: 'JAIL',
  'free-parking': 'PARKING',
  'go-to-jail': 'GO TO JAIL',
  chance: 'CHANCE',
  community: 'FUND',
}

function tileLabel(tile: BoardTile): string {
  return tile.type === 'property' || tile.type === 'railroad' || tile.type === 'utility'
    ? tile.name
    : TILE_SHORT[tile.type] ?? tile.name
}

/**
 * Short form shown when the board is too small to print full names (phones).
 * "Lighthouse Lane" → "LL", "University" → "UNI". The colour band still carries
 * the group, and tapping the tile opens the full property card.
 */
function tileAbbrev(tile: BoardTile): string {
  const label = tileLabel(tile)
  // Specials keep their whole (already short) word: START, JAIL, CHANCE…
  if (tile.type !== 'property' && tile.type !== 'railroad' && tile.type !== 'utility') {
    return label.toUpperCase()
  }
  const words = label.split(/[\s-]+/).filter(Boolean)
  // Multi-word names → initials (Lighthouse Lane → LL); single words → first 3.
  if (words.length > 1) return words.map((w) => w[0]?.toUpperCase() ?? '').join('')
  return label.slice(0, 3).toUpperCase()
}

export interface Board2DProps {
  state: SceneState
  youId?: string | null
  selectedTile: number | null
  onSelectTile: (index: number) => void
  /** Render DOM token/building markers (used when the 3D overlay is off). */
  showDomTokens?: boolean
  /** The 3D overlay is mounted here, above the tiles and the centre. */
  children?: ReactNode
}

export function Board2D({
  state,
  youId = null,
  selectedTile,
  onSelectTile,
  showDomTokens = false,
  children,
}: Board2DProps) {
  const current = state.players[state.current]
  const turnText = current ? `${current.name}'s turn` : 'Setting up…'
  const diceText = state.last
    ? `${state.last.diceTotal}`
    : `${state.dice[0]} + ${state.dice[1]}`

  // Group players by tile so token slots are stable and never overlap.
  const byTile = new Map<number, Array<{ id: string; name: string; color: PlayerColor; seat: number }>>()
  for (const p of state.players) {
    if (p.bankrupt) continue
    const list = byTile.get(p.tile) ?? []
    list.push({ id: p.id, name: p.name, color: p.color, seat: p.seat })
    byTile.set(p.tile, list)
  }

  return (
    <div className="bq-board" data-testid="board2d" role="group" aria-label="Game board">
      <div className="bq-board-inner">
        <div className="bq-center" aria-hidden="true">
          <div className="bq-wordmark">
            <span className="bq-wordmark-dot" />
            BOARDQUEST
          </div>
          <div className="bq-center-mid" />
          <div className="bq-center-foot">
            <span className="bq-center-turn">{turnText}</span>
            <span className="bq-center-dice" data-testid="board-dice-result">
              {state.last ? `LAST ROLL ${diceText}` : `DICE ${state.dice[0]} · ${state.dice[1]}`}
            </span>
          </div>
        </div>

        {TILES.map((tile) => {
          const rect = tileRect(tile.index)
          const gc = tile.colorGroup ? GROUP_COLORS[tile.colorGroup] : null
          const owner = state.owned[tile.index]
          const buildings = state.buildings[tile.index] ?? 0
          const mortgaged = Boolean(state.mortgaged[tile.index])
          const occupants = byTile.get(tile.index) ?? []
          const isSelected = selectedTile === tile.index
          const hasCurrent = occupants.some((o) => o.id === current?.id)
          const edge = bandEdge(tile.index)
          const price = tile.price ?? null

          const ownerName = owner
            ? state.players.find((p) => p.color === owner)?.name ?? 'claimed'
            : null
          const aria = [
            `Tile ${tile.index}`,
            tileLabel(tile),
            gc ? `${gc.label} group` : null,
            price != null ? `price M ${price}` : null,
            ownerName ? `owned by ${ownerName}` : 'unowned',
            buildings >= 5 ? 'hotel' : buildings > 0 ? `${buildings} houses` : null,
            mortgaged ? 'mortgaged' : null,
          ]
            .filter(Boolean)
            .join(', ')

          return (
            <button
              key={tile.index}
              type="button"
              className={[
                'bq-tile',
                `bq-tile--${tile.type}`,
                gc ? `bq-group-${tile.colorGroup as GroupId}` : '',
                `bq-side-${rect.side}`,
                owner ? 'is-owned' : '',
                mortgaged ? 'is-mortgaged' : '',
                isSelected ? 'is-selected' : '',
                hasCurrent ? 'has-current' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={
                {
                  left: `${rect.u * 100}%`,
                  top: `${rect.v * 100}%`,
                  width: `${rect.w * 100}%`,
                  height: `${rect.h * 100}%`,
                  ...(gc ? { '--bq-band': gc.hex, '--bq-band-light': gc.light } : {}),
                  ...(owner ? { '--bq-owner': PLAYER_COLORS[owner].hex } : {}),
                } as CSSProperties
              }
              data-tile={tile.index}
              data-type={tile.type}
              data-group={tile.colorGroup ?? ''}
              data-side={rect.side}
              data-owner={owner ?? ''}
              aria-label={aria}
              aria-pressed={isSelected}
              onClick={() => onSelectTile(tile.index)}
            >
              {edge && gc && <span className={`bq-band bq-band--${edge}`} aria-hidden="true" />}
              {owner && (
                <span
                  className="bq-owner-mark"
                  style={{ background: PLAYER_COLORS[owner].hex }}
                  aria-hidden="true"
                />
              )}
              <span className="bq-tile-body">
                {gc || tile.type !== 'property' ? (
                  <span className="bq-icon" aria-hidden="true">
                    {TILE_ICON[tile.type] ?? '•'}
                  </span>
                ) : null}
                <span className="bq-name">{tileLabel(tile)}</span>
                <span className="bq-abbr" aria-hidden="true">
                  {tileAbbrev(tile)}
                </span>
                {price != null && <span className="bq-price">M {price}</span>}
                {buildings > 0 && (
                  <span className="bq-buildings" aria-hidden="true">
                    {buildings >= 5 ? '🏨' : '🏠'.repeat(Math.min(buildings, 4))}
                  </span>
                )}
              </span>
              {showDomTokens && occupants.length > 0 && (
                <span className="bq-dom-tokens" aria-hidden="true">
                  {occupants.map((o, slot) => {
                    const spot = tokenSpotUV(tile.index, slot, occupants.length)
                    const left = ((spot.u - rect.u) / rect.w) * 100
                    const top = ((spot.v - rect.v) / rect.h) * 100
                    return (
                      <span
                        key={o.id}
                        className={`bq-dom-token ${o.id === youId ? 'is-you' : ''}`}
                        data-seat={o.seat}
                        title={o.name}
                        style={{ left: `${left}%`, top: `${top}%`, background: PLAYER_COLORS[o.color].hex }}
                      >
                        {o.name.slice(0, 1).toUpperCase()}
                      </span>
                    )
                  })}
                </span>
              )}
            </button>
          )
        })}

        {children}
      </div>
    </div>
  )
}

/** True when the tile can be bought / built on — used by hover styling. */
export function tileIsOwnable(index: number): boolean {
  const t = getTile(index)
  return t?.type === 'property' || t?.type === 'railroad' || t?.type === 'utility'
}
