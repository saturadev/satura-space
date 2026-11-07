import { useEffect, useMemo, useState, type ReactNode } from 'react'
import type * as Monaco from 'monaco-editor'
import type { BlameRange } from '@shared/api'
import { blameAgeBucket, formatBlameColumn, formatBlameCompact } from '../../lib/editor/blame-format'
import { relativeTimeLong } from '../../lib/relative-time'
import { isMobileLayout } from '../../lib/mobile/mobile-back'

const OVERSCAN = 8
const WIDTH = 256
const COMPACT_WIDTH = 58

const PASTEL = [
  'rgba(74, 222, 128, 0.16)',
  'rgba(163, 230, 53, 0.16)',
  'rgba(217, 230, 53, 0.16)',
  'rgba(250, 204, 21, 0.16)',
  'rgba(251, 191, 36, 0.17)',
  'rgba(251, 146, 60, 0.18)',
  'rgba(248, 113, 113, 0.19)',
  'rgba(239, 68, 68, 0.22)'
]
const UNCOMMITTED_BG = 'rgba(148, 163, 184, 0.1)'

function tooltip(range: BlameRange): string {
  if (range.uncommitted) return 'Not committed yet'
  return `${range.author || 'Unknown'} • ${relativeTimeLong(range.dateMs)}\n${range.summary}\n${range.hash.slice(0, 8)}\n(click to copy commit hash)`
}

export function BlameGutter({
  editor,
  monaco,
  ranges,
  fontSize,
  onContextMenu,
  onPick,
  picked
}: {
  editor: Monaco.editor.IStandaloneCodeEditor
  monaco: typeof Monaco
  ranges: BlameRange[]
  fontSize: number
  onContextMenu?: (x: number, y: number, line: number, range?: BlameRange) => void
  onPick?: (range: BlameRange, line: number) => void
  picked?: BlameRange | null
}) {
  const compact = isMobileLayout() && !!onPick
  const [scrollTop, setScrollTop] = useState(() => editor.getScrollTop())
  const [height, setHeight] = useState(() => editor.getLayoutInfo().height)
  const [sel, setSel] = useState<{ start: number; end: number }>(() => {
    const s = editor.getSelection()
    return s ? { start: s.startLineNumber, end: s.endLineNumber } : { start: 0, end: 0 }
  })
  const [copied, setCopied] = useState<string | null>(null)
  const [, force] = useState(0)

  useEffect(() => {
    const subs = [
      editor.onDidScrollChange((e) => setScrollTop(e.scrollTop)),
      editor.onDidLayoutChange((info) => setHeight(info.height)),
      editor.onDidChangeCursorSelection((e) =>
        setSel({ start: e.selection.startLineNumber, end: e.selection.endLineNumber })
      ),
      editor.onDidChangeConfiguration(() => force((n) => n + 1)),
      editor.onDidChangeModelContent(() => force((n) => n + 1))
    ]
    setScrollTop(editor.getScrollTop())
    setHeight(editor.getLayoutInfo().height)
    return () => subs.forEach((s) => s.dispose())
  }, [editor])

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 1300)
    return () => clearTimeout(t)
  }, [copied])

  const { byLine, oldest, newest } = useMemo(() => {
    const byLine = new Map<number, { range: BlameRange; first: boolean }>()
    let oldest = Infinity
    let newest = -Infinity
    for (const r of ranges) {
      if (!r.uncommitted) {
        if (r.dateMs < oldest) oldest = r.dateMs
        if (r.dateMs > newest) newest = r.dateMs
      }
      for (let l = r.startLine; l <= r.endLine; l++) byLine.set(l, { range: r, first: l === r.startLine })
    }
    return { byLine, oldest, newest }
  }, [ranges])

  const model = editor.getModel()
  const lineCount = model ? model.getLineCount() : 0
  const lineHeight = editor.getOption(monaco.editor.EditorOption.lineHeight)
  const paddingTop = editor.getTopForLineNumber(1)

  const start = Math.max(1, Math.floor((scrollTop - paddingTop) / lineHeight) + 1 - OVERSCAN)
  const end = Math.min(lineCount, Math.ceil((scrollTop + height - paddingTop) / lineHeight) + OVERSCAN)

  const copyHash = (hash: string): void => {
    void window.api.ui.writeClipboardText(hash)
    setCopied(hash)
  }

  const rows: ReactNode[] = []
  for (let line = start; line <= end; line++) {
    const info = byLine.get(line)
    const top = editor.getTopForLineNumber(line) - scrollTop
    const range = info?.range
    const committed = !!range && !range.uncommitted
    const selected = compact
      ? !!range && range === picked
      : !!range && sel.start > 0 && range.startLine <= sel.end && range.endLine >= sel.start
    const bg = range
      ? range.uncommitted
        ? UNCOMMITTED_BG
        : PASTEL[blameAgeBucket(range.dateMs, oldest, newest)]
      : 'transparent'
    rows.push(
      <div
        key={line}
        className={`ss-blame-row${selected ? ' ss-blame-row-selected' : ''}`}
        title={range && !compact ? tooltip(range) : undefined}
        onClick={compact && range ? () => onPick?.(range, line) : committed ? () => copyHash(range.hash) : undefined}
        data-blame-line={line}
        onContextMenu={(e) => {
          e.preventDefault()
          e.stopPropagation()
          onContextMenu?.(e.clientX, e.clientY, line, range)
        }}
        style={{
          top,
          height: lineHeight,
          lineHeight: `${lineHeight}px`,
          background: bg,
          cursor: committed || compact ? 'pointer' : 'default'
        }}
      >
        {info && info.first ? (compact ? formatBlameCompact(info.range) : formatBlameColumn(info.range)) : ''}
      </div>
    )
  }

  return (
    <div
      className={`ss-blame-gutter${compact ? ' ss-blame-compact' : ''}`}
      onContextMenu={(e) => {
        e.preventDefault()
        onContextMenu?.(e.clientX, e.clientY, Math.max(1, lineCount))
      }}
      style={{
        width: compact ? COMPACT_WIDTH : WIDTH,
        fontSize: compact ? Math.min(fontSize, 11) : fontSize,
        fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, monospace'
      }}
    >
      {rows}
      {copied && <div className="ss-blame-copied">Copied {copied.slice(0, 7)}</div>}
    </div>
  )
}

export function BlameSheet({ range, onClose, onShowCommit }: { range: BlameRange; onClose: () => void; onShowCommit?: (hash: string) => void }) {
  const [copied, setCopied] = useState('')
  const copy = (what: string, text: string): void => {
    void window.api.ui.writeClipboardText(text)
    setCopied(what)
  }
  const button = 'flex h-12 min-w-0 flex-1 items-center justify-center rounded-[10px] bg-elevated px-2 text-[14px] font-medium text-ink active:opacity-70'
  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end" data-blame-sheet={range.uncommitted ? 'uncommitted' : range.hash.slice(0, 7)}>
      <button type="button" aria-label="Close" className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative rounded-t-[14px] border-t border-hairline bg-panel px-4 pb-4 pt-3 shadow-[0_-12px_32px_rgb(0_0_0/0.45)]">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1 pt-1">
            <div className="line-clamp-3 text-[15px] font-semibold leading-snug text-ink">{range.uncommitted ? 'Not committed yet' : range.summary || 'No commit message'}</div>
            <div className="mt-1 text-[13px] text-ink-2">{range.uncommitted ? 'These lines changed since the last commit.' : `${range.author || 'Unknown'} · ${relativeTimeLong(range.dateMs)}`}</div>
            <div className="mt-0.5 text-[12px] text-ink-3">
              {range.uncommitted ? '' : `${new Date(range.dateMs).toLocaleString()} · `}
              {!range.uncommitted && <span className="font-mono">{range.hash.slice(0, 10)}</span>}
              {range.uncommitted ? '' : ' · '}
              {range.startLine === range.endLine ? `line ${range.startLine}` : `lines ${range.startLine}–${range.endLine}`}
            </div>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="-mr-2 -mt-1 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[20px] leading-none text-ink-3 active:bg-elevated">
            ×
          </button>
        </div>
        {!range.uncommitted && (
          <div className="mt-3 flex gap-2">
            <button type="button" className={button} onClick={() => copy('hash', range.hash)} data-blame-copy="hash">
              {copied === 'hash' ? 'Copied' : 'Copy hash'}
            </button>
            <button type="button" className={button} onClick={() => copy('message', range.summary)} data-blame-copy="message">
              {copied === 'message' ? 'Copied' : 'Copy message'}
            </button>
            {onShowCommit && (
              <button
                type="button"
                className={button}
                onClick={() => {
                  onClose()
                  onShowCommit(range.hash)
                }}
                data-blame-show
              >
                Show in Git
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
