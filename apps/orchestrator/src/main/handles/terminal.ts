import { writePtyInput } from '../ipc/pty'
import { terminalClipboardState } from '../ipc/terminal-clipboard'
import { defineHandle, sleep } from './registry'

const KEYS: Record<string, string> = {
  enter: '\r',
  esc: '\x1b',
  'ctrl-c': '\x03',
  tab: '\t',
  up: '\x1b[A',
  down: '\x1b[B',
  click: '\x1b[<0;10;10M\x1b[<0;10;10m'
}

defineHandle({
  name: 'terminal.type',
  side: 'main',
  description:
    "Types into a terminal the way a person does, through the same input path as the desktop and phone keyboards. text is written as one chunk; keys is a list sent one at a time after it, each a key name (enter, esc, ctrl-c, tab, up, down, click for a mouse click) or literal characters like '1'. gapMs is the pause between chunks. Returns what was written.",
  params: { ptyId: '', text: '', keys: [], gapMs: 300 },
  async run(p, ctx) {
    const ptyId = String(p.ptyId ?? '').trim()
    if (!ptyId) throw new Error('Pass ptyId: agent.status and agents.attention list them.')
    const gap = Math.max(0, Number(p.gapMs ?? 300))
    const sent: string[] = []
    const text = String(p.text ?? '')
    if (text) {
      writePtyInput(ptyId, text)
      sent.push(JSON.stringify(text))
    }
    for (const key of Array.isArray(p.keys) ? p.keys : []) {
      if (sent.length) await sleep(gap, ctx.signal)
      const name = String(key)
      const data = KEYS[name.toLowerCase()] ?? name
      writePtyInput(ptyId, data)
      sent.push(name)
    }
    return { ptyId, sent }
  }
})

defineHandle({
  name: 'terminal.clipboard',
  side: 'main',
  description:
    "Lists the clipboard writes terminal programs asked for with OSC 52, oldest first: ptyId, chars, result (written, unfocused, too-large, empty) and whether the window and the terminal had focus. A write goes through only while that terminal has focus in the focused window. clear: true empties the list after reading. focus: 'focused' or 'blurred' makes the window check treat the window as focused or not, for testing without stealing focus; 'real' goes back to the real window focus. Returns { focus, maxChars, records }.",
  params: { clear: false, focus: '' },
  async run(p) {
    return terminalClipboardState({ clear: p.clear === true, focus: String(p.focus ?? '') })
  }
})
