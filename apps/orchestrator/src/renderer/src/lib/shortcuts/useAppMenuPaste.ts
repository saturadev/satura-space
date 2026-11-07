import { useEffect } from 'react'
import { pasteClipboardIntoTerminal } from '../terminal/clipboard'
import { findTerminalContainingElement } from '../terminal/terminal-registry'
import { findFocusedMonacoEditor } from '../editor/monaco-editor-registry'

function insertIntoEditable(target: HTMLInputElement | HTMLTextAreaElement, text: string): void {
  const start = target.selectionStart ?? target.value.length
  const end = target.selectionEnd ?? target.value.length
  target.setRangeText(text, start, end, 'end')
  target.dispatchEvent(new Event('input', { bubbles: true }))
}

async function pasteIntoMonaco(
  editor: NonNullable<ReturnType<typeof findFocusedMonacoEditor>>
): Promise<void> {
  if (editor.getRawOptions().readOnly) return
  const text = await window.api.ui.readClipboardText().catch(() => '')
  if (!text || !editor.hasTextFocus()) return
  const selections = editor.getSelections()
  if (!selections || selections.length === 0) return
  editor.executeEdits(
    'clipboard-paste',
    selections.map((range) => ({ range, text, forceMoveMarkers: true }))
  )
  editor.pushUndoStop()
}

async function pasteIntoFocusedEditable(active: Element): Promise<void> {
  const editor = findFocusedMonacoEditor()
  if (editor) {
    await pasteIntoMonaco(editor)
    return
  }
  if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
    const text = await window.api.ui.readClipboardText().catch(() => '')
    if (text && document.activeElement === active) insertIntoEditable(active, text)
    return
  }
  if (active instanceof HTMLElement && active.isContentEditable) {
    const text = await window.api.ui.readClipboardText().catch(() => '')
    if (text && document.activeElement === active) {
      document.execCommand('insertText', false, text)
    }
  }
}

export function useAppMenuPaste(): void {
  useEffect(() => {
    return window.api.ui.onAppMenuPaste(() => {
      const active = document.activeElement
      const term = findTerminalContainingElement(active)
      if (term) {
        void pasteClipboardIntoTerminal(term)
        return
      }
      if (active) void pasteIntoFocusedEditable(active)
    })
  }, [])
}
