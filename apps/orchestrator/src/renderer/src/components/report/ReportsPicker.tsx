import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { ReportEntry } from '@shared/report-compile'
import { reportFallbackTitle } from '@shared/report-compile'
import { buildReportTree, type ReportNode as Node } from '@shared/report-tree'
import { useAppStore } from '../../store'
import { formatClock, formatDay, formatWhen } from '../../lib/when'
import { openFileInWorkbench } from '../../lib/editor/open-file'
import { SavedChip } from './saved-chip'

const STATUS_COLOR: Record<string, string> = {
  pass: 'bg-emerald-400',
  fail: 'bg-rose-400',
  partial: 'bg-amber-400',
  info: 'bg-sky-400'
}
export const STATUS_LABEL: Record<string, string> = { pass: 'Passed', fail: 'Failed', partial: 'Partly done', info: 'Info' }

interface Row {
  node: Node
  depth: number
  day: string | null
  group: string
  snippet?: string
}

export function titleOf(r: ReportEntry): string {
  return r.title || reportFallbackTitle(r.file)
}

function snippetOf(text: string, word: string): string {
  const at = text.toLowerCase().indexOf(word)
  if (at < 0) return ''
  const from = Math.max(0, at - 30)
  const to = Math.min(text.length, at + word.length + 60)
  return `${from > 0 ? '…' : ''}${text.slice(from, to).trim()}${to < text.length ? '…' : ''}`
}

export function matchReport(r: ReportEntry, words: string[]): { rank: number; snippet?: string } | null {
  const title = titleOf(r).toLowerCase()
  const head = `${title} ${r.name} ${r.subtitle}`.toLowerCase()
  const body = (r.text ?? '').toLowerCase()
  let rank = 0
  for (const w of words) {
    if (title.includes(w)) continue
    if (head.includes(w)) rank = Math.max(rank, 1)
    else if (body.includes(w)) rank = 2
    else return null
  }
  if (rank < 2) return { rank }
  const missing = words.find((w) => !head.includes(w)) ?? words[0]
  return { rank, snippet: snippetOf(r.text ?? '', missing) }
}

export interface ReportsPickTarget {
  workspaceId: string
  groupId: string
  worktreeId: string
  projectPath: string
}

const usePickerStore = create<{ target: ReportsPickTarget | null }>()(() => ({ target: null }))

export function openReportsPicker(target: ReportsPickTarget): void {
  usePickerStore.setState({ target })
}

export function dismissReportsPicker(): void {
  usePickerStore.setState({ target: null })
}

export function reportsPickerTarget(): ReportsPickTarget | null {
  return usePickerStore.getState().target
}

export function openPickedReport(target: ReportsPickTarget, file: string): void {
  dismissReportsPicker()
  openFileInWorkbench({
    file,
    projectPath: target.projectPath,
    workspaceId: target.workspaceId,
    worktreeId: target.worktreeId,
    sourceGroupId: target.groupId
  })
}

export function ReportsPicker(): ReactElement | null {
  const target = usePickerStore((s) => s.target)
  if (!target) return null
  return <PickerView key={target.projectPath} target={target} />
}

function PickerView({ target }: { target: ReportsPickTarget }): ReactElement {
  const [rows, setRows] = useState<ReportEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set())
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const noteReportTitles = useAppStore((s) => s.noteReportTitles)
  const openFiles = useAppStore(useShallow((s) => Object.values(s.viewerFileByTab)))

  useEffect(() => {
    let alive = true
    void window.api.app.listReports(target.projectPath).then(
      (list) => {
        if (!alive) return
        setRows(list)
        noteReportTitles(Object.fromEntries(list.filter((r) => r.title).map((r) => [r.file, r.title])))
      },
      () => alive && setRows([])
    )
    return () => {
      alive = false
    }
  }, [target.projectPath, noteReportTitles])

  useEffect(() => inputRef.current?.focus(), [])

  const tree = useMemo(() => buildReportTree(rows ?? []), [rows])

  const visible = useMemo<Row[]>(() => {
    const q = query.trim().toLowerCase()
    const out: Row[] = []
    let last = ''
    if (q) {
      const words = q.split(/\s+/).filter(Boolean)
      const hits = (rows ?? [])
        .map((r) => ({ r, m: matchReport(r, words) }))
        .filter((h): h is { r: ReportEntry; m: { rank: number; snippet?: string } } => !!h.m)
        .sort((a, b) => Number(a.m.rank > 1) - Number(b.m.rank > 1) || b.r.mtimeMs - a.r.mtimeMs)
      for (const { r, m } of hits) {
        const day = m.rank < 2 ? formatDay(r.mtimeMs) : 'Found in the report text'
        out.push({ node: { r, children: [], latest: r.mtimeMs }, depth: 0, day: day !== last ? day : null, group: day, snippet: m.snippet })
        last = day
      }
      return out
    }
    const walk = (n: Node, depth: number): void => {
      let day: string | null = null
      if (depth === 0) {
        const d = formatDay(n.latest)
        if (d !== last) day = d
        last = d
      }
      out.push({ node: n, depth, day, group: last })
      if (!collapsed.has(n.r.file)) for (const c of n.children) walk(c, depth + 1)
    }
    tree.forEach((n) => walk(n, 0))
    return out
  }, [tree, rows, query, collapsed])

  useEffect(() => setCursor(0), [query])
  useEffect(() => {
    listRef.current?.querySelector(`[data-idx="${cursor}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const open = (file: string): void => openPickedReport(target, file)
  const toggle = (file: string, close?: boolean): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (close ?? !next.has(file)) next.add(file)
      else next.delete(file)
      return next
    })

  const keyRef = useRef<(e: KeyboardEvent) => boolean>(() => false)
  keyRef.current = (e) => {
    const row = visible[cursor]
    if (e.key === 'ArrowDown') setCursor((c) => Math.min(visible.length - 1, c + 1))
    else if (e.key === 'ArrowUp') setCursor((c) => Math.max(0, c - 1))
    else if (e.key === 'ArrowRight' && !query && row?.node.children.length) toggle(row.node.r.file, false)
    else if (e.key === 'ArrowLeft' && !query && row?.node.children.length) toggle(row.node.r.file, true)
    else if (e.key === 'Enter' && row) open(row.node.r.file)
    else if (e.key === 'Escape') {
      if (query) setQuery('')
      else dismissReportsPicker()
    } else return false
    return true
  }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!keyRef.current(e)) return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const openSet = new Set(openFiles)
  return (
    <div
      className="animate-bfade-in fixed inset-0 z-[90] flex items-start justify-center bg-black/50 pt-[12vh] [-webkit-app-region:no-drag]"
      onMouseDown={dismissReportsPicker}
    >
      <div
        role="dialog"
        aria-label="Reports"
        data-reports-picker
        className="animate-menu-pop-in surface-overlay flex max-h-[70vh] w-[38rem] max-w-[92vw] origin-top flex-col overflow-hidden rounded-lg outline-none"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-4 pt-3 pb-2">
          <span className="shrink-0 text-xs text-zinc-400">Reports</span>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search"
            className="min-w-0 flex-1 rounded border border-white/10 bg-black/20 px-2 py-0.5 text-xs text-zinc-200 outline-none placeholder:text-zinc-600 focus:border-white/25"
          />
          <span className="shrink-0 text-[11px] tabular-nums text-zinc-500">
            {rows ? (query ? `${visible.length} of ${rows.length}` : rows.length) : ''}
          </span>
        </div>
        <div ref={listRef} role="listbox" className="min-h-0 flex-1 overflow-y-auto border-t border-white/10 pb-1">
          {rows === null && <p className="px-4 py-2.5 text-xs text-zinc-500">Loading reports…</p>}
          {rows !== null && !visible.length && (
            <p className="px-4 py-2.5 text-xs text-zinc-500">
              {rows.length ? 'No report matches this search' : 'No reports in .sspace/reports yet'}
            </p>
          )}
          {visible.map(({ node, depth, day, group, snippet }, i) => {
            const r = node.r
            const kids = node.children.length
            const shut = collapsed.has(r.file)
            return (
              <div key={`${r.file}:${depth}`}>
                {day && <div className="px-4 pb-1 pt-2.5 text-[10px] font-semibold uppercase tracking-wide text-zinc-500">{day}</div>}
                <div
                  role="option"
                  aria-selected={i === cursor}
                  data-idx={i}
                  data-report-row={r.file}
                  onMouseMove={() => setCursor(i)}
                  onClick={() => open(r.file)}
                  title={r.file}
                  className={`flex cursor-default items-start gap-2 py-1.5 pr-4 ${i === cursor ? 'bg-white/[0.06]' : ''}`}
                  style={{ paddingLeft: 10 + depth * 18 }}
                >
                  <span
                    className={`mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded text-zinc-500 ${kids ? 'hover:bg-white/10 hover:text-white' : ''}`}
                    onClick={(e) => {
                      if (!kids) return
                      e.stopPropagation()
                      toggle(r.file)
                    }}
                    title={kids ? (shut ? `Show ${kids} linked report${kids === 1 ? '' : 's'}` : 'Hide linked reports') : undefined}
                  >
                    {kids > 0 && (
                      <svg viewBox="0 0 24 24" className={`h-3 w-3 transition-transform ${shut ? '' : 'rotate-90'}`} fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round">
                        <path d="M9 6l6 6-6 6" />
                      </svg>
                    )}
                  </span>
                  <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${STATUS_COLOR[r.status] ?? 'bg-zinc-600'}`} title={STATUS_LABEL[r.status] ?? 'No status'} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] text-zinc-200">
                      {titleOf(r)}
                      {shut && kids > 0 && <span className="ml-2 text-[11px] text-zinc-500">+{kids}</span>}
                    </span>
                    {(r.subtitle || openSet.has(r.file)) && (
                      <span className={`block truncate text-[11px] ${openSet.has(r.file) ? 'text-sky-400/80' : 'text-zinc-500'}`}>
                        {openSet.has(r.file) ? `Open · ${r.subtitle || r.name}` : r.subtitle}
                      </span>
                    )}
                    {snippet && (
                      <span className="block truncate text-[11px] text-zinc-400" data-report-snippet>
                        {snippet}
                      </span>
                    )}
                  </span>
                  <SavedChip
                    ms={r.mtimeMs}
                    text={formatDay(r.mtimeMs) === group ? formatClock(r.mtimeMs) : formatWhen(r.mtimeMs)}
                    className="mt-0.5 shrink-0"
                    source={{ file: r.file, root: target.projectPath, load: () => window.api.app.reportInfo(r.file, target.projectPath) }}
                  />
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
