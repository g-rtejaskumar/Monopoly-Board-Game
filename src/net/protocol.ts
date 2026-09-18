/**
 * BoardQuest realtime protocol (shared by server and client).
 * The server is authoritative: clients send intents, server validates and broadcasts state.
 *
 * v2: 40-space board, 8 players, buildings, chat, richer property data.
 */

export const PROTOCOL_VERSION = 2

/** Max players per room (matches MAX_PLAYERS on the client types). */
export const MAX_PLAYERS = 8

/** Dice are always rolled by the server. */
export type Dice = [number, number]

/* --------------------------------- identity --------------------------------- */

export interface PlayerPublic {
  /** Server-assigned stable id (also the reconnection token). */
  id: string
  name: string
  color: string
  /** Present in lobby/game; false for bots. */
  connected: boolean
  isHost: boolean
  isBot: boolean
  ready: boolean
}

/* ---------------------------------- messages ---------------------------------- */

/** A pending trade offer (immutable once proposed; re-validated at execution). */
export interface TradeState {
  id: number
  fromId: string
  toId: string
  giveCash: number
  getCash: number
  giveTiles: number[]
  getTiles: number[]
  giveJailCards: number
  getJailCards: number
}

/** Trade offer payload as sent by a client (identities attached separately). */
export type TradePayload = Omit<TradeState, 'id' | 'fromId' | 'toId'>

/** Live auction for an unowned property. */
export interface AuctionState {
  tile: number
  highest: number
  highestBidder: string | null
  /** Player id expected to act now. */
  bidder: string | null
  passed: string[]
  /** Server epoch ms when the current bid window ends. */
  deadline: number
  log: string[]
}

/** A player owes money and must raise funds (mortgage/sell/trade) or go bankrupt. */
export interface DebtState {
  debtorId: string
  amount: number
  /** null = the bank. */
  creditorId: string | null
  /** False when even full liquidation cannot cover the debt. */
  canPay: boolean
}

/** Client → server. */
export type ClientMsg =
  | { t: 'hello'; name: string; playerId?: string }
  | { t: 'create' }
  | { t: 'join'; code: string }
  | { t: 'ready'; ready: boolean }
  | { t: 'addBot' }
  | { t: 'start' }
  | { t: 'roll' }
  | { t: 'buy'; accept: boolean }
  | { t: 'eventOk' }
  | { t: 'build'; tile: number }
  | { t: 'sellBuilding'; tile: number }
  | { t: 'mortgage'; tile: number }
  | { t: 'unmortgage'; tile: number }
  | { t: 'jailAction'; action: 'pay' | 'card' | 'roll' }
  | { t: 'tradePropose'; to: string; giveCash: number; getCash: number; giveTiles: number[]; getTiles: number[]; giveJailCards: number; getJailCards: number }
  | { t: 'tradeRespond'; accept: boolean }
  | { t: 'tradeCancel' }
  | { t: 'auctionBid'; amount: number }
  | { t: 'auctionPass' }
  | { t: 'debtPay' }
  | { t: 'declareBankrupt' }
  | { t: 'playAgain' }
  | { t: 'chat'; text: string }
  | { t: 'leaveRoom' }

/** Server → client. */
export type ServerMsg =
  | { t: 'you'; playerId: string; name: string }
  | { t: 'created'; code: string; you: PlayerPublic; room: RoomSnapshot }
  | { t: 'joined'; code: string; you: PlayerPublic; room: RoomSnapshot }
  | { t: 'room'; room: RoomSnapshot }
  | { t: 'started'; game: GameSnapshot }
  | { t: 'state'; game: GameSnapshot }
  | { t: 'chat'; msg: ChatMessage }
  | { t: 'err'; code: ErrCode; message: string }
  | { t: 'ping' }

export type ErrCode =
  | 'badName'
  | 'roomNotFound'
  | 'roomFull'
  | 'roomClosed'
  | 'notYourTurn'
  | 'badPhase'
  | 'tooEarly'
  | 'badTrade'
  | 'badBid'
  | 'insufficient'
  | 'notAllowed'

export interface ChatMessage {
  id: number
  fromId: string
  fromName: string
  color: string
  text: string
  at: number
}

/* --------------------------------- snapshots --------------------------------- */

export interface RoomSnapshot {
  code: string
  hostId: string
  players: PlayerPublic[]
  started: boolean
}

export interface GamePlayer {
  id: string
  name: string
  color: string
  seat: number
  tile: number
  cash: number
  isBot: boolean
  connected: boolean
  /** True when the player is in jail (sits on the JAIL corner until doubles/free). */
  inJail?: boolean
  /** Failed jail-roll attempts this jail stay (3rd forces the M 50 fine). */
  jailTurns?: number
  /** Get Out of Jail Free cards held. */
  getOutCards?: number
  bankrupt?: boolean
}

export interface GameSnapshot {
  code: string
  players: GamePlayer[]
  /** Index into players[] of whose turn it is. */
  current: number
  turn: number
  phase: 'idle' | 'rolling' | 'moving' | 'buy' | 'event' | 'jail' | 'auction' | 'debt'
  dice: Dice
  /** Monotonic counter bumped on every dice roll so clients can trigger animations. */
  rollId: number
  /** Server time of the roll (ms epoch) for animation timing. */
  rolledAt: number
  /** Consecutive doubles rolled by the current player (3 sends them to jail). */
  doubles: number
  /** tile index -> owner player id. */
  owned: Record<string, string>
  /** tile index -> number of houses (5 == hotel). */
  buildings: Record<string, number>
  /** tile index -> true while the property is mortgaged. */
  mortgaged: Record<string, true>
  /** Set during phase 'buy'. */
  buyTile: number | null
  /** Set during phase 'event' (card draw). */
  eventTile: number | null
  eventText: { title: string; body: string; good: boolean } | null
  /** Set during phase 'debt'. */
  debt: DebtState | null
  /** Pending trade awaiting a response from `toId`. */
  trade: TradeState | null
  /** Live auction during phase 'auction'. */
  auction: AuctionState | null
  log: Array<{ id: number; text: string; color: string }>
  /** Winner player id when the game ends. */
  winner: string | null
}

/* --------------------------------- game rules --------------------------------- */

export const START_CASH = 1500
export const START_BONUS = 200
export const BOARD_SIZE = 40

export function rollDie(): number {
  return 1 + Math.floor(Math.random() * 6)
}
