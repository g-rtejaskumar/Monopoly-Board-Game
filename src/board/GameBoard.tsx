/**
 * GameBoard — the stable 2D board plus its optional 3D decoration layer.
 *
 * Composition:
 *   Board2D (DOM/CSS, always rendered, always readable)
 *     └─ BoardOverlay3D (isolated WebGL canvas: tokens, dice, houses, cards)
 *
 * If WebGL is unavailable (or fails after mount) the overlay is dropped and the
 * board shows DOM token markers instead — the game stays fully playable.
 */
import { useState } from 'react'
import { Board2D } from './Board2D'
import { hasWebGL } from './webgl'
import { BoardOverlay3D } from '../three/BoardOverlay3D'
import { useSmallScreen } from '../hooks/useSmallScreen'
import type { SceneState, SceneStore } from './types'

export interface GameBoardProps {
  state: SceneState
  store: SceneStore
  youId?: string | null
  selectedTile: number | null
  onSelectTile: (index: number) => void
}

export function GameBoard({ state, store, youId = null, selectedTile, onSelectTile }: GameBoardProps) {
  const [overlayOk, setOverlayOk] = useState(hasWebGL)
  const lowPower = useSmallScreen()

  return (
    <Board2D
      state={state}
      youId={youId}
      selectedTile={selectedTile}
      onSelectTile={onSelectTile}
      showDomTokens={!overlayOk}
    >
      {overlayOk && (
        <BoardOverlay3D store={store} lowPower={lowPower} onUnavailable={() => setOverlayOk(false)} />
      )}
    </Board2D>
  )
}
