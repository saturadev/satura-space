import { useEffect } from 'react'
import { create } from 'zustand'
import type { ReportEntry } from '@shared/report-compile'
import type { Tab } from '@shared/types'

interface ReportsByRoot {
  byRoot: Record<string, ReportEntry[]>
}

export const useReportsByRoot = create<ReportsByRoot>(() => ({ byRoot: {} }))
const watched = new Map<string, number>()
const loading = new Map<string, Promise<void>>()
const again = new Set<string>()
let unsubscribe: (() => void) | null = null

export function normReportPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function refreshTerminalReports(root: string): Promise<void> {
  const busy = loading.get(root)
  if (busy) {
    again.add(root)
    return busy.then(() => (loading.get(root) ?? Promise.resolve()))
  }
  const run = window.api.app
    .listReports(root)
    .then(
      (list) => useReportsByRoot.setState((s) => ({ byRoot: { ...s.byRoot, [root]: list } })),
      () => undefined
    )
    .finally(() => {
      loading.delete(root)
      if (again.delete(root)) void refreshTerminalReports(root)
    })
  loading.set(root, run)
  return run
}

export function refreshReportsOf(file: string): Promise<void> {
  const f = normReportPath(file)
  const roots = [...watched.keys()].filter((root) => f.startsWith(`${normReportPath(root)}/`))
  return Promise.all(roots.map((r) => refreshTerminalReports(r))).then(() => undefined)
}

function onChanged(ev: { file: string }): void {
  void refreshReportsOf(ev.file)
}

function watch(root: string): () => void {
  watched.set(root, (watched.get(root) ?? 0) + 1)
  if (!unsubscribe) unsubscribe = window.api.app.onReportsChanged(onChanged)
  if (!useReportsByRoot.getState().byRoot[root]) void refreshTerminalReports(root)
  return () => {
    const n = (watched.get(root) ?? 1) - 1
    if (n > 0) {
      watched.set(root, n)
      return
    }
    watched.delete(root)
    useReportsByRoot.setState((s) => {
      const { [root]: _gone, ...rest } = s.byRoot
      return { byRoot: rest }
    })
    if (watched.size === 0 && unsubscribe) {
      unsubscribe()
      unsubscribe = null
    }
  }
}

export function useWatchReportRoots(roots: string[]): void {
  const key = roots.join('\n')
  useEffect(() => {
    const offs = roots.filter(Boolean).map((r) => watch(r))
    return () => offs.forEach((off) => off())
  }, [key])
}

export function reportsOfTab(list: ReportEntry[], tab: Pick<Tab, 'claudeSessionId'>): ReportEntry[] {
  const session = tab.claudeSessionId ?? null
  if (!session) return []
  return list.filter((r) => r.session === session).sort((a, b) => b.mtimeMs - a.mtimeMs)
}
