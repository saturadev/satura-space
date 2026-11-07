import type { Tab } from '@shared/types'
import type {
  CloseDone,
  CloseOrder,
  ExecRendererRequest,
  ExecRunStatus,
  ExecSnapshot,
  SnapshotQuery,
  SpawnDone,
  SpawnOrder
} from '@shared/agent-exec'
import { getAgentEntry } from '@shared/agent-catalog'
import type { TunerTabInfo } from '@shared/tuner-find'
import { tunerTargetView } from '@shared/tuner-scope'
import { useAppStore, type AppState } from '../../store'
import { agentRunStatusFor } from '../agent-status'
import {
  setPendingCommand,
  setPendingEnv,
  takePendingCommand,
  takePendingEnv
} from '../terminal/pending-commands'
import { setWorkspaceDriven } from './driven'
import { actOnPanes, paneModelOf, takePlaced } from './panes'
import { execTabs } from './tabs'
import { shownTab } from '../tab-tree'
import { collectReportExport } from '../../components/report/export-collect'
import { rendererHandleList, runRendererHandle, windowCensus } from '../../handles'

function comparablePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function workspaceOfPty(s: AppState, ptyId: string): string | null {
  for (const [wsId, tabs] of Object.entries(s.tabsByWorkspace)) {
    if (tabs.some((t) => t.ptyId === ptyId && t.contentType === 'terminal')) return wsId
  }
  return null
}

function workspaceOfPath(s: AppState, root: string): string | null {
  const want = comparablePath(root)
  if (!want) return null
  for (const ws of s.workspaces) {
    const paths = [
      ws.folderPath,
      ws.worktreePath,
      ...(s.worktreesByWorkspace[ws.id] ?? []).map((w) => w.path)
    ]
    if (paths.some((p) => !!p && comparablePath(p) === want)) return ws.id
  }
  return null
}

function statusOf(s: AppState, tab: Tab): ExecRunStatus {
  if (s.exitedPtyIds.includes(tab.ptyId)) return 'exited'
  const status = agentRunStatusFor(tab, false, s.agentHookStatusByPty[tab.ptyId])
  return status === 'idle' ? 'finished' : status
}

export function execSnapshot(s: AppState, query: SnapshotQuery): ExecSnapshot | null {
  const wsId = query.ptyId
    ? workspaceOfPty(s, query.ptyId)
    : query.projectRoot
      ? workspaceOfPath(s, query.projectRoot)
      : null
  if (!wsId) return null
  const worktrees = s.worktreesByWorkspace[wsId] ?? []
  const shells = (s.tabsByWorkspace[wsId] ?? []).filter((t) => t.contentType === 'terminal')
  const parents = new Set(shells.map((t) => t.parentPtyId).filter((id): id is string => !!id))
  const terminals = shells
    .filter(
      (t) => !!t.agentId || !!t.parentPtyId || parents.has(t.ptyId) || t.ptyId === query.ptyId
    )
    .map((t) => ({
      ptyId: t.ptyId,
      label: t.customLabel ?? t.generatedLabel ?? t.label,
      agentId: t.agentId ?? null,
      status: statusOf(s, t),
      parentPtyId: t.parentPtyId ?? null,
      cwd: worktrees.find((w) => w.id === t.worktreeId)?.path ?? '',
      sessionId: t.claudeSessionId ?? null
    }))
  return { workspace: s.workspaces.find((w) => w.id === wsId)?.name ?? '', workspaceId: wsId, terminals }
}

function spawnChild(order: SpawnOrder): SpawnDone {
  const entry = getAgentEntry(order.agentId)
  if (!entry) return { error: `Unknown agent ${order.agentId}.` }
  setPendingCommand(order.ptyId, order.command)
  setPendingEnv(order.ptyId, order.env)
  const tab = useAppStore.getState().openChildAgentTab({
    callerPtyId: order.callerPtyId,
    ptyId: order.ptyId,
    placement: order.placement,
    agentId: order.agentId,
    label: entry.label,
    customLabel: order.label
  })
  if (!tab) {
    takePendingCommand(order.ptyId)
    takePendingEnv(order.ptyId)
    const why = "Satura Space can't find your tab in this window"
    return { error: `${why}, so it has nowhere to open the new agent.` }
  }
  return { ptyId: tab.ptyId, label: tab.customLabel ?? tab.label }
}

function closeTerminals(order: CloseOrder): CloseDone {
  const closed: string[] = []
  for (const ptyId of order.ptyIds) {
    const s = useAppStore.getState()
    const tab = Object.values(s.tabsByWorkspace)
      .flat()
      .find((t) => t.ptyId === ptyId && t.contentType === 'terminal')
    if (!tab) continue
    s.closeTab(tab.id)
    closed.push(ptyId)
  }
  return { closed }
}

function tunerTabsOf(s: Pick<AppState, 'tabsByWorkspace' | 'groupsByWorkspace' | 'activeGroupIdByWorkspace' | 'fullscreenGroupIdByWorkspace'>, workspaceId: string): TunerTabInfo[] {
  const all = s.tabsByWorkspace[workspaceId] ?? []
  const groups = s.groupsByWorkspace[workspaceId] ?? []
  const full = s.fullscreenGroupIdByWorkspace[workspaceId]
  const active = s.activeGroupIdByWorkspace[workspaceId]
  return all
    .filter((t) => t.contentType === 'tuner')
    .map((t) => {
      const g = groups.find((x) => x.id === t.groupId)
      const shown = !!g && !g.hidden && (!full || full === g.id) && shownTab(g, all)?.id === t.id
      const view = tunerTargetView(t.tuner)
      const base = t.tuner ? tunerTargetView({ kind: t.tuner.kind, id: t.tuner.id }) : ''
      return { tabId: t.id, view, base, label: t.label, shown, focused: !!g && g.id === active, ...(t.scratchpadId ? { scratchpad: t.scratchpadId } : {}) }
    })
}

function showTuners(payload: { workspaceId: string; show?: string }): TunerTabInfo[] {
  const s = useAppStore.getState()
  if (payload.show) {
    const tab = (s.tabsByWorkspace[payload.workspaceId] ?? []).find((t) => t.id === payload.show && t.contentType === 'tuner')
    if (tab) {
      const full = s.fullscreenGroupIdByWorkspace[payload.workspaceId]
      if (full && full !== tab.groupId) s.exitFullscreen(payload.workspaceId)
      useAppStore.getState().activateTab(tab.id)
    }
  }
  return tunerTabsOf(useAppStore.getState(), payload.workspaceId)
}

export function handleExecRequest(request: ExecRendererRequest): unknown {
  switch (request.kind) {
    case 'snapshot':
      return execSnapshot(useAppStore.getState(), request.payload)
    case 'spawn':
      return spawnChild(request.payload)
    case 'close':
      return closeTerminals(request.payload)
    case 'drive':
      setWorkspaceDriven(request.payload.workspaceId, request.payload.on)
      return true
    case 'tuners':
      return showTuners(request.payload)
    case 'panes': {
      const { workspaceId, ptyId, take, act, groupId } = request.payload
      const read = (): unknown => {
        const model = paneModelOf(useAppStore.getState(), workspaceId, ptyId)
        return model ? { ...model, placed: take ? takePlaced(workspaceId) : null } : null
      }
      return act ? actOnPanes(workspaceId, act, groupId).then(read) : read()
    }
    case 'reportExport':
      return collectReportExport(request.payload.file, request.payload.root)
    case 'handle':
      return runRendererHandle(request.payload)
    case 'handles':
      return rendererHandleList()
    case 'census':
      return windowCensus(request.payload.reset)
    case 'tabs':
      return execTabs(request.payload)
    default:
      return null
  }
}

export function installAgentExecBridge(): () => void {
  return window.api.agentExec.onRequest(handleExecRequest)
}
