import { IS_PROD, getConfigError } from '../net/NetClient'
import type { NetStatus } from '../net/NetClient'

export type PlayMode = 'online' | 'practice'

/** Small pill that makes it unmistakable which mode the player is in. */
export function ModeBadge({ mode }: { mode: PlayMode }) {
  return (
    <span className={`mode-badge mode-badge--${mode}`}>
      {mode === 'online' ? '● Online Multiplayer' : '○ Practice / Demo Mode'}
    </span>
  )
}

/**
 * Banner for connection states. Renders nothing while connected.
 * Pass `active={false}` on pages a user can reach without having attempted a
 * connection (e.g. a fresh landing visit) so no false "reconnecting" shows.
 * `canPractice` marks routes where the local demo experience still exists
 * (lobby / game) so the copy can offer the explicit offline option.
 * `onRetry` enables an explicit reconnect action for unreachable states.
 */
export function ConnBanner({
  status,
  canPractice = false,
  active = true,
  onRetry,
}: {
  status: NetStatus
  canPractice?: boolean
  active?: boolean
  onRetry?: () => void
}) {
  if (!active || status === 'open') return null

  if (status === 'connecting') {
    return (
      <div className="conn-banner conn-banner--info" role="status">
        Connecting to BoardQuest multiplayer…
      </div>
    )
  }

  // The build itself is misconfigured (missing/invalid VITE_WS_URL in prod).
  // This is not a network problem — retrying cannot fix it, so no retry here.
  if (status === 'config-error') {
    const detail = getConfigError()
    return (
      <div className="conn-banner conn-banner--error" role="alert">
        <strong>Multiplayer is not configured.</strong>{' '}
        {IS_PROD
          ? 'The multiplayer server address was not configured for this build.'
          : 'The WebSocket configuration is invalid.'}
        {detail && <span className="conn-banner-hint"> {detail}</span>}
        {canPractice && (
          <span className="conn-banner-hint"> Practice mode is available from the home page.</span>
        )}
      </div>
    )
  }

  if (status === 'unreachable') {
    return (
      <div className="conn-banner conn-banner--error" role="alert">
        <strong>Can’t reach the game server.</strong>{' '}
        {IS_PROD
          ? 'Multiplayer is unavailable right now.'
          : 'Is the realtime server running? Start it with “npm run dev”.'}
        {onRetry && (
          <button type="button" className="conn-banner-retry" onClick={onRetry}>
            Retry
          </button>
        )}
        {canPractice && (
          <span className="conn-banner-hint"> Practice mode is available from the home page.</span>
        )}
      </div>
    )
  }

  // 'closed': brief drop — auto-reconnect is already scheduled.
  return (
    <div className="conn-banner conn-banner--warn" role="status">
      Connection lost — reconnecting…
    </div>
  )
}
