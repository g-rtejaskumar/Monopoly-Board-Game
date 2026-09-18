export function sanitizeName(raw: string): string {
  return (
    raw
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 14) || 'Player'
  )
}
