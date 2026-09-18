import { sanitizeName } from './sanitize'

export type PlayerColor =
  | 'amber'
  | 'sky'
  | 'mint'
  | 'rose'
  | 'violet'
  | 'cyan'
  | 'lime'
  | 'coral'

export interface Player {
  id: string
  name: string
  color: PlayerColor
  ready: boolean
  isHost: boolean
}

export const PLAYER_COLORS: Record<
  PlayerColor,
  { hex: string; light: string; dark: string; label: string }
> = {
  amber: { hex: '#f5a83c', light: '#ffd58a', dark: '#b06a12', label: 'Amber' },
  sky: { hex: '#4ea3ff', light: '#9ecfff', dark: '#1f5fa8', label: 'Sky' },
  mint: { hex: '#3ddba8', light: '#8ef0cd', dark: '#158a63', label: 'Mint' },
  rose: { hex: '#ff6b8a', light: '#ffa9bc', dark: '#b23a55', label: 'Rose' },
  violet: { hex: '#9d7bff', light: '#c8b4ff', dark: '#5f3fc9', label: 'Violet' },
  cyan: { hex: '#3fd8d8', light: '#96ecec', dark: '#178a8a', label: 'Cyan' },
  lime: { hex: '#a8d83f', light: '#d0ef96', dark: '#6a8a15', label: 'Lime' },
  coral: { hex: '#ff8a5c', light: '#ffc2a6', dark: '#b8502a', label: 'Coral' },
}

export const COLOR_ORDER: PlayerColor[] = [
  'amber',
  'sky',
  'mint',
  'rose',
  'violet',
  'cyan',
  'lime',
  'coral',
]

export const MAX_PLAYERS = 8
export const MIN_PLAYERS = 2

const NAME_POOL = [
  'Maple',
  'Juno',
  'Pixel',
  'Waffle',
  'Ziggy',
  'Nova',
  'Biscuit',
  'Comet',
  'Pretzel',
  'Mango',
  'Pepper',
  'Echo',
]

let uidCounter = 0
export function uid(): string {
  uidCounter += 1
  return `p${Date.now().toString(36)}${uidCounter.toString(36)}`
}

export function randomName(): string {
  return NAME_POOL[Math.floor(Math.random() * NAME_POOL.length)] ?? 'Player'
}

export function makeRoomCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 6; i++) {
    out += alphabet[Math.floor(Math.random() * alphabet.length)]
  }
  return out
}

export function normalizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 6)
}

/** Guest identity persisted locally so refreshes keep your seat. */
export interface LocalIdentity {
  id: string
  name: string
  code: string
}

const IDENTITY_KEY = 'boardquest.identity.v1'

export function loadIdentity(): LocalIdentity | null {
  try {
    const raw = localStorage.getItem(IDENTITY_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<LocalIdentity>
    if (!parsed || typeof parsed.id !== 'string' || typeof parsed.name !== 'string') return null
    return { id: parsed.id, name: parsed.name, code: typeof parsed.code === 'string' ? parsed.code : '' }
  } catch {
    return null
  }
}

export function saveIdentity(identity: LocalIdentity): void {
  try {
    localStorage.setItem(
      IDENTITY_KEY,
      JSON.stringify({ id: identity.id, name: identity.name, code: identity.code }),
    )
  } catch {
    /* storage unavailable — non-fatal */
  }
}

export function makePlayer(name: string, color: PlayerColor, isHost: boolean): Player {
  return { id: uid(), name: sanitizeName(name), color, ready: !isHost ? false : true, isHost }
}

/** A fake opponent so lobbies and boards feel alive in this frontend-only demo. */
export function makeBot(index: number): Player {
  const names = ['Botsby', 'Claire', 'Rooke', 'Dexter', 'Wren', 'Otto', 'Pip', 'Margo']
  return {
    id: uid(),
    name: names[index % names.length] ?? 'Rival',
    color: COLOR_ORDER[(index + 1) % COLOR_ORDER.length],
    ready: true,
    isHost: false,
  }
}
