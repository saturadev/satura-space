import { useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { ReportEntry } from '@shared/report-compile'
import { reportFallbackTitle } from '@shared/report-compile'
import { buildReportTree, type ReportNode } from '@shared/report-tree'
import type { Tab } from '@shared/types'
import { useAppStore, type AppState } from '../../store'
import { toPosixPath } from '../path'
import { normReportPath, useReportsByRoot } from './terminal-reports'

export interface PlannedReport {
  file: string
  owner: string
}

export interface ReportPlan {
  byOwner: Map<string, PlannedReport[]>
  ownerOf: Map<string, string>
  parentOf: Map<string, string>
  titleOf: Map<string, string>
}

const EMPTY_PLAN: ReportPlan = { byOwner: new Map(), ownerOf: new Map(), parentOf: new Map(), titleOf: new Map() }

function orderIndex(tabs: Map<string, Tab>, owner: string | undefined, file: string): number {
  const order = owner ? tabs.get(owner)?.reportGroup?.order : undefined
  return order ? order.indexOf(file) : -1
}

export function planReportGroups(list: ReportEntry[], terminals: Tab[]): ReportPlan {
  if (list.length === 0 || terminals.length === 0) return EMPTY_PLAN
  const bySession = new Map<string, string>()
  for (const t of terminals) if (t.claudeSessionId && !bySession.has(t.claudeSessionId)) bySession.set(t.claudeSessionId, t.id)
  if (bySession.size === 0) return EMPTY_PLAN
  const tabs = new Map(terminals.map((t) => [t.id, t] as const))
  const creator = (r: ReportEntry): string | undefined => (r.session ? bySession.get(r.session) : undefined)
  const firstCreator = (n: ReportNode): string | undefined => creator(n.r) ?? n.children.map(firstCreator).find(Boolean)
  const plan: ReportPlan = { byOwner: new Map(), ownerOf: new Map(), parentOf: new Map(), titleOf: new Map() }
  const assign = (n: ReportNode, inherited: string | undefined): void => {
    plan.titleOf.set(n.r.file, n.r.title || reportFallbackTitle(n.r.file))
    for (const c of n.children) plan.parentOf.set(c.r.file, n.r.file)
    const owner = creator(n.r) ?? inherited
    if (owner) plan.ownerOf.set(n.r.file, owner)
  }
  const walk = (nodes: ReportNode[], inherited: string | undefined, top: boolean): void => {
    const owners = new Map(nodes.map((n) => [n, creator(n.r) ?? (top ? firstCreator(n) : undefined) ?? inherited] as const))
    const sorted = nodes
      .map((n, i) => ({ n, i, k: orderIndex(tabs, owners.get(n), n.r.file) }))
      .sort((a, b) => (a.k === b.k ? a.i - b.i : a.k < 0 ? -1 : b.k < 0 ? 1 : a.k - b.k))
    for (const { n } of sorted) {
      const owner = owners.get(n)
      assign(n, owner)
      if (owner) {
        const rows = plan.byOwner.get(owner) ?? []
        rows.push({ file: n.r.file, owner })
        plan.byOwner.set(owner, rows)
      }
      walk(n.children, owner, false)
    }
  }
  walk(buildReportTree(list), undefined, true)
  return plan
}

export interface SegmentView {
  tab: Tab
  file: string
  depth: number
  parentFile: string | null
  parentTabId: string | null
  trail: string[]
  childCount: number
  children: SegmentView[]
}

export function layoutSegments(owner: Tab, attached: Tab[], plan: ReportPlan, viewerFileByTab: Record<string, string>): SegmentView[] {
  const tabOfFile = new Map<string, Tab>()
  for (const t of attached) {
    const f = viewerFileByTab[t.id]
    if (f && !tabOfFile.has(toPosixPath(f))) tabOfFile.set(toPosixPath(f), t)
  }
  const planned = (plan.byOwner.get(owner.id) ?? []).filter((p) => tabOfFile.has(toPosixPath(p.file)))
  const visible = new Set(planned.map((p) => p.file))
  const nodes = new Map<string, SegmentView>()
  const roots: SegmentView[] = []
  const trailOf = (file: string): string[] => {
    const out: string[] = []
    const seen = new Set<string>()
    let cur: string | undefined = file
    while (cur && !seen.has(cur)) {
      seen.add(cur)
      out.unshift(plan.titleOf.get(cur) ?? reportFallbackTitle(cur))
      cur = plan.parentOf.get(cur)
    }
    return out
  }
  for (const p of planned) {
    let up = plan.parentOf.get(p.file)
    const seen = new Set<string>()
    while (up && !visible.has(up) && !seen.has(up)) {
      seen.add(up)
      up = plan.parentOf.get(up)
    }
    const parent = up && visible.has(up) ? nodes.get(up) : undefined
    const view: SegmentView = {
      tab: tabOfFile.get(toPosixPath(p.file)) as Tab,
      file: p.file,
      depth: parent ? parent.depth + 1 : 0,
      parentFile: parent?.file ?? null,
      parentTabId: parent?.tab.id ?? null,
      trail: trailOf(p.file),
      childCount: 0,
      children: []
    }
    nodes.set(p.file, view)
    if (parent) parent.children.push(view)
    else roots.push(view)
  }
  const used = new Set([...nodes.values()].map((v) => v.tab.id))
  for (const t of attached) {
    if (used.has(t.id)) continue
    const file = viewerFileByTab[t.id] ?? ''
    roots.push({ tab: t, file, depth: 0, parentFile: null, parentTabId: null, trail: [plan.titleOf.get(file) ?? (file ? reportFallbackTitle(file) : 'Report')], childCount: 0, children: [] })
  }
  const settle = (v: SegmentView): number => {
    const total = v.children.reduce((n, c) => n + 1 + settle(c), 0)
    v.childCount = total
    return total
  }
  roots.forEach(settle)
  return roots
}

export function flattenSegments(roots: SegmentView[]): SegmentView[] {
  const out: SegmentView[] = []
  const walk = (v: SegmentView): void => {
    out.push(v)
    v.children.forEach(walk)
  }
  roots.forEach(walk)
  return out
}

export function workspaceTerminals(s: AppState, workspaceId: string): Tab[] {
  return (s.tabsByWorkspace[workspaceId] ?? []).filter((t) => t.contentType === 'terminal')
}

export function terminalRoot(s: AppState, workspaceId: string, tab: Tab): string {
  return s.worktreesByWorkspace[workspaceId]?.find((w) => w.id === tab.worktreeId)?.path ?? ''
}

export function planForWorkspace(s: AppState, byRoot: Record<string, ReportEntry[]>, workspaceId: string): ReportPlan {
  const terminals = workspaceTerminals(s, workspaceId)
  const roots = [...new Set(terminals.map((t) => terminalRoot(s, workspaceId, t)).filter(Boolean))]
  if (roots.length === 1) return planReportGroups(byRoot[roots[0]] ?? [], terminals)
  const plan: ReportPlan = { byOwner: new Map(), ownerOf: new Map(), parentOf: new Map(), titleOf: new Map() }
  for (const root of roots) {
    const part = planReportGroups(byRoot[root] ?? [], terminals.filter((t) => terminalRoot(s, workspaceId, t) === root))
    for (const [k, v] of part.byOwner) plan.byOwner.set(k, v)
    for (const [k, v] of part.ownerOf) plan.ownerOf.set(k, v)
    for (const [k, v] of part.parentOf) plan.parentOf.set(k, v)
    for (const [k, v] of part.titleOf) plan.titleOf.set(k, v)
  }
  return plan
}

export function useReportPlan(workspaceId: string): ReportPlan {
  const byRoot = useReportsByRoot((s) => s.byRoot)
  const terminals = useAppStore(useShallow((s) => workspaceTerminals(s, workspaceId)))
  const worktrees = useAppStore((s) => s.worktreesByWorkspace[workspaceId])
  return useMemo(() => planForWorkspace(useAppStore.getState(), byRoot, workspaceId), [byRoot, terminals, worktrees, workspaceId])
}

export function currentPlan(workspaceId: string): ReportPlan {
  return planForWorkspace(useAppStore.getState(), useReportsByRoot.getState().byRoot, workspaceId)
}

export function ownerOfReport(file: string): { workspaceId: string; owner: Tab } | null {
  const s = useAppStore.getState()
  const want = normReportPath(file)
  for (const ws of s.workspaces) {
    const plan = currentPlan(ws.id)
    for (const [f, ownerId] of plan.ownerOf) {
      if (normReportPath(f) !== want) continue
      const owner = (s.tabsByWorkspace[ws.id] ?? []).find((t) => t.id === ownerId)
      if (owner) return { workspaceId: ws.id, owner }
    }
  }
  return null
}

export function openReportSegment(file: string, opts: { highlight?: boolean } = {}): boolean {
  const found = ownerOfReport(file)
  if (!found) return false
  const plan = currentPlan(found.workspaceId)
  const real = [...plan.ownerOf.keys()].find((f) => normReportPath(f) === normReportPath(file)) ?? file
  const st = useAppStore.getState()
  const closed = found.owner.reportGroup?.closed ?? []
  if (closed.includes(real)) st.setReportGroup(found.owner.id, { closed: closed.filter((f) => f !== real) })
  const tabId = st.attachReportSegment(found.owner.id, real, { activate: true })
  if (!tabId) return false
  const after = useAppStore.getState()
  if (after.activeWorkspaceId !== found.workspaceId) after.setActiveWorkspace(found.workspaceId)
  const tab = (after.tabsByWorkspace[found.workspaceId] ?? []).find((t) => t.id === tabId)
  const full = after.fullscreenGroupIdByWorkspace[found.workspaceId]
  if (tab && full && full !== tab.groupId) after.exitFullscreen(found.workspaceId)
  if (tab && opts.highlight) after.pulseAgentPane(tab.ptyId, 'opened')
  return true
}

export function syncReportSegments(workspaceId: string, plan: ReportPlan): void {
  const st = useAppStore.getState()
  const tabs = st.tabsByWorkspace[workspaceId] ?? []
  const owners = new Map(tabs.filter((t) => t.contentType === 'terminal').map((t) => [t.id, t] as const))
  for (const [ownerId, rows] of plan.byOwner) {
    const owner = owners.get(ownerId)
    if (!owner) continue
    const closed = new Set(owner.reportGroup?.closed ?? [])
    for (const r of rows) {
      if (closed.has(r.file)) continue
      useAppStore.getState().attachReportSegment(ownerId, r.file, { activate: false })
    }
  }
}

export function reorderSegment(owner: Tab, siblings: string[]): void {
  const prev = owner.reportGroup?.order ?? []
  const drop = new Set(siblings)
  useAppStore.getState().setReportGroup(owner.id, { order: [...prev.filter((f) => !drop.has(f)), ...siblings] })
}
