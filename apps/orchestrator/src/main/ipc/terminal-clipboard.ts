export const MAX_TERMINAL_CLIPBOARD_CHARS = 96 * 1024

export type TerminalClipboardResult = 'written' | 'unfocused' | 'too-large' | 'empty'

export interface TerminalClipboardRecord {
  at: number
  ptyId: string
  chars: number
  result: TerminalClipboardResult
  windowFocused: boolean
  terminalFocused: boolean
}

const MAX_RECORDS = 50
const records: TerminalClipboardRecord[] = []
let focusOverride: 'focused' | 'blurred' | null = null

export function terminalClipboardVerdict(
  text: unknown,
  windowFocused: boolean,
  terminalFocused: boolean
): TerminalClipboardResult {
  if (typeof text !== 'string' || !text) return 'empty'
  if (text.length > MAX_TERMINAL_CLIPBOARD_CHARS) return 'too-large'
  const win = focusOverride ? focusOverride === 'focused' : windowFocused
  return win && terminalFocused ? 'written' : 'unfocused'
}

export function noteTerminalClipboard(record: TerminalClipboardRecord): void {
  records.push(record)
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS)
}

export function terminalClipboardState(opts: { clear?: boolean; focus?: string }): {
  focus: string
  maxChars: number
  records: TerminalClipboardRecord[]
} {
  if (opts.focus === 'focused' || opts.focus === 'blurred') focusOverride = opts.focus
  else if (opts.focus === 'real') focusOverride = null
  const out = records.slice()
  if (opts.clear) records.length = 0
  return { focus: focusOverride ?? 'real', maxChars: MAX_TERMINAL_CLIPBOARD_CHARS, records: out }
}
