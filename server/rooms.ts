/**
 * BoardQuest authoritative game engine (in-memory, single process).
 * Clients send intents; the server validates everything and broadcasts snapshots.
 *
 * Mechanics: trading, mortgages, auctions, jail (pay/card/doubles), structured
 * card decks, debt collection + bankruptcy, win detection, 8-player support.
 */
import type {
  ServerMsg,
  PlayerPublic,
  RoomSnapshot,
  GameSnapshot,
  GamePlayer,
  ErrCode,
  Dice,
  ChatMessage,
  TradeState,
  TradePayload,
  AuctionState,
  DebtState,
} from '../src/net/protocol'
import { MAX_PLAYERS, START_CASH, START_BONUS, BOARD_SIZE, rollDie, TOKEN_IDS, isTokenId } from '../src/net/protocol'
import type { TokenId } from '../src/net/protocol'
import {
  TILES,
  isEventTile,
  isOwnable,
  rentFor,
  groupTiles,
  getTile,
  JAIL_INDEX,
} from '../src/game/boardData'
import type { GroupId } from '../src/game/boardData'

export function log(...args: unknown[]): void {
  console.log(`[boardquest ${new Date().toISOString()}]`, ...args)
}

/* --------------------------------- identity ---------------------------------- */

let idCounter = 0
function makeId(prefix: string): string {
  idCounter++
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

function makeCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  let out = ''
  for (let i = 0; i < 6; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)]
  return out
}

/** Safety cap so an open deployment can't accumulate unbounded empty rooms. */
const MAX_ROOMS = 500

function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, 14)
}

const BOT_NAMES = ['Botsby', 'Claire', 'Rooke', 'Dexter', 'Wren', 'Otto']

/** First token id not already taken by a player in `room`. */
function firstFreeToken(room: Room): TokenId {
  const used = new Set(room.players.map((p) => p.token))
  return TOKEN_IDS.find((t) => !used.has(t)) ?? 'hat'
}

/* --------------------------------- card decks --------------------------------- */

export interface Card {
  title: string
  body: string
  /** Positive = gain, negative = pay. */
  amount: number
  /** 'bank' pays/receives; otherwise the id of a player index function. */
  collectFromEach?: number
  move?: number
  moveTo?: number
  jail?: boolean
  jailCard?: boolean
}

const CHANCE_DECK: Card[] = [
  { title: 'Advance to Start', body: 'Take a stroll down memory lane.', amount: 0, moveTo: 0 },
  { title: 'Speeding Fine', body: 'You were caught racing down Canal Bridge.', amount: -50 },
  { title: 'Bank Pays Dividend', body: 'Your investments paid off.', amount: 120 },
  { title: 'Go Directly to Jail', body: 'Do not pass Start, do not collect M 200.', amount: 0, jail: true },
  { title: 'Get Out of Jail Free', body: 'Keep this card until you need it.', amount: 0, jailCard: true },
  { title: 'Building Repairs', body: 'You own the finest roofs in town — but they cost.', amount: -40, collectFromEach: -40 },
  { title: 'Grand Opera Invite', body: 'Front-row seats, on the house.', amount: 80 },
  { title: 'Advance to Kings Promenade', body: 'The jewel of the board.', amount: 0, moveTo: 39 },
  { title: 'Windfall', body: 'Your numbers came up. +M 200!', amount: 200 },
  { title: 'Harbor Cruise', body: 'An evening to remember — and an invoice.', amount: -90 },
]

const COMMUNITY_DECK: Card[] = [
  { title: 'Bank Error', body: 'The bank shortchanged itself. Keep the difference.', amount: 150 },
  { title: 'Community Raffle', body: 'Your ticket was drawn. +M 100', amount: 100 },
  { title: 'Doctor Visit', body: 'Routine checkup, surprisingly pricey.', amount: -80 },
  { title: 'Get Out of Jail Free', body: 'Keep this card until you need it.', amount: 0, jailCard: true },
  { title: 'Go Directly to Jail', body: 'Do not pass Start, do not collect M 200.', amount: 0, jail: true },
  { title: 'Tax Refund', body: 'The city owes you one.', amount: 130 },
  { title: 'Street Party Fund', body: 'Everyone chips in for the neighborhood.', amount: 0, collectFromEach: 40 },
  { title: 'Hospital Fees', body: 'A tumble off the lobby ladder.', amount: -110 },
]

/* ------------------------------------ room ------------------------------------ */

export type SendFn = (msg: ServerMsg) => void

interface Member {
  id: string
  name: string
  color: string
  token: TokenId
  isHost: boolean
  isBot: boolean
  ready: boolean
  connected: boolean
  send: SendFn | null
}

interface Room {
  code: string
  hostId: string
  players: Member[]
  started: boolean
  game: Game | null
}

const COLORS = ['#f5a83c', '#4ea3ff', '#3ddba8', '#ff6b8a', '#9d7bff', '#3fd8d8', '#a8d83f', '#ff8a5c']

function roomSnapshot(room: Room): RoomSnapshot {
  return {
    code: room.code,
    hostId: room.hostId,
    started: room.started,
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      token: p.token,
      connected: p.connected,
      isHost: p.isHost,
      isBot: p.isBot,
      ready: p.ready,
    })),
  }
}

function broadcastRoom(room: Room): void {
  const msg: ServerMsg = { t: 'room', room: roomSnapshot(room) }
  for (const p of room.players) p.send?.(msg)
}

/* ------------------------------------ game ------------------------------------ */

interface Game {
  players: GamePlayer[]
  current: number
  turn: number
  phase: GameSnapshot['phase']
  dice: Dice
  rollId: number
  rolledAt: number
  doubles: number
  owned: Record<string, string>
  buildings: Record<string, number>
  mortgaged: Record<string, true>
  buyTile: number | null
  eventTile: number | null
  eventText: { title: string; body: string; good: boolean } | null
  pendingCard: Card | null
  debt: DebtState | null
  trade: TradeState | null
  tradeRespondedFrom: boolean
  auction: AuctionState | null
  log: Array<{ id: number; text: string; color: string }>
  winner: string | null
}

let logId = 0

/**
 * Dice source. Production rolls randomly; the regression suite can pin exact
 * rolls with BQ_FORCE_DICE="5,1,3,…" so movement can be asserted deterministically.
 * Values are consumed left to right and the queue falls back to real randomness
 * once exhausted, so a long game never blocks.
 */
const forcedDice: number[] = (process.env.BQ_FORCE_DICE || '')
  .split(',')
  .map((n) => Number(n.trim()))
  .filter((n) => Number.isInteger(n) && n >= 1 && n <= 6)
function nextDie(): number {
  const forced = forcedDice.shift()
  return forced ?? rollDie()
}

function pushLog(g: Game, color: string, text: string): void {
  g.log.push({ id: ++logId, text, color })
  if (g.log.length > 80) g.log.shift()
}

let chatId = 0
let tradeId = 0
/** How long a trade offer waits for a response before expiring. */
const TRADE_TIMEOUT_MS = 30_000
const tradeTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearTradeTimer(room: Room): void {
  const t = tradeTimers.get(room.code)
  if (t) {
    clearTimeout(t)
    tradeTimers.delete(room.code)
  }
}

function gameSnapshot(room: Room): GameSnapshot {
  const g = room.game as Game
  return {
    code: room.code,
    players: g.players,
    current: g.current,
    turn: g.turn,
    phase: g.phase,
    dice: g.dice,
    rollId: g.rollId,
    rolledAt: g.rolledAt,
    doubles: g.doubles,
    owned: g.owned,
    buildings: g.buildings,
    mortgaged: g.mortgaged,
    buyTile: g.buyTile,
    eventTile: g.eventTile,
    eventText: g.eventText,
    debt: g.debt,
    trade: g.trade,
    auction: g.auction,
    log: g.log,
    winner: g.winner,
  }
}

/**
 * Server-side assertions for state combinations that the turn flow makes
 * impossible. A violation means the movement/turn lifecycle has desynchronised
 * (the exact class of bug that froze real two-device games), so it is reported
 * loudly. It never throws: one bad room must not take down the process.
 */
function assertGameInvariants(room: Room): void {
  const g = room.game
  if (!g || g.winner) return
  const problems: string[] = []
  const phase = g.phase
  // 'moving' is a purely visual, client-side phase: the server resolves the
  // whole landing synchronously and broadcasts the resulting phase.
  if (phase === 'moving') problems.push("phase='moving' is client-only and must never be broadcast")
  if (phase === 'buy' && g.buyTile == null) problems.push('phase=buy without buyTile')
  if (g.buyTile != null && phase !== 'buy') problems.push(`buyTile set during phase=${phase}`)
  if (phase === 'event' && g.eventTile == null) problems.push('phase=event without eventTile')
  if (phase === 'debt' && !g.debt) problems.push('phase=debt without debt state')
  if (g.debt && phase !== 'debt') problems.push(`debt state during phase=${phase}`)
  if (phase === 'auction' && !g.auction) problems.push('phase=auction without auction state')
  if (g.auction && phase !== 'auction') problems.push(`auction state during phase=${phase}`)
  if (phase === 'idle' && (g.buyTile != null || g.debt || g.auction || g.eventTile != null)) {
    problems.push('phase=idle while an action is still pending')
  }
  const cur = g.players[g.current]
  if (!cur) problems.push(`current index ${g.current} has no player`)
  else if (cur.bankrupt) problems.push(`current player ${cur.name} is bankrupt`)
  if (problems.length) log(`INVARIANT room ${room.code}: ${problems.join('; ')}`)
}

function broadcastGame(room: Room): void {
  assertGameInvariants(room)
  const msg: ServerMsg = { t: 'state', game: gameSnapshot(room) }
  for (const p of room.players) p.send?.(msg)
}

function startGame(room: Room): void {
  const game: Game = {
    players: room.players.map((p, i) => ({
      id: p.id,
      name: p.name,
      color: p.color,
      seat: i,
      tile: 0,
      cash: START_CASH,
      isBot: p.isBot,
      connected: p.connected,
      token: p.token,
      getOutCards: 0,
      jailTurns: 0,
    })),
    current: 0,
    turn: 1,
    phase: 'idle',
    dice: [1, 1],
    rollId: 0,
    rolledAt: 0,
    doubles: 0,
    owned: {},
    buildings: {},
    mortgaged: {},
    buyTile: null,
    eventTile: null,
    eventText: null,
    pendingCard: null,
    debt: null,
    trade: null,
    tradeRespondedFrom: false,
    auction: null,
    log: [],
    winner: null,
  }
  pushLog(game, game.players[0]?.color ?? COLORS[0], `${game.players[0]?.name ?? 'Player'} goes first`)
  room.game = game
  room.started = true
  clearLobbyTeardownTimer(room)
  const started: ServerMsg = { t: 'started', game: gameSnapshot(room) }
  for (const p of room.players) p.send?.(started)
  log(`room ${room.code}: game started with ${room.players.length} players`)
}

/* --------------------------------- bot brain ---------------------------------- */

const botTimers = new Map<string, ReturnType<typeof setTimeout>>()
const moveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const auctionTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Seat-grace period; BQ_REAP_MS shortens it for tests only (min 1s). */
const REAP_MS = Math.max(1_000, Number(process.env.BQ_REAP_MS || 60_000))
const reapTimers = new Map<string, ReturnType<typeof setTimeout>>()

function clearBotTimer(room: Room): void {
  const t = botTimers.get(room.code)
  if (t) {
    clearTimeout(t)
    botTimers.delete(room.code)
  }
  const mt = moveTimers.get(room.code)
  if (mt) {
    clearTimeout(mt)
    moveTimers.delete(room.code)
  }
  const at = auctionTimers.get(room.code)
  if (at) {
    clearTimeout(at)
    auctionTimers.delete(room.code)
  }
}

/** Is it `playerId`'s turn and the game is waiting on them? */
function isBusyPhase(g: Game): boolean {
  return g.phase !== 'idle' && g.phase !== 'rolling' && g.phase !== 'moving'
}

/** Delay before an empty/zombie room is torn down after its last human leaves. */
const ROOM_TEARDOWN_MS = Math.max(1_000, Number(process.env.BQ_TEARDOWN_MS || 10_000))
/** Mid-game abandonment: wait out the reconnect grace before closing. */
const ROOM_ABANDON_MS = REAP_MS + 5_000
const roomTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>()
/** Grace before an unstarted lobby with no connected humans is torn down. */
const LOBBY_ABANDON_MS = Math.max(1_000, Number(process.env.BQ_LOBBY_MS || 30_000))
const lobbyTeardownTimers = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Set by server/index.ts so engine-level timers can ask the manager to close
 * a room. Optional keeps rooms.ts usable without the wiring (tests, tools).
 */
let managerRef: {
  hasRoom: (code: string) => boolean
  closeRoom: (code: string, reason: string) => void
} | null = null

export function setManagerRef(ref: {
  hasRoom: (code: string) => boolean
  closeRoom: (code: string, reason: string) => void
}): void {
  managerRef = ref
}

/**
 * Schedule deletion of a room that no human can ever return to (everyone left
 * or a finished game with only bots). Delay gives a disconnected-but-seated
 * human a grace window to reconnect before the room disappears.
 */
function scheduleRoomTeardown(room: Room, reason: string, delayMs = ROOM_TEARDOWN_MS): void {
  const existing = roomTeardownTimers.get(room.code)
  if (existing) return
  const timer = setTimeout(() => {
    roomTeardownTimers.delete(room.code)
    const stillThere = managerRef?.hasRoom(room.code)
    if (!stillThere) return
    const anyHumanConnected = room.players.some((p) => !p.isBot && p.connected)
    if (anyHumanConnected) return
    clearBotTimer(room)
    clearLobbyTeardownTimer(room)
    managerRef?.closeRoom(room.code, reason)
  }, delayMs)
  roomTeardownTimers.set(room.code, timer)
}

/** Cancel a pending lobby teardown (a human (re)connected or the game started). */
function clearLobbyTeardownTimer(room: Room): void {
  const t = lobbyTeardownTimers.get(room.code)
  if (t) {
    clearTimeout(t)
    lobbyTeardownTimers.delete(room.code)
  }
}

/**
 * Lobbies with no connected human can never start (only humans press Start)
 * and only bots would remain: reap them so they cannot leak forever.
 */
function scheduleLobbyTeardown(room: Room): void {
  clearLobbyTeardownTimer(room)
  const timer = setTimeout(() => {
    lobbyTeardownTimers.delete(room.code)
    if (!managerRef?.hasRoom(room.code) || room.started) return
    const anyHumanConnected = room.players.some((p) => !p.isBot && p.connected)
    if (anyHumanConnected) return
    clearBotTimer(room)
    managerRef?.closeRoom(room.code, 'abandoned lobby (no humans)')
  }, LOBBY_ABANDON_MS)
  lobbyTeardownTimers.set(room.code, timer)
}

function scheduleBot(room: Room): void {
  if (!room.game || room.game.winner) return
  clearBotTimer(room)
  const g = room.game
  const p = g.players[g.current]
  if (!p || !p.isBot || !p.connected) return

  const delay = 900 + Math.random() * 1100
  const timer = setTimeout(() => {
    botTimers.delete(room.code)
    if (!room.game || room.game.winner) return
    const cur = room.game.players[room.game.current]
    if (!cur || cur.id !== p.id) return
    botAct(room, p.id)
  }, delay)
  botTimers.set(room.code, timer)
}

/** One bot decision for whatever the game is waiting on. */
function botAct(room: Room, botId: string): void {
  const g = room.game
  if (!g || g.winner) return
  const cur = g.players[g.current]
  if (!cur || cur.id !== botId) return

  switch (g.phase) {
    case 'idle':
      doRoll(room, botId)
      break
    case 'buy': {
      const tile = getTile(g.buyTile ?? -1)
      const price = tile?.price ?? 0
      // Bots buy when affordable and they keep a small cushion.
      doBuy(room, botId, cur.cash >= price + 50)
      break
    }
    case 'event':
      doEventOk(room, botId)
      break
    case 'jail': {
      // Pay if rich, use card if held, otherwise try the roll.
      if ((cur.getOutCards ?? 0) > 0) doJailAction(room, botId, 'card')
      else if (cur.cash >= 200) doJailAction(room, botId, 'pay')
      else doJailAction(room, botId, 'roll')
      break
    }
    case 'debt': {
      // Try to raise funds: sell buildings, mortgage, then bankrupt.
      const owed = g.debt?.amount ?? 0
      if (tryRaiseFunds(room, cur, owed)) break
      doDeclareBankrupt(room, botId)
      break
    }
    case 'auction':
      botAuction(room, botId)
      break
    default:
      break
  }
}

/** Sell buildings / mortgage properties until cash >= target. True if enough. */
function tryRaiseFunds(room: Room, p: GamePlayer, target: number): boolean {
  const g = room.game as Game
  // 1) Sell buildings down (hotel = 5 counts as houses for sell-back math).
  const ownedIdx = Object.entries(g.owned)
    .filter(([, owner]) => owner === p.id)
    .map(([idx]) => Number(idx))
  for (const idx of ownedIdx) {
    while ((g.buildings[String(idx)] ?? 0) > 0 && p.cash < target) {
      doSellBuilding(room, p.id, idx)
      if (g.phase !== 'debt' && g.phase !== 'idle') return p.cash >= target
    }
  }
  // 2) Mortgage properties without buildings.
  for (const idx of ownedIdx) {
    if (p.cash >= target) break
    if ((g.buildings[String(idx)] ?? 0) === 0 && !g.mortgaged[String(idx)]) {
      doMortgage(room, p.id, idx)
    }
  }
  return p.cash >= target
}

/* ------------------------------- ownership utils ------------------------------ */

function hasMonopoly(g: Game, playerId: string, group: GroupId | undefined): boolean {
  if (!group) return false
  const groupIdx = groupTiles(group)
  if (groupIdx.length === 0) return false
  return groupIdx.every((i) => g.owned[String(i)] === playerId)
}

function countTypeOwned(g: Game, playerId: string, type: 'railroad' | 'utility'): number {
  return TILES.filter((t) => t.type === type && g.owned[String(t.index)] === playerId).length
}

function propOf(g: Game, playerId: string): number[] {
  return Object.entries(g.owned)
    .filter(([, owner]) => owner === playerId)
    .map(([idx]) => Number(idx))
}

/* ---------------------------------- turn flow --------------------------------- */

function nextTurn(room: Room): void {
  const g = room.game as Game
  g.turn++
  g.phase = 'idle'
  g.doubles = 0
  g.buyTile = null
  g.eventTile = null
  g.eventText = null
  g.debt = null
  // Skip bankrupt + disconnected players.
  let guard = 0
  do {
    g.current = (g.current + 1) % g.players.length
    guard++
  } while (
    guard < g.players.length * 2 &&
    (g.players[g.current]?.bankrupt || g.players[g.current]?.connected === false)
  )
}

/* ---------------------------------- game actions ------------------------------ */

function doRoll(room: Room, playerId: string): void {
  const g = room.game
  if (!g || g.winner) return
  if (g.phase !== 'idle') return
  const p = g.players[g.current]
  if (!p || p.id !== playerId) return

  // Jail: rolling for doubles happens through jailAction.
  if (p.inJail) {
    g.phase = 'jail'
    g.rollId++
    g.rolledAt = Date.now()
    pushLog(g, p.color, `${p.name} is in jail (attempt ${(p.jailTurns ?? 0) + 1}/3)`)
    broadcastGame(room)
    if (p.isBot) scheduleBot(room)
    return
  }

  rollAndMove(room, p)
}

/** Server generates the dice, broadcasts the roll, schedules the landing. */
function rollAndMove(room: Room, p: GamePlayer): void {
  const g = room.game as Game
  const dice: Dice = [nextDie(), nextDie()]
  g.dice = dice
  g.rollId++
  g.rolledAt = Date.now()
  g.phase = 'rolling'
  pushLog(g, p.color, `${p.name} rolled ${dice[0] + dice[1]}`)
  broadcastGame(room)

  const total = dice[0] + dice[1]
  const from = p.tile
  const to = (from + total) % BOARD_SIZE
  const moveDelay = 1150 + 260 + (to >= from ? to - from : to + BOARD_SIZE - from) * 150

  const isDoubles = dice[0] === dice[1]
  if (isDoubles) {
    g.doubles++
    if (g.doubles >= 3) {
      // Three consecutive doubles: straight to jail, no move.
      const moveTimer = setTimeout(() => {
        if (!room.game || room.game.winner) return
        pushLog(g, p.color, `${p.name} rolled three doubles — off to jail!`)
        sendToJail(room, p)
        broadcastGame(room)
        nextTurn(room)
        broadcastGame(room)
        scheduleBot(room)
      }, 1500)
      moveTimers.set(room.code, moveTimer)
      return
    }
  } else {
    g.doubles = 0
  }

  const moveTimer = setTimeout(() => {
    if (!room.game || room.game.winner) return
    applyMove(room, p.id, from, to)
  }, moveDelay)
  moveTimers.set(room.code, moveTimer)
}

function sendToJail(room: Room, p: GamePlayer): void {
  const g = room.game as Game
  p.inJail = true
  p.tile = JAIL_INDEX
  p.jailTurns = 0
  g.doubles = 0
  pushLog(g, p.color, `${p.name} was sent to jail!`)
}

function applyMove(room: Room, playerId: string, from: number, to: number): void {
  const g = room.game
  if (!g || g.winner) return
  const p = g.players[g.current]
  if (!p || p.id !== playerId) return

  p.tile = to
  if (to < from) {
    p.cash += START_BONUS
    pushLog(g, p.color, `${p.name} passed START +M ${START_BONUS}`)
  }

  const tile = getTile(to)

  // GO TO JAIL corner
  if (tile?.type === 'go-to-jail') {
    sendToJail(room, p)
    broadcastGame(room)
    nextTurn(room)
    broadcastGame(room)
    scheduleBot(room)
    return
  }

  // Tax tiles
  if (tile?.type === 'tax') {
    const amount = tile.taxAmount ?? 100
    pushLog(g, p.color, `${p.name} owes M ${amount} ${tile.name.toLowerCase()}`)
    charge(room, p, amount, null)
    return
  }

  // Chance / Community Fund: draw a structured card
  if (isEventTile(to)) {
    drawCard(room, p, tile?.type === 'chance' ? 'chance' : 'community')
    return
  }

  // Ownable: buy prompt, rent, or visiting your own streets
  if (tile && isOwnable(tile)) {
    const idxStr = String(to)
    const ownerId = g.owned[idxStr]
    const owner = ownerId ? g.players.find((pp) => pp.id === ownerId) : undefined
    const isMortgaged = Boolean(g.mortgaged[idxStr])

    if (owner && owner.id !== p.id) {
      if (isMortgaged) {
        pushLog(g, p.color, `${tile.name} is mortgaged — no rent due`)
        broadcastGame(room)
        afterTurnAction(room)
        return
      }
      const diceTotal = g.dice[0] + g.dice[1]
      let rentN = 0
      if (tile.type === 'property') {
        const b = g.buildings[idxStr] ?? 0
        const monopoly = hasMonopoly(g, owner.id, tile.colorGroup)
        rentN = rentFor(to, b, monopoly, diceTotal)
      } else if (tile.type === 'railroad') {
        const count = countTypeOwned(g, owner.id, 'railroad')
        rentN = rentFor(to, count, false, diceTotal)
      } else {
        const count = countTypeOwned(g, owner.id, 'utility')
        rentN = rentFor(to, count, false, diceTotal)
      }
      pushLog(g, p.color, `${p.name} owes ${owner.name} M ${rentN} rent at ${tile.name}`)
      charge(room, p, rentN, owner)
      return
    }

    if (!owner) {
      g.buyTile = to
      g.phase = 'buy'
      if (p.isBot) {
        broadcastGame(room)
        scheduleBot(room)
      } else if (p.connected === false) {
        // The mover vanished mid-move (move timer fired after their socket
        // died): nobody can answer the prompt — decline on their behalf so
        // the auction/turn flow continues instead of freezing forever.
        broadcastGame(room)
        doBuy(room, p.id, false)
      } else {
        broadcastGame(room)
      }
      return
    }

    // Own property: just visiting your own streets
    pushLog(g, p.color, `${p.name} is home at ${tile.name}`)
    broadcastGame(room)
    afterTurnAction(room)
    return
  }

  // Plain corner (START / JAIL visiting / FREE PARKING)
  pushLog(g, p.color, `${p.name} landed on ${tile?.name ?? 'the board'}`)
  broadcastGame(room)
  afterTurnAction(room)
}

/** Charge `p` money; opens debt phase if they cannot pay. Creditor null = bank. */
function charge(room: Room, p: GamePlayer, amount: number, creditor: GamePlayer | null): void {
  const g = room.game as Game
  if (p.cash >= amount) {
    p.cash -= amount
    if (creditor) creditor.cash += amount
    pushLog(g, p.color, creditor ? `${p.name} paid ${creditor.name} M ${amount}` : `${p.name} paid M ${amount}`)
    broadcastGame(room)
    afterTurnAction(room)
    return
  }
  // Cannot pay now: liquidate-first check — can they get there by mortgaging?
  const liquidatable =
    propOf(g, p.id).reduce((sum, idx) => {
      const t = getTile(idx)
      if (!t) return sum
      const b = g.buildings[String(idx)] ?? 0
      if (b > 0 && t.houseCost) sum += Math.floor((b * t.houseCost) / 2)
      if (!g.mortgaged[String(idx)]) sum += t.mortgageValue ?? 0
      return sum
    }, 0) + p.cash
  g.phase = 'debt'
  g.debt = {
    debtorId: p.id,
    amount,
    creditorId: creditor ? creditor.id : null,
    canPay: liquidatable >= amount,
  }
  pushLog(g, p.color, `${p.name} cannot pay M ${amount} — must raise funds!`)
  broadcastGame(room)
  if (p.isBot) scheduleBot(room)
  // A disconnected debtor can never act — forfeit immediately so the game
  // cannot freeze waiting on a seat nobody holds.
  if (p.connected === false) doDeclareBankrupt(room, p.id)
}

/** Settle debt from the current cash (called after debtPay or auto liquidation). */
function settleIfCovered(room: Room): boolean {
  const g = room.game as Game
  const d = g.debt
  if (!d) return false
  const debtor = g.players.find((p) => p.id === d.debtorId)
  if (!debtor) return false
  if (debtor.cash < d.amount) return false
  debtor.cash -= d.amount
  const creditor = d.creditorId ? g.players.find((p) => p.id === d.creditorId) : undefined
  if (creditor) creditor.cash += d.amount
  pushLog(g, debtor.color, `${debtor.name} settled the debt: M ${d.amount}`)
  g.debt = null
  broadcastGame(room)
  afterTurnAction(room)
  return true
}

/** Card draws — fully structured, resolved server-side. */
function drawCard(room: Room, p: GamePlayer, deck: 'chance' | 'community'): void {
  const g = room.game as Game
  const pile = deck === 'chance' ? CHANCE_DECK : COMMUNITY_DECK
  const card = pile[Math.floor(Math.random() * pile.length)]
  g.phase = 'event'
  g.eventTile = p.tile
  g.eventText = { title: card.title, body: card.body, good: card.amount >= 0 }
  g.pendingCard = card
  pushLog(g, p.color, `${p.name} drew a card: ${card.title}`)
  if (p.isBot) {
    broadcastGame(room)
    scheduleBot(room)
  } else {
    broadcastGame(room)
  }
  // A drawer who disconnected mid-move can never press Continue: resolve the
  // drawn card immediately so the turn keeps flowing.
  if (!p.isBot && p.connected === false && g.phase === 'event') doEventOk(room, p.id)
}

/** Resolve the drawn card's effect, then end the turn. */
function doEventOk(room: Room, playerId: string): void {
  const g = room.game
  if (!g || g.winner) return
  if (g.phase !== 'event') return
  const p = g.players[g.current]
  if (!p || p.id !== playerId) return

  const card = g.pendingCard
  g.eventTile = null
  g.eventText = null
  g.pendingCard = null

  if (card) {
    if (card.jailCard) {
      p.getOutCards = (p.getOutCards ?? 0) + 1
      pushLog(g, p.color, `${p.name} kept a Get Out of Jail Free card`)
      broadcastGame(room)
      afterTurnAction(room)
      return
    }
    if (card.jail) {
      sendToJail(room, p)
      broadcastGame(room)
      nextTurn(room)
      broadcastGame(room)
      scheduleBot(room)
      return
    }
    if (card.moveTo !== undefined) {
      const from = p.tile
      const to = card.moveTo
      p.tile = to
      if (to < from) {
        p.cash += START_BONUS
        pushLog(g, p.color, `${p.name} passed START +M ${START_BONUS}`)
      }
      pushLog(g, p.color, `${p.name} advanced to ${getTile(to)?.name ?? 'tile ' + to}`)
      // Re-resolve the landing at the destination.
      applyMove(room, p.id, from, to)
      return
    }
    if (card.collectFromEach !== undefined) {
      const per = card.collectFromEach
      if (per >= 0) {
        let gained = 0
        for (const other of g.players) {
          if (other.id === p.id || other.bankrupt) continue
          const take = Math.min(per, other.cash)
          other.cash -= take
          gained += take
        }
        p.cash += gained
        pushLog(g, p.color, `${p.name} collected M ${gained} from the table`)
      } else {
        const total = -per * g.players.filter((o) => !o.bankrupt && o.id !== p.id).length
        pushLog(g, p.color, `${p.name} owes M ${total} for repairs`)
        charge(room, p, total, null)
        return
      }
    } else if (card.amount !== 0) {
      if (card.amount > 0) {
        p.cash += card.amount
        pushLog(g, p.color, `${p.name} gained M ${card.amount}`)
      } else {
        pushLog(g, p.color, `${p.name} owes M ${-card.amount}`)
        charge(room, p, -card.amount, null)
        return
      }
    }
  }
  broadcastGame(room)
  afterTurnAction(room)
}

/** End-of-action bookkeeping: advance the turn unless the mover rolled doubles. */
function afterTurnAction(room: Room): void {
  const g = room.game as Game
  const p = g.players[g.current]
  if (process.env.BQ_DEBUG_TURN)
    log(`TURN-DBG ${room.code}: afterTurnAction cur=${p?.id} doubles=${g.doubles} debt=${Boolean(g.debt)}`)
  // Doubles grant another roll (unless jailed mid-turn).
  if (p && g.doubles > 0 && !p.inJail && !g.debt) {
    g.phase = 'idle'
    g.buyTile = null
    g.eventTile = null
    // The bonus roll belongs to this player — but a vanished one can never
    // take it, so hand the turn on instead of freezing on an empty seat.
    if (p.connected === false && !p.isBot) {
      nextTurn(room)
      broadcastGame(room)
      scheduleBot(room)
      return
    }
    broadcastGame(room)
    scheduleBot(room)
    return
  }
  nextTurn(room)
  broadcastGame(room)
  scheduleBot(room)
}

function doJailAction(room: Room, playerId: string, action: 'pay' | 'card' | 'roll'): void {
  const g = room.game
  if (!g || g.winner) return
  // Runtime guard: the wire is JSON, so an unknown action string must be
  // rejected — falling through to 'roll' would let a malformed frame roll dice.
  if (action !== 'pay' && action !== 'card' && action !== 'roll') return
  if (g.phase !== 'jail' && g.phase !== 'idle') return
  const p = g.players[g.current]
  if (!p || p.id !== playerId || !p.inJail) return

  if (action === 'pay') {
    if (p.cash < 50) return
    p.cash -= 50
    p.inJail = false
    p.jailTurns = 0
    pushLog(g, p.color, `${p.name} paid the M 50 jail fine`)
    broadcastGame(room)
    // Free to roll normally now.
    g.phase = 'idle'
    broadcastGame(room)
    if (p.isBot) scheduleBot(room)
    return
  }

  if (action === 'card') {
    if ((p.getOutCards ?? 0) <= 0) return
    p.getOutCards = (p.getOutCards ?? 0) - 1
    p.inJail = false
    p.jailTurns = 0
    pushLog(g, p.color, `${p.name} used a Get Out of Jail Free card`)
    g.phase = 'idle'
    broadcastGame(room)
    if (p.isBot) scheduleBot(room)
    return
  }

  // Roll for doubles (third attempt always pays and moves).
  const dice: Dice = [nextDie(), nextDie()]
  g.dice = dice
  g.rollId++
  g.rolledAt = Date.now()
  g.phase = 'rolling'
  const isDoubles = dice[0] === dice[1]
  p.jailTurns = (p.jailTurns ?? 0) + 1
  pushLog(g, p.color, `${p.name} rolled ${dice[0] + dice[1]} in jail`)

  if (isDoubles) {
    p.inJail = false
    p.jailTurns = 0
    pushLog(g, p.color, `${p.name} rolled doubles and walks free!`)
    g.doubles = 0 // doubles do not chain from jail rolls
    broadcastGame(room)
    const total = dice[0] + dice[1]
    const from = p.tile
    const to = (from + total) % BOARD_SIZE
    const moveTimer = setTimeout(() => {
      if (!room.game || room.game.winner) return
      applyMove(room, p.id, from, to)
    }, 1400)
    moveTimers.set(room.code, moveTimer)
    return
  }

  broadcastGame(room)
  if ((p.jailTurns ?? 0) >= 3) {
    // Third failed attempt: must pay and move.
    if (p.cash >= 50) {
      p.cash -= 50
      pushLog(g, p.color, `${p.name} paid the M 50 fine`)
    }
    p.inJail = false
    p.jailTurns = 0
    const total = dice[0] + dice[1]
    const from = p.tile
    const to = (from + total) % BOARD_SIZE
    const moveTimer = setTimeout(() => {
      if (!room.game || room.game.winner) return
      applyMove(room, p.id, from, to)
    }, 1400)
    moveTimers.set(room.code, moveTimer)
    return
  }
  // Stay in jail; turn passes.
  g.phase = 'jail'
  broadcastGame(room)
  nextTurn(room)
  broadcastGame(room)
  scheduleBot(room)
}

/* ---------------------------------- buy / build -------------------------------- */

function doBuy(room: Room, playerId: string, accept: boolean): void {
  const g = room.game
  if (!g || g.winner) return
  if (g.phase !== 'buy' || g.buyTile == null) return
  const p = g.players[g.current]
  if (!p || p.id !== playerId) return

  const tile = g.buyTile
  const t = getTile(tile)
  const price = t?.price ?? 100
  g.buyTile = null

  if (accept && p.cash >= price) {
    p.cash -= price
    g.owned[String(tile)] = p.id
    pushLog(g, p.color, `${p.name} bought ${t?.name ?? 'a property'} for M ${price}`)
    // Landing resolved: clear the pending action BEFORE the turn advances so no
    // snapshot can ever show a phantom move or a stale buy prompt.
    g.phase = 'idle'
    g.buyTile = null
    broadcastGame(room)
    afterTurnAction(room)
  } else {
    pushLog(g, p.color, `${p.name} passed on ${t?.name ?? 'a property'}`)
    openAuction(room, tile)
  }
}

/** Build a house/hotel on an owned street tile (server-validated). */
function doBuild(room: Room, playerId: string, tileIdx: number): void {
  const g = room.game
  if (!g || g.winner) return
  if (isBusyPhase(g)) return
  const p = g.players.find((pp) => pp.id === playerId)
  if (!p || p.bankrupt) return

  const tile = getTile(tileIdx)
  if (!tile || tile.type !== 'property' || !tile.colorGroup) return
  const idxStr = String(tileIdx)
  if (g.owned[idxStr] !== p.id) return
  if (g.mortgaged[idxStr]) return
  if (!hasMonopoly(g, p.id, tile.colorGroup)) return

  const cur = g.buildings[idxStr] ?? 0
  if (cur >= 5) return

  // Even-build rule: may only build if no other group tile has fewer houses.
  const siblings = groupTiles(tile.colorGroup).filter((i) => i !== tileIdx)
  const evenOk = siblings.every((i) => (g.buildings[String(i)] ?? 0) >= cur)
  if (!evenOk) return

  const cost = cur === 4 ? (tile.hotelCost ?? tile.houseCost ?? 100) : (tile.houseCost ?? 100)
  if (p.cash < cost) return
  p.cash -= cost
  g.buildings[idxStr] = cur + 1
  pushLog(
    g,
    p.color,
    cur === 4
      ? `${p.name} built a HOTEL at ${tile.name} for M ${cost}`
      : `${p.name} built a house at ${tile.name} for M ${cost}`,
  )
  broadcastGame(room)
}

/** Sell a house/hotel back to the bank at half price (even-sell rule). */
function doSellBuilding(room: Room, playerId: string, tileIdx: number): void {
  const g = room.game
  if (!g || g.winner) return
  const p = g.players.find((pp) => pp.id === playerId)
  if (!p || p.bankrupt) return

  const tile = getTile(tileIdx)
  if (!tile || tile.type !== 'property' || !tile.colorGroup) return
  const idxStr = String(tileIdx)
  if (g.owned[idxStr] !== p.id) return
  const cur = g.buildings[idxStr] ?? 0
  if (cur <= 0) return

  // Even-sell: no sibling may have more buildings than this one after selling.
  const siblings = groupTiles(tile.colorGroup).filter((i) => i !== tileIdx)
  const evenOk = siblings.every((i) => (g.buildings[String(i)] ?? 0) <= cur - 1)
  if (!evenOk) return

  const half = Math.floor((tile.houseCost ?? 100) / 2)
  g.buildings[idxStr] = cur - 1
  p.cash += half
  pushLog(g, p.color, `${p.name} sold a ${cur === 5 ? 'hotel' : 'house'} at ${tile.name} for M ${half}`)
  broadcastGame(room)
}

/* --------------------------------- mortgages ---------------------------------- */

function doMortgage(room: Room, playerId: string, tileIdx: number): void {
  const g = room.game
  if (!g || g.winner) return
  const p = g.players.find((pp) => pp.id === playerId)
  if (!p || p.bankrupt) return

  const tile = getTile(tileIdx)
  if (!tile || !isOwnable(tile)) return
  const idxStr = String(tileIdx)
  if (g.owned[idxStr] !== p.id) return
  if (g.mortgaged[idxStr]) return
  if ((g.buildings[idxStr] ?? 0) > 0) return // sell buildings first

  // Whole color group must be building-free? No — per-tile is fine, but a
  // mortgaged tile in a monopoly stops rent on that tile only.
  const value = tile.mortgageValue ?? 0
  if (value <= 0) return
  g.mortgaged[idxStr] = true
  p.cash += value
  pushLog(g, p.color, `${p.name} mortgaged ${tile.name} for M ${value}`)
  broadcastGame(room)
  // If this was a debt phase, try to settle immediately.
  if (g.phase === 'debt') settleIfCovered(room)
}

function doUnmortgage(room: Room, playerId: string, tileIdx: number): void {
  const g = room.game
  if (!g || g.winner) return
  const p = g.players.find((pp) => pp.id === playerId)
  if (!p || p.bankrupt) return

  const tile = getTile(tileIdx)
  if (!tile || !isOwnable(tile)) return
  const idxStr = String(tileIdx)
  if (g.owned[idxStr] !== p.id) return
  if (!g.mortgaged[idxStr]) return

  const cost = Math.ceil((tile.mortgageValue ?? 0) * 1.1)
  if (p.cash < cost) return
  p.cash -= cost
  delete g.mortgaged[idxStr]
  pushLog(g, p.color, `${p.name} unmortgaged ${tile.name} for M ${cost}`)
  broadcastGame(room)
}

/* ----------------------------------- trading ---------------------------------- */

interface TradeChecks {
  ok: boolean
  reason?: string
}

/**
 * Validate a trade payload. Rules:
 *  - both players in this game, neither bankrupt
 *  - cash amounts are non-negative integers
 *  - offered tiles belong to the offerer; requested tiles to the responder
 *  - tiles with buildings cannot be traded (buildings must be sold first)
 *  - mortgaged tiles CAN be traded (debt transfers with the deed)
 */
function validateTrade(g: Game, from: GamePlayer, to: GamePlayer, t: TradePayload): TradeChecks {
  if (from.bankrupt || to.bankrupt) return { ok: false, reason: 'bankrupt player' }
  if (!Number.isInteger(t.giveCash) || t.giveCash < 0) return { ok: false, reason: 'bad cash' }
  if (!Number.isInteger(t.getCash) || t.getCash < 0) return { ok: false, reason: 'bad cash' }
  if (t.giveCash > from.cash) return { ok: false, reason: 'not enough cash' }
  if (t.getCash > to.cash) return { ok: false, reason: `${to.name} lacks cash` }
  if (t.giveJailCards > (from.getOutCards ?? 0)) return { ok: false, reason: 'not enough jail cards' }
  if (t.getJailCards > (to.getOutCards ?? 0)) return { ok: false, reason: `${to.name} lacks jail cards` }
  for (const idx of t.giveTiles) {
    if (g.owned[String(idx)] !== from.id) return { ok: false, reason: 'you do not own an offered tile' }
    if ((g.buildings[String(idx)] ?? 0) > 0) return { ok: false, reason: 'sell buildings before trading that deed' }
  }
  for (const idx of t.getTiles) {
    if (g.owned[String(idx)] !== to.id) return { ok: false, reason: `${to.name} does not own a requested tile` }
    if ((g.buildings[String(idx)] ?? 0) > 0) return { ok: false, reason: `${to.name} must sell buildings first` }
  }
  const nothing =
    t.giveCash === 0 &&
    t.getCash === 0 &&
    t.giveTiles.length === 0 &&
    t.getTiles.length === 0 &&
    t.giveJailCards === 0 &&
    t.getJailCards === 0
  if (nothing) return { ok: false, reason: 'empty trade' }
  return { ok: true }
}

function doTradePropose(room: Room, fromId: string, toId: string, payload: TradePayload): void {
  const g = room.game
  if (!g || g.winner) return
  if (isBusyPhase(g)) return
  const from = g.players.find((p) => p.id === fromId)
  const to = g.players.find((p) => p.id === toId)
  if (!from || !to || from.id === to.id) return

  const checks = validateTrade(g, from, to, payload)
  if (!checks.ok) {
    pushLog(g, from.color, `Trade declined by the bank: ${checks.reason}`)
    broadcastGame(room)
    return
  }

  g.trade = { id: ++tradeId, ...payload, fromId, toId }
  g.tradeRespondedFrom = false
  pushLog(g, from.color, `${from.name} proposed a trade to ${to.name}`)
  broadcastGame(room)
  // Offers expire: a proposal to a disconnected player (or a bot, which cannot
  // respond) must never wedge the trade UI open forever.
  clearTradeTimer(room)
  const tradeIdAtSet = g.trade.id
  const timer = setTimeout(() => {
    tradeTimers.delete(room.code)
    const cg = room.game
    if (!cg || !cg.trade || cg.trade.id !== tradeIdAtSet) return
    pushLog(cg, '#9aa7c7', 'Trade offer expired')
    cg.trade = null
    broadcastGame(room)
    const cur = cg.players[cg.current]
    if (cur?.isBot) scheduleBot(room)
  }, TRADE_TIMEOUT_MS)
  tradeTimers.set(room.code, timer)
  if (to.isBot) scheduleBot(room)
}

function doTradeRespond(room: Room, playerId: string, accept: boolean): void {
  const g = room.game
  if (!g || g.winner) return
  const trade = g.trade
  if (!trade) return
  clearTradeTimer(room)
  const to = g.players.find((p) => p.id === trade.toId)
  const from = g.players.find((p) => p.id === trade.fromId)
  if (!to || !from) {
    g.trade = null
    broadcastGame(room)
    return
  }
  if (playerId !== trade.toId) return

  g.trade = null
  if (!accept) {
    pushLog(g, to.color, `${to.name} rejected the trade`)
    broadcastGame(room)
    if (to.isBot) scheduleBot(room)
    return
  }

  // Re-validate at execution time (ownership/cash may have changed).
  const checks = validateTrade(g, from, to, trade)
  if (!checks.ok) {
    pushLog(g, '#ff6b8a', `Trade failed: ${checks.reason}`)
    broadcastGame(room)
    if (to.isBot) scheduleBot(room)
    return
  }

  // Execute atomically.
  from.cash -= trade.giveCash
  to.cash += trade.giveCash
  to.cash -= trade.getCash
  from.cash += trade.getCash
  for (const idx of trade.giveTiles) g.owned[String(idx)] = to.id
  for (const idx of trade.getTiles) g.owned[String(idx)] = from.id
  from.getOutCards = (from.getOutCards ?? 0) - trade.giveJailCards
  to.getOutCards = (to.getOutCards ?? 0) + trade.giveJailCards
  to.getOutCards = (to.getOutCards ?? 0) - trade.getJailCards
  from.getOutCards = (from.getOutCards ?? 0) + trade.getJailCards
  pushLog(g, from.color, `Trade complete: ${from.name} ⇄ ${to.name}`)
  broadcastGame(room)
  if (to.isBot) scheduleBot(room)
}

function doTradeCancel(room: Room, playerId: string): void {
  const g = room.game
  if (!g || !g.trade) return
  if (playerId !== g.trade.fromId && playerId !== g.trade.toId) return
  clearTradeTimer(room)
  const from = g.players.find((p) => p.id === g.trade?.fromId)
  pushLog(g, from?.color ?? '#9aa7c7', 'Trade cancelled')
  g.trade = null
  broadcastGame(room)
  const cur = g.players[g.current]
  if (cur?.isBot) scheduleBot(room)
}

/* ----------------------------------- auctions ---------------------------------- */

const AUCTION_MS = 8_000

function openAuction(room: Room, tileIdx: number): void {
  const g = room.game as Game
  if (g.auction) return
  const tile = getTile(tileIdx)
  pushLog(g, '#9aa7c7', `Auction opened: ${tile?.name ?? 'property'}`)
  g.phase = 'auction'
  g.buyTile = null
  g.auction = {
    tile: tileIdx,
    highest: 0,
    highestBidder: null,
    // First eligible participant — never a bankrupt/disconnected seat.
    bidder: auctionParticipants(g)[0]?.id ?? null,
    passed: [],
    deadline: Date.now() + AUCTION_MS,
    log: [],
  }
  broadcastGame(room)
  scheduleAuction(room)
  const cur = g.players[g.current]
  if (cur?.isBot) scheduleBot(room)
}

function scheduleAuction(room: Room): void {
  const g = room.game as Game
  const a = g.auction
  if (!a) return
  const at = auctionTimers.get(room.code)
  if (at) clearTimeout(at)
  const wait = Math.max(a.deadline - Date.now(), 400)
  const timer = setTimeout(() => {
    auctionTimers.delete(room.code)
    if (!room.game?.auction || room.game.auction !== a) {
      if (process.env.BQ_DEBUG_AUCTION) log(`AUCTION-DBG ${room.code}: timer fired but auction gone/changed`)
      return
    }
    if (process.env.BQ_DEBUG_AUCTION)
      log(`AUCTION-DBG ${room.code}: deadline pass by bidder=${a.bidder} highest=${a.highest} passed=[${a.passed.join(',')}]`)
    // Window expired: treat the current player as passing.
    doAuctionPass(room, a.bidder ?? '')
  }, wait)
  auctionTimers.set(room.code, timer)
}

function auctionParticipants(g: Game): GamePlayer[] {
  return g.players.filter((p) => !p.bankrupt && p.connected !== false && !g.auction?.passed.includes(p.id))
}

function doAuctionBid(room: Room, playerId: string, amount: number): void {
  const g = room.game
  if (!g || !g.auction || g.phase !== 'auction') return
  const a = g.auction
  if (a.bidder !== playerId) return
  const p = g.players.find((pp) => pp.id === playerId)
  if (!p || p.bankrupt) return
  if (!Number.isInteger(amount) || amount <= a.highest || amount > p.cash) return

  a.highest = amount
  a.highestBidder = playerId
  a.log.push(`${p.name} bids M ${amount}`)
  if (a.log.length > 12) a.log.shift()
  // Every other eligible participant gets a fresh window to respond.
  const others = auctionParticipants(g).filter((o) => o.id !== playerId)
  if (others.length === 0) {
    finishAuction(room)
    return
  }
  const next = others.find((o) => o.id === nextAliveAfter(g, playerId)) ?? others[0]
  a.bidder = next?.id ?? null
  a.deadline = Date.now() + AUCTION_MS
  broadcastGame(room)
  scheduleAuction(room)
  if (next?.isBot) scheduleBot(room)
}

function nextAliveAfter(g: Game, afterId: string): string | null {
  const alive = g.players.filter((p) => !p.bankrupt && p.connected !== false)
  if (alive.length === 0) return null
  const startIdx = alive.findIndex((p) => p.id === afterId)
  for (let i = 1; i <= alive.length; i++) {
    const cand = alive[(startIdx + i) % alive.length]
    if (cand && !g.auction?.passed.includes(cand.id)) return cand.id
  }
  return null
}

function doAuctionPass(room: Room, playerId: string): void {
  const g = room.game
  if (!g || !g.auction) return
  const a = g.auction
  // Only the player holding the bid window may pass — otherwise anyone could
  // force-pass on behalf of an opponent (server-authoritative turn order).
  if (a.bidder !== playerId) {
    if (process.env.BQ_DEBUG_AUCTION)
      log(`AUCTION-DBG ${room.code}: pass ignored — bidder=${a.bidder} but closer=${playerId} passed=[${a.passed.join(',')}]`)
    return
  }
  const p = g.players.find((pp) => pp.id === playerId)
  if (!p || a.passed.includes(playerId)) {
    if (process.env.BQ_DEBUG_AUCTION)
      log(`AUCTION-DBG ${room.code}: pass ignored — closer=${playerId} exists=${Boolean(p)} alreadyPassed=${a.passed.includes(playerId)}`)
    return
  }

  a.passed.push(playerId)
  a.log.push(`${p.name} passes`)
  if (a.log.length > 12) a.log.shift()

  const remaining = auctionParticipants(g)
  if (process.env.BQ_DEBUG_TURN)
    log(`TURN-DBG ${room.code}: pass by=${playerId} remaining=[${remaining.map((o) => o.id).join(',')}] highest=${a.highest} highestBidder=${a.highestBidder ?? 'none'}`)
  if (remaining.length === 0 || (remaining.length === 1 && a.highestBidder != null)) {
    finishAuction(room)
    return
  }
  const next = remaining.find((o) => o.id === nextAliveAfter(g, playerId)) ?? remaining[0]
  if (!next) {
    finishAuction(room)
    return
  }
  a.bidder = next.id
  a.deadline = Date.now() + AUCTION_MS
  broadcastGame(room)
  scheduleAuction(room)
  if (next.isBot) scheduleBot(room)
}

function finishAuction(room: Room): void {
  const g = room.game as Game
  const a = g.auction
  g.auction = null
  const at = auctionTimers.get(room.code)
  if (at) {
    clearTimeout(at)
    auctionTimers.delete(room.code)
  }
  if (!a) return

  const tile = getTile(a.tile)
  if (a.highestBidder && a.highest > 0) {
    const winner = g.players.find((p) => p.id === a.highestBidder)
    if (winner && winner.cash >= a.highest) {
      winner.cash -= a.highest
      g.owned[String(a.tile)] = winner.id
      pushLog(g, winner.color, `${winner.name} won the auction for ${tile?.name} at M ${a.highest}`)
    }
  } else {
    pushLog(g, '#9aa7c7', `${tile?.name ?? 'Property'} went unsold — nobody bid`)
  }
  // The auction decided the landing: the turn may now complete normally.
  if (process.env.BQ_DEBUG_TURN)
    log(`TURN-DBG ${room.code}: finishAuction winner=${a.highestBidder ?? 'none'} amount=${a.highest} -> afterTurnAction`)
  g.phase = 'idle'
  broadcastGame(room)
  afterTurnAction(room)
}

function botAuction(room: Room, botId: string): void {
  const g = room.game
  if (!g || !g.auction || g.phase !== 'auction') return
  const a = g.auction
  if (a.bidder !== botId) return
  const p = g.players.find((pp) => pp.id === botId)
  if (!p) return
  const tile = getTile(a.tile)
  const price = tile?.price ?? 0
  // Simple valuation: up to list price + a little, only if cash allows.
  const ceiling = Math.min(p.cash, Math.round(price * 1.15))
  const minNext = a.highest + (a.highestBidder ? 10 : 10)
  if (minNext <= ceiling && Math.random() < 0.72) {
    doAuctionBid(room, botId, Math.min(minNext, ceiling))
  } else {
    doAuctionPass(room, botId)
  }
}

/* ------------------------------- debt & bankruptcy ------------------------------ */

function doDebtPay(room: Room, playerId: string): void {
  const g = room.game
  if (!g || !g.debt || g.phase !== 'debt') return
  if (g.debt.debtorId !== playerId) return
  settleIfCovered(room)
}

/**
 * Declare a winner from authoritative state once at most one non-bankrupt
 * player remains. Bankruptcy (voluntary or debt-forced) is the ONLY thing that
 * eliminates a player — a temporary disconnect during the reconnect grace MUST
 * NOT count, so disconnected players still count as active here. Returns true
 * when the game is now over.
 */
function checkWinner(room: Room): boolean {
  const g = room.game
  if (!g) return false
  if (g.winner) return true
  const alive = g.players.filter((p) => !p.bankrupt)
  if (alive.length > 1) return false
  const w = alive[0] ?? null
  g.winner = w?.id ?? null
  if (w) pushLog(g, w.color, `${w.name} wins the game! 🏆`)
  // If nobody human is left connected, schedule teardown — bots alone must not
  // become a zombie room (no socket will ever trigger cleanup).
  const humansConnected = room.players.some((p) => !p.isBot && p.connected)
  if (!humansConnected) scheduleRoomTeardown(room, 'game finished with no humans left')
  return true
}

/**
 * Mark `p` bankrupt and dispose of their assets. Cash and deeds go to
 * `creditor` (only when a debt rule demands it); otherwise everything returns
 * to the bank. Buildings always return to the bank. Safe to call from any
 * phase — it only mutates player/asset state, never the turn flow.
 */
function eliminatePlayer(room: Room, p: GamePlayer, creditor: GamePlayer | null): void {
  const g = room.game as Game
  if (p.bankrupt) return
  p.bankrupt = true

  p.cash = Math.max(p.cash, 0)
  if (creditor) creditor.cash += p.cash
  p.cash = 0

  const transferred = new Set<number>()
  for (const [idx, owner] of Object.entries(g.owned)) {
    if (owner !== p.id) continue
    const i = Number(idx)
    if (creditor) g.owned[idx] = creditor.id
    else delete g.owned[idx]
    transferred.add(i)
  }
  // Buildings return to the bank even on deeds handed to a creditor (they may
  // rebuild under the normal even-build rules).
  for (const idx of Object.keys(g.buildings)) {
    if (transferred.has(Number(idx)) || g.owned[Number(idx)] === p.id) delete g.buildings[Number(idx)]
  }
  for (const idx of Object.keys(g.mortgaged)) {
    if (g.owned[Number(idx)] === p.id) delete g.mortgaged[Number(idx)]
  }
  if (creditor) creditor.getOutCards = (creditor.getOutCards ?? 0) + (p.getOutCards ?? 0)
  p.getOutCards = 0

  // Cancel any pending trade involving the eliminated player.
  if (g.trade && (g.trade.fromId === p.id || g.trade.toId === p.id)) {
    g.trade = null
    clearTradeTimer(room)
  }
  // Drop them from the live auction standings.
  if (g.auction && g.auction.highestBidder === p.id) {
    g.auction.highestBidder = null
    g.auction.highest = 0
  }
}

/** Clear any pending prompt so a bankrupt player's turn cannot wedge the game. */
function clearPendingAction(g: Game): void {
  g.buyTile = null
  g.eventTile = null
  g.eventText = null
  g.pendingCard = null
  g.debt = null
}

/**
 * Bankruptcy / voluntary surrender. The debtor may declare during a debt phase;
 * any active player may surrender at any other time (Manage Assets → Surrender).
 * The server resolves assets, the turn handover and the winner; the client only
 * sends the intent.
 */
function doDeclareBankrupt(room: Room, playerId: string): void {
  const g = room.game
  if (!g || g.winner) return
  const p = g.players.find((pp) => pp.id === playerId)
  if (!p || p.bankrupt) return
  // During debt only the debtor may declare.
  if (g.phase === 'debt' && g.debt?.debtorId !== playerId) return

  const creditor =
    g.phase === 'debt' && g.debt?.creditorId
      ? g.players.find((pp) => pp.id === g.debt?.creditorId) ?? null
      : null
  const wasCurrent = g.players[g.current]?.id === playerId
  const wasAuctionBidder = g.phase === 'auction' && g.auction?.bidder === playerId

  eliminatePlayer(room, p, creditor)
  pushLog(g, '#ff6b8a', `${p.name} declared bankruptcy and is out!`)
  g.debt = null

  if (checkWinner(room)) {
    clearBotTimer(room)
    clearTradeTimer(room)
    broadcastGame(room)
    return
  }

  // If the eliminated player did not own the current prompt, leave it alone and
  // let the rest of the table continue.
  if (!wasCurrent) {
    broadcastGame(room)
    return
  }

  // The eliminated player owned the current prompt. An auction can resolve
  // safely by treating them as having passed; every other prompt is discarded
  // and the turn moves on.
  if (wasAuctionBidder && g.auction) {
    doAuctionPass(room, p.id)
    return
  }
  clearPendingAction(g)
  g.phase = 'idle'
  nextTurn(room)
  broadcastGame(room)
  scheduleBot(room)
}

/* ------------------------------------ chat ------------------------------------ */

function doChat(room: Room, playerId: string, raw: string): void {
  const m = room.players.find((pp) => pp.id === playerId)
  if (!m) return
  const text = String(raw ?? '').replace(/\s+/g, ' ').trim().slice(0, 200)
  if (!text) return
  const msg: ChatMessage = {
    id: ++chatId,
    fromId: m.id,
    fromName: m.name,
    color: m.color,
    text,
    at: Date.now(),
  }
  const out: ServerMsg = { t: 'chat', msg }
  for (const p of room.players) p.send?.(out)
}

/* --------------------------------- room manager -------------------------------- */

export class RoomManager {
  private rooms = new Map<string, Room>()
  private members = new Map<string, Member>()
  private sinks = new Map<string, SendFn>()

  /** Living rooms only (used by the zombie-room teardown scheduler). */
  hasRoom(code: string): boolean {
    return this.rooms.has(code)
  }

  /** Force-close a room: clear timers, drop members, remove it. */
  closeRoom(code: string, reason: string): void {
    const room = this.rooms.get(code)
    if (!room) return
    clearBotTimer(room)
    clearLobbyTeardownTimer(room)
    for (const p of room.players) {
      this.members.delete(p.id)
      p.send = null
    }
    this.rooms.delete(code)
    log(`room ${code}: closed (${reason})`)
  }

  private attachSink(id: string, send: SendFn): void {
    this.sinks.set(id, send)
  }

  private roomCodeOf(member: Member): string {
    for (const [code, room] of this.rooms) {
      if (room.players.some((p) => p.id === member.id)) return code
    }
    return ''
  }

  getRoomOf(m: Member): Room | undefined {
    for (const room of this.rooms.values()) {
      if (room.players.some((p) => p.id === m.id)) return room
    }
    return undefined
  }

  publicOf(m: Member): PlayerPublic {
    return {
      id: m.id,
      name: m.name,
      color: m.color,
      token: m.token,
      connected: m.connected,
      isHost: m.isHost,
      isBot: m.isBot,
      ready: m.ready,
    }
  }

  hello(name: string, send: SendFn): { playerId: string } | { error: ErrCode; message: string } {
    const clean = sanitizeName(name)
    if (clean.length < 2) return { error: 'badName', message: 'Name must be at least 2 characters' }
    const id = makeId('p')
    const member: Member = {
      id,
      name: clean,
      color: COLORS[this.members.size % COLORS.length],
      token: 'hat',
      isHost: false,
      isBot: false,
      ready: false,
      connected: true,
      send,
    }
    this.members.set(id, member)
    this.attachSink(id, send)
    return { playerId: id }
  }

  create(playerId: string): { code: string } | { error: ErrCode; message: string } {
    const m = this.members.get(playerId)
    if (!m) return { error: 'badName', message: 'Say hello first' }
    if (this.roomCodeOf(m)) return { error: 'roomClosed', message: 'Already in a room' }
    if (this.rooms.size >= MAX_ROOMS) return { error: 'roomFull', message: 'Server is busy — try again shortly' }
    let code = makeCode()
    while (this.rooms.has(code)) code = makeCode()
    const room: Room = { code, hostId: m.id, players: [m], started: false, game: null }
    m.isHost = true
    m.ready = true
    m.color = COLORS[0]
    if (m.token !== 'hat') m.token = firstFreeToken(room)
    this.rooms.set(code, room)
    log(`room ${code}: created by ${m.name}`)
    return { code }
  }

  join(playerId: string, rawCode: string): { code: string } | { error: ErrCode; message: string } {
    const m = this.members.get(playerId)
    if (!m) return { error: 'badName', message: 'Say hello first' }
    if (this.roomCodeOf(m)) return { error: 'roomClosed', message: 'Already in a room' }
    const code = String(rawCode ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
    const room = this.rooms.get(code)
    if (!room) {
      log(`join failed: room ${code || '?'} not found (player ${m.name})`)
      return { error: 'roomNotFound', message: `Room ${code || '?'} not found` }
    }
    if (room.started) return { error: 'roomClosed', message: 'That game already started' }
    if (room.players.length >= MAX_PLAYERS) return { error: 'roomFull', message: 'Room is full' }

    m.isHost = false
    m.ready = false
    m.color = COLORS[room.players.length % COLORS.length]
    m.token = firstFreeToken(room)
    room.players.push(m)
    clearLobbyTeardownTimer(room)
    log(`room ${code}: ${m.name} joined (${room.players.length}/${MAX_PLAYERS})`)
    broadcastRoom(room)
    return { code }
  }

  addBot(playerId: string): { ok: true } | { error: ErrCode; message: string } {
    const m = this.members.get(playerId)
    if (!m) return { error: 'badName', message: 'Say hello first' }
    const room = this.getRoomOf(m)
    if (!room) return { error: 'roomNotFound', message: 'Not in a room' }
    if (room.hostId !== m.id) return { error: 'badPhase', message: 'Only the host can add rivals' }
    if (room.players.length >= MAX_PLAYERS) return { error: 'roomFull', message: 'Room is full' }
    if (room.started) {
      // A member added mid-game would never enter game.players — a ghost seat.
      return { error: 'badPhase', message: 'Cannot add rivals after the game starts' }
    }

    const used = new Set(room.players.map((p) => p.name))
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Rival ${room.players.length}`
    const bot: Member = {
      id: makeId('bot'),
      name,
      color: COLORS[room.players.length % COLORS.length],
      token: firstFreeToken(room),
      isHost: false,
      isBot: true,
      ready: true,
      connected: true,
      send: null,
    }
    this.members.set(bot.id, bot)
    room.players.push(bot)
    log(`room ${room.code}: bot ${name} added`)
    broadcastRoom(room)
    return { ok: true }
  }

  setReady(playerId: string, ready: boolean): void {
    const m = this.members.get(playerId)
    if (!m) return
    const room = this.getRoomOf(m)
    if (!room || room.started) return
    m.ready = ready
    broadcastRoom(room)
  }

  /**
   * Update a member's display name. Used to correct a stale/default hello name
   * before creating or joining. Names are locked once a game is in progress so
   * a reconnect can never silently rename a seated player.
   */
  setName(playerId: string, raw: string): { ok: true } | { error: ErrCode; message: string } {
    const m = this.members.get(playerId)
    if (!m) return { error: 'badName', message: 'Say hello first' }
    const clean = sanitizeName(raw)
    if (clean.length < 2) return { error: 'badName', message: 'Name must be at least 2 characters' }
    const room = this.getRoomOf(m)
    if (room?.started) return { error: 'notAllowed', message: 'Names cannot change mid-game' }
    m.name = clean
    m.send?.({ t: 'you', playerId: m.id, name: clean })
    if (room) broadcastRoom(room)
    return { ok: true }
  }

  /** Choose a playing piece before the game starts. One token per player. */
  selectToken(playerId: string, token: unknown): { ok: true } | { error: ErrCode; message: string } {
    const m = this.members.get(playerId)
    if (!m) return { error: 'badName', message: 'Say hello first' }
    if (!isTokenId(token)) return { error: 'notAllowed', message: 'Unknown token' }
    const room = this.getRoomOf(m)
    if (!room) return { error: 'roomNotFound', message: 'Join a room first' }
    if (room.started) return { error: 'tokenLocked', message: 'Tokens are locked once the game starts' }
    if (m.token === token) return { ok: true }
    const taken = room.players.some((p) => p.id !== m.id && p.token === token)
    if (taken) return { error: 'tokenTaken', message: 'That token is already taken' }
    m.token = token
    broadcastRoom(room)
    return { ok: true }
  }

  start(playerId: string): { ok: true } | { error: ErrCode; message: string } {
    const m = this.members.get(playerId)
    if (!m) return { error: 'badName', message: 'Say hello first' }
    const room = this.getRoomOf(m)
    if (!room) return { error: 'roomNotFound', message: 'Not in a room' }
    if (room.hostId !== m.id) return { error: 'badPhase', message: 'Only the host can start' }
    if (room.started) return { error: 'badPhase', message: 'Already started' }
    if (room.players.length < 2) return { error: 'badPhase', message: 'Need at least 2 players' }
    if (!room.players.every((p) => p.ready)) return { error: 'badPhase', message: 'Not everyone is ready' }
    startGame(room)
    return { ok: true }
  }

  /* ------------------------- game action entrypoints ------------------------- */

  roll(playerId: string): void {
    const room = this.roomFor(playerId)
    if (room) doRoll(room, playerId)
  }

  buy(playerId: string, accept: boolean): void {
    const room = this.roomFor(playerId)
    if (room) doBuy(room, playerId, accept)
  }

  eventOk(playerId: string): void {
    const room = this.roomFor(playerId)
    if (room) doEventOk(room, playerId)
  }

  build(playerId: string, tile: number): void {
    const room = this.roomFor(playerId)
    if (room) doBuild(room, playerId, Number(tile))
  }

  sellBuilding(playerId: string, tile: number): void {
    const room = this.roomFor(playerId)
    if (room) doSellBuilding(room, playerId, Number(tile))
  }

  mortgage(playerId: string, tile: number): void {
    const room = this.roomFor(playerId)
    if (room) doMortgage(room, playerId, Number(tile))
  }

  unmortgage(playerId: string, tile: number): void {
    const room = this.roomFor(playerId)
    if (room) doUnmortgage(room, playerId, Number(tile))
  }

  jailAction(playerId: string, action: 'pay' | 'card' | 'roll'): void {
    const room = this.roomFor(playerId)
    if (room) doJailAction(room, playerId, action)
  }

  tradePropose(playerId: string, toId: string, payload: TradePayload): void {
    const room = this.roomFor(playerId)
    if (room) doTradePropose(room, playerId, toId, payload)
  }

  tradeRespond(playerId: string, accept: boolean): void {
    const room = this.roomFor(playerId)
    if (room) doTradeRespond(room, playerId, accept)
  }

  tradeCancel(playerId: string): void {
    const room = this.roomFor(playerId)
    if (room) doTradeCancel(room, playerId)
  }

  auctionBid(playerId: string, amount: number): void {
    const room = this.roomFor(playerId)
    if (room) doAuctionBid(room, playerId, Number(amount))
  }

  auctionPass(playerId: string): void {
    const room = this.roomFor(playerId)
    if (room) doAuctionPass(room, playerId)
  }

  debtPay(playerId: string): void {
    const room = this.roomFor(playerId)
    if (room) doDebtPay(room, playerId)
  }

  declareBankrupt(playerId: string): void {
    const room = this.roomFor(playerId)
    if (room) doDeclareBankrupt(room, playerId)
  }

  chat(playerId: string, text: string): void {
    const room = this.roomFor(playerId)
    if (room) doChat(room, playerId, text)
  }

  private roomFor(playerId: string): Room | undefined {
    const m = this.members.get(playerId)
    if (!m) return undefined
    return this.getRoomOf(m)
  }

  /* --------------------------- lifecycle --------------------------- */

  /**
   * Leave a room. `explicit` means the player asked to leave (Leave button or
   * room change): the seat is forfeited immediately and membership is removed
   * so a new room can be created/joined without an "Already in room" error. A
   * plain socket drop (explicit = false) keeps the reconnect grace seat.
   */
  leave(playerId: string, explicit = false): void {
    const m = this.members.get(playerId)
    if (!m) return
    const room = this.getRoomOf(m)
    if (!room) {
      this.members.delete(playerId)
      return
    }
    if (room.started && room.game) {
      if (explicit) {
        // Keep m.send (the live socket) and the member identity: the player is
        // leaving the room, not the server, so they can immediately create or
        // join another room on this connection.
        const gp = room.game.players.find((x) => x.id === m.id)
        if (gp) gp.connected = false
        const rt = reapTimers.get(m.id)
        if (rt) {
          clearTimeout(rt)
          reapTimers.delete(m.id)
        }
        // A permanent departure forfeits the seat: eliminate and resolve winner.
        if (!room.game.winner && gp && !gp.bankrupt) doDeclareBankrupt(room, m.id)
        // Keep the player's identity on this socket so they can immediately
        // create or join another room (this was the "Already in room"/dead
        // Create Room bug).
        this.removeMember(m, 'left the game', true)
        return
      }
      m.connected = false
      m.send = null
      const gp = room.game.players.find((gp2) => gp2.id === m.id)
      if (gp) gp.connected = false
      pushLog(room.game, m.color, `${m.name} disconnected`)
      broadcastGame(room)
      // If they hold the floor, free the table — in ANY waiting-on-input phase.
      // Freeing only 'idle'/'auction' left games frozen forever whenever a
      // disconnected player sat in buy/event/jail/debt (no one could act).
      if (room.game.players[room.game.current]?.id === m.id) {
        const g = room.game
        if (g.phase === 'idle') {
          nextTurn(room)
          broadcastGame(room)
          scheduleBot(room)
        } else if (g.phase === 'auction' && g.auction) {
          doAuctionPass(room, m.id)
        } else if (g.phase === 'buy') {
          doBuy(room, m.id, false) // decline → auction resolves per normal rules
        } else if (g.phase === 'event') {
          doEventOk(room, m.id) // resolve the drawn card, then the turn advances
        } else if (g.phase === 'jail') {
          // Timers still own 'rolling'/'moving' and finish safely on their own;
          // jail just needs the turn handed onward.
          nextTurn(room)
          broadcastGame(room)
          scheduleBot(room)
        } else if (g.phase === 'debt') {
          doDeclareBankrupt(room, m.id) // cannot pay → seat forfeits assets
        }
      }
      const rt = reapTimers.get(m.id)
      if (rt) clearTimeout(rt)
      reapTimers.set(
        m.id,
        setTimeout(() => {
          reapTimers.delete(m.id)
          const still = this.getRoomOf(m)
          if (!still || m.connected) return
          this.removeMember(m, 'reaper: seat forfeited after grace period')
        }, REAP_MS),
      )
      // If NO human remains connected, the room can never progress meaningfully
      // (bots alone would play on forever). Close it after the reconnect grace
      // unless someone returns — the teardown re-checks connected humans.
      const anyHumanConnected = room.players.some((p) => !p.isBot && p.connected)
      if (!anyHumanConnected) {
        scheduleRoomTeardown(room, 'all humans left the game', ROOM_ABANDON_MS)
      }
      log(`room ${room.code}: ${m.name} disconnected (seat held)`)
    } else if (explicit) {
      // Lobby leave: keep the identity so the same socket can create/join again.
      this.removeMember(m, 'left lobby', true)
    } else {
      this.removeMember(m, 'left lobby')
    }
  }

  /**
   * Socket-close cleanup that respects identity rebinds: the closing transport
   * only triggers leave() if it is still the member's active sink. Without
   * this, a refresh's old socket (whose close lands AFTER the replacement
   * socket's hello) would disconnect the freshly re-bound seat.
   */
  leaveIfActive(playerId: string, send: SendFn): void {
    const m = this.members.get(playerId)
    if (!m) return
    if (m.send !== send) return // stale transport — a newer connection owns the seat
    this.leave(playerId)
  }

  private removeMember(m: Member, reason: string, keepIdentity = false): void {
    const room = this.getRoomOf(m)
    if (!room) {
      if (!keepIdentity) this.members.delete(m.id)
      return
    }
    room.players = room.players.filter((p) => p.id !== m.id)
    if (keepIdentity) {
      // The player asked to leave: reset their room-scoped flags but keep the
      // member record so they can start or join a new room on this connection.
      m.isHost = false
      m.ready = false
      m.connected = true
    } else {
      this.members.delete(m.id)
    }
    if (room.hostId === m.id && room.players.length > 0) {
      const nextHost = room.players.find((p) => !p.isBot) ?? room.players[0]
      if (nextHost) {
        nextHost.isHost = true
        nextHost.ready = true
        room.hostId = nextHost.id
      }
    }
    if (room.players.length === 0) {
      clearBotTimer(room)
      clearLobbyTeardownTimer(room)
      this.rooms.delete(room.code)
      log(`room ${room.code}: closed (${reason})`)
    } else {
      // A lobby whose last human is gone can never start (bots never press
      // Start): reap it after a grace window instead of leaking forever.
      const anyHumanConnected = room.players.some((p) => !p.isBot && p.connected)
      if (!room.started && !anyHumanConnected) scheduleLobbyTeardown(room)
      if (room.started && room.game) broadcastGame(room)
      else broadcastRoom(room)
    }
  }

  reconnect(playerId: string, send: SendFn): boolean {
    const m = this.members.get(playerId)
    if (!m || m.isBot) return false
    // Identity rebind: the browser may open its replacement socket BEFORE the
    // old one's close event lands (refresh, network blip). This member is the
    // newest live connection for the playerId — always rebind the sink instead
    // of rejecting, or a refresh would lose the game seat to a packet race.
    const wasConnected = m.connected && m.send != null
    const rt = reapTimers.get(playerId)
    if (rt) {
      clearTimeout(rt)
      reapTimers.delete(playerId)
    }
    m.send = send
    m.connected = true
    this.attachSink(m.id, send)
    const room = this.getRoomOf(m)
    if (!room) return false
    clearLobbyTeardownTimer(room)
    const gp = room.game?.players.find((gp2) => gp2.id === m.id)
    if (gp) gp.connected = true
    send({ t: 'you', playerId: m.id, name: m.name })
    if (room.started && room.game) {
      send({ t: 'started', game: gameSnapshot(room) })
      send({ t: 'state', game: gameSnapshot(room) })
    } else {
      send({ t: 'joined', code: room.code, you: this.publicOf(m), room: roomSnapshot(room) })
      broadcastRoom(room)
    }
    if (room.game) {
      pushLog(room.game, '#9aa7c7', wasConnected ? `${m.name} resumed their session` : `${m.name} reconnected`)
      broadcastGame(room)
    }
    log(`room ${room.code}: ${m.name} reconnected`)
    scheduleBot(room)
    return true
  }

  sendSnapshot(playerId: string): void {
    const m = this.members.get(playerId)
    if (!m) return
    const room = this.getRoomOf(m)
    if (!room) return
    if (room.started && room.game) {
      m.send?.({ t: 'started', game: gameSnapshot(room) })
      m.send?.({ t: 'state', game: gameSnapshot(room) })
    } else if (playerId === room.hostId) {
      m.send?.({ t: 'created', code: room.code, you: this.publicOf(m), room: roomSnapshot(room) })
    } else {
      m.send?.({ t: 'joined', code: room.code, you: this.publicOf(m), room: roomSnapshot(room) })
    }
  }

  /** Reset the finished game back to a fresh lobby (Play Again). Host-only. */
  playAgain(playerId: string): { ok: true } | { error: ErrCode; message: string } {
    const m = this.members.get(playerId)
    if (!m) return { error: 'badName', message: 'Say hello first' }
    const room = this.getRoomOf(m)
    if (!room) return { error: 'roomNotFound', message: 'Not in a room' }
    if (room.hostId !== m.id) return { error: 'badPhase', message: 'Only the host can restart' }
    const g = room.game
    if (!g || !g.winner) return { error: 'badPhase', message: 'Finish the game first' }
    // Drop bankrupt players back into the lobby flow and reset.
    room.started = false
    room.game = null
    clearBotTimer(room) // no stale bot/auction/move timers may survive the reset
    clearTradeTimer(room)
    clearLobbyTeardownTimer(room)
    for (const p of room.players) p.ready = p.isHost
    broadcastRoom(room)
    log(`room ${room.code}: reset for another game`)
    return { ok: true }
  }
}
