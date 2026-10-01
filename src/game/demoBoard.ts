/**
 * Practice-mode ("demo") board engine.
 *
 * Extracted verbatim in behaviour from the old 3D BoardScene: a self-contained
 * local table so a lone player can try the game without a server. It obeys the
 * exact same rules the server does (roll → move → land → rent/tax/buy → event →
 * next turn) and produces the same `SceneState` shape the 2D board and the 3D
 * overlay read, so the renderers are identical in both modes.
 *
 * This is UI-only fallback logic; the authoritative online game lives in
 * `server/rooms.ts` and is driven by `netBoardStore`.
 */
import { getTile, isEventTile, isOwnable, rentFor } from './boardData'
import type { BoardStore, ScenePlayer, SceneState } from '../board/types'

let logId = 0

/** Per-store bot pacing, kept out of the rendered state. */
const botTiming = new WeakMap<SceneState, { lastSeat: number; thinkAt: number }>()

export function createDemoStore(players: ScenePlayer[]): BoardStore {
  const state: SceneState = {
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
    buyTile: null,
    owned: {},
    buildings: {},
    mortgaged: {},
    moveAnim: null,
    last: null,
  }
  botTiming.set(state, { lastSeat: -1, thinkAt: 0 })
  const subs = new Set<() => void>()
  return {
    get: () => state,
    set: (fn) => {
      fn(state)
      subs.forEach((l) => l())
    },
    subscribe: (l) => {
      subs.add(l)
      return () => {
        subs.delete(l)
      }
    },
  }
}

function pushLog(state: SceneState, text: string, color: ScenePlayer['color']): void {
  state.log.push({ id: ++logId, text, color })
  if (state.log.length > 40) state.log.shift()
}

function rollDie(): number {
  return 1 + Math.floor(Math.random() * 6)
}

function nextTurn(state: SceneState): void {
  state.current = (state.current + 1) % state.players.length
}

function doRollLocal(store: BoardStore): void {
  const s = store.get()
  if (s.phase !== 'idle') return
  store.set((st) => {
    st.phase = 'rolling'
    st.dice = [rollDie(), rollDie()]
    st.rollTrigger++
    st.rolledAt = Date.now()
    st.eventTile = null
    st.buyTile = null
  })
}

/** Human roll — practice mode seats the local player at seat 0. */
export function rollDice(store: BoardStore): void {
  const s = store.get()
  if (s.phase !== 'idle') return
  if (s.players[s.current]?.seat !== 0) return
  doRollLocal(store)
}

export function resolveBuy(store: BoardStore, accept: boolean): void {
  const s = store.get()
  if (s.buyTile == null) return
  const tile = s.buyTile
  const price = getTile(tile)?.price ?? 100
  store.set((st) => {
    st.buyTile = null
    const pl = st.players[st.current]
    if (accept && pl) {
      pl.cash -= price
      st.owned[tile] = pl.color
      pushLog(st, `${pl.name} bought ${getTile(tile)?.name ?? 'a property'} for M ${price}`, pl.color)
    } else if (pl) {
      pushLog(st, `${pl.name} passed on ${getTile(tile)?.name ?? 'a property'}`, pl.color)
    }
    nextTurn(st)
  })
}

export function resolveEvent(store: BoardStore): void {
  store.set((s) => {
    s.eventTile = null
    nextTurn(s)
  })
}

/**
 * Advance the practice table. Call on a short interval (the old 3D scene ran
 * this every animation frame); it converts elapsed time into state transitions.
 */
export function stepDemo(store: BoardStore, now: number): void {
  const st = store.get()

  if (st.phase === 'rolling' && st.rolledAt && now - st.rolledAt > 1150) {
    const total = st.dice[0] + st.dice[1]
    const p = st.players[st.current]
    if (!p) return
    const from = p.tile
    const to = (from + total) % 40
    store.set((s) => {
      s.phase = 'moving'
      s.moveAnim = { seat: p.seat, from, to, start: now }
      s.last = { diceTotal: total, seat: p.seat }
      pushLog(s, `${p.name} rolled ${total}`, p.color)
    })
  }

  if (st.phase === 'moving' && st.moveAnim) {
    const { seat, from, to, start } = st.moveAnim
    const steps = to >= from ? to - from : to + 40 - from
    const dur = 260 + steps * 150
    if ((now - start) / dur >= 1) {
      store.set((s) => {
        const pl = s.players.find((pp) => pp.seat === seat)
        s.moveAnim = null
        s.phase = 'idle'
        if (!pl) return
        pl.tile = to
        if (to < from) {
          pl.cash += 200
          pushLog(s, `${pl.name} passed START +M 200`, pl.color)
        }
        const tile = getTile(to)
        pushLog(s, `${pl.name} landed on ${tile?.name ?? 'the board'}`, pl.color)

        if (isEventTile(to)) {
          if (pl.seat !== 0) {
            pushLog(s, `${pl.name} handled a surprise event`, pl.color)
          } else {
            s.eventTile = to
          }
        } else if (tile?.type === 'tax') {
          const amount = tile.taxAmount ?? 100
          pl.cash -= amount
          pushLog(s, `${pl.name} paid M ${amount} ${tile.name.toLowerCase()}`, pl.color)
        } else if (s.owned[to] !== undefined && s.owned[to] !== pl.color) {
          const owner = s.players.find((pp) => pp.color === s.owned[to])
          const rent = rentFor(to, s.buildings[to] ?? 0, false, s.dice[0] + s.dice[1])
          if (owner && rent > 0) {
            pl.cash -= rent
            owner.cash += rent
            pushLog(s, `${pl.name} paid ${owner.name} M ${rent} rent`, pl.color)
          }
        } else if (isOwnable(tile) && s.owned[to] === undefined) {
          const price = tile?.price ?? 0
          if (pl.seat !== 0 && pl.cash >= price) {
            pl.cash -= price
            s.owned[to] = pl.color
            pushLog(s, `${pl.name} bought ${tile?.name} for M ${price}`, pl.color)
          } else {
            s.buyTile = to
          }
        }
      })
    }
  }

  // Bot turn pacing: rivals roll on their own after a human-like pause.
  const timing = botTiming.get(store.get())
  if (!timing) return
  const cur = store.get()
  if (
    cur.phase === 'idle' &&
    !cur.eventTile &&
    !cur.buyTile &&
    cur.current !== 0 &&
    timing.lastSeat !== cur.current
  ) {
    const bot = cur.players[cur.current]
    if (bot && bot.seat !== 0) {
      timing.lastSeat = cur.current
      timing.thinkAt = now + 900 + Math.random() * 900
    }
  }
  if (
    cur.phase === 'idle' &&
    timing.lastSeat === cur.current &&
    cur.current !== 0 &&
    timing.thinkAt &&
    now >= timing.thinkAt
  ) {
    const bot = cur.players[cur.current]
    if (bot && bot.seat !== 0) {
      timing.lastSeat = -1
      timing.thinkAt = 0
      doRollLocal(store)
    }
  }
}
