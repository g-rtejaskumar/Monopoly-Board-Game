import { useEffect, useState } from 'react'
import { PLAYER_COLORS } from '../game/types'
import type { PlayerColor } from '../game/types'
import './Logo.css'

interface LogoProps {
  size?: 'sm' | 'md' | 'lg'
}

export function Logo({ size = 'md' }: LogoProps) {
  const [hue, setHue] = useState(0)

  useEffect(() => {
    const id = window.setInterval(() => setHue((h) => (h + 1) % TILE_HUES.length), 2200)
    return () => window.clearInterval(id)
  }, [])

  const accent = PLAYER_COLORS[TILE_HUES[hue] ?? 'amber']

  return (
    <span className={`logo logo-${size}`} aria-label="BoardQuest">
      <span className="logo-dice" style={{ '--accent': accent.hex } as React.CSSProperties}>
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <defs>
            <linearGradient id="logo-g" x1="0" y1="0" x2="1" y2="1">
              <stop offset="0" stopColor="#ffd27a" />
              <stop offset="1" stopColor="#f08c1f" />
            </linearGradient>
          </defs>
          <rect x="4" y="4" width="56" height="56" rx="16" fill="url(#logo-g)" />
          <rect x="4" y="4" width="56" height="56" rx="16" fill="none" stroke="#fff" strokeOpacity="0.35" strokeWidth="2" />
          <circle cx="21" cy="21" r="6.5" fill="#3a2405" />
          <circle cx="43" cy="43" r="6.5" fill="#3a2405" />
          <circle cx="43" cy="21" r="6.5" fill="#fff" opacity="0.95" />
          <circle cx="21" cy="43" r="6.5" fill="#fff" opacity="0.95" />
        </svg>
      </span>
      <span className="logo-word">
        Board<em>Quest</em>
      </span>
    </span>
  )
}

const TILE_HUES: PlayerColor[] = ['amber', 'sky', 'mint', 'rose', 'violet', 'cyan']
