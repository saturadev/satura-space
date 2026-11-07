const PHYSICAL_FALLBACK_KEYS = new Set(['', 'Dead', 'Unidentified'])

function isLatinShortcutKey(key: string): boolean {
  if (key.length !== 1) return false
  const upper = key.toUpperCase()
  return (upper >= 'A' && upper <= 'Z') || (key >= '0' && key <= '9')
}

function physicalKeyToken(e: KeyboardEvent): string {
  const code = e.code || ''
  if (code.startsWith('Key') && code.length === 4) return code.slice(3).toLowerCase()
  if (code.startsWith('Digit') && code.length === 6) return code.slice(5)
  return (e.key || '').toLowerCase()
}

export function chordKey(e: KeyboardEvent): string {
  const key = e.key || ''
  if (PHYSICAL_FALLBACK_KEYS.has(key)) return physicalKeyToken(e)
  if (key.length !== 1 || isLatinShortcutKey(key)) return key.toLowerCase()
  return physicalKeyToken(e)
}
