import { IS_PROD } from '../net/NetClient'
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
 * Banner for transient connection states. Renders nothing while connected.
 * Pass `active={false}` on pages a user can reach without having attempted a
 * connection (e.g. a fresh landing visit) so no false "reconnecting" shows.
 * `canPractice` marks routes where the local demo experience still exists
 * (lobby / game) so the copy can offer the explicit offline option.
 */
export function ConnBanner({
  status,
  canPractice = false,
  active = true,
}: {
  status: NetStatus
  canPractice?: boolean
  active?: boolean
}) {
  if (!active || status === 'open') return null

  if (status === 'connecting') {
    return (
      <div className="conn-banner conn-banner--info" role="status">
        Connecting to BoardQuest multiplayer…
      </div>
    )
  }

  if (status === 'unreachable') {
    return (
      <div className="conn-banner conn-banner--error" role="alert">
        <strong>Can’t reach the game server.</strong>{' '}
        {IS_PROD
          ? 'Multiplayer is unavailable right now — please try again later.'
          : 'Is the realtime server running? Start it with “npm run dev”.'}
        {canPractice && IS_PROD && (
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
