import * as THREE from 'three'
import { GROUP_COLORS } from '../game/boardData'
import type { BoardTile, GroupId } from '../game/boardData'
import { PLAYER_COLORS } from '../game/types'
import type { PlayerColor } from '../game/types'

const DISPLAY = '"Baloo 2", "Trebuchet MS", sans-serif'
const BODY = '"Outfit", system-ui, sans-serif'

function makeCanvas(w: number, h: number) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')!
  return { canvas, ctx }
}

function toTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const tex = new THREE.CanvasTexture(canvas)
  tex.anisotropy = 8
  tex.colorSpace = THREE.SRGBColorSpace
  return tex
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

function grain(ctx: CanvasRenderingContext2D, w: number, h: number, n = 140): void {
  ctx.globalAlpha = 0.05
  for (let i = 0; i < n; i++) {
    ctx.fillStyle = i % 2 ? '#8a6d3f' : '#ffffff'
    ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2)
  }
  ctx.globalAlpha = 1
}

function bevel(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.strokeStyle = 'rgba(255,255,255,0.5)'
  ctx.lineWidth = 3
  ctx.strokeRect(2.5, 2.5, w - 5, h - 5)
  ctx.strokeStyle = 'rgba(90,60,20,0.28)'
  ctx.strokeRect(6.5, 6.5, w - 13, h - 13)
}

/** Wrap a name onto at most two lines that fit `maxW`. */
function wrapName(ctx: CanvasRenderingContext2D, name: string, maxW: number, font: string): string[] {
  ctx.font = font
  if (ctx.measureText(name).width <= maxW) return [name]
  const words = name.split(' ')
  const mid = Math.ceil(words.length / 2)
  const a = words.slice(0, mid).join(' ')
  const b = words.slice(mid).join(' ')
  return b ? [a, b] : [a]
}

/* ------------------------------- tiny glyphs ------------------------------- */

function glyphHouse(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string): void {
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.moveTo(x - s, y)
  ctx.lineTo(x, y - s * 0.9)
  ctx.lineTo(x + s, y)
  ctx.lineTo(x + s * 0.78, y)
  ctx.lineTo(x + s * 0.78, y + s * 0.8)
  ctx.lineTo(x - s * 0.78, y + s * 0.8)
  ctx.lineTo(x - s, y)
  ctx.closePath()
  ctx.fill()
}

function glyphTrain(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string): void {
  ctx.fillStyle = fill
  roundRect(ctx, x - s, y - s * 0.55, s * 2, s * 0.95, s * 0.22)
  ctx.fill()
  ctx.beginPath()
  ctx.moveTo(x - s * 0.55, y - s * 0.55)
  ctx.lineTo(x - s * 0.2, y - s * 1.05)
  ctx.lineTo(x + s * 0.75, y - s * 1.05)
  ctx.lineTo(x + s, y - s * 0.55)
  ctx.closePath()
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.85)'
  ;[-0.55, 0, 0.55].forEach((o) => {
    ctx.beginPath()
    ctx.arc(x + o * s, y + s * 0.55, s * 0.16, 0, Math.PI * 2)
    ctx.fill()
  })
}

function glyphBolt(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string): void {
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.moveTo(x + s * 0.25, y - s)
  ctx.lineTo(x - s * 0.6, y + s * 0.15)
  ctx.lineTo(x - s * 0.05, y + s * 0.15)
  ctx.lineTo(x - s * 0.25, y + s)
  ctx.lineTo(x + s * 0.6, y - s * 0.2)
  ctx.lineTo(x + s * 0.05, y - s * 0.2)
  ctx.closePath()
  ctx.fill()
}

function glyphDrop(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string): void {
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.moveTo(x, y - s)
  ctx.quadraticCurveTo(x + s * 0.85, y + s * 0.1, x, y + s * 0.85)
  ctx.quadraticCurveTo(x - s * 0.85, y + s * 0.1, x, y - s)
  ctx.fill()
}

function glyphQuestion(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string): void {
  ctx.fillStyle = fill
  ctx.font = `800 ${s * 2.1}px ${DISPLAY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('?', x, y)
}

function glyphChest(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string): void {
  ctx.fillStyle = fill
  roundRect(ctx, x - s, y - s * 0.35, s * 2, s * 1.05, s * 0.18)
  ctx.fill()
  ctx.beginPath()
  ctx.arc(x, y - s * 0.35, s, Math.PI, 0)
  ctx.fill()
  ctx.fillStyle = 'rgba(255,255,255,0.8)'
  ctx.fillRect(x - s * 0.16, y - s * 0.5, s * 0.32, s * 1.1)
}

function glyphCoin(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, fill: string): void {
  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.arc(x, y, s, 0, Math.PI * 2)
  ctx.fill()
  ctx.fillStyle = 'rgba(0,0,0,0.28)'
  ctx.font = `800 ${s * 1.3}px ${DISPLAY}`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('M', x, y + s * 0.06)
}

/**
 * Cream street tile: group-colored header band (toward the board center),
 * bold name, price and base rent. Canvas top == inner edge (matches the
 * per-side rotations in layout.ts).
 */
export function makeTileTexture(tile: BoardTile): THREE.CanvasTexture {
  const W = 256
  const H = 384 // portrait: TILE_W x TILE_D
  const { canvas, ctx } = makeCanvas(W, H)

  // base cream plastic
  const base = ctx.createLinearGradient(0, 0, 0, H)
  base.addColorStop(0, '#fbf3e4')
  base.addColorStop(0.55, '#f3e6cf')
  base.addColorStop(1, '#e7d6b8')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, W, H)
  grain(ctx, W, H)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const bandH = 92
  const gc = tile.colorGroup ? GROUP_COLORS[tile.colorGroup] : null

  if (tile.type === 'property' && gc) {
    // header band
    const band = ctx.createLinearGradient(0, 0, 0, bandH)
    band.addColorStop(0, gc.light)
    band.addColorStop(1, gc.hex)
    ctx.fillStyle = band
    ctx.fillRect(0, 0, W, bandH)
    ctx.fillStyle = 'rgba(0,0,0,0.22)'
    ctx.fillRect(0, bandH, W, 3)
    // tiny houses on the band
    glyphHouse(ctx, W / 2 - 40, bandH - 24, 13, 'rgba(255,255,255,0.9)')
    glyphHouse(ctx, W / 2, bandH - 24, 13, 'rgba(255,255,255,0.65)')
    glyphHouse(ctx, W / 2 + 40, bandH - 24, 13, 'rgba(255,255,255,0.4)')

    // name
    ctx.fillStyle = 'rgba(28,20,8,0.92)'
    const nameFont = `700 30px ${BODY}`
    const lines = wrapName(ctx, tile.name, W - 36, nameFont)
    ctx.font = nameFont
    if (lines.length === 1) ctx.fillText(lines[0], W / 2, 158)
    else {
      ctx.fillText(lines[0], W / 2, 140)
      ctx.fillText(lines[1], W / 2, 176)
    }

    // price + rent
    ctx.font = `700 26px ${BODY}`
    ctx.fillStyle = 'rgba(28,20,8,0.85)'
    ctx.fillText(`M ${tile.price}`, W / 2, 248)
    ctx.font = `600 21px ${BODY}`
    ctx.fillStyle = 'rgba(28,20,8,0.55)'
    ctx.fillText(`rent M ${tile.rent?.[0] ?? 0}`, W / 2, 286)
  } else if (tile.type === 'railroad') {
    ctx.fillStyle = '#33415c'
    ctx.fillRect(0, 0, W, bandH)
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(0, bandH, W, 3)
    glyphTrain(ctx, W / 2, bandH - 34, 26, '#f4e9d0')
    ctx.fillStyle = 'rgba(28,20,8,0.92)'
    const nameFont = `700 28px ${BODY}`
    const lines = wrapName(ctx, tile.name, W - 36, nameFont)
    ctx.font = nameFont
    if (lines.length === 1) ctx.fillText(lines[0], W / 2, 170)
    else {
      ctx.fillText(lines[0], W / 2, 150)
      ctx.fillText(lines[1], W / 2, 186)
    }
    ctx.font = `700 26px ${BODY}`
    ctx.fillStyle = 'rgba(28,20,8,0.85)'
    ctx.fillText(`M ${tile.price}`, W / 2, 268)
  } else if (tile.type === 'utility') {
    ctx.fillStyle = '#4d6273'
    ctx.fillRect(0, 0, W, bandH)
    ctx.fillStyle = 'rgba(0,0,0,0.25)'
    ctx.fillRect(0, bandH, W, 3)
    if (tile.index === 12) glyphBolt(ctx, W / 2, bandH - 36, 22, '#ffd977')
    else glyphDrop(ctx, W / 2, bandH - 36, 22, '#9adcff')
    ctx.fillStyle = 'rgba(28,20,8,0.92)'
    const nameFont = `700 28px ${BODY}`
    const lines = wrapName(ctx, tile.name, W - 36, nameFont)
    ctx.font = nameFont
    if (lines.length === 1) ctx.fillText(lines[0], W / 2, 170)
    else {
      ctx.fillText(lines[0], W / 2, 150)
      ctx.fillText(lines[1], W / 2, 186)
    }
    ctx.font = `700 26px ${BODY}`
    ctx.fillStyle = 'rgba(28,20,8,0.85)'
    ctx.fillText(`M ${tile.price}`, W / 2, 268)
  } else if (tile.type === 'chance') {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#ffb95e')
    g.addColorStop(1, '#ef8f2e')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    glyphQuestion(ctx, W / 2, H / 2 - 20, 52, 'rgba(255,255,255,0.95)')
    ctx.fillStyle = 'rgba(60,32,4,0.85)'
    ctx.font = `800 30px ${DISPLAY}`
    ctx.fillText('CHANCE', W / 2, H - 60)
  } else if (tile.type === 'community') {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#63c8f5')
    g.addColorStop(1, '#3a97cf')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    glyphChest(ctx, W / 2, H / 2 - 14, 40, 'rgba(255,255,255,0.95)')
    ctx.fillStyle = 'rgba(10,40,60,0.85)'
    ctx.font = `800 25px ${DISPLAY}`
    ctx.fillText('COMMUNITY', W / 2, H - 66)
    ctx.fillText('FUND', W / 2, H - 36)
  } else if (tile.type === 'tax') {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#cfd8e4')
    g.addColorStop(1, '#aebccb')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    glyphCoin(ctx, W / 2, H / 2 - 16, 34, '#f0c24b')
    ctx.fillStyle = 'rgba(30,36,48,0.9)'
    ctx.font = `800 26px ${DISPLAY}`
    ctx.fillText(tile.name.toUpperCase(), W / 2, H - 66)
    ctx.font = `700 24px ${BODY}`
    ctx.fillText(`pay M ${tile.taxAmount}`, W / 2, H - 32)
  }

  bevel(ctx, W, H)
  return toTexture(canvas)
}

/** Special corner tiles: START, JAIL, PARK, GO TO JAIL. */
export function makeCornerTexture(kind: 'start' | 'jail' | 'park' | 'goto'): THREE.CanvasTexture {
  const W = 256
  const H = 256
  const { canvas, ctx } = makeCanvas(W, H)

  const base = ctx.createLinearGradient(0, 0, W, H)
  base.addColorStop(0, '#fdf6e8')
  base.addColorStop(1, '#ecd9b4')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, W, H)

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'

  const drawDice = (x: number, y: number, s: number, rot: number, pips: Array<[number, number]>) => {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(rot)
    ctx.fillStyle = '#fdfaf2'
    ctx.strokeStyle = 'rgba(60,40,10,0.35)'
    ctx.lineWidth = 4
    roundRect(ctx, -s / 2, -s / 2, s, s, s * 0.24)
    ctx.fill()
    ctx.stroke()
    ctx.fillStyle = '#c8472e'
    for (const [px, py] of pips) {
      ctx.beginPath()
      ctx.arc(px * s * 0.28, py * s * 0.28, s * 0.1, 0, Math.PI * 2)
      ctx.fill()
    }
    ctx.restore()
  }

  if (kind === 'start') {
    // amber sunburst
    for (let i = 0; i < 12; i++) {
      ctx.fillStyle = i % 2 ? '#f7c765' : '#f0a93a'
      ctx.beginPath()
      ctx.moveTo(W / 2, H / 2)
      const a1 = (i / 12) * Math.PI * 2
      const a2 = ((i + 1) / 12) * Math.PI * 2
      ctx.arc(W / 2, H / 2, W * 0.72, a1, a2)
      ctx.closePath()
      ctx.fill()
    }
    ctx.fillStyle = 'rgba(50,30,5,0.85)'
    ctx.font = `800 44px ${DISPLAY}`
    ctx.fillText('START', W / 2, 52)
    ctx.font = `600 24px ${BODY}`
    ctx.fillText('collect M 200', W / 2, H - 44)
    drawDice(W / 2, H / 2 + 14, 84, -0.18, [
      [-1, -1],
      [1, -1],
      [0, 0],
      [-1, 1],
      [1, 1],
    ])
  } else if (kind === 'jail') {
    ctx.fillStyle = '#dfe9f2'
    ctx.fillRect(0, 0, W, H)
    // bars
    ctx.fillStyle = '#8f9bab'
    for (let i = 0; i < 6; i++) ctx.fillRect(28 + i * 36, 40, 12, 176)
    ctx.fillStyle = 'rgba(30,40,55,0.9)'
    ctx.font = `800 40px ${DISPLAY}`
    ctx.fillText('JAIL', W / 2, H - 34)
    ctx.font = `600 22px ${BODY}`
    ctx.fillStyle = 'rgba(30,40,55,0.65)'
    ctx.fillText('just visiting', W / 2, 30)
  } else if (kind === 'park') {
    const g = ctx.createLinearGradient(0, 0, 0, H)
    g.addColorStop(0, '#bfe6a8')
    g.addColorStop(1, '#8fce74')
    ctx.fillStyle = g
    ctx.fillRect(0, 0, W, H)
    // trees
    const tree = (x: number, y: number, s: number) => {
      ctx.fillStyle = '#7a5230'
      ctx.fillRect(x - 5 * s, y, 10 * s, 22 * s)
      ctx.fillStyle = '#4e9c4a'
      ctx.beginPath()
      ctx.arc(x, y - 10 * s, 26 * s, 0, Math.PI * 2)
      ctx.fill()
      ctx.fillStyle = '#66b95c'
      ctx.beginPath()
      ctx.arc(x - 10 * s, y + 2 * s, 16 * s, 0, Math.PI * 2)
      ctx.fill()
    }
    tree(70, 150, 1)
    tree(180, 120, 0.8)
    ctx.fillStyle = 'rgba(20,60,20,0.85)'
    ctx.font = `800 42px ${DISPLAY}`
    ctx.fillText('FREE PARKING', W / 2, 46)
    ctx.font = `600 22px ${BODY}`
    ctx.fillText('take a rest', W / 2, H - 26)
  } else {
    // go to jail
    ctx.fillStyle = '#f3d9cf'
    ctx.fillRect(0, 0, W, H)
    ctx.fillStyle = '#c8472e'
    ctx.font = `800 38px ${DISPLAY}`
    ctx.fillText('GO TO', W / 2, 74)
    ctx.fillText('JAIL', W / 2, 118)
    // handcuffs-ish ring
    ctx.strokeStyle = 'rgba(90,40,30,0.75)'
    ctx.lineWidth = 10
    ctx.beginPath()
    ctx.arc(W / 2, 186, 34, 0, Math.PI * 2)
    ctx.stroke()
    ctx.lineWidth = 8
    ctx.beginPath()
    ctx.moveTo(W / 2 - 34, 178)
    ctx.quadraticCurveTo(W / 2, 150, W / 2 + 34, 178)
    ctx.stroke()
  }

  ctx.strokeStyle = 'rgba(120,90,50,0.35)'
  ctx.lineWidth = 4
  ctx.strokeRect(2, 2, W - 4, H - 4)
  return toTexture(canvas)
}

/** Deep green felt center with the gold BoardQuest emblem. */
export function makeCenterTexture(): THREE.CanvasTexture {
  const W = 1024
  const H = 1024
  const { canvas, ctx } = makeCanvas(W, H)

  // deep felt
  const felt = ctx.createRadialGradient(W / 2, H / 2, 60, W / 2, H / 2, W * 0.62)
  felt.addColorStop(0, '#1e5c3c')
  felt.addColorStop(1, '#123c27')
  ctx.fillStyle = felt
  ctx.fillRect(0, 0, W, H)

  // subtle diagonal weave
  ctx.globalAlpha = 0.05
  ctx.strokeStyle = '#a8e6c3'
  ctx.lineWidth = 2
  for (let i = -W; i < W; i += 18) {
    ctx.beginPath()
    ctx.moveTo(i, 0)
    ctx.lineTo(i + W, W)
    ctx.stroke()
  }
  ctx.globalAlpha = 1

  // gold double ring
  ctx.strokeStyle = 'rgba(245,190,90,0.85)'
  ctx.lineWidth = 10
  ctx.beginPath()
  ctx.arc(W / 2, H / 2, 300, 0, Math.PI * 2)
  ctx.stroke()
  ctx.strokeStyle = 'rgba(245,190,90,0.4)'
  ctx.lineWidth = 4
  ctx.beginPath()
  ctx.arc(W / 2, H / 2, 272, 0, Math.PI * 2)
  ctx.stroke()
  ctx.beginPath()
  ctx.arc(W / 2, H / 2, 328, 0, Math.PI * 2)
  ctx.stroke()

  // title
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = '#f6d997'
  ctx.font = `800 112px ${DISPLAY}`
  ctx.fillText('BOARD', W / 2, H / 2 - 62)
  const grad = ctx.createLinearGradient(W / 2 - 200, 0, W / 2 + 200, 0)
  grad.addColorStop(0, '#ffd98d')
  grad.addColorStop(1, '#f0a93a')
  ctx.fillStyle = grad
  ctx.font = `800 112px ${DISPLAY}`
  ctx.fillText('QUEST', W / 2, H / 2 + 60)

  // small dice ornament
  ctx.fillStyle = 'rgba(246,217,151,0.9)'
  ;[
    [W / 2 - 205, H / 2 + 190, 0.4],
    [W / 2 + 205, H / 2 - 190, -0.5],
  ].forEach(([x, y, r]) => {
    ctx.save()
    ctx.translate(x, y)
    ctx.rotate(r)
    roundRect(ctx, -30, -30, 60, 60, 14)
    ctx.fill()
    ctx.fillStyle = '#123c27'
    ;[
      [-1, -1],
      [1, 1],
    ].forEach(([px, py]) => {
      ctx.beginPath()
      ctx.arc(px * 13, py * 13, 6.5, 0, Math.PI * 2)
      ctx.fill()
    })
    ctx.fillStyle = 'rgba(246,217,151,0.9)'
    ctx.restore()
  })

  return toTexture(canvas)
}

/** Back-compat helper for the hero scene (player-colored demo tiles). */
export function makeColorTexture(color: PlayerColor, name: string, price: number): THREE.CanvasTexture {
  const W = 256
  const H = 256
  const { canvas, ctx } = makeCanvas(W, H)
  const c = PLAYER_COLORS[color]

  const base = ctx.createLinearGradient(0, 0, 0, H)
  base.addColorStop(0, '#fbf3e4')
  base.addColorStop(0.55, '#f3e6cf')
  base.addColorStop(1, '#e7d6b8')
  ctx.fillStyle = base
  ctx.fillRect(0, 0, W, H)
  grain(ctx, W, H)

  const bandH = 74
  const band = ctx.createLinearGradient(0, 0, 0, bandH)
  band.addColorStop(0, c.light)
  band.addColorStop(1, c.hex)
  ctx.fillStyle = band
  ctx.fillRect(0, 0, W, bandH)
  ctx.fillStyle = 'rgba(0,0,0,0.22)'
  ctx.fillRect(0, bandH, W, 3)

  ctx.fillStyle = 'rgba(28,20,8,0.9)'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  const nameFont = `700 27px ${BODY}`
  const lines = wrapName(ctx, name, W - 30, nameFont)
  ctx.font = nameFont
  if (lines.length === 1) ctx.fillText(lines[0], W / 2, 38)
  else {
    ctx.fillText(lines[0], W / 2, 24)
    ctx.fillText(lines[1], W / 2, 52)
  }

  ctx.font = `600 24px ${BODY}`
  ctx.fillStyle = 'rgba(28,20,8,0.62)'
  ctx.fillText(`M ${price}`, W / 2, H - 32)

  bevel(ctx, W, H)
  return toTexture(canvas)
}

/** Group color as a plain hex string (used by HTML deed cards). */
export function groupHex(group: GroupId | undefined): string {
  return group ? GROUP_COLORS[group].hex : '#9aa7c7'
}
