import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { UnityLogLine } from '@shared/api'
import { writeClipboard } from '../../lib/clipboard'

function toneOf(severity: UnityLogLine['severity']): string {
  return severity === 'error' ? 'text-rose-300' : severity === 'warn' ? 'text-amber-300' : 'text-zinc-300'
}

const FILE_REF = /([^\s():]+\.cs)(?:\((\d+),(\d+)\)|:(\d+))/g

export function renderWithLinks(
  text: string,
  onOpen: (rel: string, line: number, col: number) => void
): ReactNode {
  FILE_REF.lastIndex = 0
  if (!FILE_REF.test(text)) return text
  FILE_REF.lastIndex = 0
  const out: ReactNode[] = []
  let last = 0
  let key = 0
  let m: RegExpExecArray | null
  while ((m = FILE_REF.exec(text))) {
    const full = m[0]
    const rel = m[1]
    if (rel.startsWith('/')) continue
    const line = m[2] !== undefined ? Number(m[2]) : Number(m[4])
    const col = m[3] !== undefined ? Number(m[3]) : 1
    if (m.index > last) out.push(text.slice(last, m.index))
    out.push(
      <span
        key={key++}
        role="link"
        title={`Open ${rel}:${line}`}
        onClick={(e) => {
          e.stopPropagation()
          if (window.getSelection()?.toString()) return
          onOpen(rel, line, col)
        }}
        className="cursor-pointer text-sky-400 underline decoration-dotted underline-offset-2 hover:text-sky-300"
      >
        {full}
      </span>
    )
    last = m.index + full.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

function isExpandable(line: UnityLogLine): boolean {
  return !!line.stack || line.message.includes('\n') || line.message.length > 100
}

function entryText(line: UnityLogLine): string {
  return line.stack ? `${line.message}\n${line.stack}` : line.message
}

export function LogRow({
  line,
  count,
  pulse,
  expanded,
  onToggle,
  onOpen
}: {
  line: UnityLogLine
  count: number
  pulse: boolean
  expanded: boolean
  onToggle: () => void
  onOpen: (rel: string, line: number, col: number) => void
}) {
  const border =
    line.severity === 'error'
      ? 'border-rose-500/70'
      : line.severity === 'warn'
        ? 'border-amber-500/70'
        : 'border-transparent'
  const tone = toneOf(line.severity)
  const pulseColor =
    line.severity === 'error'
      ? 'rgba(244, 63, 94, 0.13)'
      : line.severity === 'warn'
        ? 'rgba(245, 158, 11, 0.12)'
        : 'rgba(56, 189, 248, 0.11)'
  const expandable = isExpandable(line)
  const onClick = (): void => {
    if (window.getSelection()?.toString()) return
    if (expandable) onToggle()
  }
  return (
    <div
      onClick={onClick}
      style={{ ['--pulse-color']: pulseColor } as CSSProperties}
      className={`group flex gap-2 border-l-2 px-2 ${border} hover:bg-white/[0.03] ${
        expandable ? 'cursor-pointer' : ''
      } ${pulse ? 'console-row-pulse' : ''}`}
    >
      <span className="w-12 shrink-0 select-none text-right font-mono text-[10px] leading-[18px] tabular-nums text-zinc-600">
        {line.frame >= 0 ? line.frame : ''}
      </span>
      <div className="min-w-0 flex-1 cursor-text select-text">
        {expanded ? (
          <>
            <div className={`whitespace-pre-wrap break-words font-mono text-xs leading-[18px] ${tone}`}>
              {renderWithLinks(line.message, onOpen)}
            </div>
            {line.stack && (
              <pre className="mt-0.5 mb-1 whitespace-pre-wrap break-words font-mono text-[11px] leading-snug text-zinc-500">
                {renderWithLinks(line.stack, onOpen)}
              </pre>
            )}
          </>
        ) : (
          <div className={`truncate font-mono text-xs leading-[18px] ${tone}`}>
            {line.message ? renderWithLinks(line.message, onOpen) : ' '}
          </div>
        )}
      </div>
      {count > 1 && (
        <span
          title={`${count} identical messages`}
          className="mt-px shrink-0 select-none self-start rounded-full bg-white/10 px-1.5 text-[10px] leading-4 tabular-nums text-zinc-300"
        >
          {count}
        </span>
      )}
      <CopyEntryButton text={entryText(line)} />
      {expandable && (
        <button
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
          title={expanded ? 'Collapse' : 'Expand'}
          className="shrink-0 select-none self-start font-mono text-[10px] leading-[18px] text-zinc-600 hover:text-zinc-200"
        >
          {expanded ? '▾' : '▸'}
        </button>
      )}
    </div>
  )
}

function CopyEntryButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const copy = (e: ReactMouseEvent): void => {
    e.stopPropagation()
    void writeClipboard(text)
    setCopied(true)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 1500)
  }
  return (
    <button
      onClick={copy}
      title={copied ? 'Copied' : 'Copy message + stack trace'}
      aria-label="Copy log entry"
      className={`mt-0.5 shrink-0 select-none self-start opacity-0 transition-opacity focus:opacity-100 group-hover:opacity-100 ${
        copied ? 'text-emerald-400 opacity-100' : 'text-zinc-600 hover:text-zinc-200'
      }`}
    >
      {copied ? (
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
      )}
    </button>
  )
}
