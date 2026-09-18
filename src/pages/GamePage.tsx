import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { BoardScene, resolveBuy, resolveEvent, rollDice } from '../three/BoardScene'
import type { BoardPlayer, BoardStore, SceneStore } from '../three/BoardScene'
import { useNet } from '../net/NetContext'
import { ModeBadge } from '../components/ConnectionState'
import { createNetBoardStore } from '../net/netBoardStore'
import type { GameSnapshot, ChatMessage, TradePayload } from '../net/protocol'
import { Logo } from '../components/Logo'
import {
  IconArrowLeft,
  IconChat,
  IconCheck,
  IconCopy,
  IconDice,
  IconGear,
  IconPlus,
} from '../components/Icons'
import { PLAYER_COLORS } from '../game/types'
import type { PlayerColor } from '../game/types'
import { GROUP_COLORS, groupTiles, getTile } from '../game/boardData'
import './GamePage.css'

interface Toast {
  total: number
  color: PlayerColor
}

export function GamePage() {
  const { roomCode = '' } = useParams()
  const net = useNet()

  // Net mode is active whenever the server has a game for this room code.
  const netGame = net.game && net.game.code === roomCode.toUpperCase() ? net.game : null

  if (netGame) {
    return <NetGame roomCode={roomCode.toUpperCase()} game={netGame} />
  }
  return <DemoGame />
}

/* ================================== NET MODE ================================= */

function NetGame({ roomCode, game }: { roomCode: string; game: GameSnapshot }) {
  const navigate = useNavigate()
  const net = useNet()
  const { store, onServerMsg } = useMemo(() => createNetBoardStore(), [])

  // Subscribe BEFORE feeding snapshots so no notify is ever missed.
  const [, force] = useReducer((n: number) => n + 1, 0)
  useEffect(() => store.subscribe(() => force()), [store])

  // Feed server snapshots into the store.
  const lastGameRef = useRef<GameSnapshot | null>(null)
  useEffect(() => {
    if (lastGameRef.current !== game) {
      lastGameRef.current = game
      onServerMsg(game)
    }
  }, [game, onServerMsg])

  // --- camera controls ---
  const [view, setView] = useState<'iso' | 'top'>('iso')
  const [resetToken, setResetToken] = useState(0)
  const [autoRotate, setAutoRotate] = useState(false)

  // --- tile selection (property card in the sidebar) ---
  const [selectedTile, setSelectedTile] = useState<number | null>(null)

  // --- chat (server relayed) ---
  const [chatOpen, setChatOpen] = useState(false)
  const [chatMsgs, setChatMsgs] = useState<ChatMessage[]>([])
  const [unread, setUnread] = useState(0)
  const [chatDraft, setChatDraft] = useState('')
  // --- trade modal ---
  const [tradeOpen, setTradeOpen] = useState(false)
  useEffect(() => {
    if (!net.net) return
    const off = net.net.onMessage((m) => {
      if (m.t === 'chat') {
        setChatMsgs((prev) => [...prev.slice(-80), m.msg])
        setUnread((u) => u + 1)
      }
    })
    return off
  }, [net.net])
  useEffect(() => {
    if (chatOpen) setUnread(0)
  }, [chatOpen])

  const sendChat = useCallback(() => {
    const text = chatDraft.trim()
    if (!text || !net.net) return
    net.net.send({ t: 'chat', text })
    setChatDraft('')
  }, [chatDraft, net.net])

  const s = store.get()
  const phase = s.phase
  const current = s.players[s.current]
  const me = s.players.find((p) => p.id === net.youId)
  const isMyTurn = Boolean(current && current.id === net.youId)
  const canRoll = isMyTurn && phase === 'idle' && s.eventTile == null && s.buyTile == null

  const [toast, setToast] = useState<Toast | null>(null)
  const toastKeyRef = useRef('')

  const toastKey = s.last ? `${s.last.seat}:${s.rolledAt}` : ''
  useEffect(() => {
    if (!s.last || !toastKey) return
    if (toastKeyRef.current === toastKey) return
    toastKeyRef.current = toastKey
    const color = s.players[s.last.seat]?.color ?? 'amber'
    setToast({ total: s.last.diceTotal, color })
    const t = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastKey])

  // Auto-show the deed when the local player lands somewhere buyable.
  const lastLandedRef = useRef<number | null>(null)
  useEffect(() => {
    if (!me || s.moveAnim) return
    const t = me.tile
    if (t === lastLandedRef.current || t === 0) return
    const tile = getTile(t)
    if (tile && (tile.type === 'property' || tile.type === 'railroad' || tile.type === 'utility')) {
      setSelectedTile(t)
    }
    lastLandedRef.current = t
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me?.tile])

  const doRoll = useCallback(() => {
    if (canRoll) net.roll()
  }, [canRoll, net])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && canRoll) {
        e.preventDefault()
        net.roll()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [net, canRoll])

  const leave = useCallback(() => {
    net.leaveRoom()
    navigate('/lobby/' + roomCode)
  }, [net, navigate, roomCode])

  const disconnected = net.status !== 'open'
  const myTurnToBuild =
    isMyTurn && phase === 'idle' && s.eventTile == null && s.buyTile == null

  const canBuildOn = useCallback(
    (tileIndex: number): boolean => {
      const tile = getTile(tileIndex)
      if (!tile || tile.type !== 'property' || !tile.colorGroup) return false
      if (game.owned[String(tileIndex)] !== net.youId) return false
      if (game.mortgaged[String(tileIndex)]) return false
      const group = groupTiles(tile.colorGroup)
      if (!group.every((i) => game.owned[String(i)] === net.youId)) return false
      const cur = game.buildings[String(tileIndex)] ?? 0
      if (cur >= 5) return false
      // Even-build: no sibling may have fewer houses.
      if (!group.every((i) => (game.buildings[String(i)] ?? 0) >= cur)) return false
      const cost = cur === 4 ? (tile.hotelCost ?? tile.houseCost ?? 0) : (tile.houseCost ?? 0)
      return (me?.cash ?? 0) >= cost
    },
    [game, net.youId, me],
  )

  const canMortgageOn = useCallback(
    (tileIndex: number): boolean => {
      if (game.owned[String(tileIndex)] !== net.youId) return false
      if (game.mortgaged[String(tileIndex)]) return false
      if ((game.buildings[String(tileIndex)] ?? 0) > 0) return false
      return Boolean(getTile(tileIndex))
    },
    [game, net.youId],
  )

  const canUnmortgageOn = useCallback(
    (tileIndex: number): boolean => {
      if (game.owned[String(tileIndex)] !== net.youId) return false
      if (!game.mortgaged[String(tileIndex)]) return false
      const tile = getTile(tileIndex)
      const cost = Math.ceil((tile?.mortgageValue ?? 0) * 1.1)
      return (me?.cash ?? 0) >= cost
    },
    [game, net.youId, me],
  )

  return (
    <div className="page game">
      <div className="bg-glow" />
      <div className="bg-grid" />

      {disconnected && (
        <div className="net-banner">
          <span className="spinner" /> Reconnecting to the table…
        </div>
      )}

      <header className="game-topbar">
        <Logo size="sm" />
        <div className="game-code">ROOM {roomCode}</div>
        <div className="topbar-actions">
          <ModeBadge mode="online" />
          <button
            className={`btn btn-icon ${chatOpen ? 'active' : ''}`}
            aria-label="Chat"
            onClick={() => setChatOpen((v) => !v)}
          >
            <IconChat />
            {unread > 0 && !chatOpen && <span className="badge-dot">{unread}</span>}
          </button>
          <button
            className="btn btn-icon"
            aria-label="Propose a trade"
            title="Propose a trade"
            onClick={() => setTradeOpen(true)}
          >
            <IconPlus />
          </button>
          <button className="btn btn-icon" aria-label="Settings">
            <IconGear />
          </button>
          <button className="btn" onClick={leave}>
            <IconArrowLeft /> Leave
          </button>
        </div>
      </header>

      <main className="game-main">
        {/* ---------------- left: player status rail ---------------- */}
        <aside className="players-rail">
          {s.players.map((p, i) => (
            <div
              key={p.id}
              className={`rail-player ${i === s.current ? 'active' : ''} ${p.id === net.youId ? 'me' : ''} ${
                p.connected === false ? 'offline' : ''
              } ${p.bankrupt ? 'bankrupt' : ''}`}
            >
              <span className="rail-dot" style={{ background: PLAYER_COLORS[p.color].hex }} />
              <div className="rail-info">
                <span className="rail-name">
                  {p.name}
                  {p.id === net.youId ? ' (you)' : ''}
                  {p.isBot ? ' 🤖' : ''}
                  {p.inJail ? ' ⛓️' : ''}
                </span>
                <span className="rail-cash">M {p.cash.toLocaleString()}</span>
              </div>
              {p.connected === false && !p.bankrupt && (
                <span className="rail-offline">reconnecting…</span>
              )}
              {i === s.current && p.connected !== false && !p.bankrupt && (
                <span className="rail-live" aria-hidden="true" />
              )}
            </div>
          ))}

          <div className="turn-banner">
            {current ? (
              isMyTurn ? (
                <span className="turn-you">Your turn — roll the dice!</span>
              ) : (
                <span className="turn-them" style={{ color: PLAYER_COLORS[current.color].hex }}>
                  {current.name}'s turn
                </span>
              )
            ) : (
              <span>Setting up…</span>
            )}
          </div>
        </aside>

        {/* ---------------- center: 3D board ---------------- */}
        <div className="board-wrap">
          <BoardScene
            store={store as unknown as SceneStore}
            view={view}
            resetToken={resetToken}
            autoRotate={autoRotate}
            selectedTile={selectedTile}
            onTileSelect={(i) => setSelectedTile(i)}
          />

          <div className="board-overlay-bottom">
            {canRoll ? (
              <button className="btn btn-primary btn-xl roll-btn" onClick={doRoll}>
                <IconDice /> Roll Dice
                <span className="roll-hint">space</span>
              </button>
            ) : (
              <div className={`turn-chip ${phase !== 'idle' ? 'busy' : ''}`}>
                {game.phase === 'jail' && isMyTurn
                  ? 'You are in jail'
                  : game.phase === 'auction'
                    ? 'Auction in progress…'
                    : game.phase === 'debt'
                      ? 'Debt must be settled…'
                      : phase === 'rolling'
                        ? 'Rolling…'
                        : phase === 'moving'
                          ? `${current?.name ?? 'Player'} is moving…`
                          : current
                            ? `${current.name}'s turn`
                            : 'Setting up…'}
              </div>
            )}
          </div>

          <div className="board-cam-controls">
            <button
              className={`cam-btn ${view === 'iso' ? 'on' : ''}`}
              onClick={() => setView('iso')}
              title="Isometric 3D view"
            >
              3D
            </button>
            <button
              className={`cam-btn ${view === 'top' ? 'on' : ''}`}
              onClick={() => setView('top')}
              title="Overhead 2D view"
            >
              2D
            </button>
            <button
              className={`cam-btn ${autoRotate ? 'on' : ''}`}
              onClick={() => setAutoRotate((v) => !v)}
              title="Auto camera"
            >
              ⟳
            </button>
            <button
              className="cam-btn"
              onClick={() => setResetToken((t) => t + 1)}
              title="Reset camera"
            >
              ⌂
            </button>
          </div>

          {toast && (
            <div className="dice-toast" data-color={toast.color}>
              <div className="dice-toast-dice">
                <span>{s.dice[0]}</span>
                <span>{s.dice[1]}</span>
              </div>
              <div className="dice-toast-text">
                <strong>+{toast.total}</strong>
                <span className="dice-toast-sub">{current?.name ?? 'Player'} moves</span>
              </div>
            </div>
          )}

          {s.buyTile != null && current && current.id === net.youId && (
            <BuyModal
              tileIndex={s.buyTile}
              cash={current.cash}
              color={current.color}
              onDecide={(ok) => net.buy(ok)}
            />
          )}

          {s.eventTile != null && current && current.id === net.youId && (
            <EventModal event={game.eventText} tile={s.eventTile} onClose={() => net.eventOk()} />
          )}

          {game.phase === 'jail' && isMyTurn && current && (
            <JailPanel
              cash={current.cash}
              cards={current.getOutCards ?? 0}
              attempt={(current.jailTurns ?? 0) + 1}
              onPay={() => net.jailAction('pay')}
              onCard={() => net.jailAction('card')}
              onRoll={() => net.jailAction('roll')}
            />
          )}

          {game.phase === 'auction' && game.auction && (
            <AuctionModal
              auction={game.auction}
              game={game}
              youId={net.youId}
              onBid={(amount) => net.auctionBid(amount)}
              onPass={() => net.auctionPass()}
            />
          )}

          {game.phase === 'debt' && game.debt && game.debt.debtorId === net.youId && (
            <DebtPanel
              debt={game.debt}
              game={game}
              youId={net.youId}
              onMortgage={(t) => net.mortgage(t)}
              onSell={(t) => net.sellBuilding(t)}
              onPay={() => net.debtPay()}
              onBankrupt={() => net.declareBankrupt()}
            />
          )}

          {game.winner && <WinnerScreen game={game} youId={net.youId} onPlayAgain={() => net.playAgain()} />}
        </div>

        {/* ---------------- right: info sidebar ---------------- */}
        <aside className="side-rail">
          {/* players panel */}
          <div className="side-block players-block">
            <h3>
              Players ({s.players.length}/8)
              <button
                className="copy-inline"
                title="Copy room code"
                onClick={() => navigator.clipboard?.writeText(roomCode).catch(() => {})}
              >
                <IconCopy /> {roomCode}
              </button>
            </h3>
            <div className="side-players">
              {s.players.map((p, i) => {
                const propsCount = propOfLocal(game, p.id).length
                return (
                  <div
                    key={p.id}
                    className={`side-player ${i === s.current ? 'active' : ''} ${
                      p.bankrupt ? 'bankrupt' : ''
                    }`}
                  >
                    <span
                      className="side-player-avatar"
                      style={{ background: PLAYER_COLORS[p.color].hex }}
                    >
                      {p.name.slice(0, 2).toUpperCase()}
                    </span>
                    <div className="side-player-info">
                      <span className="side-player-name">
                        {p.name}
                        {p.id === net.youId && <em className="chip me-chip">you</em>}
                        {p.isBot && <em className="chip bot-chip">bot</em>}
                      </span>
                      <span className="side-player-sub">
                        {p.bankrupt
                          ? '💀 bankrupt'
                          : i === s.current
                            ? p.id === net.youId
                              ? '🎲 YOUR TURN'
                              : '🎲 their turn'
                            : p.connected === false
                              ? '● reconnecting…'
                              : `${propsCount} deed${propsCount === 1 ? '' : 's'}`}
                      </span>
                    </div>
                    <span className="side-player-cash">M {p.cash.toLocaleString()}</span>
                  </div>
                )
              })}
            </div>
            <button className="btn btn-sm trade-open-btn" onClick={() => setTradeOpen(true)}>
              <IconPlus /> Propose a trade
            </button>
          </div>

          {/* property card panel */}
          <div className="side-block deed-block">
            <h3>Property card</h3>
            {selectedTile != null && getTile(selectedTile) ? (
              <DeedCard
                tileIndex={selectedTile}
                game={game}
                colorOfId={(id) => s.players.find((p) => p.id === id)?.color}
                myTurnToBuild={myTurnToBuild}
                canBuild={canBuildOn(selectedTile)}
                onBuild={() => net.build(selectedTile)}
                canMortgage={canMortgageOn(selectedTile)}
                onMortgage={() => net.mortgage(selectedTile)}
                canUnmortgage={canUnmortgageOn(selectedTile)}
                onUnmortgage={() => net.unmortgage(selectedTile)}
                isMyBuyTile={s.buyTile === selectedTile && isMyTurn}
                onBuy={() => net.buy(true)}
                myCash={me?.cash ?? 0}
              />
            ) : (
              <p className="deed-empty">Click any property tile on the board to view its deed.</p>
            )}
          </div>

          {/* game log */}
          <div className="side-block log-block">
            <h3>Game log</h3>
            <div className="log-list">
              {s.log
                .slice(-14)
                .reverse()
                .map((e) => (
                  <div key={e.id} className="log-entry">
                    <span className="log-dot" style={{ background: colorHex(e.color) }} />
                    <span>{e.text}</span>
                  </div>
                ))}
            </div>
          </div>

          <div className="side-block">
            <h3>Last roll</h3>
            <div className="deed-row">
              <span className="deed-dice">
                {s.dice[0]} · {s.dice[1]}
              </span>
              <span className="deed-total">= {s.dice[0] + s.dice[1]}</span>
            </div>
            {s.last && <p className="deed-note">rolled {s.last.diceTotal}</p>}
          </div>
        </aside>
      </main>

      {chatOpen && (
        <aside className="chat-drawer">
          <div className="chat-head">
            <h3>Table talk</h3>
            <button
              className="btn btn-icon btn-ghost"
              aria-label="Close chat"
              onClick={() => setChatOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="chat-body">
            {chatMsgs.length === 0 && (
              <div className="chat-msg">
                <b>Chat</b> Say hello to the table!
              </div>
            )}
            {chatMsgs.map((m) => (
              <div key={m.id} className="chat-msg">
                <b style={{ color: colorHex(m.color) }}>{m.fromName}</b> {m.text}
              </div>
            ))}
          </div>
          <div className="chat-input-row">
            <input
              className="text-input"
              placeholder="Say something…"
              value={chatDraft}
              maxLength={200}
              onChange={(e) => setChatDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') sendChat()
              }}
            />
            <button className="btn btn-primary" aria-label="Send" onClick={sendChat}>
              ➤
            </button>
          </div>
        </aside>
      )}

      {tradeOpen && (
        <TradeModal
          game={game}
          youId={net.youId}
          onClose={() => setTradeOpen(false)}
          onPropose={(toId, payload) => {
            net.tradePropose(toId, payload)
            setTradeOpen(false)
          }}
        />
      )}

      {game.trade && !tradeOpen && (
        <TradePanel
          game={game}
          youId={net.youId}
          onAccept={() => net.tradeRespond(true)}
          onReject={() => net.tradeRespond(false)}
          onCancel={() => net.tradeCancel()}
        />
      )}
    </div>
  )
}

function colorHex(c: string): string {
  const entries = Object.entries(PLAYER_COLORS) as Array<[PlayerColor, { hex: string }]>
  const found = entries.find((pair) => pair[0] === c)
  if (found) return found[1].hex
  return /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(c) ? c : PLAYER_COLORS.amber.hex
}

function propOfLocal(game: GameSnapshot, playerId: string | null): number[] {
  if (!playerId) return []
  return Object.entries(game.owned)
    .filter(([, owner]) => owner === playerId)
    .map(([idx]) => Number(idx))
}

/* ================================ DEMO MODE ================================ */

interface RoutePlayers {
  players?: Array<{ name: string; color: PlayerColor; isHost: boolean; ready: boolean }>
}

function DemoGame() {
  const navigate = useNavigate()
  const location = useLocation()
  const state = (location.state ?? {}) as RoutePlayers

  const players: BoardPlayer[] = useMemo(() => {
    const fromLobby = state.players ?? []
    if (fromLobby.length >= 2) {
      return fromLobby.map((p, i) => ({
        id: `seat-${i}`,
        name: p.name,
        seat: i,
        color: p.color,
        tile: 0,
        cash: 1500,
      }))
    }
    const demoColors: PlayerColor[] = ['amber', 'sky', 'mint', 'rose']
    return ['You', 'Botsby', 'Claire', 'Rooke'].map((n, i) => ({
      id: `seat-${i}`,
      name: n,
      seat: i,
      color: demoColors[i] ?? 'amber',
      tile: 0,
      cash: 1500,
    }))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [store, setStore] = useState<BoardStore | null>(null)
  const [, force] = useReducer((n: number) => n + 1, 0)
  const onStore = useCallback((st: BoardStore) => setStore(st), [])

  useEffect(() => {
    if (!store) return
    return store.subscribe(() => force())
  }, [store])

  const [view, setView] = useState<'iso' | 'top'>('iso')
  const [resetToken, setResetToken] = useState(0)
  const [autoRotate, setAutoRotate] = useState(false)
  const [selectedTile, setSelectedTile] = useState<number | null>(null)
  const [chatOpen, setChatOpen] = useState(false)

  const s = store?.get()
  const phase = s?.phase ?? 'idle'
  const current = s ? s.players[s.current] : undefined
  const isMyTurn = current?.seat === 0
  const canRoll = Boolean(s) && isMyTurn && phase === 'idle' && s?.eventTile == null && s?.buyTile == null

  const [toast, setToast] = useState<Toast | null>(null)
  const toastKeyRef = useRef('')

  const toastKey = s?.last ? `${s.last.seat}:${s.rolledAt}` : ''
  useEffect(() => {
    if (!s || !s.last || !toastKey) return
    if (toastKeyRef.current === toastKey) return
    toastKeyRef.current = toastKey
    const color = s.players[s.last.seat]?.color ?? 'amber'
    setToast({ total: s.last.diceTotal, color })
    const t = window.setTimeout(() => setToast(null), 2400)
    return () => window.clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toastKey])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code === 'Space' && store && canRoll) {
        e.preventDefault()
        rollDice(store)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [store, canRoll])

  return (
    <div className="page game">
      <div className="bg-glow" />
      <div className="bg-grid" />

      <header className="game-topbar">
        <Logo size="sm" />
        <div className="game-code">PRACTICE ROOM</div>
        <div className="topbar-actions">
          <ModeBadge mode="practice" />
          <button
            className={`btn btn-icon ${chatOpen ? 'active' : ''}`}
            aria-label="Chat"
            onClick={() => setChatOpen((v) => !v)}
          >
            <IconChat />
          </button>
          <button className="btn btn-icon" aria-label="Settings">
            <IconGear />
          </button>
          <button className="btn" onClick={() => navigate('/')}>
            <IconArrowLeft /> Leave
          </button>
        </div>
      </header>

      <main className="game-main">
        <aside className="players-rail">
          {s?.players.map((p, i) => (
            <div
              key={p.id}
              className={`rail-player ${i === s.current ? 'active' : ''} ${p.seat === 0 ? 'me' : ''}`}
            >
              <span className="rail-dot" style={{ background: PLAYER_COLORS[p.color].hex }} />
              <div className="rail-info">
                <span className="rail-name">
                  {p.name}
                  {p.seat === 0 ? ' (you)' : ''}
                </span>
                <span className="rail-cash">M {p.cash.toLocaleString()}</span>
              </div>
              {i === s.current && <span className="rail-live" aria-hidden="true" />}
            </div>
          ))}

          <div className="turn-banner">
            {current ? (
              isMyTurn ? (
                <span className="turn-you">Your turn — roll the dice!</span>
              ) : (
                <span className="turn-them" style={{ color: PLAYER_COLORS[current.color].hex }}>
                  {current.name}'s turn
                </span>
              )
            ) : (
              <span>Setting up…</span>
            )}
          </div>
        </aside>

        <div className="board-wrap">
          <BoardScene
            players={players}
            onStore={onStore}
            view={view}
            resetToken={resetToken}
            autoRotate={autoRotate}
            selectedTile={selectedTile}
            onTileSelect={(i) => setSelectedTile(i)}
          />

          <div className="board-overlay-bottom">
            {canRoll && store ? (
              <button className="btn btn-primary btn-xl roll-btn" onClick={() => rollDice(store)}>
                <IconDice /> Roll Dice
                <span className="roll-hint">space</span>
              </button>
            ) : (
              <div className={`turn-chip ${phase !== 'idle' ? 'busy' : ''}`}>
                {phase === 'rolling'
                  ? 'Rolling…'
                  : phase === 'moving'
                    ? `${current?.name ?? 'Player'} is moving…`
                    : current
                      ? `${current.name}'s turn`
                      : 'Setting up…'}
              </div>
            )}
          </div>

          <div className="board-cam-controls">
            <button
              className={`cam-btn ${view === 'iso' ? 'on' : ''}`}
              onClick={() => setView('iso')}
              title="Isometric 3D view"
            >
              3D
            </button>
            <button
              className={`cam-btn ${view === 'top' ? 'on' : ''}`}
              onClick={() => setView('top')}
              title="Overhead 2D view"
            >
              2D
            </button>
            <button
              className={`cam-btn ${autoRotate ? 'on' : ''}`}
              onClick={() => setAutoRotate((v) => !v)}
              title="Auto camera"
            >
              ⟳
            </button>
            <button
              className="cam-btn"
              onClick={() => setResetToken((t) => t + 1)}
              title="Reset camera"
            >
              ⌂
            </button>
          </div>

          {toast && (
            <div className="dice-toast" data-color={toast.color}>
              <div className="dice-toast-dice">
                <span>{s?.dice[0]}</span>
                <span>{s?.dice[1]}</span>
              </div>
              <div className="dice-toast-text">
                <strong>+{toast.total}</strong>
                <span className="dice-toast-sub">{current?.name ?? 'Player'} moves</span>
              </div>
            </div>
          )}

          {s?.buyTile != null && store && current && (
            <BuyModal
              tileIndex={s.buyTile}
              cash={current.cash}
              color={current.color}
              onDecide={(ok) => resolveBuy(store, ok)}
            />
          )}

          {s?.eventTile != null && store && (
            <EventModal tile={s.eventTile} onClose={() => resolveEvent(store)} />
          )}
        </div>

        <aside className="side-rail">
          <div className="side-block players-block">
            <h3>Players ({s?.players.length ?? 0}/8)</h3>
            <div className="side-players">
              {s?.players.map((p, i) => (
                <div key={p.id} className={`side-player ${i === s.current ? 'active' : ''}`}>
                  <span
                    className="side-player-avatar"
                    style={{ background: PLAYER_COLORS[p.color].hex }}
                  >
                    {p.name.slice(0, 2).toUpperCase()}
                  </span>
                  <div className="side-player-info">
                    <span className="side-player-name">{p.name}</span>
                    <span className="side-player-sub">
                      {i === s.current ? '🎲 YOUR TURN' : 'waiting'}
                    </span>
                  </div>
                  <span className="side-player-cash">M {p.cash.toLocaleString()}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="side-block deed-block">
            <h3>Property card</h3>
            {selectedTile != null && getTile(selectedTile) ? (
              <DemoDeedCard
                tileIndex={selectedTile}
                owned={s?.owned ?? {}}
                buildings={s?.buildings ?? {}}
              />
            ) : (
              <p className="deed-empty">Click any property tile on the board to view its deed.</p>
            )}
          </div>

          <div className="side-block log-block">
            <h3>Game log</h3>
            <div className="log-list">
              {s?.log
                .slice(-14)
                .reverse()
                .map((e) => (
                  <div key={e.id} className="log-entry">
                    <span className="log-dot" style={{ background: colorHex(e.color) }} />
                    <span>{e.text}</span>
                  </div>
                ))}
            </div>
          </div>

          <div className="side-block">
            <h3>Last roll</h3>
            <div className="deed-row">
              <span className="deed-dice">
                {s ? s.dice[0] : '·'} · {s ? s.dice[1] : '·'}
              </span>
              <span className="deed-total">= {s ? s.dice[0] + s.dice[1] : '—'}</span>
            </div>
            {s?.last && (
              <p className="deed-note">
                {s.players[s.last.seat]?.name} rolled {s.last.diceTotal}
              </p>
            )}
          </div>
        </aside>
      </main>

      {chatOpen && (
        <aside className="chat-drawer">
          <div className="chat-head">
            <h3>Table talk</h3>
            <button
              className="btn btn-icon btn-ghost"
              aria-label="Close chat"
              onClick={() => setChatOpen(false)}
            >
              ✕
            </button>
          </div>
          <div className="chat-body">
            <div className="chat-msg">
              <b style={{ color: PLAYER_COLORS.amber.hex }}>You</b> ready to lose?
            </div>
            <div className="chat-msg">
              <b style={{ color: PLAYER_COLORS.sky.hex }}>Botsby</b> I call the brown streets!
            </div>
            <div className="chat-msg">
              <b style={{ color: PLAYER_COLORS.mint.hex }}>Claire</b> race you to START money
            </div>
          </div>
          <div className="chat-input-row">
            <input className="text-input" placeholder="Say something…" />
            <button className="btn btn-primary" aria-label="Send">
              ➤
            </button>
          </div>
        </aside>
      )}
    </div>
  )
}

/* ------------------------------ deed components ------------------------------ */

function DeedRows({ tileIndex }: { tileIndex: number }) {
  const tile = getTile(tileIndex)
  if (!tile || !tile.rent) return null
  if (tile.type === 'property') {
    const [base, h1, h2, h3, h4, hotel] = tile.rent
    return (
      <>
        <div className="deed-stat">
          <span>Price</span>
          <strong>M {tile.price}</strong>
        </div>
        <div className="deed-stat">
          <span>Rent</span>
          <strong>M {base}</strong>
        </div>
        <div className="deed-stat">
          <span>Rent with color set</span>
          <strong>M {(base ?? 0) * 2}</strong>
        </div>
        <div className="deed-stat">
          <span>Rent with 1 house</span>
          <strong>M {h1}</strong>
        </div>
        <div className="deed-stat">
          <span>Rent with 2 houses</span>
          <strong>M {h2}</strong>
        </div>
        <div className="deed-stat">
          <span>Rent with 3 houses</span>
          <strong>M {h3}</strong>
        </div>
        <div className="deed-stat">
          <span>Rent with 4 houses</span>
          <strong>M {h4}</strong>
        </div>
        <div className="deed-stat">
          <span>Rent with hotel</span>
          <strong>M {hotel}</strong>
        </div>
        <div className="deed-stat">
          <span>House cost</span>
          <strong>M {tile.houseCost}</strong>
        </div>
        <div className="deed-stat">
          <span>Mortgage value</span>
          <strong>M {tile.mortgageValue}</strong>
        </div>
      </>
    )
  }
  if (tile.type === 'railroad') {
    return (
      <>
        <div className="deed-stat">
          <span>Price</span>
          <strong>M {tile.price}</strong>
        </div>
        <div className="deed-stat">
          <span>1 road owned</span>
          <strong>M {tile.rent[0]}</strong>
        </div>
        <div className="deed-stat">
          <span>2 roads owned</span>
          <strong>M {tile.rent[1]}</strong>
        </div>
        <div className="deed-stat">
          <span>3 roads owned</span>
          <strong>M {tile.rent[2]}</strong>
        </div>
        <div className="deed-stat">
          <span>4 roads owned</span>
          <strong>M {tile.rent[3]}</strong>
        </div>
        <div className="deed-stat">
          <span>Mortgage value</span>
          <strong>M {tile.mortgageValue}</strong>
        </div>
      </>
    )
  }
  return (
    <>
      <div className="deed-stat">
        <span>Price</span>
        <strong>M {tile.price}</strong>
      </div>
      <div className="deed-stat">
        <span>1 utility</span>
        <strong>M {tile.rent[0]} × dice</strong>
      </div>
      <div className="deed-stat">
        <span>2 utilities</span>
        <strong>M {tile.rent[1]} × dice</strong>
      </div>
      <div className="deed-stat">
        <span>Mortgage value</span>
        <strong>M {tile.mortgageValue}</strong>
      </div>
    </>
  )
}

function DeedCard({
  tileIndex,
  game,
  colorOfId,
  myTurnToBuild,
  canBuild,
  onBuild,
  canMortgage,
  onMortgage,
  canUnmortgage,
  onUnmortgage,
  isMyBuyTile,
  onBuy,
  myCash,
}: {
  tileIndex: number
  game: GameSnapshot
  colorOfId: (id: string) => PlayerColor | undefined
  myTurnToBuild: boolean
  canBuild: boolean
  onBuild: () => void
  canMortgage: boolean
  onMortgage: () => void
  canUnmortgage: boolean
  onUnmortgage: () => void
  isMyBuyTile: boolean
  onBuy: () => void
  myCash: number
}) {
  const tile = getTile(tileIndex)
  if (!tile) return null
  const gc = tile.colorGroup ? GROUP_COLORS[tile.colorGroup] : null
  const ownerId = game.owned[String(tileIndex)]
  const owner = ownerId ? game.players.find((p) => p.id === ownerId) : undefined
  const ownerColor = ownerId ? colorOfId(ownerId) : undefined
  const buildings = game.buildings[String(tileIndex)] ?? 0
  const mortgaged = Boolean(game.mortgaged[String(tileIndex)])
  const price = tile.price ?? 0

  return (
    <div className="deed-mini" data-group={tile.colorGroup}>
      <div
        className="deed-mini-head"
        style={{ background: gc ? `linear-gradient(120deg, ${gc.light}, ${gc.hex})` : '#33415c' }}
      >
        <span className="deed-kicker">
          {tile.type === 'railroad'
            ? 'Road'
            : tile.type === 'utility'
              ? 'Utility'
              : gc?.label ?? 'Special'}
        </span>
        <h4>{tile.name}</h4>
        {mortgaged && <span className="deed-mortgaged-tag">MORTGAGED</span>}
      </div>
      <div className="deed-mini-body">
        <DeedRows tileIndex={tileIndex} />
        {owner && (
          <div className="deed-stat owner-row">
            <span>Owner</span>
            <strong style={{ color: ownerColor ? PLAYER_COLORS[ownerColor].hex : undefined }}>
              {owner.name}
              {buildings > 0 && (
                <span className="deed-buildings">
                  {buildings >= 5 ? ' 🏨 hotel' : ` 🏠 ×${buildings}`}
                </span>
              )}
            </strong>
          </div>
        )}
        {mortgaged && (
          <div className="deed-stat">
            <span>No rent while mortgaged</span>
            <strong>Unmortgage for M {Math.ceil((tile.mortgageValue ?? 0) * 1.1)}</strong>
          </div>
        )}
      </div>
      <div className="deed-mini-actions">
        {isMyBuyTile && (
          <button className="btn btn-primary btn-sm" onClick={onBuy} disabled={myCash < price}>
            <IconCheck /> Buy for M {price}
          </button>
        )}
        {owner && owner.id !== undefined && myTurnToBuild && canBuild && (
          <button className="btn btn-sm deed-build" onClick={onBuild}>
            🏠 Build {buildings === 4 ? 'Hotel' : `M ${tile.houseCost}`}
          </button>
        )}
        {canMortgage && (
          <button className="btn btn-sm" onClick={onMortgage}>
            🏦 Mortgage M {tile.mortgageValue}
          </button>
        )}
        {canUnmortgage && (
          <button className="btn btn-sm" onClick={onUnmortgage}>
            ♻️ Unmortgage M {Math.ceil((tile.mortgageValue ?? 0) * 1.1)}
          </button>
        )}
      </div>
    </div>
  )
}

function DemoDeedCard({
  tileIndex,
  owned,
  buildings,
}: {
  tileIndex: number
  owned: Record<number, PlayerColor>
  buildings: Record<number, number>
}) {
  const tile = getTile(tileIndex)
  if (!tile) return null
  const gc = tile.colorGroup ? GROUP_COLORS[tile.colorGroup] : null
  const ownerColor = owned[tileIndex]
  const b = buildings[tileIndex] ?? 0
  return (
    <div className="deed-mini" data-group={tile.colorGroup}>
      <div
        className="deed-mini-head"
        style={{ background: gc ? `linear-gradient(120deg, ${gc.light}, ${gc.hex})` : '#33415c' }}
      >
        <span className="deed-kicker">{gc?.label ?? 'Special'}</span>
        <h4>{tile.name}</h4>
      </div>
      <div className="deed-mini-body">
        <DeedRows tileIndex={tileIndex} />
        {ownerColor && (
          <div className="deed-stat owner-row">
            <span>Owner</span>
            <strong style={{ color: PLAYER_COLORS[ownerColor].hex }}>
              {b >= 5 ? '🏨 hotel' : b > 0 ? `🏠 ×${b}` : 'owned'}
            </strong>
          </div>
        )}
      </div>
    </div>
  )
}

/* ------------------------------- buy modal --------------------------------- */

function BuyModal({
  tileIndex,
  cash,
  color,
  onDecide,
}: {
  tileIndex: number
  cash: number
  color: PlayerColor
  onDecide: (accept: boolean) => void
}) {
  const tile = useMemo(() => getTile(tileIndex), [tileIndex])
  const price = tile?.price ?? 100
  const gc = tile?.colorGroup ? GROUP_COLORS[tile.colorGroup] : null
  return (
    <div className="modal-wrap" onClick={() => onDecide(false)}>
      <section className="modal deed" onClick={(e) => e.stopPropagation()} data-color={color}>
        <div
          className="deed-header"
          style={{ background: gc ? `linear-gradient(120deg, ${gc.light}, ${gc.hex})` : undefined }}
        >
          <span className="deed-kicker">
            Title deed — {gc?.label ?? tile?.type ?? 'property'}
          </span>
          <h3>{tile?.name ?? 'Property'}</h3>
        </div>
        <div className="deed-body">
          <DeedRows tileIndex={tileIndex} />
          <div className="deed-stat">
            <span>Your balance</span>
            <strong>M {cash.toLocaleString()}</strong>
          </div>
        </div>
        <div className="modal-actions">
          <button className="btn" onClick={() => onDecide(false)}>
            Pass (auction)
          </button>
          <button className="btn btn-primary" onClick={() => onDecide(true)} disabled={cash < price}>
            <IconCheck /> Buy for M {price}
          </button>
        </div>
      </section>
    </div>
  )
}

/* ------------------------------ trade modal -------------------------------- */

function TradeModal({
  game,
  youId,
  onClose,
  onPropose,
}: {
  game: GameSnapshot
  youId: string | null
  onClose: () => void
  onPropose: (toId: string, payload: TradePayload) => void
}) {
  const others = game.players.filter((p) => p.id !== youId && !p.bankrupt)
  const [targetId, setTargetId] = useState<string>(others[0]?.id ?? '')
  const [giveCash, setGiveCash] = useState('')
  const [getCash, setGetCash] = useState('')
  const [giveTiles, setGiveTiles] = useState<number[]>([])
  const [getTiles, setGetTiles] = useState<number[]>([])

  const me = game.players.find((p) => p.id === youId)
  const target = game.players.find((p) => p.id === targetId)
  const myProps = propOfLocal(game, youId).filter(
    (i) => (game.buildings[String(i)] ?? 0) === 0,
  )
  const theirProps = propOfLocal(game, targetId).filter(
    (i) => (game.buildings[String(i)] ?? 0) === 0,
  )

  const giveCashN = Math.max(0, Math.min(Number(giveCash) || 0, me?.cash ?? 0))
  const getCashN = Math.max(0, Math.min(Number(getCash) || 0, target?.cash ?? 0))

  const toggle = (arr: number[], set: (v: number[]) => void, idx: number) => {
    set(arr.includes(idx) ? arr.filter((x) => x !== idx) : [...arr, idx])
  }

  const canPropose =
    Boolean(targetId) &&
    (giveCashN > 0 || getCashN > 0 || giveTiles.length > 0 || getTiles.length > 0)

  return (
    <div className="modal-wrap" onClick={onClose}>
      <section className="modal trade-modal" onClick={(e) => e.stopPropagation()}>
        <div className="trade-head">
          <h3>Propose a trade</h3>
          <div className="trade-targets">
            {others.map((p) => (
              <button
                key={p.id}
                className={`trade-target ${p.id === targetId ? 'on' : ''}`}
                onClick={() => {
                  setTargetId(p.id)
                  setGetTiles([])
                  setGetCash('')
                }}
              >
                <span className="trade-dot" style={{ background: p.color }} />
                {p.name}
              </button>
            ))}
          </div>
        </div>

        <div className="trade-cols">
          <div className="trade-side">
            <h4>You give</h4>
            <label className="trade-money">
              💰
              <input
                className="text-input"
                inputMode="numeric"
                placeholder="Cash"
                value={giveCash}
                onChange={(e) => setGiveCash(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </label>
            <div className="trade-props">
              {myProps.map((idx) => {
                const t = getTile(idx)
                const gc = t?.colorGroup ? GROUP_COLORS[t.colorGroup] : null
                return (
                  <button
                    key={idx}
                    className={`trade-prop ${giveTiles.includes(idx) ? 'on' : ''}`}
                    onClick={() => toggle(giveTiles, setGiveTiles, idx)}
                  >
                    <span className="trade-chip" style={{ background: gc?.hex ?? '#33415c' }} />
                    {t?.name}
                  </button>
                )
              })}
            </div>
          </div>

          <div className="trade-arrow">⇄</div>

          <div className="trade-side right">
            <h4>You get ({target?.name ?? '—'})</h4>
            <label className="trade-money">
              💰
              <input
                className="text-input"
                inputMode="numeric"
                placeholder="Cash"
                value={getCash}
                onChange={(e) => setGetCash(e.target.value.replace(/[^0-9]/g, ''))}
              />
            </label>
            <div className="trade-props">
              {theirProps.map((idx) => {
                const t = getTile(idx)
                const gc = t?.colorGroup ? GROUP_COLORS[t.colorGroup] : null
                return (
                  <button
                    key={idx}
                    className={`trade-prop ${getTiles.includes(idx) ? 'on' : ''}`}
                    onClick={() => toggle(getTiles, setGetTiles, idx)}
                  >
                    <span className="trade-chip" style={{ background: gc?.hex ?? '#33415c' }} />
                    {t?.name}
                  </button>
                )
              })}
            </div>
          </div>
        </div>

        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            disabled={!canPropose}
            onClick={() =>
              targetId &&
              onPropose(targetId, {
                giveCash: giveCashN,
                getCash: getCashN,
                giveTiles,
                getTiles,
                giveJailCards: 0,
                getJailCards: 0,
              })
            }
          >
            <IconCheck /> Offer trade
          </button>
        </div>
      </section>
    </div>
  )
}

function TradePanel({
  game,
  youId,
  onAccept,
  onReject,
  onCancel,
}: {
  game: GameSnapshot
  youId: string | null
  onAccept: () => void
  onReject: () => void
  onCancel: () => void
}) {
  const trade = game.trade
  if (!trade) return null
  const iAmTarget = trade.toId === youId
  const from = game.players.find((p) => p.id === trade.fromId)
  const to = game.players.find((p) => p.id === trade.toId)

  return (
    <div className="modal-wrap">
      <section className="modal trade-modal" onClick={(e) => e.stopPropagation()}>
        <div className="trade-head">
          <h3>{iAmTarget ? 'Incoming trade' : 'Trade proposed'}</h3>
          <p className="trade-sub">
            {from?.name} → {to?.name}
          </p>
        </div>
        <div className="trade-cols">
          <TradeSide
            title={`${from?.name ?? 'They'} give`}
            tiles={trade.giveTiles}
            cash={trade.giveCash}
            game={game}
          />
          <div className="trade-arrow">⇄</div>
          <TradeSide
            title={`${to?.name ?? 'You'} give`}
            tiles={trade.getTiles}
            cash={trade.getCash}
            game={game}
            right
          />
        </div>
        <div className="modal-actions">
          {iAmTarget ? (
            <>
              <button className="btn" onClick={onReject}>
                Reject
              </button>
              <button className="btn btn-primary" onClick={onAccept}>
                <IconCheck /> Accept trade
              </button>
            </>
          ) : (
            <button className="btn" onClick={onCancel}>
              Cancel proposal
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

function TradeSide({
  title,
  tiles,
  cash,
  game,
  right,
}: {
  title: string
  tiles: number[]
  cash: number
  game: GameSnapshot
  right?: boolean
}) {
  return (
    <div className={`trade-side ${right ? 'right' : ''}`}>
      <h4>{title}</h4>
      {cash > 0 && <div className="trade-item">💰 M {cash.toLocaleString()}</div>}
      {tiles.map((i) => {
        const t = getTile(i)
        const gc = t?.colorGroup ? GROUP_COLORS[t.colorGroup] : null
        const mortgaged = game.mortgaged[String(i)]
        return (
          <div key={i} className="trade-item" data-group={t?.colorGroup}>
            <span className="trade-chip" style={{ background: gc?.hex ?? '#33415c' }} />
            {t?.name ?? `Tile ${i}`}
            {mortgaged ? ' (mortgaged)' : ''}
          </div>
        )
      })}
      {cash === 0 && tiles.length === 0 && <p className="trade-none">Nothing</p>}
    </div>
  )
}

/* ------------------------------ jail panel --------------------------------- */

function JailPanel({
  cash,
  cards,
  attempt,
  onPay,
  onCard,
  onRoll,
}: {
  cash: number
  cards: number
  attempt: number
  onPay: () => void
  onCard: () => void
  onRoll: () => void
}) {
  return (
    <div className="modal-wrap">
      <section className="modal jail-modal" onClick={(e) => e.stopPropagation()}>
        <div className="event-emoji">⛓️</div>
        <h3>In jail</h3>
        <p>Attempt {attempt} of 3 — roll doubles to walk free.</p>
        <p className="deed-note">Get Out of Jail Free cards: {cards}</p>
        <div className="modal-actions column">
          {cards > 0 && (
            <button className="btn btn-primary" onClick={onCard}>
              🎟️ Use Get Out of Jail Free
            </button>
          )}
          {cash >= 50 && (
            <button className="btn" onClick={onPay}>
              Pay M 50 fine
            </button>
          )}
          <button className="btn btn-primary" onClick={onRoll}>
            <IconDice /> Roll for doubles
          </button>
        </div>
      </section>
    </div>
  )
}

/* ---------------------------- auction modal -------------------------------- */

function AuctionModal({
  auction,
  game,
  youId,
  onBid,
  onPass,
}: {
  auction: NonNullable<GameSnapshot['auction']>
  game: GameSnapshot
  youId: string | null
  onBid: (amount: number) => void
  onPass: () => void
}) {
  const tile = getTile(auction.tile)
  const gc = tile?.colorGroup ? GROUP_COLORS[tile.colorGroup] : null
  const me = game.players.find((p) => p.id === youId)
  const myTurnToBid = auction.bidder === youId
  const [bid, setBid] = useState<string>(String(auction.highest + 10))
  const [, tick] = useReducer((n: number) => n + 1, 0)
  useEffect(() => {
    const id = window.setInterval(tick, 250)
    return () => window.clearInterval(id)
  }, [])

  const secondsLeft = Math.max(0, Math.ceil((auction.deadline - Date.now()) / 1000))
  const minNext = auction.highest > 0 ? auction.highest + 10 : 10

  return (
    <div className="modal-wrap">
      <section className="modal auction-modal" onClick={(e) => e.stopPropagation()}>
        <div
          className="deed-header"
          style={{ background: gc ? `linear-gradient(120deg, ${gc.light}, ${gc.hex})` : undefined }}
        >
          <span className="deed-kicker">Property auction</span>
          <h3>{tile?.name ?? 'Property'}</h3>
        </div>
        <div className="auction-lead">
          <span>
            {auction.highestBidder
              ? `${game.players.find((p) => p.id === auction.highestBidder)?.name ?? '?'} leads`
              : 'No bids yet'}
          </span>
          <strong>M {auction.highest.toLocaleString()}</strong>
        </div>
        <div className="auction-log">
          {auction.log.slice(-5).map((l, i) => (
            <div key={i} className="auction-log-line">
              {l}
            </div>
          ))}
        </div>
        {myTurnToBid ? (
          <div className="auction-actions">
            <input
              className="text-input"
              inputMode="numeric"
              value={bid}
              onChange={(e) => setBid(e.target.value.replace(/[^0-9]/g, ''))}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && Number(bid) >= minNext) onBid(Number(bid))
              }}
            />
            <button
              className="btn btn-primary"
              onClick={() => onBid(Number(bid))}
              disabled={!Number(bid) || Number(bid) < minNext || Number(bid) > (me?.cash ?? 0)}
            >
              Bid
            </button>
            <button className="btn" onClick={onPass}>
              Pass
            </button>
          </div>
        ) : (
          <p className="deed-note">
            {auction.bidder
              ? `Waiting for ${game.players.find((p) => p.id === auction.bidder)?.name ?? '…'}…`
              : 'Auction ending…'}
          </p>
        )}
        <p className="auction-timer">{secondsLeft}s left to bid</p>
      </section>
    </div>
  )
}

/* ------------------------------ debt panel --------------------------------- */

function DebtPanel({
  debt,
  game,
  youId,
  onMortgage,
  onSell,
  onPay,
  onBankrupt,
}: {
  debt: NonNullable<GameSnapshot['debt']>
  game: GameSnapshot
  youId: string | null
  onMortgage: (tile: number) => void
  onSell: (tile: number) => void
  onPay: () => void
  onBankrupt: () => void
}) {
  const debtor = game.players.find((p) => p.id === debt.debtorId)
  const canPayNow = (debtor?.cash ?? 0) >= debt.amount
  return (
    <div className="modal-wrap">
      <section className="modal debt-modal bad" onClick={(e) => e.stopPropagation()}>
        <div className="event-emoji">💸</div>
        <h3>Debt collection</h3>
        <p>
          You owe <strong>M {debt.amount.toLocaleString()}</strong>
          {debt.creditorId
            ? ` to ${game.players.find((p) => p.id === debt.creditorId)?.name}`
            : ' to the bank'}
          .
        </p>
        <p className="deed-note">
          Sell buildings or mortgage properties to raise M{' '}
          {Math.max(0, debt.amount - (debtor?.cash ?? 0)).toLocaleString()} more.
        </p>
        <div className="debt-assets">
          {propOfLocal(game, youId).map((idx) => {
            const t = getTile(idx)
            const b = game.buildings[String(idx)] ?? 0
            const mortgaged = Boolean(game.mortgaged[String(idx)])
            return (
              <div key={idx} className="debt-asset">
                <span className="debt-asset-name">
                  {t?.name ?? `Tile ${idx}`}
                  {b > 0 ? ` (${b >= 5 ? 'hotel' : `${b} house${b > 1 ? 's' : ''}`})` : ''}
                </span>
                <div className="debt-asset-actions">
                  {b > 0 && (
                    <button className="btn btn-sm" onClick={() => onSell(idx)}>
                      Sell M {Math.floor((t?.houseCost ?? 100) / 2)}
                    </button>
                  )}
                  {!b && !mortgaged && (
                    <button className="btn btn-sm" onClick={() => onMortgage(idx)}>
                      Mortgage M {t?.mortgageValue ?? 0}
                    </button>
                  )}
                </div>
              </div>
            )
          })}
        </div>
        <div className="modal-actions">
          {canPayNow && (
            <button className="btn btn-primary" onClick={onPay}>
              <IconCheck /> Pay M {debt.amount.toLocaleString()}
            </button>
          )}
          {!debt.canPay && (
            <button className="btn btn-danger" onClick={onBankrupt}>
              Declare bankruptcy
            </button>
          )}
        </div>
      </section>
    </div>
  )
}

/* ----------------------------- winner screen ------------------------------- */

function WinnerScreen({
  game,
  youId,
  onPlayAgain,
}: {
  game: GameSnapshot
  youId: string | null
  onPlayAgain: () => void
}) {
  const winner = game.players.find((p) => p.id === game.winner)
  if (!winner) return null
  const isMe = winner.id === youId
  const standings = [...game.players].sort((a, b) => b.cash - a.cash)

  return (
    <div className="modal-wrap winner-wrap">
      <section className="modal winner-modal">
        <div className="winner-trophy" aria-hidden="true">
          🏆
        </div>
        <h2 style={{ color: PLAYER_COLORS[winner.color as PlayerColor]?.hex }}>
          {isMe ? 'You win!' : `${winner.name} wins!`}
        </h2>
        <p className="winner-cash">Final balance: M {winner.cash.toLocaleString()}</p>
        <div className="winner-standings">
          {standings.map((p, i) => (
            <div key={p.id} className={`winner-row ${p.id === youId ? 'me' : ''}`}>
              <span className="winner-place">#{i + 1}</span>
              <span
                className="winner-dot"
                style={{ background: PLAYER_COLORS[p.color as PlayerColor]?.hex }}
              />
              <span className="winner-name">{p.name}</span>
              <span className="winner-cash-cell">M {p.cash.toLocaleString()}</span>
            </div>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn btn-primary" onClick={onPlayAgain}>
            Play again
          </button>
        </div>
      </section>
    </div>
  )
}

/* ------------------------------ event modal -------------------------------- */

const EVENT_TEXT: Record<number, { title: string; body: string; good: boolean }> = {
  2: { title: 'Community Fund', body: 'The neighborhood chips in. +M 100', good: true },
  7: { title: 'Lucky Break', body: 'You found a wallet on Chance Lane. +M 75', good: true },
  17: { title: 'Parade Day', body: 'The city tips you for the show. +M 50', good: true },
  22: { title: 'Sudden Storm', body: 'Your roof leaks. Pay M 120.', good: false },
  33: { title: 'Tax Refund', body: 'The city owes you one. +M 150', good: true },
  36: { title: 'Windfall', body: 'Your numbers came up. +M 200!', good: true },
}

function EventModal({
  tile,
  onClose,
  event,
}: {
  tile: number
  onClose: () => void
  event?: { title: string; body: string; good: boolean } | null
}) {
  const fallback = EVENT_TEXT[tile] ?? { title: 'Surprise!', body: 'Something happened.', good: true }
  const ev = event ?? fallback
  return (
    <div className="modal-wrap" onClick={onClose}>
      <section className={`modal event ${ev.good ? 'good' : 'bad'}`} onClick={(e) => e.stopPropagation()}>
        <div className="event-emoji" aria-hidden="true">
          {ev.good ? '🎉' : '⛈️'}
        </div>
        <h3>{ev.title}</h3>
        <p>{ev.body}</p>
        <button className="btn btn-primary" onClick={onClose}>
          Continue
        </button>
      </section>
    </div>
  )
}
