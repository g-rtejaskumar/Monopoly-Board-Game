import { Suspense, lazy } from 'react'
import { BrowserRouter, Navigate, Route, Routes, useSearchParams } from 'react-router-dom'
import { NetProvider } from './net/NetContext'
import { LandingPage } from './pages/LandingPage'

const LobbyPage = lazy(() => import('./pages/LobbyPage').then((m) => ({ default: m.LobbyPage })))
const GamePage = lazy(() => import('./pages/GamePage').then((m) => ({ default: m.GamePage })))

function JoinRedirect() {
  const [params] = useSearchParams()
  const join = params.get('join') ?? ''
  const code = join.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6)
  return <Navigate to={code ? `/lobby/${code}` : '/'} replace />
}

export default function App() {
  return (
    <NetProvider>
      <BrowserRouter>
        <Suspense fallback={null}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/lobby/:roomCode" element={<LobbyPage />} />
          <Route path="/play/:roomCode" element={<GamePage />} />
          <Route path="/join" element={<JoinRedirect />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </Suspense>
      </BrowserRouter>
    </NetProvider>
  )
}
