import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import type { GameSnapshot, RoomSnapshot, TradePayload } from './protocol'
import { NetClient, getNet, loadNetIdentity } from './NetClient'
import type { NetStatus } from './NetClient'

interface NetError {
  code: string
  message: string
  id: number
}

interface NetContextValue {
  net: NetClient | null
  status: NetStatus
  room: RoomSnapshot | null
  game: GameSnapshot | null
  youId: string | null
  error: NetError | null
  /** Connect + hello with the given name (no-op if already connected as someone). */
  ensureConnected: (name: string) => void
  createRoom: () => void
  joinRoom: (code: string) => void
  setReady: (ready: boolean) => void
  addBot: () => void
  startGame: () => void
  roll: () => void
  buy: (accept: boolean) => void
  eventOk: () => void
  build: (tile: number) => void
  sellBuilding: (tile: number) => void
  mortgage: (tile: number) => void
  unmortgage: (tile: number) => void
  jailAction: (action: 'pay' | 'card' | 'roll') => void
  tradePropose: (toId: string, payload: TradePayload) => void
  tradeRespond: (accept: boolean) => void
  tradeCancel: () => void
  auctionBid: (amount: number) => void
  auctionPass: () => void
  debtPay: () => void
  declareBankrupt: () => void
  playAgain: () => void
  leaveRoom: () => void
  dismissError: () => void
}

const NetContext = createContext<NetContextValue | null>(null)

let errId = 0

export function NetProvider({ children }: { children: ReactNode }) {
  const [net, setNet] = useState<NetClient | null>(null)
  const [status, setStatus] = useState<NetStatus>('closed')
  const [room, setRoom] = useState<RoomSnapshot | null>(null)
  const [game, setGame] = useState<GameSnapshot | null>(null)
  const [youId, setYouId] = useState<string | null>(null)
  const [error, setError] = useState<NetError | null>(null)
  const desiredName = useRef<string>('')

  // Restore a persisted session on mount (reconnect after refresh).
  useEffect(() => {
    const identity = loadNetIdentity()
    if (!identity?.name) return
    desiredName.current = identity.name
    const client = getNet(identity.name)
    setNet(client)
    client.connect()
  }, [])

  useEffect(() => {
    if (!net) return
    const offMsg = net.onMessage((msg) => {
      switch (msg.t) {
        case 'you':
          setYouId(msg.playerId)
          break
        case 'created':
        case 'joined':
          setRoom(msg.room)
          setYouId(msg.you.id)
          setError(null)
          break
        case 'room':
          setRoom(msg.room)
          // A room reset (Play Again) ends the old game on every client.
          if (!msg.room.started) setGame(null)
          break
        case 'started':
          setGame(msg.game)
          setRoom((r) => (r ? { ...r, started: true } : r))
          break
        case 'state':
          setGame(msg.game)
          break
        case 'err':
          setError({ code: msg.code, message: msg.message, id: ++errId })
          break
        default:
          break
      }
    })
    const offStatus = net.onStatus(setStatus)
    return () => {
      offMsg()
      offStatus()
    }
  }, [net])

  const ensureConnected = useCallback((name: string) => {
    desiredName.current = name
    const client = getNet(name)
    if (client.name !== name && client.status === 'closed') {
      client.name = name
    }
    netRef.current = client
    setNet(client)
    client.connect()
  }, [])

  // Actions go through a ref so they work on the very first click, before a
  // re-render has published the freshly created client into state.
  const netRef = useRef<NetClient | null>(null)
  const viaRef = useCallback((fn: (c: NetClient) => void) => {
    const c = netRef.current ?? net
    if (c) fn(c)
  }, [net])

  const createRoom = useCallback(() => viaRef((c) => c.send({ t: 'create' })), [viaRef])
  const joinRoom = useCallback((code: string) => viaRef((c) => c.send({ t: 'join', code })), [viaRef])
  const setReady = useCallback((ready: boolean) => viaRef((c) => c.send({ t: 'ready', ready })), [viaRef])
  const addBot = useCallback(() => viaRef((c) => c.send({ t: 'addBot' })), [viaRef])
  const startGame = useCallback(() => viaRef((c) => c.send({ t: 'start' })), [viaRef])
  const roll = useCallback(() => viaRef((c) => c.send({ t: 'roll' })), [viaRef])
  const buy = useCallback((accept: boolean) => viaRef((c) => c.send({ t: 'buy', accept })), [viaRef])
  const eventOk = useCallback(() => viaRef((c) => c.send({ t: 'eventOk' })), [viaRef])
  const build = useCallback((tile: number) => viaRef((c) => c.send({ t: 'build', tile })), [viaRef])
  const sellBuilding = useCallback((tile: number) => viaRef((c) => c.send({ t: 'sellBuilding', tile })), [viaRef])
  const mortgage = useCallback((tile: number) => viaRef((c) => c.send({ t: 'mortgage', tile })), [viaRef])
  const unmortgage = useCallback((tile: number) => viaRef((c) => c.send({ t: 'unmortgage', tile })), [viaRef])
  const jailAction = useCallback(
    (action: 'pay' | 'card' | 'roll') => viaRef((c) => c.send({ t: 'jailAction', action })),
    [viaRef],
  )
  const tradePropose = useCallback(
    (toId: string, payload: TradePayload) => viaRef((c) => c.send({ t: 'tradePropose', to: toId, ...payload })),
    [viaRef],
  )
  const tradeRespond = useCallback((accept: boolean) => viaRef((c) => c.send({ t: 'tradeRespond', accept })), [viaRef])
  const tradeCancel = useCallback(() => viaRef((c) => c.send({ t: 'tradeCancel' })), [viaRef])
  const auctionBid = useCallback((amount: number) => viaRef((c) => c.send({ t: 'auctionBid', amount })), [viaRef])
  const auctionPass = useCallback(() => viaRef((c) => c.send({ t: 'auctionPass' })), [viaRef])
  const debtPay = useCallback(() => viaRef((c) => c.send({ t: 'debtPay' })), [viaRef])
  const declareBankrupt = useCallback(() => viaRef((c) => c.send({ t: 'declareBankrupt' })), [viaRef])
  const playAgain = useCallback(() => viaRef((c) => c.send({ t: 'playAgain' })), [viaRef])
  const leaveRoom = useCallback(() => {
    net?.send({ t: 'leaveRoom' })
    setRoom(null)
    setGame(null)
  }, [net])
  const dismissError = useCallback(() => setError(null), [])

  const value = useMemo<NetContextValue>(
    () => ({
      net,
      status,
      room,
      game,
      youId,
      error,
      ensureConnected,
      createRoom,
      joinRoom,
      setReady,
      addBot,
      startGame,
      roll,
      buy,
      eventOk,
      build,
      sellBuilding,
      mortgage,
      unmortgage,
      jailAction,
      tradePropose,
      tradeRespond,
      tradeCancel,
      auctionBid,
      auctionPass,
      debtPay,
      declareBankrupt,
      playAgain,
      leaveRoom,
      dismissError,
    }),
    [net, status, room, game, youId, error, ensureConnected, createRoom, joinRoom, setReady, addBot, startGame, roll, buy, eventOk, build, sellBuilding, mortgage, unmortgage, jailAction, tradePropose, tradeRespond, tradeCancel, auctionBid, auctionPass, debtPay, declareBankrupt, playAgain, leaveRoom, dismissError],
  )

  return <NetContext.Provider value={value}>{children}</NetContext.Provider>
}

export function useNet(): NetContextValue {
  const ctx = useContext(NetContext)
  if (!ctx) throw new Error('useNet must be used inside <NetProvider>')
  return ctx
}
