import type { Terminal } from '@xterm/xterm'
import { showDropFeedback } from '../drop-feedback'

export type Osc52ParseResult =
  | { kind: 'write'; selections: string; text: string }
  | { kind: 'query' }
  | { kind: 'invalid'; reason: string }

const MAX_OSC52_BYTES = 128 * 1024

export function parseOsc52(data: string): Osc52ParseResult {
  const semi = data.indexOf(';')
  if (semi === -1) {
    return { kind: 'invalid', reason: 'missing selection/data separator' }
  }
  const selections = data.slice(0, semi)
  const payload = data.slice(semi + 1)

  if (selections.length === 0) {
    return { kind: 'invalid', reason: 'empty selection list' }
  }
  if (!/^[cpqs0-7]+$/.test(selections)) {
    return { kind: 'invalid', reason: 'unknown selection kind' }
  }

  if (payload === '?') {
    return { kind: 'query' }
  }

  if (payload.length > MAX_OSC52_BYTES) {
    return { kind: 'invalid', reason: 'payload exceeds size limit' }
  }

  const decoded = decodeBase64Utf8(payload)
  if (decoded === null) {
    return { kind: 'invalid', reason: 'payload is not valid base64' }
  }
  return { kind: 'write', selections, text: decoded }
}

export function handleOsc52ClipboardRequest(
  data: string,
  writeClipboardText: (text: string) => Promise<unknown>
): boolean {
  const parsed = parseOsc52(data)
  if (parsed.kind !== 'write') {
    return true
  }
  void writeClipboardText(parsed.text).catch(() => {})
  return true
}

function decodeBase64Utf8(b64: string): string | null {
  const stripped = normalizeBase64Payload(b64)
  if (stripped === null) {
    return null
  }
  try {
    const binary = atob(stripped)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i)
    }
    return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  } catch {
    return null
  }
}

function normalizeBase64Payload(value: string): string | null {
  let stripped = ''
  let sawWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isWhitespaceCode(code)) {
      if (!sawWhitespace) {
        stripped = value.slice(0, index)
        sawWhitespace = true
      }
      continue
    }
    if (!isBase64Code(code)) {
      return null
    }
    if (sawWhitespace) {
      stripped += value[index]
    }
  }
  return sawWhitespace ? stripped : value
}

function isBase64Code(code: number): boolean {
  return (
    (code >= 65 && code <= 90) ||
    (code >= 97 && code <= 122) ||
    (code >= 48 && code <= 57) ||
    code === 43 ||
    code === 47 ||
    code === 61
  )
}

function isWhitespaceCode(code: number): boolean {
  return code === 32 || (code >= 9 && code <= 13)
}

export function attachOsc52Clipboard(term: Terminal, ptyId = ''): () => void {
  const handler = term.parser.registerOscHandler(52, (data) =>
    handleOsc52ClipboardRequest(data, async (text) => {
      const terminalFocused = !!term.textarea && document.activeElement === term.textarea
      const result = await window.api.ui.writeTerminalClipboard({ text, ptyId, terminalFocused })
      if (result === 'written') {
        showDropFeedback(`A terminal program copied ${text.length} character${text.length === 1 ? '' : 's'} to the clipboard`)
      }
    })
  )
  return () => handler.dispose()
}
