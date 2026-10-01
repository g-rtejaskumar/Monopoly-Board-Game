/**
 * One-time WebGL probe. The 2D board is the source of truth for readability;
 * if the GPU/WebGL is unavailable (old device, blocked context, headless) the
 * board simply renders DOM tokens instead of the 3D overlay.
 */

let cached: boolean | null = null

export function hasWebGL(): boolean {
  if (cached !== null) return cached
  if (typeof document === 'undefined') {
    cached = false
    return cached
  }
  try {
    const canvas = document.createElement('canvas')
    const gl =
      canvas.getContext('webgl2') ??
      canvas.getContext('webgl') ??
      canvas.getContext('experimental-webgl')
    cached = Boolean(gl)
    if (gl && 'getExtension' in gl) {
      // Release the probe context promptly so it doesn't count against the
      // browser's live-context budget.
      const lose = (gl as WebGLRenderingContext).getExtension('WEBGL_lose_context')
      lose?.loseContext()
    }
  } catch {
    cached = false
  }
  return cached
}

/** True when the user has asked the OS/browser to minimise motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches
}
