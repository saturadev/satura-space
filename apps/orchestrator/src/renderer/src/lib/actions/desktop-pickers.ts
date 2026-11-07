import type { ReportEntry } from '@shared/report-compile'
import { useAppStore } from '../../store'
import { dismissClaudePicker, pickClaudeSession, useClaudePickerStore } from '../claude-sessions/launch-restore'
import { STATUS_LABEL, dismissReportsPicker, matchReport, openPickedReport, reportsPickerTarget, titleOf } from '../../components/report/ReportsPicker'
import { rankQuickOpenFiles } from '../quick-open/quick-open-search'
import { openFileFromExplorer } from '../editor/open-file-from-explorer'
import { formatClock, formatDay } from '../when'

export type PickerKind = 'claude' | 'reports' | 'quickOpen'

export interface WirePickerItem {
  id: string
  label: string
  detail?: string
  icon?: string
  badge?: string
}

export interface WirePicker {
  kind: PickerKind
  title: string
  placeholder: string
  loading: boolean
  empty: string
  sections: { title: string; items: WirePickerItem[] }[]
}

export function openPickerKind(): PickerKind | null {
  if (useClaudePickerStore.getState().picker) return 'claude'
  if (reportsPickerTarget()) return 'reports'
  if (useAppStore.getState().quickOpen) return 'quickOpen'
  return null
}

const listCache = new Map<string, { at: number; value: Promise<unknown> }>()

function cached<T>(key: string, load: () => Promise<T>): Promise<T> {
  const hit = listCache.get(key)
  if (hit && Date.now() - hit.at < 10_000) return hit.value as Promise<T>
  const value = load()
  listCache.set(key, { at: Date.now(), value })
  value.catch(() => listCache.delete(key))
  return value
}

function bySection<T>(rows: T[], title: (r: T) => string, item: (r: T) => WirePickerItem): WirePicker['sections'] {
  const out: WirePicker['sections'] = []
  for (const r of rows) {
    const t = title(r)
    let sec = out[out.length - 1]
    if (!sec || sec.title !== t) out.push((sec = { title: t, items: [] }))
    sec.items.push(item(r))
  }
  return out
}

function words(query: string): string[] {
  return query.trim().toLowerCase().split(/\s+/).filter(Boolean)
}

export async function pickerData(kind: PickerKind, query: string): Promise<WirePicker> {
  if (kind === 'claude') {
    const picker = useClaudePickerStore.getState().picker
    if (!picker) throw new Error('That list closed')
    const w = words(query)
    const rows = picker.rows.filter((r) => w.every((x) => `${r.title} ${r.hint}`.toLowerCase().includes(x)))
    return {
      kind,
      title: 'Resume Claude session',
      placeholder: 'Search sessions',
      loading: picker.loading,
      empty: query ? 'No sessions match' : 'No Claude sessions for this project yet',
      sections: bySection(
        rows,
        (r) => (r.open ? 'Open in a tab' : formatDay(r.updatedAt)),
        (r) => ({ id: r.sessionId, label: r.title || 'Untitled session', detail: [r.hint, formatClock(r.updatedAt)].filter(Boolean).join(' · '), icon: r.open ? 'rectangle.stack' : 'clock.arrow.circlepath' })
      )
    }
  }
  if (kind === 'reports') {
    const target = reportsPickerTarget()
    if (!target) throw new Error('That list closed')
    const list = await cached(`reports:${target.projectPath}`, () => window.api.app.listReports(target.projectPath))
    const w = words(query)
    const hits = (w.length ? list.map((r) => ({ r, m: matchReport(r, w) })).filter((h) => !!h.m) : list.map((r) => ({ r, m: null })))
      .sort((a, b) => b.r.mtimeMs - a.r.mtimeMs) as { r: ReportEntry; m: { snippet?: string } | null }[]
    return {
      kind,
      title: 'Reports',
      placeholder: 'Search reports',
      loading: false,
      empty: query ? 'No reports match' : 'No reports in this project yet',
      sections: bySection(
        hits,
        (h) => formatDay(h.r.mtimeMs),
        (h) => ({
          id: h.r.file,
          label: titleOf(h.r),
          detail: h.m?.snippet || [h.r.subtitle, formatClock(h.r.mtimeMs)].filter(Boolean).join(' · '),
          icon: 'doc.richtext',
          badge: STATUS_LABEL[h.r.status]
        })
      )
    }
  }
  const target = useAppStore.getState().quickOpen
  if (!target) throw new Error('That list closed')
  const files = await cached(`files:${target.rootPath}`, () => window.api.fs.listFiles(target.rootPath))
  const ranked = rankQuickOpenFiles(query, files)
  return {
    kind,
    title: 'Quick Open',
    placeholder: 'Search files by name',
    loading: false,
    empty: query ? 'No files match' : 'This folder has no files',
    sections: [
      {
        title: query ? 'Matching files' : 'Files',
        items: ranked.map((rel) => {
          const slash = rel.lastIndexOf('/')
          return { id: rel, label: slash < 0 ? rel : rel.slice(slash + 1), detail: slash < 0 ? '' : rel.slice(0, slash), icon: 'doc' }
        })
      }
    ]
  }
}

export function pickerPick(kind: PickerKind, id: string): void {
  if (openPickerKind() !== kind) throw new Error('That list closed')
  if (kind === 'claude') {
    pickClaudeSession(id)
    return
  }
  if (kind === 'reports') {
    const target = reportsPickerTarget()
    if (target) openPickedReport(target, id)
    return
  }
  const s = useAppStore.getState()
  const target = s.quickOpen
  if (!target) return
  openFileFromExplorer(target.workspaceId, target.worktreeId, target.groupId, target.rootPath ? `${target.rootPath}/${id}` : id, { preview: false })
  s.closeQuickOpen()
}

export function pickerDismiss(kind: PickerKind): void {
  if (kind === 'claude') dismissClaudePicker()
  else if (kind === 'reports') dismissReportsPicker()
  else if (useAppStore.getState().quickOpen) useAppStore.getState().closeQuickOpen()
}
