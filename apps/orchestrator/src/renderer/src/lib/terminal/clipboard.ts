import type { Terminal } from '@xterm/xterm'
import { chordKey } from '../shortcuts/chord-key'
import { pasteFilePaths } from './paste-file-paths'

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent)
const IS_WINDOWS = /Win/i.test(navigator.platform || navigator.userAgent)

const MODIFIER_KEYS = new Set(['Alt', 'AltGraph', 'Control', 'Meta', 'Shift'])
const INTERRUPT = '\x03'
const RESET_KITTY_KEYBOARD = '\x1b[<99u\x1b[=0u'

function isShiftEnter(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
}

function isCtrlEnter(e: KeyboardEvent): boolean {
  return e.key === 'Enter' && e.ctrlKey && !e.shiftKey && !e.metaKey && !e.altKey
}

function isCKey(e: KeyboardEvent): boolean {
  const key = chordKey(e)
  if (key) return key === 'c'
  return e.keyCode === 67
}

function isPlainCtrlC(e: KeyboardEvent): boolean {
  return isCKey(e) && e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
}

function isSingleNonAsciiPrintable(key: string): boolean {
  const chars = Array.from(key)
  if (chars.length !== 1) return false
  const codePoint = chars[0].codePointAt(0)
  return codePoint !== undefined && codePoint >= 128
}

function isCopyShortcut(e: KeyboardEvent, term: Terminal): boolean {
  if (chordKey(e) !== 'c') return false
  if (IS_MAC) return e.metaKey && !e.ctrlKey && !e.altKey && term.hasSelection()
  if (!e.ctrlKey || e.metaKey || e.altKey) return false
  if (e.shiftKey) return true
  return term.hasSelection()
}

function isPasteShortcut(e: KeyboardEvent): boolean {
  const key = chordKey(e)
  if (IS_MAC) return e.metaKey && !e.ctrlKey && !e.altKey && key === 'v'
  if (key === 'insert') return e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey
  if (key !== 'v') return false
  return e.ctrlKey && !e.metaKey && !e.altKey
}

function copySelection(term: Terminal): void {
  const selection = term.getSelection()
  if (selection) void window.api.ui.writeClipboardText(selection).catch(() => {})
}

function terminalIsConnected(term: Terminal): boolean {
  return !(term.element && !term.element.isConnected)
}

export async function pasteClipboardIntoTerminal(
  term: Terminal,
  isAlive: () => boolean = () => terminalIsConnected(term)
): Promise<void> {
  const text = await window.api.ui.readClipboardText().catch(() => '')
  if (!isAlive()) return
  if (text) {
    term.paste(text)
    return
  }
  const filePaths = await window.api.ui.readClipboardFilePaths().catch(() => [] as string[])
  if (!isAlive()) return
  if (filePaths.length) {
    pasteFilePaths(term, filePaths)
    return
  }
  const imagePath = await window.api.ui.saveClipboardImageAsTempFile().catch(() => null)
  if (!imagePath || !isAlive()) return
  term.paste(imagePath)
}

export function attachTerminalClipboard(
  term: Terminal,
  sendInput?: (data: string) => void
): () => void {
  let pendingInterruptKeyup = false
  let disposed = false

  const canPaste = (): boolean => !disposed && terminalIsConnected(term)

  const pasteClipboard = (): void => {
    void pasteClipboardIntoTerminal(term, canPaste)
  }

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' && e.type !== 'keyup') return true

    if (e.isComposing || e.keyCode === 229) return false

    if (sendInput && (isShiftEnter(e) || isCtrlEnter(e))) {
      if (e.type === 'keydown') {
        e.preventDefault()
        e.stopImmediatePropagation()
        if (isShiftEnter(e)) sendInput(IS_WINDOWS ? '\x1b\r' : '\x1b[13;2u')
        else sendInput('\x1b[13;5u')
      }
      return false
    }

    if (
      pendingInterruptKeyup &&
      e.type === 'keyup' &&
      isCKey(e) &&
      !e.metaKey &&
      !e.altKey &&
      !e.shiftKey
    ) {
      pendingInterruptKeyup = false
      return false
    }

    if (isPlainCtrlC(e) && (IS_MAC || !term.hasSelection())) {
      if (e.type === 'keydown') {
        pendingInterruptKeyup = true
        term.input(INTERRUPT)
        term.write(RESET_KITTY_KEYBOARD)
      } else {
        pendingInterruptKeyup = false
      }
      return false
    }

    if (isCopyShortcut(e, term)) {
      if (e.type === 'keydown') {
        copySelection(term)
        e.preventDefault()
        e.stopImmediatePropagation()
      }
      return false
    }

    if (MODIFIER_KEYS.has(e.key)) return false

    const platformMod = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
    if (e.defaultPrevented && platformMod) return false

    if (
      e.shiftKey &&
      !e.ctrlKey &&
      !e.metaKey &&
      !e.altKey &&
      isSingleNonAsciiPrintable(e.key)
    ) {
      return false
    }

    if (isPasteShortcut(e)) {
      if (e.type === 'keydown') {
        e.preventDefault()
        e.stopImmediatePropagation()
        pasteClipboard()
      }
      return false
    }

    return true
  })

  return () => {
    disposed = true
  }
}
