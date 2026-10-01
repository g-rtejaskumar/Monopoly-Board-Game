/**
 * BoardOverlay3D — the selective 3D layer that sits ON TOP of the fixed 2D board.
 *
 * This replaces the old "one giant canvas renders the whole board" approach.
 * There is no board geometry, no camera rig, no orbit controls and no board
 * lighting here: just the objects that genuinely benefit from being 3D —
 * player tokens, dice, houses/hotels, cards and coins.
 *
 * Alignment contract: the camera looks straight down at a board-sized square
 * world, and `geometry.toWorld()` maps normalized board coordinates 1:1 onto
 * that plane. A token standing at ground level therefore projects exactly onto
 * the tile the DOM board draws underneath it.
 *
 * The overlay is decorative and never authoritative: it reads the same
 * `SceneStore` the 2D board does and only animates between tiles the server (or
 * the practice engine) already decided. It can be unmounted entirely and the
 * game stays fully playable and readable.
 */
import { Component, useEffect, useMemo, useReducer, useRef } from 'react'
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame, useThree } from '@react-three/fiber'
import type { PlayerColor } from '../game/types'
import {
  OVERLAY_CAM_DIST,
  TOKEN_TOP,
  buildingSpot,
  overlayFovDeg,
  tokenSpot,
  tileRect,
} from '../board/geometry'
import type { SceneStore } from '../board/types'
import { CoinStack, Dice3D, Hotel, House, Token, tokenKindForSeat } from './models'

const DEV = import.meta.env.DEV

/** Dev-only: expose the tile each pawn is actually drawn on (regression hook). */
function publishPawnTile(seat: number, tile: number): void {
  if (!DEV || typeof window === 'undefined') return
  const w = window as unknown as { __bqPawns?: Record<number, number> }
  if (!w.__bqPawns) w.__bqPawns = {}
  w.__bqPawns[seat] = tile
}

/**
 * Dev-only: where the 3D camera projects a pawn's GROUND point, in normalized
 * board space (0..1 within the playfield). The UI test compares this against
 * `geometry.tokenSpotUV(tile, slot, count)` so any drift between the 3D overlay
 * and the 2D board is caught automatically rather than by eye.
 */
interface PawnScreen {
  x: number
  y: number
  tile: number
  slot: number
  count: number
}
function publishPawnScreen(seat: number, p: PawnScreen): void {
  if (!DEV || typeof window === 'undefined') return
  const w = window as unknown as { __bqPawnScreen?: Record<number, PawnScreen> }
  if (!w.__bqPawnScreen) w.__bqPawnScreen = {}
  w.__bqPawnScreen[seat] = p
}

/* --------------------------------- camera ---------------------------------- */

/** Straight-down perspective camera whose ground plane matches the DOM board. */
function TopDownCamera() {
  const camera = useThree((s) => s.camera as THREE.PerspectiveCamera)
  useEffect(() => {
    camera.up.set(0, 0, -1)
    camera.position.set(0, OVERLAY_CAM_DIST, 0)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
  }, [camera])
  return null
}

/* ---------------------------------- tokens --------------------------------- */

const HOP_PER_TILE_MS = 150
const HOP_BASE_MS = 260

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t
}

interface PawnProps {
  from: number
  to: number
  slot: number
  count: number
  seat: number
  color: PlayerColor
  isTurn: boolean
  progressRef: { current: number }
}

function Pawn3D({ from, to, slot, count, seat, color, isTurn, progressRef }: PawnProps) {
  const group = useRef<THREE.Group>(null)
  const kind = tokenKindForSeat(seat)
  const camera = useThree((s) => s.camera)
  const project = useMemo(() => new THREE.Vector3(), [])

  useFrame((state, delta) => {
    const g = group.current
    if (!g) return
    const t = Math.min(Math.max(progressRef.current, 0), 1)

    let spot: { x: number; z: number }
    let tileNow: number
    if (from === to) {
      spot = tokenSpot(from, slot, count)
      tileNow = from
    } else {
      const steps = to >= from ? to - from : to + 40 - from
      const seg = Math.min(Math.floor(t * steps), steps - 1)
      const frac = t * steps - seg
      const i0 = (from + seg) % 40
      const i1 = (from + seg + 1) % 40
      const p0 = tokenSpot(i0, slot, count)
      const p1 = tokenSpot(i1, slot, count)
      spot = { x: lerp(p0.x, p1.x, frac), z: lerp(p0.z, p1.z, frac) }
      tileNow = i0 + frac
    }

    const time = state.clock.elapsedTime
    const moving = from !== to && t < 1
    const bob = Math.sin(time * 2.1 + seat * 1.7) * 0.012
    const lift = moving ? 0.06 + Math.abs(Math.sin(t * Math.PI * 4)) * 0.08 : 0
    g.position.set(spot.x, TOKEN_TOP + bob + lift, spot.z)
    g.rotation.y += delta * 0.35
    publishPawnTile(seat, t >= 1 ? to : tileNow)

    if (DEV) {
      // Project the pawn's GROUND point (y = 0) through the real camera. Ground
      // points map 1:1 onto the normalized board the DOM draws.
      project.set(spot.x, 0, spot.z).project(camera)
      publishPawnScreen(seat, {
        x: project.x * 0.5 + 0.5,
        y: -project.y * 0.5 + 0.5,
        tile: t >= 1 ? to : Math.round(tileNow),
        slot,
        count,
      })
    }

    const squash = isTurn ? 1 + Math.sin(time * 4.2) * 0.025 : 1
    g.scale.set(0.92 / squash, 0.92 * squash, 0.92 / squash)
  })

  return (
    <group ref={group}>
      {/* cheap blob shadow — no shadow map needed */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.035, 0]}>
        <circleGeometry args={[0.24, 18]} />
        <meshBasicMaterial color="#22170a" transparent opacity={0.24} depthWrite={false} />
      </mesh>
      <Token kind={kind} color={color} isTurn={isTurn} />
    </group>
  )
}

/* -------------------------------- buildings -------------------------------- */

function Buildings3D({
  index,
  count,
  color,
}: {
  index: number
  count: number
  color: PlayerColor
}) {
  if (count <= 0) return null
  if (count >= 5) {
    const p = buildingSpot(index, 0)
    return (
      <group position={[p.x, TOKEN_TOP, p.z]} scale={1.25}>
        <Hotel position={[0, 0, 0]} color={color} />
      </group>
    )
  }
  return (
    <group>
      {Array.from({ length: count }).map((_, j) => {
        const p = buildingSpot(index, j - (count - 1) / 2)
        return (
          <group key={j} position={[p.x, TOKEN_TOP, p.z]} scale={1.15}>
            <House position={[0, 0, 0]} color={color} />
          </group>
        )
      })}
    </group>
  )
}

/* --------------------------------- event card ------------------------------- */

/** A Chance/Community card that rises over the board while the draw is shown. */
function EventCard3D({ active, good }: { active: boolean; good: boolean }) {
  const group = useRef<THREE.Group>(null)
  const startedAt = useRef(0)
  const wasActive = useRef(false)

  useFrame(() => {
    const g = group.current
    if (!g) return
    if (active && !wasActive.current) {
      wasActive.current = true
      startedAt.current = performance.now()
    }
    if (!active && wasActive.current) {
      wasActive.current = false
    }
    const t = active ? Math.min((performance.now() - startedAt.current) / 380, 1) : 0
    const ease = 1 - Math.pow(1 - t, 3)
    g.visible = active
    g.position.set(0, lerp(-0.9, 1.15, ease), 0)
    g.rotation.set(lerp(-0.9, 0, ease), lerp(0.8, 0.15, ease), 0)
    g.scale.setScalar(lerp(0.4, 1, ease))
  })

  return (
    <group ref={group}>
      <mesh>
        <boxGeometry args={[1.5, 0.06, 1.0]} />
        <meshStandardMaterial color="#fbf6ea" roughness={0.55} />
      </mesh>
      <mesh position={[0, 0.05, 0.42]}>
        <boxGeometry args={[1.5, 0.05, 0.16]} />
        <meshStandardMaterial color={good ? '#43a86b' : '#e05548'} roughness={0.5} />
      </mesh>
    </group>
  )
}

/* ---------------------------------- world ---------------------------------- */

function OverlayWorld({ store }: { store: SceneStore }) {
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => store.subscribe(force), [store])

  const s = store.get()

  // Stable per-seat progress refs so a mid-hop snapshot can't reset a pawn.
  const progressRefs = useMemo(() => Array.from({ length: 8 }, () => ({ current: 1 })), [])

  useFrame(() => {
    const st = store.get()
    const now = Date.now()
    for (const p of st.players) {
      const ref = progressRefs[p.seat]
      if (!ref) continue
      if (st.moveAnim && st.moveAnim.seat === p.seat) {
        const { start, dur, from, to } = st.moveAnim
        const steps = to >= from ? to - from : to + 40 - from
        const d = dur || HOP_BASE_MS + steps * HOP_PER_TILE_MS
        ref.current = Math.min(Math.max((now - start) / d, 0), 1)
      } else {
        ref.current = 1
      }
    }
  })

  // Where each pawn is heading (destination decides its slot, so the overlay
  // and the DOM fallback always agree on a settled position).
  const renderedTile = new Map<number, number>()
  for (const p of s.players) {
    const animating = s.moveAnim && s.moveAnim.seat === p.seat
    renderedTile.set(p.seat, animating ? s.moveAnim!.to : p.tile)
  }
  const groups = new Map<number, number[]>()
  for (const p of s.players) {
    if (p.bankrupt) continue
    const tile = renderedTile.get(p.seat) ?? p.tile
    const list = groups.get(tile) ?? []
    list.push(p.seat)
    groups.set(tile, list)
  }

  const currentPid = s.players[s.current]?.id

  // Houses/hotels, keyed by tile, coloured by the owner.
  const buildings: ReactNode[] = []
  for (const [key, count] of Object.entries(s.buildings)) {
    const index = Number(key)
    const color = s.owned[index]
    if (!color || count <= 0) continue
    if (tileRect(index).side === 'corner') continue
    buildings.push(<Buildings3D key={`b-${key}`} index={index} count={count} color={color} />)
  }

  return (
    <>
      <ambientLight intensity={1.2} />
      <directionalLight position={[5, 9, 4]} intensity={1.75} color="#fff4e2" />
      <directionalLight position={[-6, 7, -5]} intensity={0.65} color="#cfe0ff" />

      {buildings}

      {s.players.map((p) => {
        if (p.bankrupt) return null
        const tile = renderedTile.get(p.seat) ?? p.tile
        const list = groups.get(tile) ?? [p.seat]
        const slot = Math.max(0, list.indexOf(p.seat))
        const animating = s.moveAnim && s.moveAnim.seat === p.seat
        const from = animating ? s.moveAnim!.from : p.tile
        const to = animating ? s.moveAnim!.to : p.tile
        return (
          <Pawn3D
            key={p.id}
            from={from}
            to={to}
            slot={slot}
            count={list.length}
            seat={p.seat}
            color={p.color}
            isTurn={p.id === currentPid}
            progressRef={progressRefs[p.seat] ?? { current: 1 }}
          />
        )
      })}

      <Dice3D value={s.dice[0]} pos={[-0.95, -0.2]} trigger={s.rollTrigger} />
      <Dice3D value={s.dice[1]} pos={[0.95, 0.4]} trigger={s.rollTrigger} />

      <EventCard3D active={s.eventTile != null || s.buyTile != null} good={s.eventTile == null} />

      {s.buyTile != null && <CoinStack position={[0, TOKEN_TOP, 2.4]} count={3} />}
    </>
  )
}

/* --------------------------------- boundary --------------------------------- */

interface BoundaryProps {
  onError: () => void
  children: ReactNode
}

/** WebGL can fail at any time; the board must never depend on it. */
class CanvasErrorBoundary extends Component<BoundaryProps, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }
  componentDidCatch(): void {
    this.props.onError()
  }
  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

export interface BoardOverlay3DProps {
  store: SceneStore
  /** Called when the 3D layer can't run, so the board can show DOM markers. */
  onUnavailable?: () => void
  /** Cap the pixel ratio on low-power devices. */
  lowPower?: boolean
}

export function BoardOverlay3D({ store, onUnavailable, lowPower = false }: BoardOverlay3DProps) {
  return (
    <div className="bq-overlay" aria-hidden="true">
      <CanvasErrorBoundary onError={() => onUnavailable?.()}>
        <Canvas
          dpr={lowPower ? [1, 1.5] : [1, 2]}
          gl={{ antialias: !lowPower, alpha: true, powerPreference: 'high-performance' }}
          camera={{ fov: overlayFovDeg(), position: [0, OVERLAY_CAM_DIST, 0], near: 0.1, far: 80 }}
          style={{ pointerEvents: 'none' }}
          onCreated={({ gl }) => {
            gl.setClearColor(0x000000, 0)
          }}
        >
          <TopDownCamera />
          <OverlayWorld store={store} />
        </Canvas>
      </CanvasErrorBoundary>
    </div>
  )
}
