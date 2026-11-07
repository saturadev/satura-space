import { useEffect, useRef, type ReactNode } from 'react'
import type * as Monaco from 'monaco-editor'
import { X } from 'lucide-react'
import { NO_UNICODE_HIGHLIGHT, monaco } from '../monaco-setup'
import { chordKey } from '../../shortcuts/chord-key'
import type { MergeConflictCompareRequest } from './services'

const QUICK_COMMAND = 'editor.action.quickCommand'
const SEPARATOR = 'vs.actions.separator'

function isPaletteChord(e: KeyboardEvent): boolean {
  if (e.key === 'F1' || e.code === 'F1') return true
  return (e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && chordKey(e) === 'p'
}

function dropPaletteFromMenu(editor: Monaco.editor.ICodeEditor): void {
  const menu = editor.getContribution('editor.contrib.contextmenu') as unknown as {
    _getMenuActions?: (...args: unknown[]) => Array<{ id?: string }>
  } | null
  const orig = menu?._getMenuActions
  if (!menu || typeof orig !== 'function') return
  menu._getMenuActions = (...args: unknown[]) => {
    const out: Array<{ id?: string }> = []
    for (const a of orig.apply(menu, args)) {
      if (a?.id === QUICK_COMMAND) continue
      if (a?.id === SEPARATOR && (out.length === 0 || out[out.length - 1]?.id === SEPARATOR)) continue
      out.push(a)
    }
    while (out.length > 0 && out[out.length - 1]?.id === SEPARATOR) out.pop()
    return out
  }
}

let seq = 0

export function MergeConflictCompare({
  request,
  fontSize,
  onClose,
  footer,
  touch = false
}: {
  request: MergeConflictCompareRequest
  fontSize: number
  onClose: () => void
  footer?: ReactNode
  touch?: boolean
}) {
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const id = ++seq
    const uri = (side: string): Monaco.Uri =>
      monaco.Uri.from({ scheme: 'merge-conflict.conflict-diff', path: `/${side}`, query: String(id) })
    const original = monaco.editor.createModel(request.original, request.language, uri('current'))
    const modified = monaco.editor.createModel(request.modified, request.language, uri('incoming'))
    const diff = monaco.editor.createDiffEditor(host, {
      readOnly: true,
      originalEditable: false,
      ...(touch ? { renderSideBySide: false, renderOverviewRuler: false, glyphMargin: false, lineDecorationsWidth: 4 } : {}),
      minimap: { enabled: false },
      fontSize,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace',
      scrollBeyondLastLine: false,
      automaticLayout: true,
      scrollbar: { useShadows: false },
      unicodeHighlight: NO_UNICODE_HIGHLIGHT
    })
    diff.setModel({ original, modified })
    dropPaletteFromMenu(diff.getOriginalEditor())
    dropPaletteFromMenu(diff.getModifiedEditor())
    const block = (e: KeyboardEvent): void => {
      if (!isPaletteChord(e)) return
      e.preventDefault()
      e.stopImmediatePropagation()
    }
    const dom = diff.getContainerDomNode()
    dom.addEventListener('keydown', block, true)
    const target = diff.getModifiedEditor()
    target.setSelection(request.selection)
    target.revealRangeInCenter(request.selection, monaco.editor.ScrollType.Immediate)
    if (!touch) target.focus()
    return () => {
      dom.removeEventListener('keydown', block, true)
      diff.setModel(null)
      diff.dispose()
      original.dispose()
      modified.dispose()
    }
  }, [request, fontSize, touch])

  return (
    <div className="absolute inset-0 z-20 flex flex-col bg-editor-surface" data-compare-view>
      <div className={`flex shrink-0 items-center gap-2 border-b border-hairline bg-panel px-3 ${touch ? 'h-11 text-[14px]' : 'h-[30px] text-[13px]'}`}>
        <span className="min-w-0 flex-1 truncate text-ink">{request.title}</span>
        <button
          type="button"
          aria-label="Close"
          title="Close"
          onClick={onClose}
          className={`rounded text-ink-3 hover:bg-white/10 hover:text-ink ${touch ? 'p-2.5' : 'p-1'}`}
        >
          <X size={touch ? 18 : 14} />
        </button>
      </div>
      <div ref={hostRef} className="relative min-h-0 flex-1" />
      {footer}
    </div>
  )
}
