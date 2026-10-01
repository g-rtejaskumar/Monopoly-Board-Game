/**
 * Procedural 3D tabletop models for BoardQuest.
 * All geometry is generated here (no external assets): tokens, houses,
 * hotels, card decks and coin props.
 */
import { useEffect, useMemo, useRef } from 'react'
import type { ReactNode } from 'react'
import * as THREE from 'three'
import { useFrame } from '@react-three/fiber'
import { Html, RoundedBox } from '@react-three/drei'
import { PLAYER_COLORS } from '../game/types'
import type { PlayerColor } from '../game/types'

/* --------------------------------- tokens --------------------------------- */

export const TOKEN_KINDS = [
  'crown',
  'rocket',
  'knight',
  'robot',
  'cat',
  'car',
  'wizard',
  'dragon',
] as const
export type TokenKind = (typeof TOKEN_KINDS)[number]

export function tokenKindForSeat(seat: number): TokenKind {
  return TOKEN_KINDS[seat % TOKEN_KINDS.length] ?? 'crown'
}

function TokenShape({ kind, hex, light }: { kind: TokenKind; hex: string; light: string }) {
  switch (kind) {
    case 'crown':
      return (
        <group>
          <mesh castShadow position={[0, 0.16, 0]}>
            <cylinderGeometry args={[0.19, 0.23, 0.16, 10]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          {[0, 1, 2, 3, 4].map((i) => {
            const a = (i / 5) * Math.PI * 2
            return (
              <mesh key={i} castShadow position={[Math.cos(a) * 0.16, 0.3, Math.sin(a) * 0.16]}>
                <coneGeometry args={[0.055, 0.14, 8]} />
                <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
              </mesh>
            )
          })}
          <mesh castShadow position={[0, 0.3, 0]}>
            <sphereGeometry args={[0.05, 10, 10]} />
            <meshStandardMaterial color={light} roughness={0.2} emissive={light} emissiveIntensity={0.35} />
          </mesh>
        </group>
      )
    case 'rocket':
      return (
        <group>
          <mesh castShadow position={[0, 0.22, 0]}>
            <cylinderGeometry args={[0.09, 0.13, 0.3, 12]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.47, 0]}>
            <coneGeometry args={[0.09, 0.2, 12]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          {[0, 1, 2].map((i) => {
            const a = (i / 3) * Math.PI * 2
            return (
              <mesh
                key={i}
                castShadow
                position={[Math.cos(a) * 0.12, 0.1, Math.sin(a) * 0.12]}
                rotation={[0, -a, 0.4]}
              >
                <boxGeometry args={[0.03, 0.14, 0.1]} />
                <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
              </mesh>
            )
          })}
          <mesh position={[0, 0.36, 0]}>
            <sphereGeometry args={[0.045, 10, 10]} />
            <meshStandardMaterial color={light} emissive={light} emissiveIntensity={0.7} />
          </mesh>
        </group>
      )
    case 'knight':
      return (
        <group>
          <mesh castShadow position={[0, 0.1, 0]}>
            <cylinderGeometry args={[0.16, 0.2, 0.12, 10]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.26, -0.02]} rotation={[0.35, 0, 0]}>
            <boxGeometry args={[0.14, 0.3, 0.12]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.42, 0.06]}>
            <boxGeometry args={[0.12, 0.14, 0.22]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.53, 0.05]} rotation={[0, Math.PI / 4, 0]}>
            <coneGeometry args={[0.07, 0.12, 4]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
        </group>
      )
    case 'robot':
      return (
        <group>
          <mesh castShadow position={[0, 0.16, 0]}>
            <boxGeometry args={[0.2, 0.22, 0.16]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.36, 0]}>
            <boxGeometry args={[0.16, 0.13, 0.14]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh position={[0, 0.37, 0.08]}>
            <boxGeometry args={[0.1, 0.04, 0.01]} />
            <meshStandardMaterial color={light} emissive={light} emissiveIntensity={0.9} />
          </mesh>
          <mesh castShadow position={[0, 0.46, 0]}>
            <cylinderGeometry args={[0.02, 0.02, 0.08, 6]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.52, 0]}>
            <sphereGeometry args={[0.04, 8, 8]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
        </group>
      )
    case 'cat':
      return (
        <group>
          <mesh castShadow position={[0, 0.14, 0]}>
            <capsuleGeometry args={[0.11, 0.16, 4, 10]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.36, 0.02]}>
            <sphereGeometry args={[0.11, 12, 12]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} castShadow position={[s * 0.07, 0.48, 0]}>
              <coneGeometry args={[0.045, 0.09, 6]} />
              <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
            </mesh>
          ))}
          <mesh castShadow position={[0, 0.3, -0.14]} rotation={[0.7, 0, 0]}>
            <capsuleGeometry args={[0.035, 0.16, 3, 8]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
        </group>
      )
    case 'car':
      return (
        <group rotation={[0, Math.PI / 5, 0]}>
          <mesh castShadow position={[0, 0.1, 0]}>
            <boxGeometry args={[0.34, 0.1, 0.18]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.2, -0.01]}>
            <boxGeometry args={[0.18, 0.1, 0.16]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          {[
            [-0.11, 0.1],
            [0.11, 0.1],
            [-0.11, -0.1],
            [0.11, -0.1],
          ].map(([x, z], i) => (
            <mesh key={i} castShadow position={[x, 0.05, z]} rotation={[Math.PI / 2, 0, 0]}>
              <cylinderGeometry args={[0.05, 0.05, 0.03, 10]} />
              <meshStandardMaterial color="#26221e" roughness={0.7} />
            </mesh>
          ))}
          <mesh position={[0, 0.2, 0.09]}>
            <boxGeometry args={[0.14, 0.05, 0.01]} />
            <meshStandardMaterial color={light} emissive={light} emissiveIntensity={0.5} />
          </mesh>
        </group>
      )
    case 'wizard':
      return (
        <group>
          <mesh castShadow position={[0, 0.14, 0]}>
            <coneGeometry args={[0.14, 0.28, 10]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.34, 0]}>
            <coneGeometry args={[0.17, 0.1, 10]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.5, 0]}>
            <coneGeometry args={[0.06, 0.24, 8]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh position={[0, 0.33, 0.15]}>
            <sphereGeometry args={[0.035, 8, 8]} />
            <meshStandardMaterial color={light} emissive={light} emissiveIntensity={0.8} />
          </mesh>
        </group>
      )
    default: // dragon
      return (
        <group>
          <mesh castShadow position={[0, 0.12, 0]}>
            <capsuleGeometry args={[0.1, 0.14, 4, 10]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.32, 0.05]} rotation={[0.5, 0, 0]}>
            <capsuleGeometry args={[0.07, 0.12, 3, 8]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          <mesh castShadow position={[0, 0.42, 0.12]} rotation={[0.9, 0, 0]}>
            <coneGeometry args={[0.05, 0.12, 6]} />
            <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
          </mesh>
          {[-1, 1].map((s) => (
            <mesh key={s} castShadow position={[s * 0.12, 0.22, -0.04]} rotation={[0, 0, s * 0.7]}>
              <coneGeometry args={[0.06, 0.16, 4]} />
              <meshStandardMaterial color={hex} roughness={0.28} metalness={0.18} />
            </mesh>
          ))}
        </group>
      )
  }
}

/** A full player token: base disc, themed shape, animated turn ring. */
export function Token({
  kind,
  color,
  isTurn,
  children,
}: {
  kind: TokenKind
  color: PlayerColor
  isTurn: boolean
  children?: ReactNode
}) {
  const c = PLAYER_COLORS[color]
  const ring = useRef<THREE.Mesh>(null)
  useFrame((state) => {
    if (ring.current) {
      ring.current.rotation.z = state.clock.elapsedTime * 1.4
      const m = ring.current.material as THREE.MeshBasicMaterial
      m.opacity = isTurn ? 0.55 + Math.sin(state.clock.elapsedTime * 4) * 0.2 : 0
    }
  })
  return (
    <group>
      <mesh castShadow position={[0, 0.02, 0]} receiveShadow>
        <cylinderGeometry args={[0.21, 0.24, 0.05, 18]} />
        <meshStandardMaterial color={c.dark} roughness={0.4} metalness={0.2} />
      </mesh>
      <TokenShape kind={kind} hex={c.hex} light={c.light} />
      <mesh ref={ring} position={[0, 0.012, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.3, 0.42, 28, 1, 0, Math.PI * 1.5]} />
        <meshBasicMaterial color={c.light} transparent opacity={0} side={THREE.DoubleSide} />
      </mesh>
      {children}
    </group>
  )
}

/* ----------------------------------- dice ---------------------------------- */

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
  const p = PIP_PATTERN[v] ?? PIP_PATTERN[1]!
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

const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3)
const smooth = (a: number, b: number, t: number) => {
  const x = Math.min(Math.max((t - a) / (b - a), 0), 1)
  return x * x * (3 - 2 * x)
}

/**
 * A tumbling 3D die that ALWAYS settles showing `value` — the animation never
 * decides the result, the authoritative dice do.
 */
export function Dice3D({
  value,
  pos,
  trigger,
  settleY = 0.42,
}: {
  value: number
  /** [x, z] on the board plane. */
  pos: [number, number]
  trigger: number
  settleY?: number
}) {
  const group = useRef<THREE.Group>(null)
  const anim = useRef({ t0: 0, active: false })
  const start = useMemo(() => new THREE.Vector3(pos[0], 5.4, pos[1]), [pos])
  const end = useMemo(() => new THREE.Vector3(pos[0], settleY, pos[1]), [pos, settleY])
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
      faceE.set(...(FACE_ROT[value] ?? FACE_ROT[1]!))
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
      faceE.set(...(FACE_ROT[value] ?? FACE_ROT[1]!))
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

/* -------------------------------- buildings -------------------------------- */

let sharedBuildingGeo: {
  body: THREE.BoxGeometry
  roof: THREE.ConeGeometry
  hotelBody: THREE.BoxGeometry
  hotelRoof: THREE.ConeGeometry
} | null = null

function getBuildingGeometries() {
  if (!sharedBuildingGeo) {
    sharedBuildingGeo = {
      body: new THREE.BoxGeometry(0.22, 0.18, 0.22),
      roof: new THREE.ConeGeometry(0.19, 0.16, 4),
      hotelBody: new THREE.BoxGeometry(0.3, 0.46, 0.3),
      hotelRoof: new THREE.ConeGeometry(0.27, 0.2, 4),
    }
  }
  return sharedBuildingGeo
}

/** Small 3D house placed on an owned street tile. */
export function House({
  position,
  rotationY = 0,
  color,
}: {
  position: [number, number, number]
  rotationY?: number
  color: PlayerColor
}) {
  const geo = getBuildingGeometries()
  const c = PLAYER_COLORS[color]
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh geometry={geo.body} castShadow position={[0, 0.09, 0]}>
        <meshStandardMaterial color={c.hex} roughness={0.4} />
      </mesh>
      <mesh geometry={geo.roof} castShadow position={[0, 0.26, 0]} rotation={[0, Math.PI / 4, 0]}>
        <meshStandardMaterial color="#6b4226" roughness={0.6} />
      </mesh>
    </group>
  )
}

/** Larger 3D hotel that replaces houses on a fully built street. */
export function Hotel({
  position,
  rotationY = 0,
  color,
}: {
  position: [number, number, number]
  rotationY?: number
  color: PlayerColor
}) {
  const geo = getBuildingGeometries()
  const c = PLAYER_COLORS[color]
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh geometry={geo.hotelBody} castShadow position={[0, 0.23, 0]}>
        <meshStandardMaterial color={c.hex} roughness={0.35} metalness={0.1} />
      </mesh>
      <mesh geometry={geo.hotelRoof} castShadow position={[0, 0.56, 0]} rotation={[0, Math.PI / 4, 0]}>
        <meshStandardMaterial color="#8a5a2e" roughness={0.55} metalness={0.15} />
      </mesh>
      <mesh position={[0, 0.3, 0.16]}>
        <planeGeometry args={[0.18, 0.08]} />
        <meshStandardMaterial color="#ffe9b0" emissive="#ffd977" emissiveIntensity={0.8} />
      </mesh>
    </group>
  )
}

/* ---------------------------------- props ---------------------------------- */

/** Card deck (Chance / Community) sitting on the felt. */
export function CardDeck({
  position,
  color,
  label,
}: {
  position: [number, number, number]
  color: string
  label: string
}) {
  const cards = useMemo(() => new Array(5).fill(0).map((_, i) => i), [])
  return (
    <group position={position}>
      {cards.map((i) => (
        <mesh key={i} castShadow position={[0, 0.02 + i * 0.022, 0]} rotation={[0, (i % 2) * 0.06, 0]}>
          <boxGeometry args={[0.72, 0.02, 0.46]} />
          <meshStandardMaterial color={i === cards.length - 1 ? color : '#f5edd8'} roughness={0.6} />
        </mesh>
      ))}
      <Html center position={[0, 0.2, 0]} distanceFactor={9} zIndexRange={[30, 0]}>
        <div className="deck-label">{label}</div>
      </Html>
    </group>
  )
}

/** A small stack of golden coins. */
export function CoinStack({
  position,
  count = 4,
}: {
  position: [number, number, number]
  count?: number
}) {
  const coins = useMemo(() => new Array(count).fill(0).map((_, i) => i), [count])
  return (
    <group position={position}>
      {coins.map((i) => (
        <mesh key={i} castShadow position={[0, 0.03 + i * 0.045, 0]} rotation={[0, i * 0.5, 0]}>
          <cylinderGeometry args={[0.11, 0.11, 0.035, 16]} />
          <meshStandardMaterial color="#e8b64c" roughness={0.25} metalness={0.75} />
        </mesh>
      ))}
    </group>
  )
}

/** Wooden tray resting on the felt (decorative). */
export function WoodenTray({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      <RoundedBox
        args={[2.5, 0.14, 1.1]}
        radius={0.05}
        smoothness={3}
        position={[0, 0.07, 0]}
        castShadow
        receiveShadow
      >
        <meshStandardMaterial color="#6d4426" roughness={0.6} />
      </RoundedBox>
      <RoundedBox args={[2.36, 0.06, 0.96]} radius={0.03} smoothness={3} position={[0, 0.15, 0]}>
        <meshStandardMaterial color="#7d5230" roughness={0.55} />
      </RoundedBox>
    </group>
  )
}
