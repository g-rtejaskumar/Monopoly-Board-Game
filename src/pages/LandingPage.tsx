import { Suspense, lazy, useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { Logo } from '../components/Logo'
import { CodeInput } from '../components/CodeInput'
import { IconDice, IconLogin, IconPlus, IconSpark, IconUsers } from '../components/Icons'
import { sanitizeName } from '../game/sanitize'
import { useNet } from '../net/NetContext'
import { loadNetIdentity } from '../net/NetClient'
import { ConnBanner } from '../components/ConnectionState'
import './LandingPage.css'

const HeroScene = lazy(() => import('../three/HeroScene'))

type Panel = 'closed' | 'create' | 'join'

export function LandingPage() {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const net = useNet()
  const [panel, setPanel] = useState<Panel>('closed')
  const [name, setName] = useState('')
  const [code, setCode] = useState('')
  const [codeError, setCodeError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  // Invite links carry ?join=CODE — open the join panel pre-filled.
  const inviteCode = useMemo(
    () => (params.get('join') ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6),
    [params],
  )

  const stored = useMemo(() => loadNetIdentity(), [])
  const nameOk = name.trim().length > 0

  useEffect(() => {
    if (stored) setName(stored.name)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (inviteCode.length === 6) {
      setCode(inviteCode)
      setPanel('join')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inviteCode])

  const goCreate = useCallback(() => {
    if (!nameOk) {
      setPanel('create')
      return
    }
    setCreating(true)
    net.ensureConnected(sanitizeName(name))
    // Give the socket a beat to open, then ask for a room.
    window.setTimeout(() => {
      net.createRoom()
      setCreating(false)
    }, 450)
  }, [name, nameOk, net])

  const goJoin = useCallback(
    (joinedCode?: string) => {
      const c = (joinedCode ?? code).toUpperCase()
      if (c.length !== 6) {
        setCodeError('Enter the full 6-character room code')
        return
      }
      if (!nameOk) {
        setPanel('join')
        setCodeError(null)
        return
      }
      setCodeError(null)
      net.ensureConnected(sanitizeName(name))
      window.setTimeout(() => {
        net.joinRoom(c)
      }, 450)
    },
    [code, name, nameOk, net],
  )

  const openPanel = (p: Panel) => {
    setPanel(p)
    setCodeError(null)
  }

  // Navigate to the lobby once the server confirms create/join.
  useEffect(() => {
    if (net.room) {
      navigate(`/lobby/${net.room.code}`)
    }
  }, [net.room, navigate])

  // Surface server errors (room not found, full, name too short…).
  useEffect(() => {
    if (!net.error) return
    if (net.error.code === 'roomNotFound') {
      setCodeError(net.error.message)
    }
    setCreating(false)
  }, [net.error])

  return (
    <div className="page landing">
      <div className="bg-glow" />
      <div className="bg-grid" />
      <div className="bg-noise" />
      <ConnBanner status={net.status} active={net.net !== null} />

      <header className="topbar">
        <Logo size="md" />
        <div className="topbar-actions">
          <a className="btn btn-ghost" href="#features">
            <IconSpark /> Features
          </a>
          <button className="btn btn-ghost" onClick={() => openPanel('join')}>
            <IconLogin /> Join
          </button>
        </div>
      </header>

      <main className="landing-main">
        <section className="hero">
          <div className="hero-copy">
            <div className="hero-badge">
              <IconDice /> 3D · Multiplayer · Free
            </div>
            <h1 className="hero-title">
              Buy the block.
              <br />
              <span className="accent-text">Bankrupt your friends.</span>
            </h1>
            <p className="hero-sub">
              BoardQuest is a premium 3D property-trading board game. Create a private room,
              share the code, and race your friends around a hand-crafted isometric board —
              right in your browser. No downloads, no accounts.
            </p>

            <div className="hero-cta">
              <button className="btn btn-primary btn-xl" onClick={goCreate}>
                <IconPlus /> Play With Friends
              </button>
              <button className="btn btn-lg" onClick={() => openPanel('join')}>
                <IconLogin /> Join Game
              </button>
            </div>

            <div className="hero-stats">
              <span><strong>40</strong> unique tiles</span>
              <span><strong>8</strong> players per room</span>
              <span><strong>1</strong> shared code to party up</span>
            </div>
          </div>

          <div className="hero-scene" aria-hidden="true">
            <Suspense fallback={<div className="hero-scene-loading" />}>
              <HeroScene />
            </Suspense>
            <div className="hero-scene-fade" />
          </div>
        </section>

        {/* ------------------------- create / join panel ------------------------- */}
        {panel !== 'closed' && (
          <div className="panel-wrap" role="presentation" onClick={() => openPanel('closed')}>
            <section
              className="panel action-panel"
              role="dialog"
              aria-modal="true"
              aria-label={panel === 'create' ? 'Create a game' : 'Join a game'}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="panel-head">
                <h2>{panel === 'create' ? 'Create a new game' : 'Join your friends'}</h2>
                <button className="btn btn-icon btn-ghost" aria-label="Close" onClick={() => openPanel('closed')}>
                  ✕
                </button>
              </div>

              <label className="field-label" htmlFor="player-name">
                Your name
              </label>
              <input
                id="player-name"
                className="text-input"
                placeholder="e.g. Maple"
                maxLength={14}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    if (panel === 'create') goCreate()
                    else goJoin()
                  }
                }}
              />

              {panel === 'create' ? (
                <>
                  <p className="panel-hint">
                    You'll be the host. Share the room code with friends after the lobby opens.
                  </p>
                  <button className="btn btn-primary btn-lg panel-cta" disabled={creating} onClick={goCreate}>
                    {creating ? (
                      <>
                        <span className="spinner" /> Opening room…
                      </>
                    ) : (
                      <>
                        <IconDice /> Create Game
                      </>
                    )}
                  </button>
                </>
              ) : (
                <>
                  <label className="field-label" style={{ marginTop: 18 }}>
                    Room code
                  </label>
                  <CodeInput
                    value={code}
                    onChange={(v) => {
                      setCode(v)
                      setCodeError(null)
                    }}
                    onComplete={(v) => goJoin(v)}
                  />
                  {codeError && <p className="error-text">{codeError}</p>}
                  {net.error && net.error.code !== 'roomNotFound' && (
                    <p className="error-text">{net.error.message}</p>
                  )}
                  {net.status === 'connecting' && (
                    <p className="panel-hint">Connecting to the game server…</p>
                  )}
                  <button className="btn btn-primary btn-lg panel-cta" onClick={() => goJoin()}>
                    <IconUsers /> Join Game
                  </button>
                </>
              )}
            </section>
          </div>
        )}

        {/* ------------------------------ features ------------------------------ */}
        <section className="features" id="features">
          <h2 className="features-title">
            Made for <span className="accent-text">game night</span>
          </h2>
          <div className="feature-grid">
            <article className="feature panel">
              <div className="feature-icon amber"><IconDice /></div>
              <h3>Roll in gorgeous 3D</h3>
              <p>Weighted dice tumble across a real felt table. Every token, house, and tile is hand-crafted with soft light and satisfying motion.</p>
            </article>
            <article className="feature panel">
              <div className="feature-icon sky"><IconUsers /></div>
              <h3>Private rooms, zero friction</h3>
              <p>Create a room, share the 6-character code, and your friends are at the table in seconds — on desktop or phone.</p>
            </article>
            <article className="feature panel">
              <div className="feature-icon mint"><IconSpark /></div>
              <h3>Trade, build, win</h3>
              <p>Collect rent, strike deals, and build houses across 32 original streets. Last tycoon standing takes the town.</p>
            </article>
          </div>
        </section>
      </main>

      <footer className="footer">
        <span>BoardQuest — an original property-trading party game.</span>
        <span className="footer-dim">Made for friends, rivals, and sore losers.</span>
      </footer>
    </div>
  )
}
