import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { Logo } from '../components/Logo'
import { IconArrowLeft, IconCheck, IconCopy, IconPlay, IconPlus } from '../components/Icons'
import { MAX_PLAYERS, MIN_PLAYERS, PLAYER_COLORS } from '../game/types'
import type { PlayerColor } from '../game/types'
import { useNet } from '../net/NetContext'
import { ConnBanner, ModeBadge } from '../components/ConnectionState'
import type { RoomSnapshot } from '../net/protocol'
import './LobbyPage.css'

export function LobbyPage() {
  const navigate = useNavigate()
  const { roomCode = '' } = useParams()
  const code = roomCode.toUpperCase().slice(0, 6)
  const net = useNet()

  // Server lobby is active when the net room matches this URL.
  const serverRoom = net.room && net.room.code === code ? net.room : null
  const serverMode = Boolean(serverRoom)

  return serverMode && serverRoom ? (
    <ServerLobby code={code} room={serverRoom} />
  ) : (
    <DemoLobby code={code} onBack={() => navigate('/')} />
  )
}

/* =============================== SERVER LOBBY =============================== */

function ServerLobby({ code, room }: { code: string; room: RoomSnapshot }) {
  const navigate = useNavigate()
  const net = useNet()
  const [copied, setCopied] = useState(false)
  const [starting, setStarting] = useState(false)

  const players = room.players
  const me = players.find((p) => p.id === net.youId)
  const isHost = Boolean(me?.isHost)
  const readyCount = players.filter((p) => p.ready).length
  const canStart = players.length >= MIN_PLAYERS && readyCount === players.length

  // When the host starts, the server pushes 'started' → navigate.
  const gameStarted = Boolean(net.game && net.game.code === code)
  useEffect(() => {
    if (gameStarted) navigate(`/play/${code}`)
  }, [gameStarted, navigate, code])

  // Someone else might see the game already running (late refresh).
  useEffect(() => {
    if (room.started && !gameStarted) navigate(`/play/${code}`)
  }, [room.started, gameStarted, navigate, code])

  const copy = useCallback(async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard unavailable */
    }
  }, [])

  const leaveSeat = useCallback(() => {
    net.leaveRoom()
    navigate('/')
  }, [net, navigate])

  const startGame = useCallback(() => {
    setStarting(true)
    net.startGame()
    window.setTimeout(() => setStarting(false), 2500)
  }, [net])

  const inviteLink = useMemo(() => `${window.location.origin}/lobby/${code}`, [code])

  return (
    <div className="page lobby">
      <div className="bg-glow" />
      <div className="bg-grid" />
      <ConnBanner status={net.status} canPractice />

      <header className="topbar">
        <Logo size="sm" />
        <div className="topbar-actions">
          <ModeBadge mode="online" />
          <span className={`net-pill ${net.status}`} title={`Connection: ${net.status}`}>
            {net.status === 'open' ? '● live' : net.status === 'connecting' ? '○ connecting…' : '○ offline'}
          </span>
          <button className="btn btn-ghost" onClick={leaveSeat}>
            <IconArrowLeft /> Leave
          </button>
        </div>
      </header>

      <main className="lobby-main">
        <div className="lobby-head">
          <h1>Game Lobby</h1>
          <p>Share the code and gather your rivals. {MAX_PLAYERS} seats max.</p>
        </div>

        <section className="lobby-grid">
          <section className="room-card panel">
            <p className="room-card-label">Room code</p>
            <div className="room-code">{code || '······'}</div>
            <div className="room-card-actions">
              <button className="btn" onClick={() => copy(code)}>
                {copied ? <IconCheck /> : <IconCopy />} {copied ? 'Copied!' : 'Copy code'}
              </button>
              <button className="btn" onClick={() => copy(inviteLink)}>
                {copied ? <IconCheck /> : <IconCopy />} Copy invite link
              </button>
            </div>
            <p className="room-hint">
              Anyone who enters this code — from any browser — joins <em>this</em> table.
            </p>
          </section>

          <section className="slots-card panel">
            <div className="slots-head">
              <h2>Players</h2>
              <span className="slots-count">
                {players.length}/{MAX_PLAYERS}
              </span>
            </div>

            <div className="slots">
              {Array.from({ length: MAX_PLAYERS }).map((_, i) => {
                const p = players[i]
                if (!p) {
                  return (
                    <div key={`empty-${i}`} className="slot empty">
                      <div className="slot-avatar">?</div>
                      <div className="slot-info">
                        <span className="slot-name">Empty seat</span>
                        <span className="slot-sub">Waiting for a friend…</span>
                      </div>
                    </div>
                  )
                }
                const isMe = p.id === net.youId
                return (
                  <div key={p.id} className="slot" data-color={colorOf(p.color)}>
                    <div className="slot-avatar" style={{ background: p.color }}>
                      {p.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="slot-info">
                      <span className="slot-name">
                        {p.name}
                        {isMe && <span className="chip me-chip">you</span>}
                        {p.isHost && <span className="chip">host</span>}
                        {p.isBot && <span className="chip bot-chip">bot</span>}
                      </span>
                      <span className="slot-sub">
                        {p.isBot ? (
                          'Practice rival'
                        ) : p.connected === false ? (
                          <span className="offline-badge">● reconnecting…</span>
                        ) : p.ready ? (
                          <span className="ready-badge">
                            <IconCheck /> Ready
                          </span>
                        ) : (
                          'Picking a token…'
                        )}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>

            {isHost && players.length < MAX_PLAYERS && (
              <button className="btn add-bot" onClick={net.addBot}>
                <IconPlus /> Add practice rival
              </button>
            )}

            {me && !me.isBot && !isHost && (
              <button
                className={`btn add-bot ${me.ready ? 'ready-toggle on' : ''}`}
                onClick={() => net.setReady(!me.ready)}
              >
                {me.ready ? (
                  <>
                    <IconCheck /> I'm ready
                  </>
                ) : (
                  'Ready up'
                )}
              </button>
            )}
            {me && !me.isBot && isHost && !me.ready && (
              <button className="btn add-bot ready-toggle on" onClick={() => net.setReady(true)}>
                <IconCheck /> I'm ready
              </button>
            )}
          </section>

          <section className="start-card panel">
            <div className="start-info">
              <h2>Ready to roll?</h2>
              <p>
                {canStart
                  ? 'Everyone is seated and ready. The city awaits.'
                  : `Waiting for players — ${readyCount}/${players.length} ready.`}
              </p>
            </div>
            {isHost ? (
              <button
                className="btn btn-primary btn-lg start-btn"
                disabled={!canStart || starting}
                onClick={startGame}
                aria-busy={starting}
              >
                {starting ? (
                  <>
                    <span className="spinner" /> Setting up the board…
                  </>
                ) : (
                  <>
                    <IconPlay /> Start Game
                  </>
                )}
              </button>
            ) : (
              <div className="waiting-chip">
                <span className="spinner" /> Waiting for the host…
              </div>
            )}
            {!isHost && <p className="start-hint">The host starts the game for everyone.</p>}
            <div className="start-rules">
              <span>🏠 32 tiles</span>
              <span>💰 M 1,500 starting cash</span>
              <span>🎲 Server-rolled dice</span>
            </div>
          </section>
        </section>
      </main>
    </div>
  )
}

function colorOf(hex: string): PlayerColor {
  const entries = Object.entries(PLAYER_COLORS) as Array<[PlayerColor, { hex: string }]>
  const found = entries.find((pair) => pair[1].hex.toLowerCase() === hex.toLowerCase())
  return found ? found[0] : 'amber'
}

/* ================================ DEMO LOBBY ================================ */

interface DemoPlayer {
  id: string
  name: string
  color: PlayerColor
  ready: boolean
  isHost: boolean
}

function DemoLobby({ code, onBack }: { code: string; onBack: () => void }) {
  const [players, setPlayers] = useState<DemoPlayer[]>([
    { id: 'me', name: 'You', color: 'amber', ready: true, isHost: true },
  ])
  const [copied, setCopied] = useState(false)
  const [starting, setStarting] = useState(false)
  const navigate = useNavigate()

  const readyCount = players.filter((p) => p.ready).length
  const canStart = players.length >= MIN_PLAYERS && readyCount === players.length

  const copyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      /* clipboard unavailable */
    }
  }, [code])

  const addBot = useCallback(() => {
    setPlayers((prev) => {
      if (prev.length >= MAX_PLAYERS) return prev
      const names = ['Botsby', 'Claire', 'Rooke', 'Dexter', 'Wren', 'Otto']
      const colors: PlayerColor[] = ['sky', 'mint', 'rose', 'violet']
      const idx = prev.length - 1
      return [
        ...prev,
        {
          id: `bot-${idx}`,
          name: names[idx % names.length] ?? 'Rival',
          color: colors[idx % colors.length] ?? 'sky',
          ready: true,
          isHost: false,
        },
      ]
    })
  }, [])

  const startGame = useCallback(() => {
    setStarting(true)
    window.setTimeout(() => {
      navigate(`/play/${code}`, { state: { players } })
    }, 700)
  }, [code, navigate, players])

  return (
    <div className="page lobby">
      <div className="bg-glow" />
      <div className="bg-grid" />

      <header className="topbar">
        <Logo size="sm" />
        <div className="topbar-actions">
          <ModeBadge mode="practice" />
          <button className="btn btn-ghost" onClick={onBack}>
            <IconArrowLeft /> Leave
          </button>
        </div>
      </header>

      <main className="lobby-main">
        <div className="lobby-head">
          <h1>Practice Lobby</h1>
          <p>
            Offline demo — bots only. For real multiplayer, create a room from the{' '}
            <button className="linklike" onClick={() => navigate('/')}>
              homepage
            </button>
            .
          </p>
        </div>

        <section className="lobby-grid">
          <section className="room-card panel">
            <p className="room-card-label">Practice code</p>
            <div className="room-code">{code || '······'}</div>
            <div className="room-card-actions">
              <button className="btn" onClick={copyCode}>
                {copied ? <IconCheck /> : <IconCopy />} {copied ? 'Copied!' : 'Copy code'}
              </button>
            </div>
            <p className="room-hint">
              This is a local sandbox. Other browsers that enter this code will open their own
              practice table, not this one.
            </p>
          </section>

          <section className="slots-card panel">
            <div className="slots-head">
              <h2>Players</h2>
              <span className="slots-count">
                {players.length}/{MAX_PLAYERS}
              </span>
            </div>
            <div className="slots">
              {Array.from({ length: MAX_PLAYERS }).map((_, i) => {
                const p = players[i]
                if (!p) {
                  return (
                    <div key={`empty-${i}`} className="slot empty">
                      <div className="slot-avatar">?</div>
                      <div className="slot-info">
                        <span className="slot-name">Empty seat</span>
                        <span className="slot-sub">Add a practice rival…</span>
                      </div>
                    </div>
                  )
                }
                return (
                  <div key={p.id} className="slot" data-color={p.color}>
                    <div className="slot-avatar" style={{ background: PLAYER_COLORS[p.color].hex }}>
                      {p.name.slice(0, 2).toUpperCase()}
                    </div>
                    <div className="slot-info">
                      <span className="slot-name">
                        {p.name}
                        {p.isHost && <span className="chip">host</span>}
                        {!p.isHost && <span className="chip bot-chip">bot</span>}
                      </span>
                      <span className="slot-sub">
                        {p.ready ? (
                          <span className="ready-badge">
                            <IconCheck /> Ready
                          </span>
                        ) : (
                          'Picking a token…'
                        )}
                      </span>
                    </div>
                  </div>
                )
              })}
            </div>
            <button className="btn add-bot" onClick={addBot}>
              <IconPlus /> Add practice rival
            </button>
          </section>

          <section className="start-card panel">
            <div className="start-info">
              <h2>Ready to roll?</h2>
              <p>
                {canStart
                  ? 'Everyone is seated and ready. The city awaits.'
                  : `Waiting — ${readyCount}/${players.length} ready.`}
              </p>
            </div>
            <button
              className="btn btn-primary btn-lg start-btn"
              disabled={!canStart || starting}
              onClick={startGame}
              aria-busy={starting}
            >
              {starting ? (
                <>
                  <span className="spinner" /> Setting up the board…
                </>
              ) : (
                <>
                  <IconPlay /> Start Practice
                </>
              )}
            </button>
            <div className="start-rules">
              <span>🏠 32 tiles</span>
              <span>💰 M 1,500 starting cash</span>
              <span>🎲 Local dice</span>
            </div>
          </section>
        </section>
      </main>
    </div>
  )
}
