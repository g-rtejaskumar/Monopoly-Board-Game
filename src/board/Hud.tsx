/**
 * HUD pieces shared by the online and practice tables.
 *
 * The action dock is the single "what can I do right now" area: it is the
 * bottom grid row on desktop and a sticky bar on mobile, so the primary action
 * (Roll / Buy / Bid / Pay / End turn) is never below the fold.
 */
import type { ReactNode } from 'react'
import { PLAYER_COLORS } from '../game/types'
import type { PlayerColor } from '../game/types'
import type { ScenePlayer } from './types'

export interface ActionInfo {
  isMyTurn: boolean
  currentName: string | null
  currentColor?: PlayerColor
  /** Your cash, when known. */
  meCash?: number
  /** The tile you (or the player who acted last) is standing on. */
  myTileName?: string
  /** Dice shown on the last authoritative roll. */
  lastRoll?: { dice: [number, number]; total: number; byName: string } | null
  /** Human-readable current state ("Auction in progress…"). */
  status?: string
  /** True while an animation is playing. */
  busy?: boolean
}

export function ActionDock({ info, children }: { info: ActionInfo; children?: ReactNode }) {
  const { isMyTurn, currentName } = info
  const who = isMyTurn ? 'YOUR TURN' : currentName ? `${currentName}'s turn` : 'Setting up…'
  return (
    <div
      className={`action-dock ${isMyTurn ? 'is-you' : ''} ${info.busy ? 'is-busy' : ''}`}
      data-testid="action-dock"
      data-turn={isMyTurn ? 'you' : 'them'}
    >
      {/* Screen-reader announcement of whose turn it is and the dice result. */}
      <p className="sr-only" role="status" aria-live="polite" data-testid="turn-announce">
        {who}
        {info.lastRoll ? `. ${info.lastRoll.byName} rolled ${info.lastRoll.total}.` : ''}
      </p>

      <div className="action-status">
        <span className={`action-who ${isMyTurn ? 'you' : ''}`}>{who}</span>
        {info.meCash != null && (
          <span className="action-cash" data-testid="action-cash">
            M {info.meCash.toLocaleString()}
          </span>
        )}
        {info.myTileName && <span className="action-tile">{info.myTileName}</span>}
      </div>

      {info.lastRoll && (
        <div className="action-roll" data-testid="last-roll">
          <span className="action-roll-dice">
            {info.lastRoll.dice[0]} + {info.lastRoll.dice[1]}
          </span>
          <span className="action-roll-total">= {info.lastRoll.total}</span>
          <span className="action-roll-by">{info.lastRoll.byName}</span>
        </div>
      )}

      {info.status && <div className="action-note">{info.status}</div>}

      <div className="action-buttons">{children}</div>
    </div>
  )
}

/** Compact horizontal player strip for phones. */
export function PlayerStrip({
  players,
  current,
  youId,
  onOpen,
}: {
  players: ScenePlayer[]
  current: number
  youId: string | null
  onOpen?: () => void
}) {
  return (
    <div className="player-strip" role="list" aria-label="Players">
      {players.map((p, i) => (
        <button
          key={p.id}
          type="button"
          role="listitem"
          className={`strip-player ${i === current ? 'active' : ''} ${p.bankrupt ? 'bankrupt' : ''} ${
            p.connected === false ? 'offline' : ''
          }`}
          onClick={onOpen}
          aria-label={`${p.name}${p.id === youId ? ', you' : ''}, M ${p.cash}${
            i === current ? ', their turn' : ''
          }${p.bankrupt ? ', bankrupt' : ''}`}
        >
          <span className="strip-dot" style={{ background: PLAYER_COLORS[p.color].hex }} />
          <span className="strip-body">
            <span className="strip-name">
              {p.name}
              {p.id === youId ? ' (you)' : ''}
            </span>
            <span className="strip-cash">M {p.cash.toLocaleString()}</span>
          </span>
          {i === current && !p.bankrupt && <span className="strip-live" aria-hidden="true">🎲</span>}
          {p.bankrupt && <span className="strip-out">out</span>}
          {p.connected === false && !p.bankrupt && <span className="strip-off">…</span>}
        </button>
      ))}
    </div>
  )
}

export type SheetTab = 'players' | 'property' | 'log'

/** Tab bar shown inside the mobile bottom sheet. */
export function SheetTabs({
  active,
  onChange,
  labels,
}: {
  active: SheetTab
  onChange: (t: SheetTab) => void
  labels?: Partial<Record<SheetTab, string>>
}) {
  const tabs: SheetTab[] = ['players', 'property', 'log']
  return (
    <div className="sheet-tabs" role="tablist" aria-label="Game details">
      {tabs.map((t) => (
        <button
          key={t}
          type="button"
          role="tab"
          aria-selected={active === t}
          className={`sheet-tab ${active === t ? 'on' : ''}`}
          onClick={() => onChange(t)}
        >
          {labels?.[t] ?? t}
        </button>
      ))}
    </div>
  )
}
