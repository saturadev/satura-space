import type { TabContentType, TabGroupLayoutNode } from '@shared/types'
import { useAppStore, type AppState } from '../store'
import { setCapture } from '../lib/capture'
import { remeasureTerminals } from '../lib/terminal/terminal-registry'
import { defineHandle, type RendererCtx } from './registry'
import { panes, settle } from './layout'

const LAYOUTS: Record<string, [TabContentType, number][]> = {
  tuner: [['tuner', 1]],
  'terminal+tuner': [['terminal', 0.3], ['tuner', 0.7]],
  'unity+terminal': [['unity-instance-player', 0.62], ['terminal', 0.38]]
}

interface Snapshot {
  ws: string
  sidebarOpen: boolean
  tabs: AppState['tabsByWorkspace'][string]
  groups: AppState['groupsByWorkspace'][string]
  layout: TabGroupLayoutNode
  fullscreen: string | null
  activeGroup: string
}

let snapshot: Snapshot | null = null

function take(s: AppState, ws: string): Snapshot {
  return {
    ws,
    sidebarOpen: s.sidebarOpen,
    tabs: s.tabsByWorkspace[ws],
    groups: s.groupsByWorkspace[ws],
    layout: s.layoutByWorkspace[ws],
    fullscreen: s.fullscreenGroupIdByWorkspace[ws] ?? null,
    activeGroup: s.activeGroupIdByWorkspace[ws]
  }
}

function restore(snap: Snapshot): void {
  const s = useAppStore.getState()
  const ws = snap.ws
  useAppStore.setState({
    tabsByWorkspace: { ...s.tabsByWorkspace, [ws]: snap.tabs },
    groupsByWorkspace: { ...s.groupsByWorkspace, [ws]: snap.groups },
    layoutByWorkspace: { ...s.layoutByWorkspace, [ws]: snap.layout },
    fullscreenGroupIdByWorkspace: { ...s.fullscreenGroupIdByWorkspace, [ws]: snap.fullscreen },
    activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [ws]: snap.activeGroup }
  })
  useAppStore.getState().setSidebarOpen(snap.sidebarOpen)
}

function shownTabOf(s: AppState, ws: string, kind: TabContentType): { id: string; groupId: string } {
  const tabs = (s.tabsByWorkspace[ws] ?? []).filter((t) => t.contentType === kind)
  if (!tabs.length) throw new Error(`The preset needs a ${kind} tab and the workspace has none.`)
  const groups = s.groupsByWorkspace[ws] ?? []
  const shown = tabs.find((t) => groups.find((g) => g.id === t.groupId)?.activeTabId === t.id)
  return shown ?? tabs[0]
}

function arrange(ws: string, layout: string): void {
  const spec = LAYOUTS[layout]
  if (!spec) return
  let s = useAppStore.getState()
  if (s.fullscreenGroupIdByWorkspace[ws]) s.exitFullscreen(ws)
  const first = shownTabOf(s, ws, spec[0][0])
  s.activateTab(first.id)
  if (spec.length === 1) {
    useAppStore.getState().toggleGroupFullscreen(ws, first.groupId)
    return
  }
  s = useAppStore.getState()
  let second = shownTabOf(s, ws, spec[1][0])
  if (second.groupId === first.groupId) {
    s.moveTabToSplit(second.id, first.groupId, 'horizontal', 'second')
    s = useAppStore.getState()
    second = s.tabsByWorkspace[ws].find((t) => t.id === second.id)!
  }
  s.activateTab(second.id)
  s.activateTab(first.id)
  const next: TabGroupLayoutNode = { type: 'split', direction: 'horizontal', first: { type: 'leaf', groupId: first.groupId }, second: { type: 'leaf', groupId: second.groupId }, ratio: spec[0][1] }
  useAppStore.setState({ layoutByWorkspace: { ...useAppStore.getState().layoutByWorkspace, [ws]: next } })
}

defineHandle({
  name: 'capture.apply',
  side: 'renderer',
  description:
    'The window half of capture.mode: on hides the status bar, toasts and Drift highlight frame, swaps text with replace and name, sets the sidebar and arranges the panes for layout; off puts the tabs, groups, layout, sidebar back as they were. Call capture.mode instead, it also sizes the window.',
  params: { on: true, name: '', replace: {}, sidebar: true, layout: '' },
  async run(p, ctx: RendererCtx) {
    const ws = ctx.workspaceId
    if (p.on === false) {
      setCapture({ on: false, name: '', replace: [] })
      const snap = snapshot
      snapshot = null
      if (snap) restore(snap)
      await settle()
      remeasureTerminals()
      return panes(snap?.ws ?? ws)
    }
    if (!ws) throw new Error('This call has no project workspace.')
    const s = useAppStore.getState()
    if (!snapshot) snapshot = take(s, ws)
    else restore(snapshot)
    const replace = Object.entries((p.replace as Record<string, unknown>) ?? {}).map(([k, v]) => [k, String(v ?? '')] as [string, string])
    const project = s.workspaces.find((w) => w.id === ws)
    if (p.name && project?.name) replace.push([project.name, String(p.name)])
    replace.sort((a, b) => b[0].length - a[0].length)
    setCapture({ on: true, name: String(p.name ?? ''), replace })
    useAppStore.getState().setSidebarOpen(p.sidebar !== false)
    arrange(ws, String(p.layout ?? ''))
    await settle()
    remeasureTerminals()
    return panes(ws)
  }
})
