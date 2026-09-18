import { useMemo, useRef } from 'react'
import * as THREE from 'three'
import { Canvas, useFrame } from '@react-three/fiber'
import { ContactShadows, Environment, Lightformer, RoundedBox } from '@react-three/drei'
import { useFontsReady } from '../hooks/useFontsReady'
import { makeColorTexture, makeCornerTexture } from './textures'
import { CORNER_INDICES, CORNER_SIZE, TILE_POS, TILE_W, tileRotationY } from './layout'
import { TILES, CORNER_KINDS } from '../game/boardData'
import type { BoardTile } from '../game/boardData'

/* ------------------------------ floating island ------------------------------ */

function MiniBoard() {
  const fontsReady = useFontsReady()
  const tiles: BoardTile[] = useMemo(() => TILES, [])

  const textures = useMemo(() => {
    if (!fontsReady) return null
    const map = new Map<number, THREE.Texture>()
    tiles.forEach((t) => {
      if (!CORNER_INDICES.includes(t.index)) {
        map.set(t.index, makeColorTexture('amber', t.name, t.price ?? 100))
      }
    })
    CORNER_KINDS.forEach((k, i) => map.set(CORNER_INDICES[i], makeCornerTexture(k)))
    return map
  }, [fontsReady, tiles])

  const group = useRef<THREE.Group>(null)
  useFrame((state) => {
    const g = group.current
    if (!g) return
    g.rotation.y = -0.5 + Math.sin(state.clock.elapsedTime * 0.12) * 0.08
    g.position.y = Math.sin(state.clock.elapsedTime * 0.8) * 0.12
  })

  if (!textures) return null

  return (
    <group ref={group} rotation={[0, -0.5, 0]}>
      {/* felt slab */}
      <RoundedBox args={[8.4, 0.55, 8.4]} radius={0.12} smoothness={4} position={[0, -0.5, 0]}>
        <meshStandardMaterial color="#16304e" roughness={0.85} />
      </RoundedBox>
      {/* wooden rim */}
      <RoundedBox args={[9.0, 0.34, 9.0]} radius={0.12} smoothness={4} position={[0, -0.62, 0]}>
        <meshStandardMaterial color="#5d3a1f" roughness={0.55} />
      </RoundedBox>
      {/* golden trim */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, -0.22, 0]}>
        <ringGeometry args={[4.62, 4.76, 64]} />
        <meshStandardMaterial color="#d9a441" roughness={0.35} metalness={0.6} />
      </mesh>

      {/* all 40 tiles */}
      {tiles.map((t) => {
        const [x, z] = TILE_POS[t.index]
        const isCorner = CORNER_INDICES.includes(t.index)
        const size = isCorner ? CORNER_SIZE : TILE_W
        return (
          <RoundedBox
            key={t.index}
            args={[size, 0.12, isCorner ? size : size * 1.25]}
            radius={0.04}
            smoothness={3}
            position={[x, 0.06, z]}
            rotation={[0, tileRotationY(t.index), 0]}
            castShadow
          >
            <meshStandardMaterial map={textures.get(t.index)} roughness={0.42} metalness={0.04} />
          </RoundedBox>
        )
      })}

      {/* mini trees in the middle */}
      {[
        [-1.7, -1.4],
        [1.6, -1.6],
        [-1.4, 1.7],
        [1.7, 1.5],
      ].map(([x, z], i) => (
        <group key={i} position={[x, 0.12, z]}>
          <mesh castShadow position={[0, 0.16, 0]}>
            <cylinderGeometry args={[0.07, 0.1, 0.32, 8]} />
            <meshStandardMaterial color="#7a5230" roughness={0.8} />
          </mesh>
          <mesh castShadow position={[0, 0.52, 0]}>
            <coneGeometry args={[0.34, 0.64, 9]} />
            <meshStandardMaterial color={i % 2 ? '#4e9c4a' : '#3f8a3f'} roughness={0.7} />
          </mesh>
        </group>
      ))}

      {/* a couple of houses */}
      {[
        [0.6, 0.9, 'amber'],
        [-0.9, -0.6, 'sky'],
      ].map(([x, z, color], i) => (
        <group key={i} position={[Number(x), 0.12, Number(z)]}>
          <mesh castShadow position={[0, 0.1, 0]}>
            <boxGeometry args={[0.22, 0.2, 0.22]} />
            <meshStandardMaterial color={color === 'amber' ? '#f5a83c' : '#4ea3ff'} roughness={0.35} />
          </mesh>
          <mesh castShadow position={[0, 0.28, 0]} rotation={[0, Math.PI / 4, 0]}>
            <coneGeometry args={[0.18, 0.2, 4]} />
            <meshStandardMaterial color="#5b3b20" roughness={0.5} />
          </mesh>
        </group>
      ))}
    </group>
  )
}

/* --------------------------------- floating dice ------------------------------ */

function FloatingDie({
  position,
  scale = 1,
  speed = 1,
}: {
  position: [number, number, number]
  scale?: number
  speed?: number
}) {
  const group = useRef<THREE.Group>(null)
  useFrame((state) => {
    const g = group.current
    if (!g) return
    const t = state.clock.elapsedTime
    g.rotation.x = t * 0.45 * speed
    g.rotation.y = t * 0.62 * speed
    g.position.y = position[1] + Math.sin(t * speed + position[0]) * 0.22
  })
  return (
    <group ref={group} position={position} scale={scale}>
      <RoundedBox args={[0.9, 0.9, 0.9]} radius={0.16} smoothness={4} castShadow>
        <meshStandardMaterial color="#f7f1e3" roughness={0.25} />
      </RoundedBox>
      {[[-0.22, -0.22], [0.22, 0.22]].map(([x, y], i) => (
        <mesh key={i} position={[x, 0.46, y]}>
          <sphereGeometry args={[0.075, 14, 14]} />
          <meshStandardMaterial color="#31261a" roughness={0.5} />
        </mesh>
      ))}
    </group>
  )
}

/* --------------------------------- floating pawns ----------------------------- */

function FloatingPawn({
  position,
  color,
  phase = 0,
}: {
  position: [number, number, number]
  color: keyof typeof COLORS
  phase?: number
}) {
  const group = useRef<THREE.Group>(null)
  const c = COLORS[color]
  useFrame((state) => {
    const g = group.current
    if (!g) return
    const t = state.clock.elapsedTime
    g.position.y = position[1] + Math.sin(t * 1.1 + phase) * 0.24
    g.rotation.y = t * 0.5 + phase
  })
  return (
    <group ref={group} position={position}>
      <mesh castShadow>
        <coneGeometry args={[0.3, 0.74, 26]} />
        <meshStandardMaterial color={c.hex} roughness={0.25} metalness={0.12} />
      </mesh>
      <mesh position={[0, 0.45, 0]} castShadow>
        <sphereGeometry args={[0.14, 18, 18]} />
        <meshStandardMaterial color={c.light} roughness={0.2} />
      </mesh>
    </group>
  )
}

const COLORS = {
  amber: { hex: '#f5a83c', light: '#ffd58a' },
  sky: { hex: '#4ea3ff', light: '#9ecfff' },
  mint: { hex: '#3ddba8', light: '#8ef0cd' },
  rose: { hex: '#ff6b8a', light: '#ffa9bc' },
  violet: { hex: '#9d7bff', light: '#c8b4ff' },
  cyan: { hex: '#3fd8d8', light: '#96ecec' },
}

/* ------------------------------------- hero ----------------------------------- */

export default function HeroScene() {
  return (
    <Canvas
      shadows
      dpr={[1, 2]}
      gl={{ antialias: true }}
      camera={{ fov: 34, position: [9.5, 8.5, 9.5] }}
      style={{ touchAction: 'none' }}
    >
      <ambientLight intensity={0.5} />
      <directionalLight
        position={[8, 14, 6]}
        intensity={2.2}
        color="#fff4e0"
        castShadow
        shadow-mapSize={[2048, 2048]}
        shadow-camera-left={-10}
        shadow-camera-right={10}
        shadow-camera-top={10}
        shadow-camera-bottom={-10}
        shadow-bias={-0.0004}
      />
      <directionalLight position={[-7, 9, -6]} intensity={0.5} color="#7fb2ff" />

      <group position={[0, -0.6, 0]}>
        <MiniBoard />
        <FloatingDie position={[-4.6, 2.2, 2.6]} scale={1} speed={0.9} />
        <FloatingDie position={[4.4, 3.1, -2.2]} scale={0.72} speed={1.15} />
        <FloatingPawn position={[-3.9, 1.4, -3.2]} color="rose" phase={1.2} />
        <FloatingPawn position={[4.1, 1.1, 3.4]} color="mint" phase={2.6} />
        <FloatingPawn position={[0.4, 4.6, 4.6]} color="violet" phase={0.4} />
      </group>

      <ContactShadows position={[0, -2.35, 0]} opacity={0.5} scale={24} blur={2.8} far={6} />

      <Environment resolution={64}>
        <Lightformer intensity={2.0} position={[0, 6, 0]} scale={[12, 12, 1]} rotation-x={Math.PI / 2} />
        <Lightformer intensity={0.7} position={[-6, 3, -6]} scale={[8, 8, 1]} color="#9db8ff" />
        <Lightformer intensity={1.1} position={[6, 3, 6]} scale={[8, 8, 1]} color="#ffd9a0" />
      </Environment>
    </Canvas>
  )
}
