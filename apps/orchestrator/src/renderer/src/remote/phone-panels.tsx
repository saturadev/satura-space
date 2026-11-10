import { Suspense, lazy, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type { Tab, TabContentType } from '@shared/types'
import type { ActivityEntry } from '@shared/remote-push'
import { useAppStore, type AppState } from '../store'
import { RemoteTerminalSession, pinchTerminal } from './RemoteTerminalSession'
import { PaneTerminalSlot } from '../components/workbench/PaneTerminalSlot'
import { PaneFileViewerSlot } from '../components/workbench/PaneFileViewerSlot'
import { PaneErrorBoundary } from '../components/workbench/PaneErrorBoundary'
import { TargetedToolPane } from '../components/scratchpad/TargetedToolPane'
import { PaneDashboardSlot } from '../components/dashboard/PaneDashboardSlot'
import { setDashboardAlerts } from '../lib/dashboard/alerts-store'
import { PaneScratchpadSlot } from '../components/scratchpad/PaneScratchpadSlot'
import { getTerminalInstance } from '../lib/terminal/terminal-registry'
import { collectGroupIds, shownTab } from '../lib/tab-tree'
import { tabDisplayLabel } from '../lib/tab-label'
import { pathBasename, workspaceTitle } from '../lib/path'
import { agentRunStatusFor, detectAgentStatusFromTitle, stripAgentStatusGlyph, type AgentRunStatus } from '../lib/agent-status'
import { canGoBackInPanel, goBackInPanel, onPanelBackChange, panelBackTitles } from '../lib/mobile/mobile-back'
import { setViewerZoom, viewerZoom } from '../lib/mobile/viewer-zoom'
import { phoneScales, setPhoneScale, setPhoneScaleRoot } from '../lib/mobile/phone-scales'
import { terminalLinkAt, type TerminalLinkHit } from '../lib/terminal/terminal-file-links'
import { refloat } from '../lib/floating'
import { resolveTerminalPath } from '../lib/terminal/terminal-file-paths'
import { relativePath } from '../lib/file-explorer/copy-paths'
import { findScmRoot } from '../lib/git/scm-root'
import { openFileInWorkbench } from '../lib/editor/open-file'
import { requestGoto } from '../lib/editor/goto-line'
import { postGitHistoryRequest } from '../lib/git/history-request'
import { GIT_TAB_LABEL } from '../lib/tab-label'
import { hydrating, invokeRemote, onDrive, retry, wsTransport } from './ws-transport'
import type { PhonePanelReport, PhoneScreen, PhoneShowTarget } from '@shared/phone-panel'
import { TAB_KIND } from '@shared/tab-ref'
import { setPhoneDevice } from '../lib/remote/phone-panel'
import { runMirrored } from './mirror'
import { exposeToShell, postToShell } from './shell-bus'
import { keySequence } from './keys'
import { RemoteVideo } from './video/RemoteVideo'
import type { GamePlay } from './game-input/GameInput'
import { StoppedView, UnityStateNote, editorBusyLabel } from '../components/workbench/PaneUnitySlot'
import { useEffectiveLifecycle, useInstance } from '../lib/unity/world-store'
import { useUnityLifecycle } from '../lib/unity/lifecycle-store'
import { stateLabel } from '@shared/unity/lifecycle'
import { UnityStateCard } from '../components/workbench/UnityStateCard'
import { UnityDialogCard } from '../components/workbench/UnityDialogCard'
import { NoCameraCard } from '../components/workbench/NoCameraCard'
import { UnityHubBlockedView } from '../components/workbench/UnityHubGate'
import { usePickedPlayer } from './video/player-pick'
import { PlayerPicker } from './video/PlayerPicker'
import { RemoteTuner } from './tuner/RemoteTuner'
import { tunerActions, type PhoneAction } from './tuner/actions'
import { RemoteLayout } from './layout/RemoteLayout'
import { macOrder, macShownTab, useMacOrderVersion } from './layout/mac-order'
import { menuItemAtRow, scanTerminal, type MenuOption, type TerminalScan } from './terminal-menu'
import { findClaudeInput, pasteImagePaths } from './claude-input'
import { installTerminalTouch } from './terminal-touch'
import { revealTyping, typingPane } from './tuner/typing-pane'
import { leafIds, panelActions, runAction, usePanelActions } from '../lib/actions/action-tree'
import { splitPhoneMenus } from './phone-menu-policy'
import { Presence, navigate } from './motion'
import { UnityIdleCard, UnityLoadingCard, isUnityLoading } from './unity-card'
import { UnityActionsHost, desktopCall, installPhoneActions, logActionTree, usePhonePanelActions, useRefreshOnSelect } from './phone-actions'
import { heldTabId, isHeldTab, useRestorePrompts } from './restore-prompts'
import { RestorePromptCard } from './restore-card'

const PhoneGit = lazy(() => import('./git/PhoneGit').then((m) => ({ default: m.PhoneGit })))

type Dot = 'work' | 'wait' | 'ok' | 'err' | 'off'
type PanelKind = 'terminal' | 'console' | 'git' | 'viewer' | 'scratchpads' | 'unity' | 'tuner' | 'dashboard' | 'layout'

const KIND_OF: Record<TabContentType, PanelKind> = {
  terminal: 'terminal',
  'unity-instance-player': 'unity',
  'unity-console': 'console',
  'file-viewer': 'viewer',
  tuner: 'tuner',
  'unity-scratchpad': 'scratchpads',
  'git-scm': 'git',
  dashboard: 'dashboard'
}

const STATUS_DOT: Record<AgentRunStatus, Dot> = { working: 'work', 'needs-input': 'wait', idle: 'ok' }
const STATUS_WORD: Record<AgentRunStatus, string> = { working: 'working', 'needs-input': 'needs you', idle: 'idle' }

let panelRoot: HTMLElement | null = null
let cornerRadius = 0
let cornerTimer = 0

function outsideArc(x: number, y: number, w: number, h: number, r: number): boolean {
  const cx = x < r ? r : x > w - r ? w - r : null
  const cy = y < r ? r : y > h - r ? h - r : null
  if (cx == null || cy == null) return false
  return Math.hypot(x - cx, y - cy) > r + 0.5
}

const CORNER_TARGETS = 'button, a, input, textarea, select, [role="button"], [data-ti-prop], [data-tuner-unsaved]'

export function checkCorners(why: string, always = false): number {
  const r = cornerRadius
  const w = window.innerWidth
  const h = window.innerHeight
  if (r <= 0) return 0
  const hits: string[] = []
  const seen = new Set<Element>()
  const consider = (el: Element): void => {
    if (seen.has(el)) return
    seen.add(el)
    const b = el.getBoundingClientRect()
    if (b.width < 1 || b.height < 1 || b.right < 0 || b.bottom < 0 || b.left > w || b.top > h) return
    const style = getComputedStyle(el)
    if (style.visibility === 'hidden' || style.display === 'none') return
    const left = Math.max(0, b.left)
    const top = Math.max(0, b.top)
    const right = Math.min(w, b.right)
    const bottom = Math.min(h, b.bottom)
    const pts: [number, number][] = [[left, top], [right, top], [left, bottom], [right, bottom]]
    if (pts.some(([x, y]) => outsideArc(x, y, w, h, r))) {
      const label = (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().replace(/\s+/g, ' ').slice(0, 30)
      hits.push(`${label} ${Math.round(b.left)},${Math.round(b.top)} ${Math.round(b.width)}x${Math.round(b.height)}`)
    }
  }
  for (const el of document.querySelectorAll(CORNER_TARGETS)) consider(el)
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.textContent?.trim() && n.parentElement) consider(n.parentElement)
  }
  if (hits.length || always) console.info(`[corners] ${why}: ${hits.length ? `${hits.length} clipped by the r=${r} corners: ${hits.slice(0, 8).join(' | ')}` : `nothing clipped by the r=${r} corners in ${w}x${h}`}`)
  return hits.length
}
let layoutShown = true
let dynamicActions: PhoneAction[] = []

function actionDescriptor(a: PhoneAction): Record<string, unknown> {
  return { id: a.id, label: a.label, icon: a.icon, group: a.group, enabled: a.enabled, checked: a.checked ?? null, hint: a.hint ?? null }
}
const layoutListeners = new Set<() => void>()

function setLayoutShown(on: boolean): void {
  if (layoutShown === on) return
  layoutShown = on
  console.info(`[shell] ${on ? 'layout' : 'panel'} screen`)
  navigate(on ? 'pop' : 'push', () => {
    for (const l of layoutListeners) l()
  }, 40)
}

function useLayoutShown(): boolean {
  const [on, setOn] = useState(layoutShown)
  useEffect(() => {
    const l = (): void => setOn(layoutShown)
    layoutListeners.add(l)
    l()
    return () => {
      layoutListeners.delete(l)
    }
  }, [])
  return on
}
let shownPty: string | null = null
const menuByPty = new Map<string, TerminalScan>()

function menuRowsOnScreen(): string {
  const pty = shownPty
  const scan = pty ? menuByPty.get(pty) : undefined
  const term = pty ? getTerminalInstance(pty) : undefined
  const screen = term?.element?.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect()
  if (!scan || !term || !screen || term.rows <= 0) return ''
  const top = term.buffer.active.viewportY
  const h = screen.height / term.rows
  const rows = scan.spans.map(([a, b], k) => `${scan.menu[k]?.key}@${Math.round(screen.top + (a - top + 0.5) * h)}-${Math.round(screen.top + (b - top + 0.5) * h)}`).join(',')
  return `${rows} q=${scan.question.replace(/\s+/g, '_').slice(0, 40)}`
}

function inputBoxOnScreen(): Record<string, unknown> | null {
  const term = shownPty ? getTerminalInstance(shownPty) : undefined
  const screen = term?.element?.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect()
  const rows = term ? findClaudeInput(term) : null
  if (!term || !screen || !rows) return null
  const cw = screen.width / term.cols
  const ch = screen.height / term.rows
  const vy = term.buffer.active.viewportY
  const rect = (r: { left: number; top: number; width: number; height: number }): number[] => [r.left, r.top, r.width, r.height].map((n) => Math.round(n * 10) / 10)
  const line = rect({ left: screen.left + rows.col * cw, top: screen.top + (rows.caretY - vy) * ch, width: (rows.end - rows.col) * cw, height: ch })
  const caret = rect({ left: screen.left + rows.caretX * cw, top: screen.top + (rows.caretY - vy) * ch, width: cw, height: ch })
  const el = document.querySelector<HTMLTextAreaElement>('[data-web-shell-composer]')
  const cs = el ? getComputedStyle(el) : null
  const fr = el?.getBoundingClientRect()
  const field = fr ? rect(fr) : null
  const textAt = fr && cs ? [fr.left + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.textIndent) || 0), fr.top + (parseFloat(cs.paddingTop) || 0)].map((n) => Math.round(n * 10) / 10) : null
  const placed = el?.closest<HTMLElement>('[data-ws-composer-row]')?.dataset.wsComposerRow ?? ''
  const text = Array.from({ length: rows.last - rows.first + 1 }, (_, i) => term.buffer.active.getLine(rows.first + i)?.translateToString(true) ?? '')
  return {
    pty: shownPty,
    grid: `${term.cols}x${term.rows}`,
    scroll: `${vy}/${term.buffer.active.baseY} ${term.buffer.active.type}`,
    rows: [rows.first - vy, rows.last - vy],
    caretCell: [rows.caretX, rows.caretY - vy],
    text,
    line,
    caret,
    field,
    textAt,
    placed,
    textIndent: cs ? parseFloat(cs.textIndent) || 0 : null,
    font: cs ? `${cs.fontSize} ${cs.lineHeight} ls=${cs.letterSpacing}` : null,
    cell: [Math.round(cw * 100) / 100, Math.round(ch * 100) / 100],
    lineHeight: cs ? parseFloat(cs.lineHeight) || 0 : null
  }
}

function logInputBox(): void {
  const r = inputBoxOnScreen()
  console.info(`[drive] inputBox ${r ? JSON.stringify(r) : 'none'}`)
}

Object.assign(window, { __saturaMenuRows: menuRowsOnScreen, __saturaInputBox: inputBoxOnScreen })
const menuListeners = new Set<() => void>()

interface Presence {
  workspaceId: string | null
  screen: Exclude<PhoneScreen, 'files'>
  tabId: string | null
  label: string
  kind: string
  overlay: 'files' | null
  visible: boolean
  device: string
}

const presence: Presence = { workspaceId: null, screen: 'projects', tabId: null, label: '', kind: '', overlay: null, visible: true, device: 'iPhone' }
const PAGE = Math.random().toString(36).slice(2, 10)
let presenceSent = ''
let presenceSeq = 0
let presenceTimer: ReturnType<typeof setInterval> | null = null

function panelReport(): PhonePanelReport {
  const screen: PhoneScreen = presence.overlay && presence.workspaceId ? presence.overlay : presence.screen
  const tabId = screen === 'panel' ? presence.tabId : null
  return { device: presence.device, visible: presence.visible, workspaceId: presence.workspaceId, screen, tabId, label: tabId ? presence.label : '', kind: tabId ? presence.kind : '', page: PAGE }
}

function pushPresence(force = false): void {
  if (hydrating()) {
    setTimeout(() => pushPresence(force), 0)
    return
  }
  const report = panelReport()
  const key = JSON.stringify(report)
  if (!force && key === presenceSent) return
  if (key !== presenceSent) console.info(`[shell] phone panel ${report.screen}${report.tabId ? ` ${report.kind} "${report.label}" ${report.tabId.slice(0, 8)}` : ''}${report.workspaceId ? ` in ${report.workspaceId.slice(0, 8)}` : ''}, ${report.visible ? 'foreground' : 'background'}`)
  presenceSent = key
  presenceTimer ??= setInterval(() => pushPresence(true), 10_000)
  void invokeRemote('remote:panelReport', { ...report, seq: ++presenceSeq }).catch(() => {
    if (presenceSent === key) presenceSent = ''
  })
}

export function resendPresence(): void {
  pushPresence(true)
}

export function phoneShows(): { workspaceId: string | null; screen: PhoneScreen; tabId: string | null; visible: boolean } {
  const r = panelReport()
  return { workspaceId: r.workspaceId ?? null, screen: r.screen ?? 'projects', tabId: r.tabId ?? null, visible: r.visible !== false }
}

function setPresence(next: Partial<Presence>): void {
  Object.assign(presence, next)
  pushPresence()
}

export function shownTerminalPty(): string | null {
  return shownPty
}

function ack(id: unknown, ok: boolean, error?: string): void {
  if (id === undefined || id === null) return
  postToShell({ type: 'ack', id, ok, ...(error ? { error } : {}) })
}

async function acked(id: unknown, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    ack(id, true)
  } catch (e) {
    ack(id, false, (e as Error)?.message ?? String(e))
  }
}

function writePty(ptyId: string, data: string): Promise<unknown> {
  return invokeRemote('remote:ptyWrite', { id: ptyId, data })
}

function findTab(s: AppState, tabId: string): { workspaceId: string; tab: Tab } | null {
  for (const [workspaceId, tabs] of Object.entries(s.tabsByWorkspace)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) return { workspaceId, tab }
  }
  return null
}

function heldByPrompt(tab: Tab): boolean {
  return Object.values(useRestorePrompts.getState().prompts).some((p) => isHeldTab(p, tab))
}

function tabStatus(s: AppState, tab: Tab): AgentRunStatus | null {
  if (tab.contentType !== 'terminal') return null
  if (heldByPrompt(tab)) return 'needs-input'
  if (!tab.agentId && !detectAgentStatusFromTitle(tab.generatedLabel) && !menuByPty.get(tab.ptyId)?.menu.length) return null
  const status = agentRunStatusFor(tab, s.exitedPtyIds.includes(tab.ptyId), s.agentHookStatusByPty[tab.ptyId])
  if (status !== 'working' && menuByPty.get(tab.ptyId)?.menu.length) return 'needs-input'
  return status
}

function tabLabel(s: AppState, tab: Tab): string {
  const label = tabDisplayLabel(tab, s.viewerFileByTab)
  return tab.contentType === 'terminal' ? stripAgentStatusGlyph(label) : label
}

function orderedTabs(s: AppState, workspaceId: string): Tab[] {
  const tabs = s.tabsByWorkspace[workspaceId] ?? []
  const groups = s.groupsByWorkspace[workspaceId] ?? []
  const order = collectGroupIds(s.layoutByWorkspace[workspaceId])
  const ids = [...order, ...groups.map((g) => g.id).filter((id) => !order.includes(id))]
  const out: Tab[] = []
  for (const gid of ids) {
    const g = groups.find((x) => x.id === gid)
    if (!g) continue
    const own = g.tabOrder.map((tid) => tabs.find((x) => x.id === tid)).filter((t): t is Tab => !!t)
    for (const t of macOrder(g.id, own, g.activeTabId)) if (!out.includes(t)) out.push(t)
  }
  return out
}

function groupsPayload(s: AppState, workspaceId: string): { id: string; name: string; count: number; focused: boolean }[] {
  const tabs = orderedTabs(s, workspaceId)
  const out: { id: string; name: string; count: number; focused: boolean }[] = []
  for (const t of tabs) {
    const g = out.find((x) => x.id === t.groupId)
    if (g) g.count++
    else out.push({ id: t.groupId, name: tabLabel(s, t), count: 1, focused: s.activeGroupIdByWorkspace[workspaceId] === t.groupId })
  }
  return out
}

function selectedTab(s: AppState, workspaceId: string): Tab | undefined {
  const tabs = s.tabsByWorkspace[workspaceId] ?? []
  const groups = s.groupsByWorkspace[workspaceId] ?? []
  const group = groups.find((g) => g.id === s.activeGroupIdByWorkspace[workspaceId]) ?? groups[0]
  return group ? shownTab(group, tabs) : tabs[0]
}

function shows(s: AppState, workspaceId: string, file: string): boolean {
  const tab = selectedTab(s, workspaceId)
  if (!tab) return false
  if (s.viewerFileByTab[tab.id] === file) return true
  return tab.contentType === 'tuner' && tab.tuner?.kind === 'file' && file.endsWith(`/${tab.tuner.id}`)
}

function until(test: (s: AppState) => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (test(useAppStore.getState())) return resolve(true)
    const timer = setTimeout(() => {
      off()
      resolve(false)
    }, ms)
    const off = useAppStore.subscribe((s) => {
      if (!test(s)) return
      clearTimeout(timer)
      off()
      resolve(true)
    })
  })
}

function untilShown(workspaceId: string, file: string, ms: number): Promise<boolean> {
  return until((s) => shows(s, workspaceId, file), ms)
}

function untilKind(workspaceId: string, kind: TabContentType, ms: number): Promise<boolean> {
  return until((s) => selectedTab(s, workspaceId)?.contentType === kind, ms)
}

function projectsPayload(s: AppState): Record<string, unknown> {
  return {
    type: 'projects',
    activeId: s.activeWorkspaceId,
    items: s.workspaces.map((w) => {
      const tabs = s.tabsByWorkspace[w.id] ?? []
      return {
        id: w.id,
        title: workspaceTitle(w),
        path: w.worktreePath || w.folderPath || '',
        unity: tabs.some((t) => t.contentType === 'unity-instance-player'),
        agents: tabs
          .filter((t) => tabStatus(s, t) !== null)
          .map((t) => {
            const status = tabStatus(s, t) ?? 'idle'
            return { tabId: t.id, label: tabLabel(s, t), status, dot: STATUS_DOT[status] }
          })
      }
    })
  }
}

function useDedupedPost(payload: Record<string, unknown> | null): void {
  const last = useRef('')
  const text = payload ? JSON.stringify(payload) : ''
  useEffect(() => {
    if (!text || text === last.current) return
    last.current = text
    postToShell(JSON.parse(text))
  }, [text])
}

function useMenuVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => {
    const l = (): void => setV((n) => n + 1)
    menuListeners.add(l)
    return () => {
      menuListeners.delete(l)
    }
  }, [])
  return v
}

function useProjectsFeed(): void {
  const menuVersion = useMenuVersion()
  const prompts = useRestorePrompts((s) => s.prompts)
  const payload = useAppStore(useShallow((s) => ({ json: JSON.stringify(projectsPayload(s)) })))
  useDedupedPost(useMemo(() => JSON.parse(payload.json), [payload.json, menuVersion, prompts]))
}

const ASK_OPTIONS: MenuOption[] = [{ key: '1', label: 'Yes', selected: true }, { key: 'esc', label: 'No', selected: false }]

let feedNow: ActivityEntry[] = []
let feedBaselined = false
const feedSubs = new Set<() => void>()
const seenTabAt = new Map<string, number>()

function latestByTab(feed: ActivityEntry[], workspaceId?: string): Map<string, number> {
  const out = new Map<string, number>()
  for (const e of feed) {
    const tabId = e.link.tabId
    if (!tabId || (workspaceId && e.link.workspaceId && e.link.workspaceId !== workspaceId)) continue
    out.set(tabId, Math.max(out.get(tabId) ?? 0, e.at))
  }
  return out
}

function setFeedNow(list: ActivityEntry[], loaded: boolean): void {
  feedNow = list
  if (loaded && !feedBaselined) {
    feedBaselined = true
    for (const [tabId, at] of latestByTab(list)) seenTabAt.set(tabId, Math.max(seenTabAt.get(tabId) ?? 0, at))
  }
  for (const fn of feedSubs) fn()
}

function useFeedNow(): ActivityEntry[] {
  return useSyncExternalStore(
    (fn) => {
      feedSubs.add(fn)
      return () => feedSubs.delete(fn)
    },
    () => feedNow
  )
}

function useActivityFeed(): void {
  const [feed, setFeed] = useState<ActivityEntry[]>([])
  const menuVersion = useMenuVersion()
  useEffect(() => {
    const load = (): void => {
      void invokeRemote<ActivityEntry[]>('remote:push:activity').then((list) => {
        console.info(`[shell] activity from the desktop: ${list.length} entries, ${list.filter((e) => e.open).length} open`)
        setFeedNow(list, true)
        setFeed(list)
      }, () => {})
    }
    load()
    const offFeed = wsTransport.on('remote:activity', (list: ActivityEntry[]) => {
      const next = Array.isArray(list) ? list : []
      setFeedNow(next, false)
      setFeed(next)
    })
    const offOnline = wsTransport.on('remote:online', load)
    return () => {
      offFeed()
      offOnline()
    }
  }, [])
  useEffect(() => {
    postToShell({ type: 'activity', items: feed.map((e) => ({ ...e, options: e.open && e.kind === 'ask' ? (menuByPty.get(e.link.ptyId ?? '')?.menu.slice(0, 3) ?? ASK_OPTIONS) : [] })) })
  }, [feed, menuVersion])
}

function useScmRoot(projectPath: string): string | null {
  const [root, setRoot] = useState<string | null>(null)
  useEffect(() => {
    let alive = true
    setRoot(null)
    if (!projectPath) return
    void findScmRoot(projectPath, (p) => window.api.fs.statPath(p).then((i) => i.exists, () => false)).then((found) => {
      if (alive) setRoot(found ?? projectPath)
    })
    return () => {
      alive = false
    }
  }, [projectPath])
  return root
}

function GitLoading() {
  return (
    <div className="flex h-full items-center justify-center gap-2 text-[14px] text-ink-3" data-pg-state="opening">
      <span className="h-4 w-4 animate-spin rounded-full border-2 border-ink-4 border-t-transparent" />
      Opening Git
    </div>
  )
}

function GitPanel({ ptyId, projectPath }: { ptyId: string; projectPath: string }) {
  const root = useScmRoot(projectPath)
  if (root === null) return <GitLoading />
  return (
    <Suspense fallback={<GitLoading />}>
      <PhoneGit rootPath={root} projectPath={projectPath} scope={ptyId} onOpenFile={(file) => void openFileInWorkbench({ file, projectPath })} />
    </Suspense>
  )
}

function TerminalPanel({ ptyId, epoch }: { ptyId: string; epoch: number }) {
  useEffect(() => {
    shownPty = ptyId
    void invokeRemote('remote:claimPty', { id: ptyId }).catch(() => {})
    let last = ''
    const scan = (): void => {
      const result = scanTerminal(getTerminalInstance(ptyId))
      const text = JSON.stringify(result)
      if (text === last) return
      last = text
      if (result.menu.length) menuByPty.set(ptyId, result)
      else menuByPty.delete(ptyId)
      if (result.menu.length) console.info(`[shell] menu on ${ptyId}: ${result.menu.map((m, k) => `${m.key}=${m.label} [${result.spans[k]?.join('-')}]`).join(' | ')}`)
      for (const l of menuListeners) l()
    }
    const timer = setInterval(scan, 400)
    return () => {
      clearInterval(timer)
      if (shownPty === ptyId) shownPty = null
      menuByPty.delete(ptyId)
      for (const l of menuListeners) l()
      void invokeRemote('remote:releasePty', { id: ptyId }).catch(() => {})
    }
  }, [ptyId])
  return (
    <>
      <PaneTerminalSlot key={`${ptyId}:${epoch}`} ptyId={ptyId} />
      <RemoteTerminalSession key={`session:${ptyId}:${epoch}`} ptyId={ptyId} />
    </>
  )
}

function linkUnder(ptyId: string, x: number, y: number): TerminalLinkHit | null {
  const term = getTerminalInstance(ptyId)
  const screen = term?.element?.querySelector<HTMLElement>('.xterm-screen')?.getBoundingClientRect()
  if (!term || !screen || term.rows <= 0 || term.cols <= 0) return null
  if (x < screen.left || x > screen.right || y < screen.top || y > screen.bottom) return null
  const col = Math.min(term.cols - 1, Math.floor((x - screen.left) / (screen.width / term.cols)))
  const row = Math.min(term.rows - 1, Math.floor((y - screen.top) / (screen.height / term.rows)))
  return terminalLinkAt(term, term.buffer.active.viewportY + row, col)
}

function phoneToast(text: string): void {
  postToShell({ type: 'toast', text, retryId: null })
}

async function openTerminalLink(ptyId: string, cwd: string, hit: TerminalLinkHit): Promise<void> {
  if (hit.kind === 'url') {
    console.info(`[terminal] tap opens ${hit.url} in the phone's browser`)
    const win = window.open(hit.url, '_blank')
    if (win) win.opener = null
    else phoneToast(`The browser didn't open ${hit.url}`)
    return
  }
  const target = resolveTerminalPath(hit.path, cwd) ?? hit.path
  const shown = cwd ? relativePath(cwd, target) : target
  const info = await window.api.fs.statPath(target).catch(() => null)
  if (!info?.exists) {
    console.info(`[terminal] tap on ${hit.path}: no file at ${target}`)
    phoneToast(`There's no file at ${shown}`)
    return
  }
  if (!info.isFile) {
    console.info(`[terminal] tap on ${hit.path}: ${info.resolved} is a folder`)
    phoneToast(`${shown} is a folder, not a file`)
    return
  }
  const file = info.resolved
  const found = findTabByPty(useAppStore.getState(), ptyId)
  console.info(`[terminal] tap opens ${file}${hit.line ? `:${hit.line}${hit.column ? `:${hit.column}` : ''}` : ''} from ${ptyId}`)
  postToShell({ type: 'haptic' })
  if (hit.line) requestGoto(file, hit.line, hit.column ?? 1)
  await desktopCall('openFile', [{ file, line: hit.line, column: hit.column, ptyId, preview: true, highlight: true }])
  const opened = found ? await untilShown(found.workspaceId, file, 4000) : false
  console.info(`[terminal] ${opened ? 'showing' : 'opened on the Mac, the phone shows the selected tab for'} ${file}`)
  setLayoutShown(false)
}

function findTabByPty(s: AppState, ptyId: string): { workspaceId: string; tab: Tab } | null {
  for (const [workspaceId, tabs] of Object.entries(s.tabsByWorkspace)) {
    const tab = tabs.find((t) => t.ptyId === ptyId && t.contentType === 'terminal')
    if (tab) return { workspaceId, tab }
  }
  return null
}

function Unsupported({ kind }: { kind: PanelKind }) {
  const what = kind === 'tuner' ? 'Tuner' : 'This panel'
  return (
    <div className="flex h-full items-center justify-center px-8 text-center text-[14px] text-ink-3" data-phone-unsupported={kind}>
      {what} isn't on the phone yet. Use it on your desktop for now.
    </div>
  )
}

const MEDIA_SURFACE = '[data-media-surface], .sr-viewport, .rk-overlay'

function reportAnchor(host: HTMLElement, x: number, y: number): HTMLElement | null {
  const hit = document.elementFromPoint(x, y)
  const inside = hit instanceof HTMLElement && host.contains(hit) ? hit : null
  return inside ?? host.querySelector<HTMLElement>('.rk-report')
}

function installPinchZoom(el: HTMLElement): () => void {
  let start: { d: number; z: number; report: HTMLElement | null; anchor: HTMLElement | null; top: number; mid: { x: number; y: number } } | null = null
  let frame = 0
  let want = 0
  let held: EventTarget | null = null
  const opts = { capture: true, passive: false } as const
  const dist = (t: TouchList): number => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  const midOf = (t: TouchList): { x: number; y: number } => ({ x: (t[0].clientX + t[1].clientX) / 2, y: (t[0].clientY + t[1].clientY) / 2 })
  const within = (t: TouchList, sel: string): boolean => [0, 1].some((i) => t[i].target instanceof Element && !!(t[i].target as Element).closest(sel))
  const hold = (target: EventTarget | null): void => {
    if (held === target) return
    if (held) for (const t of ['touchmove', 'touchend', 'touchcancel']) held.removeEventListener(t, onTarget as EventListener, opts)
    held = target
    if (held) for (const t of ['touchmove', 'touchend', 'touchcancel']) held.addEventListener(t, onTarget as EventListener, opts)
  }
  const applyReport = (s: NonNullable<typeof start>, z: number): void => {
    const host = s.report
    const next = setPhoneScale({ reportScale: z }, false).reportScale
    if (!host) return
    host.style.zoom = next === 1 ? '' : String(next)
    host.toggleAttribute('data-scaled', next !== 1)
    if (!s.anchor) return
    const r = host.getBoundingClientRect()
    const unit = host.clientHeight > 0 ? r.height / host.clientHeight : 1
    const moved = s.anchor.getBoundingClientRect().top - s.top
    if (Math.abs(moved) > 0.5) host.scrollTop += moved / (unit || 1)
    s.top = s.anchor.getBoundingClientRect().top
  }
  const onStart = (e: TouchEvent): void => {
    if (e.touches.length !== 2 || within(e.touches, '[data-image-viewer]')) return
    const report = within(e.touches, '[data-viewer-report]')
    if (report && within(e.touches, MEDIA_SURFACE)) return
    const host = report ? el.querySelector<HTMLElement>('[data-viewer-report] .rk-host') : null
    const mid = midOf(e.touches)
    const anchor = host ? reportAnchor(host, mid.x, mid.y) : null
    start = { d: dist(e.touches), z: report ? phoneScales().reportScale : viewerZoom(), report: report ? host : null, anchor, top: anchor?.getBoundingClientRect().top ?? 0, mid }
    if (report && !host) start = null
    if (!start) return
    hold(e.target)
    e.preventDefault()
    e.stopPropagation()
  }
  const onMove = (e: TouchEvent): void => {
    if (!start || e.touches.length !== 2) return
    e.preventDefault()
    e.stopPropagation()
    want = start.z * (dist(e.touches) / Math.max(1, start.d))
    if (!frame) frame = requestAnimationFrame(() => {
      frame = 0
      if (!start) return
      if (start.report) applyReport(start, want)
      else setViewerZoom(want)
    })
  }
  const onEnd = (e: TouchEvent): void => {
    if (!start || (e.type === 'touchend' && e.touches.length >= 2)) return
    const s = start
    start = null
    hold(null)
    if (frame) {
      cancelAnimationFrame(frame)
      frame = 0
      if (s.report) applyReport(s, want)
      else setViewerZoom(want)
    }
    if (s.report) {
      const z = phoneScales().reportScale
      console.info(`[report] pinch scale ${Math.round(s.z * 100)}% -> ${Math.round(z * 100)}%`)
      if (z !== s.z) setPhoneScale({ reportScale: z }, true)
      return
    }
    console.info(`[viewer] pinch zoom ${Math.round(s.z * 100)}% -> ${Math.round(viewerZoom() * 100)}%`)
  }
  const seen = new WeakSet<Event>()
  function onTarget(e: TouchEvent): void {
    if (seen.has(e)) return
    seen.add(e)
    if (e.type === 'touchmove') onMove(e)
    else onEnd(e)
  }
  const onEl = (e: TouchEvent): void => onTarget(e)
  el.addEventListener('touchstart', onStart, opts)
  el.addEventListener('touchmove', onEl, opts)
  el.addEventListener('touchend', onEl, opts)
  el.addEventListener('touchcancel', onEl, opts)
  return () => {
    cancelAnimationFrame(frame)
    hold(null)
    el.removeEventListener('touchstart', onStart, opts)
    el.removeEventListener('touchmove', onEl, opts)
    el.removeEventListener('touchend', onEl, opts)
    el.removeEventListener('touchcancel', onEl, opts)
  }
}

function PhonePanel({ tab, projectPath, epoch }: { tab: Tab; projectPath: string; epoch: number }) {
  const kind = KIND_OF[tab.contentType]
  const rootRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => (kind === 'dashboard' ? window.api.dashboard.onAlerts((ev) => setDashboardAlerts(ev.project, ev.alerts)) : undefined), [kind])
  useEffect(() => (kind === 'viewer' && rootRef.current ? installPinchZoom(rootRef.current) : undefined), [kind])
  useEffect(() => {
    if (kind !== 'terminal' || !rootRef.current) return
    const ptyId = tab.ptyId
    return installTerminalTouch(rootRef.current, {
      term: () => getTerminalInstance(ptyId),
      onTapRow: (text, y) => {
        const scan = menuByPty.get(ptyId)
        const row = text.replace(/\s+/g, ' ').trim()
        const hit = menuItemAtRow(scan, y) ?? (scan?.menu ?? []).find((m) => m.label.trim().length > 1 && row.includes(m.label.replace(/\s+/g, ' ').trim()))
        if (!hit) {
          if (scan) console.info(`[terminal] tap on row ${y} is outside the ${scan.menu.length} menu rows`)
          return false
        }
        const seq = keySequence(hit.key)
        console.info(`[terminal] tap picks ${hit.key} ${hit.label} (row ${y})`)
        if (seq) void writePty(ptyId, seq).catch(() => {})
        return !!seq
      },
      onSelect: (text) => {
        console.info(`[terminal] selected ${text.length} chars`)
        postToShell({ type: 'copy', text })
      },
      onLongPress: () => postToShell({ type: 'haptic' }),
      onTapLink: (x, y) => {
        const hit = linkUnder(ptyId, x, y)
        if (!hit) return false
        void openTerminalLink(ptyId, projectPath, hit).catch((e: Error) => {
          console.info(`[terminal] opening ${hit.kind === 'url' ? hit.url : hit.path} failed: ${e?.message ?? e}`)
          phoneToast(e?.message || "Couldn't open that file")
        })
        return true
      },
      onPinch: (phase, k, mid) => pinchTerminal(ptyId, phase, k, mid)
    })
  }, [kind, tab.ptyId, projectPath])
  let body: ReactNode
  if (kind === 'terminal') body = <TerminalPanel ptyId={tab.ptyId} epoch={epoch} />
  else if (kind === 'console')
    body = <TargetedToolPane contentType="unity-console" tabId={tab.id} ptyId={tab.ptyId} worktreePath={projectPath} scratchpadId={tab.scratchpadId ?? null} />
  else if (kind === 'git') body = <GitPanel ptyId={tab.ptyId} projectPath={projectPath} />
  else if (kind === 'viewer') body = <PaneFileViewerSlot rootPath={projectPath} tabId={tab.id} focused={false} />
  else if (kind === 'scratchpads')
    body = (
      <PaneScratchpadSlot
        tabId={tab.id}
        ptyId={tab.ptyId}
        projectPath={projectPath}
        phoneLive={(pad) => <UnityStream key={pad.path} tab={tab} projectPath={pad.path} epoch={epoch} canStop={false} />}
      />
    )
  else if (kind === 'unity') body = <UnityStream tab={tab} projectPath={projectPath} epoch={epoch} canStop />
  else if (kind === 'dashboard') body = <PaneDashboardSlot tabId={tab.id} projectPath={projectPath} />
  else if (kind === 'tuner') body = <RemoteTuner key={`${tab.id}:${epoch}`} tab={tab} worktreePath={projectPath} />
  else body = <Unsupported kind={kind} />
  return (
    <div
      ref={(el) => {
        panelRoot = el
        rootRef.current = el
      }}
      className="ws-swap absolute overflow-hidden bg-canvas"
      style={{ top: 'var(--remote-top, 0px)', bottom: 'calc(var(--remote-bottom, 0px) + var(--remote-keyboard-pad, 0px))', left: 'var(--remote-left, 0px)', right: 'var(--remote-right, 0px)' }}
      data-phone-panel={kind}
      data-tab-id={tab.id}
    >
      <PaneErrorBoundary key={tab.id} label="Panel">
        {body}
      </PaneErrorBoundary>
    </div>
  )
}

function UnityStream({ tab, projectPath, epoch, canStop }: { tab: Tab; projectPath: string; epoch: number; canStop: boolean }) {
  return (
    <>
      <UnityVideoPanel tab={tab} projectPath={projectPath} epoch={epoch} canStart={canStop} />
      <UnityActionsHost ptyId={tab.ptyId} projectPath={projectPath} canStop={canStop} />
    </>
  )
}

type PhoneUnityView = 'waiting' | 'dialog' | 'loading' | 'hub' | 'down' | 'stopped' | 'idle' | 'no-camera' | 'live' | 'edit' | 'busy' | 'note'

function UnityVideoPanel({ tab, projectPath, epoch, canStart }: { tab: Tab; projectPath: string; epoch: number; canStart: boolean }) {
  const { worldId, ids } = usePickedPlayer(tab.id, projectPath)
  const inst = useInstance(projectPath, worldId)
  const lifecycle = useEffectiveLifecycle(projectPath, worldId)
  const life = useUnityLifecycle(projectPath)
  const player = Math.max(0, ids.indexOf(worldId)) + 1
  const label = life ? stateLabel(life) : ''
  const up = life?.state === 'ready'
  const blind = inst?.unityMode === 'headless-nographics'
  const live = up && lifecycle === 'playing' && !blind
  const edit = up && lifecycle === 'editmode' && !inst?.fault && inst?.compile !== 'compiling' && !inst?.progressLabel && !inst?.stall && !blind
  const dialog = player === 1 ? (life?.dialog ?? null) : null
  const hubGate = life?.phase === 'hub' && life.hub !== 'ready' && life.state !== 'starting' && life.state !== 'stopping' ? life.hub : null
  const busy = !life
    ? 'Asking the desktop about Unity…'
    : up && !live && !inst?.fault && !blind && inst?.compile !== 'error'
      ? editorBusyLabel(inst, lifecycle) || inst?.progressLabel || (!inst ? 'Connecting to Unity…' : lifecycle === 'launching' || lifecycle === 'init' ? 'Starting Unity…' : '')
      : ''
  const view: PhoneUnityView = !life
    ? 'waiting'
    : dialog
      ? 'dialog'
      : life.state === 'starting' || life.state === 'stopping'
        ? 'loading'
        : hubGate
          ? 'hub'
          : life.state === 'failed' || life.state === 'exited'
            ? 'down'
            : life.state === 'stopped'
              ? 'stopped'
              : life.state === 'idle'
                ? 'idle'
                : live
                  ? inst?.noCamera
                    ? 'no-camera'
                    : 'live'
                  : edit
                    ? 'edit'
                    : busy
                      ? 'busy'
                      : 'note'
  const play: GamePlay = {
    mode: view === 'live' || view === 'no-camera' ? 'play' : view === 'edit' ? 'edit' : 'busy',
    busy: view === 'busy' || view === 'waiting' ? busy : undefined,
    pct: inst?.progressPct,
    onPlay: () =>
      void runAction(panelActions(tab.ptyId), 'unity.play').catch((e: Error) => {
        console.warn(`[unity] Play from the game view failed: ${e.message}`)
        phoneToast(`Play didn't go through: ${e.message}`)
      }),
    blocked: inst?.compile === 'error' ? 'Fix the compile errors in the Console' : undefined
  }
  const why = !life
    ? 'no state from the desktop yet'
    : `desktop ${label}${life.dialog ? ` with dialog '${life.dialog.title || 'untitled'}'` : ''}, editor ${lifecycle ?? 'not in the world yet'}${inst?.compile && inst.compile !== 'idle' ? ` (${inst.compile})` : ''}${busy ? `, busy: ${busy}` : ''}`
  useEffect(() => {
    console.info(`[unity] phone Unity panel of ${pathBasename(projectPath)} (player ${player}) shows ${view}: ${why}`)
  }, [view, why, player, projectPath])
  return (
    <div className="flex h-full w-full flex-col" data-unity-view={view} data-unity-state={lifecycle ?? ''} data-unity-machine={label} data-unity-player={player}>
      <PlayerPicker tabId={tab.id} projectPath={projectPath} ids={ids} worldId={worldId} />
      <div className="relative min-h-0 flex-1">
        <RemoteVideo key={`${tab.id}:${worldId}:${epoch}`} source={worldId} project={projectPath} scope={tab.id} game expectFrames={live && !inst?.fault} play={play} />
        {view === 'dialog' && dialog ? (
          <div className="ws-swap absolute inset-0 z-[36] flex items-center justify-center bg-canvas px-6" data-phone-unity-dialog={dialog.id}>
            <UnityDialogCard project={projectPath} dialog={dialog} remote />
          </div>
        ) : view === 'no-camera' ? (
          <div className="ws-swap absolute inset-0 z-[36] flex items-center justify-center bg-canvas px-6" data-phone-unity-no-camera>
            <NoCameraCard remote />
          </div>
        ) : view === 'hub' && hubGate ? (
          <div className="ws-swap absolute inset-0" data-phone-unity-hub={hubGate}>
            <UnityHubBlockedView
              projectPath={projectPath}
              initial={hubGate}
              onReady={() =>
                void window.api.unity.retry(projectPath).then(
                  (r) => console.info(`[unity] Unity Hub is up, the phone asked the desktop to start Unity: ${r.ok ? 'ok' : r.error}`),
                  (e: Error) => console.warn(`[unity] Unity Hub is up but the start didn't go through: ${e.message}`)
                )
              }
            />
          </div>
        ) : view === 'down' && life ? (
          <div className="ws-swap absolute inset-0 flex items-center justify-center bg-canvas" data-phone-unity-down={label}>
            <UnityStateCard life={life} remote compact />
          </div>
        ) : view === 'stopped' ? (
          <div className="ws-swap absolute inset-0">
            <StoppedView closing={false} />
          </div>
        ) : view === 'idle' && life ? (
          <UnityIdleCard life={life} canStart={canStart} />
        ) : view === 'note' ? (
          <div className="ws-swap pointer-events-none absolute inset-0">
            <UnityStateNote quitting={false} pending={false} pendingHub={null} inst={inst} lifecycle={lifecycle} scope={tab.ptyId} life={life} remote />
          </div>
        ) : null}
        <Presence when={view === 'loading' && life}>{(l) => <UnityLoadingCard life={l} inst={inst} />}</Presence>
      </div>
    </div>
  )
}

function LayoutPanel({ id }: { id: string }) {
  return (
    <div className="absolute overflow-hidden bg-canvas" style={{ top: 'var(--remote-top, 0px)', bottom: 'var(--remote-bottom, 0px)', left: 'var(--remote-left, 0px)', right: 'var(--remote-right, 0px)' }} data-phone-panel="layout">
      <PaneErrorBoundary label="Layout">
        <RemoteLayout
          workspaceId={id}
          onOpenTab={(tabId) => {
            const s = useAppStore.getState()
            if (!s.tabsByWorkspace[id]?.some((t) => t.id === tabId)) return
            if (selectedTab(s, id)?.id === tabId) return setLayoutShown(false)
            runMirrored('activateTab', [tabId]).then(
              () => setLayoutShown(false),
              (e: Error) => console.info(`[layout] the Mac didn't switch to ${tabId}: ${e.message}`)
            )
          }}
        />
      </PaneErrorBoundary>
    </div>
  )
}

function useBackAvailable(): boolean {
  const [can, setCan] = useState(canGoBackInPanel())
  useEffect(() => onPanelBackChange(() => setCan(canGoBackInPanel())), [])
  return can
}

function useBackTitles(): string[] {
  const [titles, setTitles] = useState<string[]>(panelBackTitles())
  useEffect(
    () =>
      onPanelBackChange(() => {
        const next = panelBackTitles()
        setTitles((prev) => (prev.join('\n') === next.join('\n') ? prev : next))
      }),
    []
  )
  return titles
}

function useTunerNodes(kind: PanelKind | null, tabId: string | null): void {
  const [list, setList] = useState<PhoneAction[]>([])
  useEffect(() => {
    if (kind !== 'tuner') {
      setList([])
      return
    }
    let last = ''
    const probe = (): void => {
      const next = tunerActions(panelRoot)
      const key = next.map((a) => `${a.id}:${a.label}:${a.enabled ? 1 : 0}${a.checked ? 1 : 0}`).join()
      if (key === last) return
      last = key
      setList(next)
    }
    probe()
    const t = setInterval(probe, 700)
    return () => clearInterval(t)
  }, [kind, tabId])
  const groups: string[] = []
  for (const a of list) if (!groups.includes(a.group)) groups.push(a.group)
  usePanelActions(
    kind === 'tuner' ? `tuner:${tabId}` : null,
    groups.map((g) => ({
      id: `tuner.group.${g}`,
      label: '',
      inline: true,
      children: list
        .filter((a) => a.group === g)
        .map((a) => ({ id: `tuner.${a.id}`, label: a.label, icon: a.icon, hint: a.hint, enabled: a.enabled, checked: a.checked, primary: a.primary, run: a.run }))
    }))
  )
}

function PhoneWorkspace({ id, epoch }: { id: string; epoch: number }) {
  const menuVersion = useMenuVersion()
  useMacOrderVersion()
  const ws = useAppStore((s) => s.workspaces.find((w) => w.id === id))
  const prompt = useRestorePrompts((s) => s.prompts[id])
  const view = useAppStore(
    useShallow((s) => {
      const tabs = orderedTabs(s, id)
      const sel = selectedTab(s, id)
      return {
        selId: sel?.id ?? null,
        chips: JSON.stringify(
          tabs.map((t) => {
            const status = tabStatus(s, t)
            const group = (s.groupsByWorkspace[id] ?? []).find((g) => g.id === t.groupId)
            return {
              id: t.id,
              label: tabLabel(s, t),
              kind: KIND_OF[t.contentType],
              dot: status ? STATUS_DOT[status] : null,
              badge: null,
              group: t.groupId,
              groupActive: !!group && (macShownTab(group.id, group.activeTabId) ?? shownTab(group, s.tabsByWorkspace[id] ?? [])?.id) === t.id
            }
          })
        ),
        groups: JSON.stringify(groupsPayload(s, id)),
        status: sel ? tabStatus(s, sel) : null,
        selLabel: sel ? tabLabel(s, sel) : ''
      }
    })
  )
  const sel = useAppStore((s) => (view.selId ? (s.tabsByWorkspace[id] ?? []).find((t) => t.id === view.selId) : undefined))
  const worktrees = useAppStore((s) => s.worktreesByWorkspace[id])
  const restoreTab = useAppStore((s) => heldTabId(prompt, s.tabsByWorkspace[id] ?? []))
  const kind = sel ? KIND_OF[sel.contentType] : null
  const projectPath = sel ? (worktrees ?? []).find((w) => w.id === sel.worktreeId)?.path ?? ws?.worktreePath ?? ws?.folderPath ?? '' : ''
  const worktreeName = sel ? (worktrees ?? []).find((w) => w.id === sel.worktreeId)?.name ?? '' : ''
  setPhoneScaleRoot((worktrees ?? [])[0]?.path ?? ws?.worktreePath ?? ws?.folderPath ?? '')
  const onLayout = useLayoutShown()
  const held = !onLayout && !!prompt && isHeldTab(prompt, sel)
  const restore = prompt && !held ? { title: `Restore Claude sessions in ${prompt.projectName || (ws ? workspaceTitle(ws) : 'this project')}?`, tabId: restoreTab } : null
  const canBack = useBackAvailable() || !onLayout
  const backTitles = useBackTitles()
  useEffect(() => {
    if (backTitles.length) console.info(`[nav] ${kind} stack: ${backTitles.join(' › ')}`)
    else if (kind) console.info(`[nav] ${kind} stack empty`)
  }, [backTitles, kind])
  useTunerNodes(onLayout ? null : kind, sel?.id ?? null)
  const scopes = useMemo(() => (sel && !onLayout ? [sel.id, sel.ptyId, `tuner:${sel.id}`] : []), [sel?.id, sel?.ptyId, onLayout])
  const actions = usePhonePanelActions(sel, scopes)
  const unityLoading = isUnityLoading(useUnityLifecycle(kind === 'unity' && !onLayout ? projectPath : null))
  const menus = useMemo(() => {
    const split = splitPhoneMenus(actions)
    return unityLoading ? { ...split, panel: [] } : split
  }, [actions, unityLoading])
  useEffect(() => {
    if (kind && !onLayout) console.info(`[menu] ${kind}${unityLoading ? ' while Unity loads' : ''}: panel ${leafIds(menus.panel).length}, tab ${leafIds(menus.tab).length}, workspace ${leafIds(menus.workspace).length}; left out ${menus.excluded.join(', ') || 'nothing'}`)
  }, [kind, menus, onLayout])
  useRefreshOnSelect(onLayout ? null : sel?.id ?? null)
  useEffect(() => {
    if (kind && !onLayout) logActionTree(kind, menus.panel)
  }, [kind, menus, onLayout])
  const scan = sel && kind === 'terminal' ? menuByPty.get(sel.ptyId) : undefined
  const feed = useFeedNow()
  const latest = useMemo(() => latestByTab(feed, id), [feed, id])
  const shownId = onLayout ? null : sel?.id ?? null
  if (shownId) seenTabAt.set(shownId, Math.max(seenTabAt.get(shownId) ?? 0, latest.get(shownId) ?? 0))
  const attn = [...latest].filter(([tabId, at]) => tabId !== shownId && at > (seenTabAt.get(tabId) ?? 0)).map(([tabId]) => tabId).sort().join(',')
  const chips = useMemo(() => {
    const lit = new Set(attn.split(','))
    return (JSON.parse(view.chips) as { id: string }[]).map((c) => (lit.has(c.id) ? { ...c, attn: true } : c))
  }, [view.chips, attn])
  useEffect(() => {
    if (attn) console.info(`[shell] tabs with news: ${attn}`)
  }, [attn])
  const title = sel && !onLayout ? view.selLabel : ws ? workspaceTitle(ws) : ''
  const subtitle = !sel || onLayout
    ? ''
    : view.status
      ? [worktreeName || (ws ? workspaceTitle(ws) : ''), STATUS_WORD[view.status]].filter(Boolean).join(' · ')
      : ws
        ? workspaceTitle(ws)
        : ''

  useDedupedPost(
    useMemo(
      () => ({
        type: 'workspace',
        id,
        title,
        subtitle,
        project: ws ? workspaceTitle(ws) : '',
        root: (worktrees ?? [])[0]?.path ?? ws?.worktreePath ?? ws?.folderPath ?? '',
        tabs: chips,
        groups: JSON.parse(view.groups),
        selected: onLayout ? null : sel?.id ?? null,
        restore,
        panel: onLayout
          ? { kind: 'layout', tabId: null, ptyId: null, composer: 'none', agent: false, working: false, menu: [], canBack, stack: backTitles, landscape: true, actions: menus.workspace, tabActions: [], workspaceActions: menus.workspace }
          : sel
          ? {
              kind,
              tabId: sel.id,
              ptyId: kind === 'terminal' && !held ? sel.ptyId : null,
              composer: kind === 'terminal' && !held ? 'terminal' : 'none',
              agent: !!sel.agentId,
              working: view.status === 'working',
              menu: held ? [] : scan?.menu ?? [],
              canBack,
              stack: backTitles,
              landscape: true,
              actions: held ? [] : menus.panel,
              tabActions: menus.tab,
              workspaceActions: menus.workspace
            }
          : null
      }),
      [id, title, subtitle, ws, worktrees, chips, view.groups, sel, kind, view.status, scan, canBack, backTitles, menus, menuVersion, onLayout, held, restore?.title, restore?.tabId]
    )
  )

  const shownKind = sel ? TAB_KIND[sel.contentType] ?? sel.contentType : ''
  useEffect(() => {
    const shown = onLayout ? null : sel ?? null
    setPresence({ workspaceId: id, screen: onLayout ? 'layout' : 'panel', tabId: shown?.id ?? null, label: shown ? view.selLabel : '', kind: shown ? shownKind : '' })
  }, [id, sel?.id, onLayout, view.selLabel, shownKind])

  if (!ws) return null
  if (onLayout) return <LayoutPanel id={id} />
  if (sel && held && prompt)
    return (
      <div
        className="absolute overflow-hidden bg-canvas"
        style={{ top: 'var(--remote-top, 0px)', bottom: 'var(--remote-bottom, 0px)', left: 'var(--remote-left, 0px)', right: 'var(--remote-right, 0px)' }}
        data-phone-panel="restore"
        data-tab-id={sel.id}
      >
        <RestorePromptCard prompt={prompt} />
      </div>
    )
  if (!sel)
    return (
      <div className="absolute flex items-center justify-center px-8 text-center text-[14px] text-ink-3" style={{ top: 'var(--remote-top, 0px)', bottom: 'var(--remote-bottom, 0px)', left: 'var(--remote-left, 0px)', right: 'var(--remote-right, 0px)' }}>
        This workspace has no panels open.
      </div>
    )
  return <PhonePanel key={`${sel.id}:${epoch}`} tab={sel} projectPath={projectPath} epoch={epoch} />
}

export function PhonePanels({ epoch }: { epoch: number }) {
  const [open, setOpen] = useState<string | null>(null)
  const openRef = useRef(open)
  openRef.current = open
  useProjectsFeed()
  useActivityFeed()

  useEffect(() => {
    if (!open) setPresence({ workspaceId: null, screen: 'projects', tabId: null, label: '', kind: '' })
  }, [open])

  useEffect(
    () =>
      wsTransport.on('remote:showPanel', (raw: unknown) => {
        const t = (raw ?? {}) as Partial<PhoneShowTarget>
        const wsId = typeof t.workspaceId === 'string' ? t.workspaceId : ''
        const tabId = typeof t.tabId === 'string' && t.tabId ? t.tabId : null
        if (!wsId) return
        console.info(`[shell] the Mac asks the phone to show ${tabId ?? 'the focused tab'} of workspace ${wsId}`)
        const reveal = (): void => {
          if (openRef.current !== wsId) {
            openRef.current = wsId
            setOpen(wsId)
          }
          postToShell({ type: 'show', workspaceId: wsId, tabId })
          setLayoutShown(false)
        }
        if (!tabId || selectedTab(useAppStore.getState(), wsId)?.id === tabId) return reveal()
        runMirrored('activateTab', [tabId]).then(reveal, (e: Error) => {
          console.info(`[shell] the Mac didn't switch to ${tabId}: ${e.message}`)
          reveal()
        })
      }),
    []
  )

  useEffect(
    () =>
      onDrive((m) => {
        if (m.action === 'corners') {
          checkCorners('drive', true)
          return
        }
        if (m.action === 'rects') {
          const found = [...document.querySelectorAll<HTMLElement>(String(m.selector ?? ''))]
          const chain: HTMLElement[] = []
          if (m.chain && found[0]) for (let n: HTMLElement | null = found[0]; n && !n.dataset.phonePanel; n = n.parentElement) chain.push(n)
          const out = (m.chain ? chain : found).slice(0, 16).map((el) => {
            const r = el.getBoundingClientRect()
            const cs = getComputedStyle(el)
            return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').slice(0, 3).join('.') : ''} ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} zoom=${cs.zoom} pos=${cs.position} ov=${cs.overflowY} z=${cs.zIndex} sh=${el.style.height || "-"} disp=${cs.display}`
          })
          console.info(`[drive] rects ${m.selector}: ${out.join(' | ') || 'none'}`)
          return
        }
        if (m.action === 'inspect') {
          const canvas = document.querySelector('[data-ti-canvas]')
          let box: HTMLElement | null = canvas?.parentElement ?? null
          while (box && !(/(auto|scroll)/.test(getComputedStyle(box).overflowY) && box.scrollHeight > box.clientHeight)) box = box.parentElement
          const want = new RegExp(String(m.match ?? '.'))
          const props = [...document.querySelectorAll<HTMLElement>('[data-ti-prop]')]
            .filter((el) => want.test(el.dataset.tiProp ?? ''))
            .slice(0, 12)
            .map((el) => {
              const r = el.getBoundingClientRect()
              return `${el.dataset.tiProp}=${el.dataset.tiV ?? el.dataset.tiValue ?? ''} at ${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)} value@${el.dataset.tiValueAt ?? '-'}`
            })
          const active = document.activeElement as HTMLElement | null
          console.info(`[drive] inspect scroll ${Math.round(box?.scrollTop ?? -1)} focus ${active?.dataset?.tiTextOverlay ? `overlay ${(active as HTMLInputElement).value}` : active?.tagName ?? '-'}: ${props.join(' | ') || 'no props'}`)
          return
        }
        if (m.action === 'inputBox') {
          logInputBox()
          return
        }
        if (m.action !== 'screen') return
        const term = shownPty ? getTerminalInstance(shownPty) : undefined
        if (!term) return console.info('[drive] screen: no terminal')
        const buf = term.buffer.active
        const lines: string[] = []
        for (let y = buf.baseY + buf.cursorY; y >= 0 && lines.length < Number(m.lines ?? 8); y--) {
          const text = buf.getLine(y)?.translateToString(true) ?? ''
          if (text.trim() || lines.length) lines.unshift(text)
        }
        console.info(`[drive] screen ${shownPty} ${term.cols}x${term.rows}:\n${lines.join('\n')}`)
      }),
    []
  )

  useEffect(() => {
    installPhoneActions()
    postToShell({ type: 'ready' })
    exposeToShell({
      setInsets: (top: number, bottom: number, left?: number, right?: number, corner?: number, safe?: { t?: number; r?: number; b?: number; l?: number }) => {
        const t = Math.max(0, Number(top) || 0)
        const b = Math.max(0, Number(bottom) || 0)
        const l = Math.max(0, Number(left) || 0)
        const r = Math.max(0, Number(right) || 0)
        const w = window.innerWidth
        const h = window.innerHeight
        if (w > 0 && h > 0 && (w - l - r <= 0 || h - t - b <= 0)) {
          console.warn(`[shell] insets ${t},${b},${l},${r} leave no room in page ${w}x${h}, kept the old ones`)
          return false
        }
        const root = document.documentElement.style
        root.setProperty('--remote-top', `${t}px`)
        root.setProperty('--remote-bottom', `${b}px`)
        root.setProperty('--remote-left', `${l}px`)
        root.setProperty('--remote-right', `${r}px`)
        document.documentElement.dataset.chrome = l > 0 || r > 0 ? 'rails' : 'bars'
        cornerRadius = Math.max(0, Number(corner) || 0)
        root.setProperty('--remote-corner', `${cornerRadius}px`)
        refloat()
        const sa = { top: safe?.t, right: safe?.r, bottom: safe?.b, left: safe?.l }
        for (const [side, v] of Object.entries(sa)) root.setProperty(`--safe-${side}`, `${Math.max(0, Math.round(Number(v) || 0))}px`)
        window.dispatchEvent(new Event('satura-insets'))
        window.clearTimeout(cornerTimer)
        cornerTimer = window.setTimeout(() => checkCorners('insets'), 900)
        console.info(`[shell] insets top ${t} bottom ${b} left ${l} right ${r}, content ${w - l - r}x${h - t - b} of page ${w}x${h}, safe area ${[sa.top, sa.right, sa.bottom, sa.left].map((v) => Math.round(Number(v) || 0)).join(',')}`)
        return true
      },
      setKeyboard: (height: number) => {
        const px = Math.max(0, Number(height) || 0)
        const pane = typingPane()
        const root = document.documentElement.style
        root.setProperty('--remote-keyboard', `${px}px`)
        root.setProperty('--remote-keyboard-pad', pane ? '0px' : `${px}px`)
        refloat()
        console.info(`[shell] keyboard covers ${px} pt of the panel, ${px === 0 ? 'panel back to full size' : pane ? `only the tuner ${pane} shows above it` : 'panel shrinks above it'}`)
        requestAnimationFrame(() => {
          const el = document.activeElement
          if (px > 0 && typingPane()) revealTyping(`keyboard ${px} pt`)
          else if (px > 0 && el instanceof HTMLElement && el !== document.body) el.scrollIntoView({ block: 'nearest' })
        })
        return true
      },
      openWorkspace: (wsId: string, req: unknown) => {
        console.info(`[shell] open workspace ${wsId}`)
        if (openRef.current !== String(wsId)) setLayoutShown(true)
        setOpen(String(wsId))
        void acked(req, () => (useAppStore.getState().activeWorkspaceId === wsId ? Promise.resolve() : runMirrored('setActiveWorkspace', [wsId])))
        return true
      },
      closeWorkspace: () => {
        setOpen(null)
        return true
      },
      viewerFile: (tabId: string) => useAppStore.getState().viewerFileByTab[String(tabId)] ?? null,
      openFile: (path: string, opts: unknown, req: unknown) => {
        const wsId = openRef.current
        const wt = wsId ? (useAppStore.getState().worktreesByWorkspace[wsId] ?? [])[0] : undefined
        if (!wsId || !wt) {
          ack(req, false, 'No project is open')
          return false
        }
        const file = String(path)
        const o = (opts && typeof opts === 'object' ? opts : {}) as { mode?: unknown; line?: unknown; column?: unknown }
        const line = Number(o.line) > 0 ? Number(o.line) : 0
        const column = Number(o.column) > 0 ? Number(o.column) : 1
        const how = o.mode === 'text' ? { text: true } : o.mode === 'asset' ? { asset: true } : line ? { line, column } : {}
        console.info(`[files] open ${file}${o.mode ? ` as ${String(o.mode)}` : ''}${line ? ` at line ${line}:${column}` : ''} on the Mac`)
        if (line) requestGoto(file, line, column)
        void acked(req, async () => {
          await desktopCall('openFile', [{ file, workspaceId: wsId, worktreeId: wt.id, preview: false, ...how }])
          const shown = await untilShown(wsId, file, 4000)
          console.info(`[files] ${shown ? 'showing' : 'opened, the phone shows the selected tab for'} ${file}`)
          setLayoutShown(false)
        })
        return true
      },
      showHistory: (path: string, req: unknown) => {
        const wsId = openRef.current
        const s = useAppStore.getState()
        const wt = wsId ? (s.worktreesByWorkspace[wsId] ?? [])[0] : undefined
        if (!wsId || !wt) {
          ack(req, false, 'No project is open')
          return false
        }
        const file = String(path)
        console.info(`[files] history of ${file}`)
        postGitHistoryRequest(wt.path, [file])
        void acked(req, async () => {
          const git = (useAppStore.getState().tabsByWorkspace[wsId] ?? []).find((t) => t.contentType === 'git-scm' && t.worktreeId === wt.id)
          if (git) await runMirrored('activateTab', [git.id])
          else {
            const now = useAppStore.getState()
            const group = now.activeGroupIdByWorkspace[wsId] ?? (now.groupsByWorkspace[wsId] ?? [])[0]?.id
            if (!group) throw new Error("There's no panel to open Git next to.")
            await runMirrored('openTabBeside', [wsId, group, wt.id, { label: GIT_TAB_LABEL, contentType: 'git-scm' }])
          }
          const shown = await untilKind(wsId, 'git-scm', 4000)
          console.info(`[files] history of ${file} ${shown ? 'shows in Git' : 'was sent, Git is not the selected tab yet'}`)
          setLayoutShown(false)
        })
        return true
      },
      selectTab: (tabId: string, req: unknown) => {
        console.info(`[shell] select tab ${tabId}`)
        setLayoutShown(false)
        void acked(req, () => runMirrored('activateTab', [String(tabId)]))
        return true
      },
      key: (name: string, req: unknown) => {
        const seq = keySequence(String(name))
        const pty = shownPty
        console.info(`[shell] key ${name} -> ${pty ?? 'no terminal'}`)
        if (!seq || !pty) {
          ack(req, false, pty ? `Unknown key ${name}` : 'No terminal is open')
          return false
        }
        void acked(req, () => writePty(pty, seq))
        return true
      },
      send: (text: string, req: unknown, images?: unknown) => {
        const pty = shownPty
        const paths = Array.isArray(images) ? images.map(String) : []
        console.info(`[shell] send ${paths.length ? `${paths.length} images and ` : ''}${JSON.stringify(String(text).slice(0, 80))} -> ${pty ?? 'no terminal'}`)
        if (!pty) {
          ack(req, false, 'No terminal is open')
          return false
        }
        void acked(req, async () => {
          await pasteImagePaths(getTerminalInstance(pty), paths, (data) => writePty(pty, data))
          const typed = writePty(pty, String(text))
          await new Promise((r) => setTimeout(r, 60))
          await Promise.all([typed, writePty(pty, '\r')])
        })
        return true
      },
      type: (text: string) => {
        const pty = shownPty
        if (!pty) return false
        void writePty(pty, String(text)).catch((e: unknown) => console.warn(`[shell] typing into ${pty} failed: ${e instanceof Error ? e.message : String(e)}`))
        return true
      },
      revealInput: () => {
        const term = shownPty ? getTerminalInstance(shownPty) : undefined
        const buf = term?.buffer.active
        if (!term || !buf || buf.viewportY >= buf.baseY) return false
        console.info(`[shell] typing scrolls ${shownPty} back to the bottom from ${buf.baseY - buf.viewportY} lines up`)
        term.scrollToBottom()
        return true
      },
      paste: (text: string) => {
        const term = shownPty ? getTerminalInstance(shownPty) : undefined
        console.info(`[shell] paste ${String(text).length} chars -> ${shownPty ?? 'no terminal'}`)
        term?.paste(String(text))
        return !!term
      },
      answer: (ptyId: string, keyName: string, req: unknown) => {
        const seq = keySequence(String(keyName))
        console.info(`[shell] answer ${keyName} -> ${ptyId}`)
        if (!seq) {
          ack(req, false, `Unknown answer ${keyName}`)
          return false
        }
        void acked(req, () => writePty(String(ptyId), seq))
        return true
      },
      back: () => {
        if (!layoutShown && !canGoBackInPanel()) {
          setLayoutShown(true)
          console.info('[shell] back to layout')
          return true
        }
        const used = goBackInPanel()
        console.info(`[shell] back ${used ? 'in panel' : 'to projects'}`)
        return used
      },
      retry: (id: number) => retry(Number(id)),
      setVisible: (visible: boolean) => {
        presence.visible = !!visible
        console.info(`[shell] app ${visible ? 'foreground' : 'background'}`)
        pushPresence(true)
        return true
      },
      setDevice: (name: string) => {
        presence.device = String(name || 'iPhone').slice(0, 60)
        setPhoneDevice(presence.device)
        pushPresence(true)
        return true
      },
      setOverlay: (name: unknown) => {
        setPresence({ overlay: name === 'files' ? 'files' : null })
        return true
      }
    })
  }, [])

  return open ? <PhoneWorkspace id={open} epoch={epoch} /> : null
}
