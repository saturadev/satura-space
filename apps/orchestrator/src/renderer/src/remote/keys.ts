export const KEYS: Record<string, string> = {
  esc: '\x1b',
  'shift-tab': '\x1b[Z',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  right: '\x1b[C',
  left: '\x1b[D',
  'ctrl-c': '\x03',
  enter: '\r',
  slash: '/',
  backspace: '\x7f'
}

export function keySequence(name: string): string | null {
  if (KEYS[name]) return KEYS[name]
  if (/^\d{1,2}$/.test(name)) return name
  const pick = /^pick:(\d+):(\d+)$/.exec(name)
  if (pick) {
    const delta = Number(pick[1]) - Number(pick[2])
    return (delta > 0 ? KEYS.down : KEYS.up).repeat(Math.abs(delta)) + KEYS.enter
  }
  return null
}
