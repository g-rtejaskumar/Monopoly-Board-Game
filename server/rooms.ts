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
import { MAX_PLAYERS, START_CASH, START_BONUS, BOARD_SIZE, rollDie } from '../src/net/protocol'
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

function pushLog(g: Game, color: string, text: string): void {
  g.log.push({ id: ++logId, text, color })
  if (g.log.length > 80) g.log.shift()
}

let chatId = 0
let tradeId = 0

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

function broadcastGame(room: Room): void {
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
  const started: ServerMsg = { t: 'started', game: gameSnapshot(room) }
  for (const p of room.players) p.send?.(started)
  log(`room ${room.code}: game started with ${room.players.length} players`)
}

/* --------------------------------- bot brain ---------------------------------- */

const botTimers = new Map<string, ReturnType<typeof setTimeout>>()
const moveTimers = new Map<string, ReturnType<typeof setTimeout>>()
const auctionTimers = new Map<string, ReturnType<typeof setTimeout>>()
const REAP_MS = 60_000
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
  const dice: Dice = [rollDie(), rollDie()]
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
  // Doubles grant another roll (unless jailed mid-turn).
  if (p && g.doubles > 0 && !p.inJail && !g.debt) {
    g.phase = 'idle'
    g.buyTile = null
    g.eventTile = null
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
  const dice: Dice = [rollDie(), rollDie()]
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
    g.phase = 'moving'
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
  if (to.isBot) scheduleBot(room)
}

function doTradeRespond(room: Room, playerId: string, accept: boolean): void {
  const g = room.game
  if (!g || g.winner) return
  const trade = g.trade
  if (!trade) return
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
    bidder: g.players.find((p) => !p.bankrupt)?.id ?? null,
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
    if (!room.game?.auction || room.game.auction !== a) return
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
  const p = g.players.find((pp) => pp.id === playerId)
  if (!p || a.passed.includes(playerId)) return

  a.passed.push(playerId)
  a.log.push(`${p.name} passes`)
  if (a.log.length > 12) a.log.shift()

  const remaining = auctionParticipants(g)
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
  g.phase = 'moving'
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

function doDeclareBankrupt(room: Room, playerId: string): void {
  const g = room.game
  if (!g || !g.debt || g.phase !== 'debt') return
  if (g.debt.debtorId !== playerId) return
  const p = g.players.find((pp) => pp.id === playerId)
  if (!p) return

  const creditor = g.debt.creditorId ? g.players.find((pp) => pp.id === g.debt?.creditorId) : null
  p.bankrupt = true
  pushLog(g, '#ff6b8a', `${p.name} is bankrupt!`)

  // Transfer assets: properties + cash to the creditor, or back to the bank.
  p.cash = Math.max(p.cash, 0)
  if (creditor) creditor.cash += p.cash
  p.cash = 0
  for (const [idx, owner] of Object.entries(g.owned)) {
    if (owner === p.id) {
      if (creditor) g.owned[idx] = creditor.id
      else delete g.owned[idx]
    }
  }
  // Buildings return to the bank (creditor may rebuild).
  for (const idx of Object.keys(g.buildings)) {
    if (g.owned[Number(idx)] !== p.id) continue
    if (!creditor) delete g.buildings[Number(idx)]
  }
  for (const idx of Object.keys(g.mortgaged)) {
    if (g.owned[Number(idx)] !== p.id) continue
    if (!creditor) delete g.mortgaged[Number(idx)]
  }
  if (creditor) creditor.getOutCards = (creditor.getOutCards ?? 0) + (p.getOutCards ?? 0)
  p.getOutCards = 0
  g.debt = null

  // Winner check.
  const alive = g.players.filter((pp) => !pp.bankrupt)
  if (alive.length <= 1) {
    g.winner = alive[0]?.id ?? null
    const w = alive[0]
    if (w) pushLog(g, w.color, `${w.name} wins the game! 🏆`)
  }
  broadcastGame(room)
  if (!g.winner) {
    nextTurn(room)
    broadcastGame(room)
    scheduleBot(room)
  }
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
    room.players.push(m)
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

    const used = new Set(room.players.map((p) => p.name))
    const name = BOT_NAMES.find((n) => !used.has(n)) ?? `Rival ${room.players.length}`
    const bot: Member = {
      id: makeId('bot'),
      name,
      color: COLORS[room.players.length % COLORS.length],
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

  leave(playerId: string): void {
    const m = this.members.get(playerId)
    if (!m) return
    const room = this.getRoomOf(m)
    if (!room) {
      this.members.delete(playerId)
      return
    }
    if (room.started && room.game) {
      m.connected = false
      m.send = null
      const gp = room.game.players.find((gp2) => gp2.id === m.id)
      if (gp) gp.connected = false
      pushLog(room.game, m.color, `${m.name} disconnected`)
      broadcastGame(room)
      // If they hold the floor, free the table.
      if (room.game.players[room.game.current]?.id === m.id) {
        const g = room.game
        if (g.phase === 'idle') {
          nextTurn(room)
          broadcastGame(room)
          scheduleBot(room)
        } else if (g.phase === 'auction' && g.auction) {
          doAuctionPass(room, m.id)
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
      log(`room ${room.code}: ${m.name} disconnected (seat held)`)
    } else {
      this.removeMember(m, 'left lobby')
    }
  }

  private removeMember(m: Member, reason: string): void {
    const room = this.getRoomOf(m)
    if (!room) {
      this.members.delete(m.id)
      return
    }
    room.players = room.players.filter((p) => p.id !== m.id)
    this.members.delete(m.id)
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
      this.rooms.delete(room.code)
      log(`room ${room.code}: closed (${reason})`)
    } else {
      if (room.started && room.game) broadcastGame(room)
      else broadcastRoom(room)
    }
  }

  reconnect(playerId: string, send: SendFn): boolean {
    const m = this.members.get(playerId)
    if (!m || m.isBot) return false
    if (m.connected && m.send) return false
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
      pushLog(room.game, '#9aa7c7', `${m.name} reconnected`)
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
    for (const p of room.players) p.ready = p.isHost
    broadcastRoom(room)
    log(`room ${room.code}: reset for another game`)
    return { ok: true }
  }
}
