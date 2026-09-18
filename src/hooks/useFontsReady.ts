import { useEffect, useState } from 'react'

/** Resolves to true once web fonts are loaded (canvas textures need them). */
export function useFontsReady(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let cancelled = false
    const done = () => {
      if (!cancelled) setReady(true)
    }
    if (typeof document !== 'undefined' && 'fonts' in document) {
      document.fonts.ready.then(done).catch(done)
    } else {
      done()
    }
    const fallback = window.setTimeout(done, 1500)
    return () => {
      cancelled = true
      window.clearTimeout(fallback)
    }
  }, [])
  return ready
}
