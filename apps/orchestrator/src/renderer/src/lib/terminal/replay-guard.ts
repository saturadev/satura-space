import type { Terminal } from '@xterm/xterm'

export const RESET_TERMINAL_CURSOR_STYLE = '\x1b[0 q'
export const RESET_KITTY_KEYBOARD_PROTOCOL = '\x1b[<99u\x1b[=0u'
export const POST_REPLAY_MODE_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1004l\x1b[?1006l\x1b[?2004l`
export const POST_REPLAY_REATTACH_RESET = `${RESET_TERMINAL_CURSOR_STYLE}${RESET_KITTY_KEYBOARD_PROTOCOL}\x1b[?25h\x1b[?1004l`

const ALT_SCREEN_ON = '\x1b[?1049h'
const ALT_SCREEN_OFF = '\x1b[?1049l'

export interface ReplayGuard {
  isReplaying(): boolean
  replay(data: string): void
}

export function createReplayGuard(term: Terminal): ReplayGuard {
  let pending = 0
  return {
    isReplaying: () => pending > 0,
    replay(data) {
      if (!data) return
      pending++
      term.write(data, () => {
        pending = Math.max(0, pending - 1)
      })
    }
  }
}

export function restoreSerializedBuffer(
  guard: ReplayGuard,
  data: string,
  options?: { reattached?: boolean }
): void {
  if (!data) return
  if (options?.reattached) {
    guard.replay('\x1b[2J\x1b[3J\x1b[H')
    guard.replay(data)
    guard.replay(POST_REPLAY_REATTACH_RESET)
    return
  }
  let buf = data
  const lastOn = buf.lastIndexOf(ALT_SCREEN_ON)
  const lastOff = buf.lastIndexOf(ALT_SCREEN_OFF)
  if (lastOn > lastOff) buf = buf.slice(0, lastOn)
  if (buf.length === 0) return
  guard.replay(buf)
  guard.replay('\r\n')
  guard.replay(POST_REPLAY_MODE_RESET)
}
