import { TUNER_SCENE_VIEW, type TunerOpenRequest, type TunerView } from '@shared/tuner'
import type { Tab, TabGroup, TunerTarget } from '@shared/types'
import { baseOfView, baseScope, filterBase, isBaseView, isSceneTuner, viewScope } from '@shared/tuner-scope'
import { assetFileName, assetTunerView, unityAssetKind } from '@shared/unity-assets'
import { useAppStore } from '../../store'
import { pickTunerTab, resolveTunerOpenTarget, sceneTunerTab } from './tuner-target'
import { resolveSceneSwitch } from './unsaved'
import { useWorldStore } from '../unity/world-store'
import { scratchpadParentProject } from '@shared/scratchpads'
import { placeDriftTab } from '../agent-exec/panes'
import { debugLog } from '@shared/debug-log'

export function tunerLabel(view: string): string {
  return `Tuner: ${view}`
}

export function tunerTargetLabel(t: TunerTarget): string {
  if (t.filter) return tunerLabel(t.filter)
  return t.kind === 'file' ? assetFileName(t.id) : tunerLabel(t.id)
}

function findView(views: TunerView[], name: string): TunerView | null {
  return assetTunerView(name) ?? views.find((v) => v.name === name) ?? views.find((v) => v.name.toLowerCase() === name.toLowerCase()) ?? null
}

export async function ensureSceneView(projectPath: string, views: TunerView[]): Promise<void> {
  if (views.some((v) => v.name === TUNER_SCENE_VIEW)) return
  await window.api.tuner.writeQuickView(projectPath, { kind: 'scene' })
}

export async function switchEditorScene(projectPath: string, scene: string): Promise<boolean> {
  const w = useWorldStore.getState().worlds[projectPath]
  const ids = w ? Object.keys(w.observed.instances) : []
  const open = w ? Object.values(w.observed.instances).find((i) => i.role === 'primary')?.scene : undefined
  if (!ids.length || open === scene) return true
  if (!(await resolveSceneSwitch(projectPath))) {
    debugLog(`[tuner] kept ${open ?? 'the open scene'}: the switch to ${scene} was cancelled`)
    return false
  }
  debugLog(`[tuner] the scene Tuner switches the editor from ${open ?? '-'} to ${scene}`)
  const st = useWorldStore.getState()
  for (const id of ids) st.setScene(projectPath, id, scene)
  return true
}

export async function openSceneInEditor(projectPath: string, scene: string, at: { workspaceId: string; worktreeId: string; scratchpadId: string | null }): Promise<void> {
  const w = useWorldStore.getState().worlds[projectPath]
  if (w && Object.values(w.observed.instances).some((i) => i.alive)) {
    debugLog(`[tuner] scene click opens ${scene} in the editor of ${projectPath}`)
    await switchEditorScene(projectPath, scene)
    return
  }
  debugLog(`[tuner] scene click: no editor runs for ${projectPath}, starting it on ${scene}`)
  window.api.unity.setLastScene(projectPath, scene)
  if (at.scratchpadId) {
    const parent = scratchpadParentProject(projectPath)
    if (parent) void window.api.scratchpads.start(parent, at.scratchpadId)
    return
  }
  const st = useAppStore.getState()
  const player = (st.tabsByWorkspace[at.workspaceId] ?? []).find((t) => t.contentType === 'unity-instance-player' && t.worktreeId === at.worktreeId)
  if (player) {
    st.activateTab(player.id)
    return
  }
  const group = st.activeGroupIdByWorkspace[at.workspaceId] ?? st.ensureWorkbench(at.workspaceId)
  st.openTabBeside(at.workspaceId, group, at.worktreeId, { label: 'Unity Player', contentType: 'unity-instance-player' })
}

function otherTargetTuner(
  tabs: Tab[],
  worktreeId: string,
  scratchpadId: string | null,
  groups: TabGroup[],
  choose: (pad: string | null) => { picked: Tab | null; single: Tab | null }
): { picked: Tab | null; single: Tab | null; from: string | null } | null {
  const shown = new Set(groups.map((g) => g.activeTabId).filter((id): id is string => !!id))
  const pads = new Set(tabs.filter((t) => t.contentType === 'tuner' && t.worktreeId === worktreeId).map((t) => t.scratchpadId ?? null))
  pads.delete(scratchpadId)
  const found = [...pads]
    .map((from) => ({ ...choose(from), from }))
    .filter((c) => c.single ?? c.picked)
  const tab = (c: (typeof found)[number]): Tab => (c.single ?? c.picked)!
  found.sort((a, b) => Number(shown.has(tab(b).id)) - Number(shown.has(tab(a).id)) || (tab(b).createdAt ?? 0) - (tab(a).createdAt ?? 0))
  return found[0] ?? null
}

export async function openTunerView(req: TunerOpenRequest): Promise<boolean> {
  const views = await window.api.tuner.listViews(req.projectPath).catch(() => [] as TunerView[])
  const s = useAppStore.getState()
  const target = resolveTunerOpenTarget(s, req)
  if (!target) return false
  const { workspaceId, worktreeId, agentTab, scratchpadId } = target
  if (!req.quiet && s.activeWorkspaceId !== workspaceId) s.setActiveWorkspace(workspaceId)
  const asBase = isBaseView(req.view)
  const requested = findView(views, req.view)
  const base = asBase ? baseOfView(req.view) : requested ? filterBase(requested) : { kind: 'view' as const, id: TUNER_SCENE_VIEW }
  const want = asBase ? baseScope(base, requested) : requested ? viewScope(requested) : baseScope(base, null)
  const sceneFile = asBase && base.kind === 'file' && unityAssetKind(base.id) === 'scene'
  const scopeOf = (t: Tab) => {
    const sc = t.tuner ? baseScope(t.tuner, t.tuner.kind === 'view' ? findView(views, t.tuner.id) : null) : null
    return sceneFile && sc?.kind === 'scene' && !sc.scene ? null : sc
  }
  const tabs = useAppStore.getState().tabsByWorkspace[workspaceId] ?? []
  const groups = useAppStore.getState().groupsByWorkspace[workspaceId] ?? []
  const sceneWant = want.kind === 'scene' && isSceneTuner(base)
  const choose = (pad: string | null): { picked: Tab | null; single: Tab | null } => {
    const picked = pickTunerTab(tabs, worktreeId, pad, want, scopeOf)
    return { picked, single: sceneWant && !(picked && isSceneTuner(picked.tuner)) ? sceneTunerTab(tabs, worktreeId, pad, groups) : null }
  }
  const here = choose(scratchpadId)
  const moved = !here.picked && !here.single ? otherTargetTuner(tabs, worktreeId, scratchpadId, groups, choose) : null
  const { picked, single } = moved ?? here
  const existing = single ?? picked
  const st = useAppStore.getState()
  if (moved && existing)
    console.info(`[tuner] open on ${scratchpadId ?? 'project'} retargets ${existing.label} (${existing.id}) from ${moved.from ?? 'project'} instead of opening another Tuner`)
  if (single) {
    debugLog(`[tuner] one scene Tuner per project: ${req.view} opens in ${single.label}`)
    if (sceneFile && !(await switchEditorScene(req.projectPath, base.id))) {
      st.activateTab(single.id)
      return true
    }
  }
  if (existing) {
    const keep = existing.tuner ?? base
    const swap = !!single && sceneFile && existing.tuner?.kind === 'file'
    const tuner: TunerTarget = swap ? base : asBase ? (existing.tuner && !(req.unfilter && existing.tuner.filter) ? existing.tuner : { kind: keep.kind, id: keep.id }) : { kind: keep.kind, id: keep.id, filter: req.view }
    if (tuner.kind === 'view' && tuner.id === TUNER_SCENE_VIEW) await ensureSceneView(req.projectPath, views)
    if (tuner !== existing.tuner) st.setTabTuner(existing.id, tuner, tunerTargetLabel(tuner), scratchpadId)
    else if (moved) st.setTabScratchpad(existing.id, scratchpadId)
    if (st.fullscreenGroupIdByWorkspace[workspaceId] && st.fullscreenGroupIdByWorkspace[workspaceId] !== existing.groupId)
      st.exitFullscreen(workspaceId)
    st.activateTab(existing.id)
    st.pulseAgentPane(existing.ptyId, 'opened')
    return true
  }
  const tuner: TunerTarget = asBase ? base : { ...base, filter: req.view }
  if (tuner.kind === 'view' && tuner.id === TUNER_SCENE_VIEW) await ensureSceneView(req.projectPath, views)
  const opts = { label: tunerTargetLabel(tuner), contentType: 'tuner' as const, tuner, scratchpadId }
  const planned = req.quiet ? placeDriftTab(workspaceId, worktreeId, opts, agentTab?.ptyId ?? req.paneKey) : null
  if (planned) {
    useAppStore.getState().pulseAgentPane(planned.ptyId, 'opened')
    return true
  }
  const st2 = useAppStore.getState()
  const sourceGroupId = agentTab?.groupId ?? st2.activeGroupIdByWorkspace[workspaceId] ?? st2.ensureWorkbench(workspaceId)
  const tab = st2.openTabBeside(workspaceId, sourceGroupId, worktreeId, opts)
  useAppStore.getState().pulseAgentPane(tab.ptyId, 'opened')
  return true
}
