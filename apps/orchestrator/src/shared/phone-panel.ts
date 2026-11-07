import type { WorkspaceState } from './api'
import type { RemotePresence } from './remote-protocol'
import type { Tab, TabGroupLayoutNode } from './types'
import { TAB_KIND } from './tab-ref'

export type PhoneScreen = 'projects' | 'layout' | 'panel' | 'files'

export const PHONE_SCREENS: readonly PhoneScreen[] = ['projects', 'layout', 'panel', 'files']

export interface PhonePanelReport {
  device?: string
  visible?: boolean
  workspaceId?: string | null
  screen?: PhoneScreen
  tabId?: string | null
  label?: string
  kind?: string
  page?: string
  seq?: number
}

export interface PhoneShowTarget {
  workspaceId: string
  tabId: string | null
}

export interface PhonePanelTab {
  id: string
  label: string
  kind: string
  pane: number | null
  onMac: boolean
  closed?: true
}

export interface PhonePanel {
  connected: boolean
  device: string | null
  visible: boolean
  screen: PhoneScreen | null
  workspace: { id: string; name: string } | null
  tab: PhonePanelTab | null
  changedAt: number | null
  heardMs: number | null
  stale: boolean
  pending: PhoneShowTarget | null
}

interface Seen {
  device: string
  visible: boolean
  workspaceId: string | null
  screen: PhoneScreen
  tabId: string | null
  label: string
  kind: string
}

interface Slot {
  cid: string
  device: string
  connectedAt: number
  heardAt: number
  changedAt: number
  page: string
  seq: number
  seen: Seen | null
  staleNoted: boolean
}

export const PHONE_PANEL_TTL_MS = 25_000
export const PHONE_SHOW_WINDOW_MS = 60_000
const RESEND_GAP_MS = 2500

function clean(r: PhonePanelReport, device: string): Seen {
  const screen = r.screen && PHONE_SCREENS.includes(r.screen) ? r.screen : r.tabId ? 'panel' : r.workspaceId ? 'layout' : 'projects'
  const workspaceId = typeof r.workspaceId === 'string' && r.workspaceId ? r.workspaceId : null
  const tabId = screen === 'panel' && typeof r.tabId === 'string' && r.tabId ? r.tabId : null
  return {
    device: String(r.device || device || 'phone').slice(0, 60),
    visible: r.visible !== false,
    workspaceId: screen === 'projects' ? null : workspaceId,
    screen,
    tabId,
    label: tabId ? String(r.label ?? '').slice(0, 120) : '',
    kind: tabId ? String(r.kind ?? '').slice(0, 40) : ''
  }
}

function same(a: Seen | null, b: Seen | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

function groupOrder(node: TabGroupLayoutNode | undefined, out: string[] = []): string[] {
  if (!node) return out
  if (node.type === 'leaf') out.push(node.groupId)
  else {
    groupOrder(node.first, out)
    groupOrder(node.second, out)
  }
  return out
}

function macFocusedTab(ws: WorkspaceState, workspaceId: string): Tab | undefined {
  const tabs = ws.tabsByWorkspace[workspaceId] ?? []
  const groups = ws.groupsByWorkspace[workspaceId] ?? []
  const group = groups.find((g) => g.id === ws.activeGroupIdByWorkspace[workspaceId]) ?? groups[0]
  if (!group) return tabs[0]
  const own = group.tabOrder.map((id) => tabs.find((t) => t.id === id)).filter((t): t is Tab => !!t)
  return own.find((t) => t.id === group.activeTabId) ?? own[0]
}

function macLabel(tab: Tab): string {
  return tab.customLabel || tab.generatedLabel || tab.label
}

export function showTargetMet(seen: Pick<Seen, 'workspaceId' | 'screen' | 'tabId'> | null, want: PhoneShowTarget): boolean {
  return !!seen && seen.workspaceId === want.workspaceId && seen.screen === 'panel' && (want.tabId === null || seen.tabId === want.tabId)
}

export function describePhonePanel(p: PhonePanel): string {
  if (!p.connected) return 'no phone connected'
  const who = p.device ?? 'the phone'
  const where = p.workspace ? ` in ${p.workspace.name}` : ''
  const what =
    p.screen === null
      ? 'connected, nothing reported yet'
      : p.screen === 'projects'
        ? 'shows the project list'
        : p.screen === 'layout'
          ? `shows the panel list${where}`
          : p.screen === 'files'
            ? `shows the file browser${where}`
            : p.tab
              ? `shows ${p.tab.label || p.tab.kind} (${p.tab.kind}, tab ${p.tab.id.slice(0, 8)})${where}${p.tab.closed ? ', a tab the desktop closed' : ''}`
              : `shows an empty workspace${where}`
  if (p.screen === null) return `${who} ${what}`
  const state = p.stale ? ', not heard from lately' : p.visible ? ', in the foreground' : ', in the background'
  return `${who} ${what}${state}`
}

export class PhonePanelTracker {
  private slots = new Map<string, Slot>()
  private current: string | null = null
  private want: (PhoneShowTarget & { until: number; sentAt: number }) | null = null

  constructor(
    private readonly ttlMs = PHONE_PANEL_TTL_MS,
    private readonly showWindowMs = PHONE_SHOW_WINDOW_MS
  ) {}

  connect(cid: string, device: string, now: number): void {
    this.slots.set(cid, { cid, device, connectedAt: now, heardAt: 0, changedAt: now, page: '', seq: -1, seen: null, staleNoted: false })
    this.current = cid
  }

  leave(cid: string): boolean {
    if (!this.slots.delete(cid)) return false
    if (this.current !== cid) return false
    let next: Slot | null = null
    for (const s of this.slots.values()) if (!next || s.connectedAt > next.connectedAt) next = s
    this.current = next?.cid ?? null
    return true
  }

  clear(): boolean {
    const had = this.slots.size > 0
    this.slots.clear()
    this.current = null
    return had
  }

  currentCid(): string | null {
    return this.current
  }

  report(cid: string, raw: PhonePanelReport, now: number): { changed: boolean; resend: PhoneShowTarget | null } {
    const slot = this.slots.get(cid)
    if (!slot) return { changed: false, resend: null }
    const page = typeof raw.page === 'string' ? raw.page.slice(0, 40) : ''
    const seq = typeof raw.seq === 'number' && Number.isFinite(raw.seq) ? raw.seq : -1
    if (page && page === slot.page && seq >= 0 && seq <= slot.seq) return { changed: false, resend: null }
    slot.page = page
    slot.seq = seq
    const wasStale = this.isStale(slot, now) || slot.staleNoted
    slot.staleNoted = false
    slot.heardAt = now
    const seen = clean(raw, slot.device)
    slot.device = seen.device
    const changed = !same(slot.seen, seen) || wasStale
    if (changed) slot.changedAt = now
    slot.seen = seen
    let resend: PhoneShowTarget | null = null
    const want = this.want
    if (want && cid === this.current) {
      if (now > want.until || showTargetMet(seen, want)) this.want = null
      else if (seen.visible && now - want.sentAt >= RESEND_GAP_MS) {
        want.sentAt = now
        resend = { workspaceId: want.workspaceId, tabId: want.tabId }
      }
    }
    return { changed: changed && cid === this.current, resend }
  }

  expect(target: PhoneShowTarget, now: number): void {
    this.want = { ...target, until: now + this.showWindowMs, sentAt: now }
  }

  dropExpected(): void {
    this.want = null
  }

  shows(target: PhoneShowTarget): boolean {
    const slot = this.current ? this.slots.get(this.current) : undefined
    return showTargetMet(slot?.seen ?? null, target)
  }

  sweep(now: number): boolean {
    let changed = false
    for (const s of this.slots.values()) {
      if (s.staleNoted || !this.isStale(s, now)) continue
      s.staleNoted = true
      s.changedAt = now
      if (s.cid === this.current) changed = true
    }
    if (this.want && now > this.want.until) this.want = null
    return changed
  }

  hasReports(): boolean {
    for (const s of this.slots.values()) if (s.seen) return true
    return false
  }

  private isStale(slot: Slot, now: number): boolean {
    return slot.heardAt > 0 && now - slot.heardAt > this.ttlMs
  }

  view(ws: WorkspaceState | null | undefined, now: number): PhonePanel {
    const slot = this.current ? this.slots.get(this.current) : undefined
    const want = this.want && now <= this.want.until ? { workspaceId: this.want.workspaceId, tabId: this.want.tabId } : null
    if (!slot) return { connected: false, device: null, visible: false, screen: null, workspace: null, tab: null, changedAt: null, heardMs: null, stale: false, pending: null }
    const seen = slot.seen
    const stale = this.isStale(slot, now)
    const heardMs = slot.heardAt ? now - slot.heardAt : null
    if (!seen) return { connected: true, device: slot.device, visible: false, screen: null, workspace: null, tab: null, changedAt: slot.changedAt, heardMs, stale, pending: want }
    const wsId = seen.workspaceId ?? (seen.tabId && ws ? Object.keys(ws.tabsByWorkspace).find((k) => ws.tabsByWorkspace[k]?.some((t) => t.id === seen.tabId)) ?? null : null)
    const wsRow = wsId ? ws?.workspaces.find((w) => w.id === wsId) : undefined
    const workspace = wsId ? { id: wsId, name: wsRow?.name || wsId } : null
    let tab: PhonePanelTab | null = null
    if (seen.tabId) {
      const macTab = wsId ? (ws?.tabsByWorkspace[wsId] ?? []).find((t) => t.id === seen.tabId) : undefined
      if (macTab && wsId && ws) {
        const order = groupOrder(ws.layoutByWorkspace[wsId])
        const at = order.indexOf(macTab.groupId)
        tab = { id: macTab.id, label: seen.label || macLabel(macTab), kind: seen.kind || TAB_KIND[macTab.contentType] || macTab.contentType, pane: at >= 0 ? at + 1 : null, onMac: macFocusedTab(ws, wsId)?.id === macTab.id }
      } else tab = { id: seen.tabId, label: seen.label, kind: seen.kind, pane: null, onMac: false, ...(ws ? { closed: true as const } : {}) }
    }
    return {
      connected: true,
      device: seen.device,
      visible: seen.visible && !stale,
      screen: seen.screen,
      workspace,
      tab,
      changedAt: slot.changedAt,
      heardMs,
      stale,
      pending: want
    }
  }

  presence(now: number): RemotePresence[] {
    const slot = this.current ? this.slots.get(this.current) : undefined
    const seen = slot?.seen
    if (!slot || !seen || !seen.visible || seen.screen !== 'panel' || !seen.tabId || this.isStale(slot, now)) return []
    return [{ tabId: seen.tabId, device: seen.device }]
  }
}
