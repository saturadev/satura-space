import type { OpenFileRequest } from '@shared/api'
import { useAppStore, type AppState } from '../../store'
import { toPosixPath } from '../path'
import { requestGoto } from './goto-line'
import { planFileOpen } from './file-open-plan'
import { checkUnityProject, knownUnityProject } from '../unity/unity-project-cache'
import { assetFileName, assetTunerViewName, opensInSatura, unityAssetKind, unityAssetRelPath } from '@shared/unity-assets'
import { openSceneInEditor, openTunerView } from '../tuner/open-tuner'
import type { Tab, TunerTarget, Worktree } from '@shared/types'
import { isReactReport } from '@shared/report-compile'
import { assetProjectRoot, scratchpadOwnerOf } from '@shared/scratchpads'
import { openReportSegment } from '../terminal/report-groups'
import { refreshReportsOf } from '../terminal/terminal-reports'

export interface WorkbenchOpenRequest {
  file: string
  line?: number
  column?: number
  projectPath?: string
  workspaceId?: string
  worktreeId?: string
  ptyId?: string
  sourceGroupId?: string
  preview?: boolean
  live?: boolean
  highlight?: boolean
  text?: boolean
  meta?: boolean
  asset?: boolean
  newTab?: boolean
}

interface Target {
  workspaceId: string
  worktreeId: string
}

function within(file: string, root: string): boolean {
  return !!root && (file === root || file.startsWith(`${root.replace(/\/+$/, '')}/`))
}

function resolveTarget(s: AppState, req: WorkbenchOpenRequest, file: string): Target | null {
  if (req.workspaceId && req.worktreeId) return { workspaceId: req.workspaceId, worktreeId: req.worktreeId }
  if (req.ptyId) {
    for (const [workspaceId, tabs] of Object.entries(s.tabsByWorkspace)) {
      const tab = tabs.find((t) => t.ptyId === req.ptyId)
      if (tab) return { workspaceId, worktreeId: tab.worktreeId }
    }
  }
  const project = req.projectPath ? toPosixPath(req.projectPath) : ''
  let best: (Target & { len: number }) | null = null
  for (const [workspaceId, wts] of Object.entries(s.worktreesByWorkspace)) {
    for (const wt of wts) {
      const p = toPosixPath(wt.path)
      const len = p === project ? Number.MAX_SAFE_INTEGER : file && within(file, p) ? p.length : -1
      if (len < 0) continue
      const preferActive = workspaceId === s.activeWorkspaceId ? 0.5 : 0
      if (!best || len + preferActive > best.len) best = { workspaceId, worktreeId: wt.id, len: len + preferActive }
    }
  }
  if (best) return { workspaceId: best.workspaceId, worktreeId: best.worktreeId }
  if (project) return null
  const ws = s.activeWorkspaceId
  if (!ws) return null
  const tabs = s.tabsByWorkspace[ws] ?? []
  const activeGroup = s.groupsByWorkspace[ws]?.find((g) => g.id === s.activeGroupIdByWorkspace[ws])
  const activeTab = tabs.find((t) => t.id === activeGroup?.activeTabId)
  const worktreeId = activeTab?.worktreeId ?? s.worktreesByWorkspace[ws]?.[0]?.id ?? tabs[0]?.worktreeId
  return worktreeId ? { workspaceId: ws, worktreeId } : null
}

function assetRoot(file: string, wtPath: string): { root: string; scratchpadId: string | null } {
  const pad = scratchpadOwnerOf(toPosixPath(wtPath), file)
  return pad ? { root: pad.root, scratchpadId: pad.id } : { root: toPosixPath(wtPath), scratchpadId: null }
}

function assetRelPath(req: WorkbenchOpenRequest, file: string, root: string | undefined): string | null {
  if (!root || req.text || req.line || req.live) return null
  const known = knownUnityProject(root)
  if (known === undefined) void checkUnityProject(root)
  if (known !== true) return null
  return unityAssetRelPath(root, file)
}

function cachedMeta(s: AppState, worktreeId: string, file: string): boolean | undefined {
  if (!file.includes('/')) return undefined
  const dir = file.slice(0, file.lastIndexOf('/'))
  const meta = `${file}.meta`
  for (const [key, entries] of Object.entries(s.dirCacheByWorktree[worktreeId] ?? {})) {
    if (!Array.isArray(entries) || toPosixPath(key) !== dir) continue
    return entries.some((e) => toPosixPath(e.path) === meta)
  }
  return undefined
}

function assetTarget(rel: string | null, meta: boolean | undefined): TunerTarget | null {
  return rel && !opensInSatura(rel) && (meta === true || unityAssetKind(rel) != null) ? { kind: 'file', id: rel } : null
}

function assetFiles(tabs: Tab[], worktrees: Worktree[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const t of tabs) {
    if (t.contentType !== 'tuner' || t.tuner?.kind !== 'file') continue
    const root = worktrees.find((w) => w.id === t.worktreeId)?.path
    if (root) out[t.id] = `${assetProjectRoot(toPosixPath(root), t.scratchpadId)}/${t.tuner.id}`
  }
  return out
}

let remoteOpener: ((req: WorkbenchOpenRequest) => boolean) | null = null

export function setRemoteFileOpener(fn: ((req: WorkbenchOpenRequest) => boolean) | null): void {
  remoteOpener = fn
}

export function openFileInWorkbench(req: WorkbenchOpenRequest): boolean {
  if (remoteOpener) return remoteOpener(req)
  const file = req.file ? toPosixPath(req.file) : ''
  const s = useAppStore.getState()
  const target = resolveTarget(s, req, file)
  if (!target) return false
  const { workspaceId, worktreeId } = target
  if (s.activeWorkspaceId !== workspaceId) s.setActiveWorkspace(workspaceId)
  if (!file) return true
  if (isReactReport(file) && !req.text && !req.line && openReportSegment(file, { highlight: req.highlight })) return true

  const wtPath = s.worktreesByWorkspace[workspaceId]?.find((w) => w.id === worktreeId)?.path
  const owner = wtPath ? assetRoot(file, wtPath) : null
  if (owner?.scratchpadId && !req.text && !req.line && !req.live && knownUnityProject(owner.root) === undefined) {
    void checkUnityProject(owner.root).then(() =>
      openFileInWorkbench({ ...req, workspaceId, worktreeId, ...(knownUnityProject(owner.root) === undefined ? { text: true } : {}) })
    )
    return true
  }
  const rel = assetRelPath(req, file, owner?.root)
  const meta = req.meta ?? (rel ? cachedMeta(s, worktreeId, file) : undefined)
  if (rel && !req.asset && meta === undefined && unityAssetKind(rel) == null && !opensInSatura(rel)) {
    void window.api.fs
      .statPath(`${file}.meta`)
      .then((info) => info.exists && info.isFile, () => false)
      .then((found) => openFileInWorkbench({ ...req, workspaceId, worktreeId, meta: found }))
    return true
  }
  if (rel && owner && unityAssetKind(rel) === 'scene' && !req.text && !req.line && !req.live) {
    if (req.asset) void openTunerView({ projectPath: owner.root, view: assetTunerViewName(rel), paneKey: '' })
    else void openSceneInEditor(owner.root, rel, { workspaceId, worktreeId, scratchpadId: owner.scratchpadId })
    return true
  }
  if (wtPath && within(file, toPosixPath(wtPath))) s.openFileInWorktree(worktreeId, file)
  if (req.line && req.line > 0) requestGoto(file, req.line, req.column && req.column > 0 ? req.column : 1)

  const preview = req.preview === true
  const asset: TunerTarget | null = req.asset && rel ? { kind: 'file', id: rel } : assetTarget(rel, meta)
  const assetLabel = asset ? assetFileName(asset.id) : ''
  const assetPad = owner?.scratchpadId ?? null
  if (asset) retargetAssetTuner(workspaceId, worktreeId, asset.id, assetPad)
  const st = useAppStore.getState()
  const fullscreenGroupId = st.fullscreenGroupIdByWorkspace[workspaceId] ?? null
  const activeGroup = st.activeGroupIdByWorkspace[workspaceId] ?? null
  const sourceGroup = (st.groupsByWorkspace[workspaceId] ?? []).find((g) => g.id === (req.sourceGroupId ?? activeGroup))?.id
  const plan: ReturnType<typeof planFileOpen> = req.newTab && sourceGroup && !asset ? { kind: 'create', groupId: sourceGroup } : planFileOpen({
    asset: !!asset,
    assetFileByTab: assetFiles(st.tabsByWorkspace[workspaceId] ?? [], st.worktreesByWorkspace[workspaceId] ?? []),
    filePath: file,
    worktreeId,
    preview,
    tabs: st.tabsByWorkspace[workspaceId] ?? [],
    groups: st.groupsByWorkspace[workspaceId] ?? [],
    layout: st.layoutByWorkspace[workspaceId],
    fullscreenGroupId,
    activeGroupId: st.activeGroupIdByWorkspace[workspaceId] ?? null,
    viewerFileByTab: st.viewerFileByTab
  })

  let tabId: string | null = null
  if (plan.kind === 'reuse') {
    tabId = plan.tabId
    if (!preview) st.promoteTab(tabId)
    if (req.live) st.setViewerLive(tabId, true)
  } else if (plan.kind === 'replace') {
    tabId = plan.tabId
    showFileIn(tabId, file, asset, assetLabel, req.live, assetPad)
    if (!preview) st.promoteTab(tabId)
  } else if (plan.kind === 'create') {
    const tab = st.createTab(workspaceId, worktreeId, {
      groupId: plan.groupId,
      contentType: asset ? 'tuner' : 'file-viewer',
      label: asset ? assetLabel : 'Viewer',
      tuner: asset,
      scratchpadId: asset ? assetPad : null,
      preview
    })
    tabId = tab.id
    if (!asset) st.setViewerFile(tabId, file, { live: req.live })
  } else {
    const groups = st.groupsByWorkspace[workspaceId] ?? []
    const source =
      groups.find((g) => g.id === req.sourceGroupId)?.id ??
      st.activeGroupIdByWorkspace[workspaceId] ??
      groups[0]?.id
    const tab = source ? st.openFileViewerSplit(workspaceId, source, worktreeId, 0.5) : null
    if (!tab) return false
    tabId = tab.id
    showFileIn(tabId, file, asset, assetLabel, req.live, assetPad)
    if (!preview) st.promoteTab(tabId)
  }

  const after = useAppStore.getState()
  const tab = (after.tabsByWorkspace[workspaceId] ?? []).find((t) => t.id === tabId)
  if (!tab) return false
  if (fullscreenGroupId && fullscreenGroupId !== tab.groupId) after.exitFullscreen(workspaceId)
  after.activateTab(tab.id)
  if (req.highlight) after.pulseAgentPane(tab.ptyId, 'opened')
  return true
}

function retargetAssetTuner(workspaceId: string, worktreeId: string, rel: string, pad: string | null): void {
  const s = useAppStore.getState()
  const tabs = s.tabsByWorkspace[workspaceId] ?? []
  const same = (t: Tab): boolean => t.contentType === 'tuner' && t.tuner?.kind === 'file' && t.tuner.id === rel && t.worktreeId === worktreeId
  if (tabs.some((t) => same(t) && (t.scratchpadId ?? null) === pad)) return
  const other = tabs.find(same)
  if (!other) return
  console.info(`[tuner] open ${rel} on ${pad ?? 'project'} retargets ${other.label} (${other.id}) from ${other.scratchpadId ?? 'project'}`)
  s.setTabScratchpad(other.id, pad)
}

function showFileIn(tabId: string, file: string, asset: TunerTarget | null, label: string, live?: boolean, scratchpadId?: string | null): void {
  const st = useAppStore.getState()
  if (asset) {
    st.setTabContent(tabId, 'tuner', asset, label)
    if (scratchpadId) st.setTabScratchpad(tabId, scratchpadId)
    return
  }
  const tab = Object.values(st.tabsByWorkspace).flat().find((t) => t.id === tabId)
  if (tab && tab.contentType !== 'file-viewer') st.setTabContent(tabId, 'file-viewer', null, 'Viewer')
  st.setViewerFile(tabId, file, { live })
}

export async function handleExternalOpenFile(req: OpenFileRequest): Promise<void> {
  if (req.file && isReactReport(req.file)) await refreshReportsOf(req.file).catch(() => undefined)
  openFileInWorkbench({
    file: req.file,
    line: req.line,
    column: req.column,
    projectPath: req.projectPath,
    ptyId: req.ptyId,
    preview: req.preview,
    highlight: true
  })
}

export function openFileInApp(req: OpenFileRequest): void {
  void window.api.app.openFile(req).catch(() => {})
}
