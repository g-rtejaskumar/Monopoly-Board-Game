import { useEffect, useState } from 'react'

/**
 * True on phone-sized viewports. Drives the low-power 3D settings (to keep 3D
 * overlays smooth on mid-range phones) and matches the mobile CSS breakpoint.
 */
export function useSmallScreen(maxWidth = 820): boolean {
  const [small, setSmall] = useState(() =>
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(`(max-width: ${maxWidth}px)`).matches
      : false,
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia(`(max-width: ${maxWidth}px)`)
    const onChange = (): void => setSmall(mq.matches)
    onChange()
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [maxWidth])
  return small
}
