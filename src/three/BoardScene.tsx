import { useEffect, useMemo, useRef, useReducer } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import {
  ContactShadows,
  Environment,
  Lightformer,
  OrbitControls,
  Html,
  RoundedBox,
} from '@react-three/drei'
import { PLAYER_COLORS } from '../game/types'
import type { PlayerColor } from '../game/types'
import {
  TILES,
  cornerKindOf,
  isEventTile,
  isOwnable,
  rentFor,
  getTile,
} from '../game/boardData'
import {
  CORNER_INDICES,
  CORNER_SIZE,
  TILE_POS,
  TILE_W,
  TILE_D,
  BOARD_HALF,
  pawnSpot,
  tileRotationY,
} from './layout'
import { makeCenterTexture, makeCornerTexture, makeTileTexture } from './textures'
import { Token, tokenKindForSeat, House, Hotel, CardDeck, CoinStack, WoodenTray } from './models'
import { useFontsReady } from '../hooks/useFontsReady'

/* ---------------------------------- store ---------------------------------- */

export interface BoardPlayer {
  id: string
  name: string
  seat: number
  color: PlayerColor
  tile: number
  cash: number
  connected?: boolean
  isBot?: boolean
  /** True while the player sits in jail. */
  inJail?: boolean
  bankrupt?: boolean
}

interface BoardState {
  players: BoardPlayer[]
  current: number
  phase: 'idle' | 'rolling' | 'moving'
  dice: [number, number]
  rollTrigger: number
  rolledAt: number
  log: Array<{ id: number; text: string; color: PlayerColor }>
  eventTile: number | null
  buyTile: number | null
  owned: Record<number, PlayerColor>
  buildings: Record<number, number>
  moveAnim: { seat: number; from: number; to: number; start: number } | null
  last: { diceTotal: number; seat: number } | null
  lastThink: number
  thinkAt: number
}

let logId = 0

function createStore(players: BoardPlayer[]) {
  const state: BoardState = {
    players,
    current: 0,
    phase: 'idle',
    dice: [3, 4],
    rollTrigger: 0,
    rolledAt: 0,
    log: [
      { id: ++logId, text: 'Welcome to BoardQuest!', color: 'amber' },
      {
        id: ++logId,
        text: `${players[0]?.name ?? 'Player'} goes first`,
        color: players[0]?.color ?? 'amber',
      },
    ],
    eventTile: null,
    lastThink: -1,
    thinkAt: 0,
    buyTile: null,
    owned: {},
    buildings: {},
    moveAnim: null,
    last: null,
  }
  const subs = new Set<() => void>()
  return {
    get: () => state,
    set: (fn: (s: BoardState) => void) => {
      fn(state)
      subs.forEach((l) => l())
    },
    subscribe: (l: () => void) => {
      subs.add(l)
      return () => {
        subs.delete(l)
      }
    },
  }
}

export type BoardStore = ReturnType<typeof createStore>

/** Minimal store shape the renderer needs (satisfied by both local and net stores). */
export interface SceneState {
  players: BoardPlayer[]
  current: number
  phase: 'idle' | 'rolling' | 'moving'
  dice: [number, number]
  rollTrigger: number
  rolledAt: number
  moveAnim: { seat: number; from: number; to: number; start: number } | null
  last: { diceTotal: number; seat: number } | null
  eventTile: number | null
  buyTile: number | null
  owned: Record<number, PlayerColor>
  buildings: Record<number, number>
  log: Array<{ id: number; text: string; color: PlayerColor }>
}

export interface SceneStore {
  get: () => SceneState
  subscribe: (l: () => void) => () => void
}

/* ------------------------------- board actions ------------------------------ */

function doRollLocal(store: BoardStore) {
  const s = store.get()
  if (s.phase !== 'idle') return
  const r = () => 1 + Math.floor(Math.random() * 6)
  store.set((st) => {
    st.phase = 'rolling'
    st.dice = [r(), r()]
    st.rollTrigger++
    st.rolledAt = Date.now()
    st.eventTile = null
    st.buyTile = null
  })
}

/** Human roll (demo mode only — net rolls go through the server). */
export function rollDice(store: BoardStore) {
  const s = store.get()
  if (s.phase !== 'idle') return
  if (s.players[s.current]?.seat !== 0) return
  doRollLocal(store)
}

export function resolveBuy(store: BoardStore, accept: boolean) {
  const s = store.get()
  if (s.buyTile == null) return
  const tile = s.buyTile
  const price = getTile(tile)?.price ?? 100
  store.set((s2) => {
    s2.buyTile = null
    const pl = s2.players[s2.current]
    if (accept && pl) {
      pl.cash -= price
      s2.owned[tile] = pl.color
      s2.log.push({
        id: ++logId,
        text: `${pl.name} bought ${getTile(tile)?.name ?? 'a property'} for M ${price}`,
        color: pl.color,
      })
    } else if (pl) {
      s2.log.push({
        id: ++logId,
        text: `${pl.name} passed on ${getTile(tile)?.name ?? 'a property'}`,
        color: pl.color,
      })
    }
    if (s2.log.length > 40) s2.log.shift()
    nextTurn(s2)
  })
}

export function resolveEvent(store: BoardStore) {
  store.set((s) => {
    s.eventTile = null
    nextTurn(s)
  })
}

function nextTurn(s: BoardState) {
  s.current = (s.current + 1) % s.players.length
}

/* --------------------------------- helpers ---------------------------------- */

const TILE_TOP = 0.07 // top surface of the tiles

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(Math.max((t - a) / (b - a), 0), 1)
  return x * x * (3 - 2 * x)
}

/* ----------------------------------- tiles ----------------------------------- */

function TileMesh({
  index,
  texture,
  active,
  selectable,
  onEnter,
  onLeave,
  onClick,
}: {
  index: number
  texture: THREE.Texture
  active: boolean
  selectable: boolean
  onEnter?: () => void
  onLeave?: () => void
  onClick?: () => void
}) {
  const group = useRef<THREE.Group>(null)
  const hovered = useRef(false)
  const [x, z] = TILE_POS[index]
  const isCorner = CORNER_INDICES.includes(index)
  const sizeX = isCorner ? CORNER_SIZE : TILE_W
  const sizeZ = isCorner ? CORNER_SIZE : TILE_D
  const rotY = tileRotationY(index)

  useFrame((_, delta) => {
    const g = group.current
    if (!g) return
    const target = hovered.current || active ? 0.09 : 0
    g.position.y += (target - g.position.y) * Math.min(1, delta * 9)
  })

  return (
    <group ref={group} position={[x, 0, z]}>
      <RoundedBox
        args={[sizeX, 0.07, sizeZ]}
        radius={0.03}
        smoothness={3}
        position={[0, 0.035, 0]}
        rotation={[0, rotY, 0]}
        castShadow
        receiveShadow
        onPointerOver={(e) => {
          if (!selectable) return
          e.stopPropagation()
          hovered.current = true
          document.body.style.cursor = 'pointer'
          onEnter?.()
        }}
        onPointerOut={() => {
          if (!selectable) return
          hovered.current = false
          document.body.style.cursor = 'auto'
          onLeave?.()
        }}
        onClick={(e) => {
          if (!selectable) return
          e.stopPropagation()
          onClick?.()
        }}
      >
        <meshStandardMaterial map={texture} roughness={0.42} metalness={0.04} />
      </RoundedBox>
    </group>
  )
}

/** Thin colored ownership bar on a tile's inner edge. */
function OwnerBar({ index, color }: { index: number; color: PlayerColor }) {
  const [x, z] = TILE_POS[index]
  if (CORNER_INDICES.includes(index)) return null
  const len = Math.max(Math.hypot(x, z), 0.0001)
  const ix = -x / len
  const iz = -z / len
  const dist = TILE_D / 2 - 0.14
  const c = PLAYER_COLORS[color]
  return (
    <group position={[x + ix * dist, 0, z + iz * dist]} rotation={[0, tileRotationY(index), 0]}>
      <mesh position={[0, 0.078, 0]}>
        <boxGeometry args={[TILE_W * 0.72, 0.022, 0.12]} />
        <meshStandardMaterial color={c.hex} roughness={0.35} emissive={c.hex} emissiveIntensity={0.25} />
      </mesh>
    </group>
  )
}

/* --------------------------------- buildings -------------------------------- */

function BuildingsOnTile({ index, count, color }: { index: number; count: number; color: PlayerColor }) {
  const [x, z] = TILE_POS[index]
  if (CORNER_INDICES.includes(index) || count <= 0) return null
  const len = Math.max(Math.hypot(x, z), 0.0001)
  const ix = -x / len
  const iz = -z / len
  const px = -iz
  const pz = ix
  const rotY = tileRotationY(index)
  const baseDist = TILE_D / 2 - 0.52

  if (count >= 5) {
    return <Hotel position={[x + ix * baseDist, TILE_TOP, z + iz * baseDist]} rotationY={rotY} color={color} />
  }
  return (
    <group>
      {Array.from({ length: count }).map((_, j) => {
        const along = (j - (count - 1) / 2) * 0.28
        return (
          <House
            key={j}
            position={[x + ix * baseDist + px * along, TILE_TOP, z + iz * baseDist + pz * along]}
            rotationY={rotY}
            color={color}
          />
        )
      })}
    </group>
  )
}

/* ----------------------------------- pawns ----------------------------------- */

function Pawn({
  from,
  to,
  progressRef,
  color,
  label,
  isTurn,
  seat,
}: {
  from: number
  to: number
  progressRef: { current: number }
  color: PlayerColor
  label: string
  isTurn: boolean
  seat: number
}) {
  const group = useRef<THREE.Group>(null)
  const kind = tokenKindForSeat(seat)

  useFrame((state, delta) => {
    const g = group.current
    if (!g) return
    const t = Math.min(Math.max(progressRef.current, 0), 1)

    let x: number
    let z: number
    if (from === to) {
      const [sx, sz] = pawnSpot(from, seat)
      x = sx
      z = sz
    } else {
      const steps = to >= from ? to - from : to + 40 - from
      const seg = Math.min(Math.floor(t * steps), steps - 1)
      const frac = t * steps - seg
      const i0 = (from + seg) % 40
      const i1 = (from + seg + 1) % 40
      const p0 = pawnSpot(i0, seat)
      const p1 = pawnSpot(i1, seat)
      x = p0[0] + (p1[0] - p0[0]) * frac
      z = p0[1] + (p1[1] - p0[1]) * frac
    }

    const time = state.clock.elapsedTime
    const moving = from !== to && t < 1
    const bob = Math.sin(time * 2.1 + seat * 1.7) * 0.015
    const lift = moving ? 0.07 + Math.abs(Math.sin(t * Math.PI * 4)) * 0.1 : 0
    g.position.set(x, TILE_TOP + bob + lift, z)
    g.rotation.y += delta * 0.4

    const squash = isTurn ? 1 + Math.sin(time * 4.2) * 0.025 : 1
    g.scale.set(1 / squash, squash, 1 / squash)
  })

  return (
    <group
      ref={group}
      onPointerOver={(e) => {
        e.stopPropagation()
        document.body.style.cursor = 'pointer'
      }}
      onPointerOut={() => {
        document.body.style.cursor = 'auto'
      }}
    >
      <Token kind={kind} color={color} isTurn={isTurn}>
        {(isTurn || from !== to) && (
          <Html center distanceFactor={11} position={[0, 0.95, 0]} zIndexRange={[30, 0]}>
            <div className={`pawn-tag ${isTurn ? 'turn' : ''}`}>{label}</div>
          </Html>
        )}
      </Token>
    </group>
  )
}

/* ------------------------------------ dice ----------------------------------- */

const PIP_PATTERN: Record<number, Array<[number, number]>> = {
  1: [[0, 0]],
  2: [
    [-0.16, -0.16],
    [0.16, 0.16],
  ],
  3: [
    [-0.16, -0.16],
    [0, 0],
    [0.16, 0.16],
  ],
  4: [
    [-0.16, -0.16],
    [0.16, -0.16],
    [-0.16, 0.16],
    [0.16, 0.16],
  ],
  5: [
    [-0.16, -0.16],
    [0.16, -0.16],
    [0, 0],
    [-0.16, 0.16],
    [0.16, 0.16],
  ],
  6: [
    [-0.16, -0.16],
    [0.16, -0.16],
    [-0.16, 0],
    [0.16, 0],
    [-0.16, 0.16],
    [0.16, 0.16],
  ],
}

/** Pip world offsets per value, placed on the face that FACE_ROT brings upward. */
function facePips(v: number): Array<[number, number, number]> {
  const p = PIP_PATTERN[v] ?? PIP_PATTERN[1]
  switch (v) {
    case 1:
      return p.map(([a, b]) => [a, 0.33, b])
    case 6:
      return p.map(([a, b]) => [a, -0.33, b])
    case 3:
      return p.map(([a, b]) => [0.33, a, b])
    case 4:
      return p.map(([a, b]) => [-0.33, a, b])
    case 2:
      return p.map(([a, b]) => [a, b, 0.33])
    default:
      return p.map(([a, b]) => [a, b, -0.33])
  }
}

const FACE_ROT: Record<number, [number, number, number]> = {
  1: [0, 0, 0],
  6: [Math.PI, 0, 0],
  3: [0, 0, Math.PI / 2],
  4: [0, 0, -Math.PI / 2],
  2: [-Math.PI / 2, 0, 0],
  5: [Math.PI / 2, 0, 0],
}

function Dice3D({
  value,
  pos,
  trigger,
}: {
  value: number
  pos: [number, number]
  trigger: number
}) {
  const group = useRef<THREE.Group>(null)
  const anim = useRef({ t0: 0, active: false })
  const start = useMemo(() => new THREE.Vector3(pos[0], 5.4, pos[1]), [pos])
  const end = useMemo(() => new THREE.Vector3(pos[0], TILE_TOP + 0.42, pos[1]), [pos])
  const tmpQ = useMemo(() => new THREE.Quaternion(), [])
  const tmpQ2 = useMemo(() => new THREE.Quaternion(), [])
  const tmpE = useMemo(() => new THREE.Euler(), [])
  const faceE = useMemo(() => new THREE.Euler(), [])

  useEffect(() => {
    if (trigger > 0) anim.current = { t0: performance.now(), active: true }
  }, [trigger])

  useFrame(() => {
    const g = group.current
    if (!g) return
    const a = anim.current
    const D = 1.0
    if (a.active) {
      const t = (performance.now() - a.t0) / 1000
      const p = Math.min(t / D, 1)
      const e = easeOutCubic(p)
      g.position.lerpVectors(start, end, e)
      tmpE.set(t * 11, t * 14, t * 5)
      tmpQ.setFromEuler(tmpE)
      faceE.set(...FACE_ROT[value])
      tmpQ2.setFromEuler(faceE)
      g.quaternion.slerpQuaternions(tmpQ, tmpQ2, smooth(0.55, 0.95, p))
      if (t > D && t < D + 0.28) {
        const s = 1 + Math.sin(((t - D) / 0.28) * Math.PI) * 0.14
        g.scale.setScalar(s)
      } else {
        g.scale.setScalar(1)
      }
      if (p >= 1) {
        a.active = false
        g.position.copy(end)
        g.quaternion.copy(tmpQ2)
        g.scale.setScalar(1)
      }
    } else {
      const time = performance.now() / 1000
      g.position.set(end.x, end.y + Math.sin(time * 1.7) * 0.03, end.z)
      faceE.set(...FACE_ROT[value])
      g.quaternion.slerp(tmpQ.setFromEuler(faceE), 0.18)
    }
  })

  return (
    <group ref={group} position={[pos[0], 5.4, pos[1]]}>
      <RoundedBox args={[0.78, 0.78, 0.78]} radius={0.13} smoothness={4} castShadow>
        <meshStandardMaterial color="#f7f1e3" roughness={0.28} />
      </RoundedBox>
      {facePips(value).map((p, i) => (
        <mesh key={i} position={p}>
          <sphereGeometry args={[0.062, 14, 14]} />
          <meshStandardMaterial color="#31261a" roughness={0.5} />
        </mesh>
      ))}
    </group>
  )
}

/* ---------------------------------- camera ----------------------------------- */

const ISO_POS = new THREE.Vector3(12.6, 14.2, 12.6)
const TOP_POS = new THREE.Vector3(0.02, 21.5, 0.02)

function CameraRig({ view, resetToken }: { view: 'iso' | 'top'; resetToken: number }) {
  const camera = useThree((s) => s.camera)
  const anim = useRef({ t0: 0, from: new THREE.Vector3(), active: false })
  const lookAt = useMemo(() => new THREE.Vector3(0, 0, 0), [])

  useEffect(() => {
    anim.current.t0 = performance.now()
    anim.current.from.copy(camera.position)
    anim.current.active = true
  }, [view, resetToken, camera])

  useFrame(() => {
    const a = anim.current
    if (!a.active) return
    const p = Math.min((performance.now() - a.t0) / 850, 1)
    const e = easeInOut(p)
    const dest = view === 'top' ? TOP_POS : ISO_POS
    camera.position.lerpVectors(a.from, dest, e)
    camera.lookAt(lookAt)
    if (p >= 1) a.active = false
  })
  return null
}

/* ------------------------------------ world ----------------------------------- */

function BoardWorld({
  store,
  autoRotate,
  netMode,
  view,
  resetToken,
  selectedTile,
  onTileSelect,
}: {
  store: BoardStore
  autoRotate: boolean
  netMode: boolean
  view: 'iso' | 'top'
  resetToken: number
  selectedTile: number | null
  onTileSelect?: (index: number) => void
}) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => store.subscribe(force), [store])

  const fontsReady = useFontsReady()
  const s = store.get()

  const textures = useMemo(() => {
    if (!fontsReady) return null
    const map = new Map<number, THREE.Texture>()
    TILES.forEach((t) => {
      if (cornerKindOf(t.index)) {
        map.set(t.index, makeCornerTexture(cornerKindOf(t.index)!))
      } else {
        map.set(t.index, makeTileTexture(t))
      }
    })
    return map
  }, [fontsReady])
  const centerTex = useMemo(() => (fontsReady ? makeCenterTexture() : null), [fontsReady])

  const progressRefs = useMemo(() => s.players.map(() => ({ current: 0 })), [s.players])

  // master animation driver: dice settle -> move pawns -> land events
  // In net mode this logic lives on the server; here we only animate visuals.
  useFrame(() => {
    if (netMode) return
    const st = store.get()
    const now = Date.now()

    if (st.phase === 'rolling' && st.rolledAt && now - st.rolledAt > 1150) {
      const total = st.dice[0] + st.dice[1]
      const p = st.players[st.current]
      if (!p) return
      const from = p.tile
      const to = (from + total) % 40
      progressRefs.forEach((r) => {
        r.current = 0
      })
      store.set((s2) => {
        s2.phase = 'moving'
        s2.moveAnim = { seat: p.seat, from, to, start: now }
        s2.last = { diceTotal: total, seat: p.seat }
        s2.log.push({ id: ++logId, text: `${p.name} rolled ${total}`, color: p.color })
        if (s2.log.length > 40) s2.log.shift()
      })
    }

    if (st.phase === 'moving' && st.moveAnim) {
      const { seat, from, to, start } = st.moveAnim
      const steps = to >= from ? to - from : to + 40 - from
      const dur = 260 + steps * 150
      const t = Math.min((now - start) / dur, 1)
      const ref = progressRefs[seat]
      if (ref) ref.current = t
      if (t >= 1) {
        const passedStart = to < from
        store.set((s2) => {
          const pl = s2.players.find((pp) => pp.seat === seat)
          s2.moveAnim = null
          s2.phase = 'idle'
          if (pl) {
            pl.tile = to
            if (passedStart) {
              pl.cash += 200
              s2.log.push({
                id: ++logId,
                text: `${pl.name} passed START +M 200`,
                color: pl.color,
              })
            }
            const tile = getTile(to)
            s2.log.push({
              id: ++logId,
              text: `${pl.name} landed on ${tile?.name ?? 'the board'}`,
              color: pl.color,
            })

            if (isEventTile(to)) {
              if (pl.seat !== 0) {
                s2.log.push({
                  id: ++logId,
                  text: `${pl.name} handled a surprise event`,
                  color: pl.color,
                })
              } else {
                s2.eventTile = to
              }
            } else if (tile?.type === 'tax') {
              const amount = tile.taxAmount ?? 100
              pl.cash -= amount
              s2.log.push({
                id: ++logId,
                text: `${pl.name} paid M ${amount} ${tile.name.toLowerCase()}`,
                color: pl.color,
              })
            } else if (s2.owned[to] !== undefined && s2.owned[to] !== pl.color) {
              // rent to the owner (demo rules: no monopoly multiplier)
              const owner = s2.players.find((pp) => pp.color === s2.owned[to])
              const rent = rentFor(to, s2.buildings[to] ?? 0, false, st.dice[0] + st.dice[1])
              if (owner && rent > 0) {
                pl.cash -= rent
                owner.cash += rent
                s2.log.push({
                  id: ++logId,
                  text: `${pl.name} paid ${owner.name} M ${rent} rent`,
                  color: pl.color,
                })
              }
            } else if (isOwnable(tile) && s2.owned[to] === undefined) {
              const price = tile?.price ?? 0
              if (pl.seat !== 0 && pl.cash >= price) {
                pl.cash -= price
                s2.owned[to] = pl.color
                s2.log.push({
                  id: ++logId,
                  text: `${pl.name} bought ${tile?.name} for M ${price}`,
                  color: pl.color,
                })
              } else {
                s2.buyTile = to
              }
            }
            if (s2.log.length > 40) s2.log.shift()
          }
        })
      }
    }

    // Life-like bot turns: rivals roll on their own after a human-like pause.
    if (
      st.phase === 'idle' &&
      !st.eventTile &&
      !st.buyTile &&
      st.current !== 0 &&
      st.lastThink !== st.current
    ) {
      const bot = st.players[st.current]
      if (bot && bot.seat !== 0) {
        store.set((s2) => {
          s2.lastThink = s2.current
          s2.thinkAt = Date.now() + 900 + Math.random() * 900
        })
      }
    }
    if (
      st.phase === 'idle' &&
      st.lastThink === st.current &&
      st.current !== 0 &&
      st.thinkAt &&
      now >= st.thinkAt
    ) {
      const bot = st.players[st.current]
      if (bot && bot.seat !== 0) {
        store.set((s2) => {
          s2.lastThink = -1
          s2.thinkAt = 0
        })
        doRollLocal(store)
      }
    }
  })

  if (!textures || !centerTex) {
    return (
      <Html center>
        <div className="board-loading">Setting up the board…</div>
      </Html>
    )
  }

  const activeTile = s.eventTile ?? s.buyTile ?? selectedTile
  const currentPlayer = s.players[s.current]
  const felt = BOARD_HALF - CORNER_SIZE // inner square half-size

  return (
    <group>
      {/* table shadow catcher */}
      <ContactShadows position={[0, -1.42, 0]} opacity={0.55} scale={30} blur={2.6} far={5} />

      {/* pedestal */}
      <RoundedBox
        args={[11.6, 0.5, 11.6]}
        radius={0.1}
        smoothness={3}
        position={[0, -1.05, 0]}
        receiveShadow
      >
        <meshStandardMaterial color="#17223a" roughness={0.65} metalness={0.1} />
      </RoundedBox>

      {/* outer wooden frame (protrudes around the slab) */}
      <RoundedBox
        args={[16.6, 0.5, 16.6]}
        radius={0.12}
        smoothness={3}
        position={[0, -0.33, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#5d3a1f" roughness={0.55} metalness={0.05} />
      </RoundedBox>

      {/* main slab */}
      <RoundedBox
        args={[15.2, 0.5, 15.2]}
        radius={0.08}
        smoothness={3}
        position={[0, -0.25, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#26170c" roughness={0.72} />
      </RoundedBox>

      {/* deep green felt center with emblem */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]} receiveShadow>
        <planeGeometry args={[felt * 2, felt * 2]} />
        <meshStandardMaterial map={centerTex} roughness={0.9} />
      </mesh>

      {/* golden rim trim */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.014, 0]}>
        <ringGeometry args={[felt - 0.16, felt + 0.05, 64]} />
        <meshStandardMaterial color="#d9a441" roughness={0.35} metalness={0.6} />
      </mesh>

      {/* tiles */}
      {TILES.map((t) => (
        <TileMesh
          key={t.index}
          index={t.index}
          texture={textures.get(t.index)!}
          active={activeTile === t.index}
          selectable={isOwnable(t)}
          onClick={() => onTileSelect?.(t.index)}
        />
      ))}

      {/* ownership bars */}
      {Object.entries(s.owned).map(([idx, color]) => (
        <OwnerBar key={`o-${idx}`} index={Number(idx)} color={color} />
      ))}

      {/* houses / hotels */}
      {Object.entries(s.buildings).map(([idx, count]) => {
        const i = Number(idx)
        const color = s.owned[i]
        if (!color) return null
        return <BuildingsOnTile key={`b-${idx}`} index={i} count={count} color={color} />
      })}

      {/* pawns */}
      {s.players.map((p) => {
        const animating = s.moveAnim && s.moveAnim.seat === p.seat
        const from = animating ? s.moveAnim!.from : p.tile
        const to = animating ? s.moveAnim!.to : p.tile
        return (
          <Pawn
            key={p.id}
            from={from}
            to={to}
            seat={p.seat}
            progressRef={progressRefs[p.seat]}
            color={p.color}
            label={p.name}
            isTurn={currentPlayer?.id === p.id}
          />
        )
      })}

      {/* dice */}
      <Dice3D value={s.dice[0]} pos={[-1.35, 0.9]} trigger={s.rollTrigger} />
      <Dice3D value={s.dice[1]} pos={[1.35, 1.9]} trigger={s.rollTrigger} />

      {/* tabletop props */}
      <CardDeck position={[-3.1, 0, -3.1]} color="#ef8f2e" label="CHANCE" />
      <CardDeck position={[3.1, 0, 3.1]} color="#3a97cf" label="COMMUNITY" />
      <CoinStack position={[3.4, 0, -2.9]} count={4} />
      <CoinStack position={[3.9, 0, -2.2]} count={2} />
      <group position={[-3.6, 0, 2.7]} rotation={[0, 0.5, 0]}>
        <WoodenTray position={[0, 0, 0]} />
      </group>

      {/* lighting */}
      <ambientLight intensity={0.55} />
      <directionalLight
        position={[9, 15, 7]}
        intensity={2.1}
        color="#fff4e0"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-14}
        shadow-camera-right={14}
        shadow-camera-top={14}
        shadow-camera-bottom={-14}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-8, 9, -7]} intensity={0.5} color="#7fb2ff" />
      <pointLight position={[0, 4.5, 0]} intensity={18} distance={14} color="#ffd9a0" />

      {/* image-based lighting built locally (no network assets) */}
      <Environment resolution={64}>
        <Lightformer intensity={2.2} position={[0, 6, 0]} scale={[12, 12, 1]} rotation-x={Math.PI / 2} />
        <Lightformer intensity={0.7} position={[-6, 3, -6]} scale={[8, 8, 1]} color="#9db8ff" />
        <Lightformer intensity={1.2} position={[6, 3, 6]} scale={[8, 8, 1]} color="#ffd9a0" />
      </Environment>

      <CameraRig view={view} resetToken={resetToken} />
      <OrbitControls
        makeDefault
        enablePan={false}
        minDistance={12}
        maxDistance={30}
        maxPolarAngle={Math.PI * 0.46}
        autoRotate={autoRotate}
        autoRotateSpeed={0.7}
        enableDamping
        dampingFactor={0.08}
      />
    </group>
  )
}

/* ------------------------------------ scene ----------------------------------- */

export interface BoardSceneProps {
  players?: BoardPlayer[]
  /** Externally-owned store (net mode). When provided, `players` is ignored. */
  store?: SceneStore
  onStore?: (store: BoardStore) => void
  autoRotate?: boolean
  /** 'iso' = angled 3D table view, 'top' = flat 2D-like overhead view. */
  view?: 'iso' | 'top'
  /** Bump to glide the camera back to the default position for `view`. */
  resetToken?: number
  /** Called when a player clicks a tile (property card in the sidebar). */
  onTileSelect?: (index: number) => void
  selectedTile?: number | null
}

export function BoardScene({
  players,
  store: externalStore,
  onStore,
  autoRotate = false,
  view = 'iso',
  resetToken = 0,
  onTileSelect,
  selectedTile = null,
}: BoardSceneProps) {
  const localStore = useMemo(
    () => createStore(players ?? []),
    // players are fixed for the lifetime of the board
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const store = (externalStore ?? localStore) as BoardStore
  const netMode = Boolean(externalStore)

  useEffect(() => {
    if (!externalStore) onStore?.(store)
  }, [store, onStore, externalStore])

  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ antialias: true }}
      camera={{ fov: 38, position: [12.6, 14.2, 12.6], near: 0.1, far: 120 }}
      style={{ touchAction: 'none' }}
    >
      <BoardWorld
        store={store}
        autoRotate={autoRotate}
        netMode={netMode}
        view={view}
        resetToken={resetToken}
        selectedTile={selectedTile}
        onTileSelect={onTileSelect}
      />
    </Canvas>
  )
}
