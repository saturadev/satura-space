import type { AgentId } from '@shared/types'
import { AGENT_CATALOG, buildAgentLaunchCommand, getAgentEntry } from '@shared/agent-catalog'
import { isSceneTuner } from '@shared/tuner-scope'
import type { AppState } from '../../store'
import { setPendingCommand } from '../terminal/pending-commands'
import { GIT_TAB_LABEL } from '../tab-label'
import { openClaudeSessionPicker } from '../claude-sessions/launch-restore'
import { openReportsPicker } from '../../components/report/ReportsPicker'
import { openDashboard } from '../dashboard/open-dashboard'
import { agentHasModelEffort } from '../../components/AgentModelEffort'
import { IS_PRIMARY_WINDOW } from '../window-role'
import { section, type ActionNode } from './action-tree'

export type AgentLaunchTarget = 'split' | 'panel'

export interface NewSessionContext {
  workspaceId: string
  groupId: string
  defaultWorktreeId: string
  isUnityProject: boolean | null
  isGitRepo: boolean | null
  onClose: () => void
}

export function newSessionModel(s: AppState, ctx: NewSessionContext) {
  const { workspaceId, groupId, defaultWorktreeId, isUnityProject, isGitRepo, onClose } = ctx
  const worktrees = s.worktreesByWorkspace[workspaceId] ?? []
  const tabs = s.tabsByWorkspace[workspaceId] ?? []
  const settings = s.settings
  const targetWorktreeId = defaultWorktreeId || worktrees[0]?.id || ''
  const targetPath = worktrees.find((w) => w.id === targetWorktreeId)?.path
  const pathByWorktreeId = new Map(worktrees.map((w) => [w.id, w.path] as const))
  const existing = (type: string) =>
    tabs.find((t) => t.contentType === type && !!targetPath && pathByWorktreeId.get(t.worktreeId) === targetPath)
  const existingUnityTab = existing('unity-instance-player')
  const existingConsoleTab = existing('unity-console')
  const existingScmTab = existing('git-scm')
  const existingScratchpadTab = existing('unity-scratchpad')
  const existingDashboardTab = existing('dashboard')
  const canOpenUnity = !!existingUnityTab || isUnityProject === true
  const canOpenConsole = !!existingConsoleTab || isUnityProject === true
  const canOpenScm = !!existingScmTab || isGitRepo === true

  const detected = s.detectedAgents ?? []
  const isEnabled = (id: AgentId): boolean => settings?.agents[id]?.enabled !== false
  const launchable = (id: AgentId): boolean => detected.includes(id) && isEnabled(id)
  const favs = (settings?.favoriteAgents ?? []).filter(launchable)
  const more = AGENT_CATALOG.map((e) => e.id).filter((id) => launchable(id) && !favs.includes(id))
  const optionAgents = [...favs, ...more].filter(agentHasModelEffort)

  const openAgent = (id: AgentId, target: AgentLaunchTarget): void => {
    if (!targetWorktreeId) return
    const entry = getAgentEntry(id)
    if (!entry) return
    const opts = { label: entry.label, agentId: id }
    const tab =
      target === 'panel'
        ? s.createTab(workspaceId, targetWorktreeId, { ...opts, groupId })
        : s.openTabBeside(workspaceId, groupId, targetWorktreeId, opts)
    setPendingCommand(tab.ptyId, buildAgentLaunchCommand(entry, settings?.agents[id]))
    onClose()
  }
  const canResumeClaude = launchable('claude') && !!targetPath
  const openClaudeResume = (): void => {
    if (!targetWorktreeId || !targetPath) return
    openClaudeSessionPicker({ workspaceId, groupId, worktreeId: targetWorktreeId, projectPath: targetPath })
    onClose()
  }
  const openTerminal = (): void => {
    if (!targetWorktreeId) return
    s.openTabBeside(workspaceId, groupId, targetWorktreeId)
    onClose()
  }
  const openSingle = (found: { id: string } | undefined, allowed: boolean, label: string, contentType: 'unity-instance-player' | 'unity-console' | 'git-scm' | 'unity-scratchpad') => (): void => {
    if (!targetWorktreeId) return
    if (found) {
      s.activateTab(found.id)
      onClose()
      return
    }
    if (!allowed) return
    s.openTabBeside(workspaceId, groupId, targetWorktreeId, { label, contentType })
    onClose()
  }
  const openUnity = openSingle(existingUnityTab, canOpenUnity, 'Unity Player', 'unity-instance-player')
  const openConsole = openSingle(existingConsoleTab, canOpenConsole, 'Unity Console', 'unity-console')
  const openScm = openSingle(existingScmTab, canOpenScm, GIT_TAB_LABEL, 'git-scm')
  const openScratchpads = openSingle(existingScratchpadTab, isUnityProject === true, 'Scratchpads', 'unity-scratchpad')
  const openReports = (): void => {
    if (!targetWorktreeId || !targetPath) return
    openReportsPicker({ workspaceId, groupId, worktreeId: targetWorktreeId, projectPath: targetPath })
    onClose()
  }
  const openDashboardPanel = (): void => {
    if (!targetWorktreeId || !targetPath) return
    if (existingDashboardTab) s.activateTab(existingDashboardTab.id)
    else openDashboard({ projectPath: targetPath, workspaceId, groupId })
    onClose()
  }
  const openTuner = (): void => {
    if (!targetWorktreeId || isUnityProject !== true) return
    const sceneTuner = tabs.find((t) => t.contentType === 'tuner' && t.worktreeId === targetWorktreeId && isSceneTuner(t.tuner))
    if (sceneTuner) {
      s.activateTab(sceneTuner.id)
      onClose()
      return
    }
    s.openTabBeside(workspaceId, groupId, targetWorktreeId, { label: 'Tuner', contentType: 'tuner' })
    onClose()
  }

  return {
    targetPath,
    existingUnityTab,
    existingConsoleTab,
    existingScmTab,
    existingScratchpadTab,
    existingDashboardTab,
    canOpenUnity,
    canOpenConsole,
    canOpenScm,
    favs,
    more,
    optionAgents,
    canResumeClaude,
    openAgent,
    openClaudeResume,
    openTerminal,
    openUnity,
    openConsole,
    openScm,
    openScratchpads,
    openReports,
    openDashboardPanel,
    openTuner
  }
}

export type NewSessionModel = ReturnType<typeof newSessionModel>

function agentNode(m: NewSessionModel, id: AgentId): ActionNode {
  const label = getAgentEntry(id)?.label ?? id
  return {
    id: `agent:${id}`,
    label,
    icon: 'sparkles',
    children: [
      { id: `agent:${id}:split`, label: 'Split', icon: 'rectangle.split.2x1', run: () => m.openAgent(id, 'split') },
      { id: `agent:${id}:panel`, label: 'This panel', icon: 'square.on.square', run: () => m.openAgent(id, 'panel') }
    ]
  }
}

function optionsNode(s: AppState, id: AgentId): ActionNode {
  const entry = getAgentEntry(id)
  const config = s.settings?.agents?.[id]
  const pick = (key: 'model' | 'effort', value: string, current: string, label: string): ActionNode => ({
    id: `options:${id}:${key}:${value || 'default'}`,
    label,
    checked: current === value,
    run: () => s.setAgentConfig(id, { [key]: value || undefined })
  })
  const children: ActionNode[] = []
  if (entry?.models)
    children.push({
      id: `options:${id}:model`,
      label: 'Model',
      icon: 'cpu',
      children: [pick('model', '', config?.model ?? '', 'Default'), ...entry.models.map((o) => pick('model', o.value, config?.model ?? '', o.label))]
    })
  if (entry?.efforts)
    children.push({
      id: `options:${id}:effort`,
      label: 'Effort',
      icon: 'gauge.with.dots.needle.50percent',
      children: [pick('effort', '', config?.effort ?? '', 'Default'), ...entry.efforts.map((o) => pick('effort', o.value, config?.effort ?? '', o.label))]
    })
  return { id: `options:${id}`, label: `${entry?.label ?? id} options`, icon: 'slider.horizontal.3', children }
}

export function newSessionNodes(s: AppState, m: NewSessionModel, isUnityProject: boolean | null): ActionNode[] {
  const noAgents = m.favs.length === 0 && m.more.length === 0
  return [
    section('agents', [
      noAgents && { id: 'no-agents', label: 'No agents detected — open Settings', enabled: false },
      ...m.favs.map((id) => agentNode(m, id)),
      m.more.length > 0 && { id: 'more-agents', label: 'More agents', icon: 'ellipsis', children: m.more.map((id) => agentNode(m, id)) },
      !noAgents && m.canResumeClaude && { id: 'resume-claude', label: 'Resume Claude session…', icon: 'clock.arrow.circlepath', run: m.openClaudeResume }
    ]),
    section('options', m.optionAgents.map((id) => optionsNode(s, id))),
    section(
      'unity',
      IS_PRIMARY_WINDOW
        ? [
            { id: 'open-unity', label: m.existingUnityTab ? 'Show Unity Player' : 'Open Unity Player', icon: 'cube', enabled: m.canOpenUnity, run: m.openUnity },
            { id: 'open-console', label: m.existingConsoleTab ? 'Show Unity Console' : 'Open Unity Console', icon: 'list.bullet.rectangle', enabled: m.canOpenConsole, run: m.openConsole },
            { id: 'open-tuner', label: 'Open Tuner', icon: 'slider.horizontal.3', enabled: isUnityProject === true, run: m.openTuner },
            { id: 'open-scratchpads', label: m.existingScratchpadTab ? 'Show Scratchpads' : 'Open Scratchpads', icon: 'square.grid.2x2', enabled: !!m.existingScratchpadTab || isUnityProject === true, run: m.openScratchpads }
          ]
        : []
    ),
    section('git', [
      { id: 'open-reports', label: 'Reports…', icon: 'doc.richtext', enabled: !!m.targetPath, run: m.openReports },
      { id: 'open-dashboard', label: m.existingDashboardTab ? 'Show Dashboard' : 'Dashboard', icon: 'gauge.with.dots.needle.33percent', enabled: !!m.targetPath, run: m.openDashboardPanel },
      { id: 'open-git', label: m.existingScmTab ? 'Show Git' : 'Open Git', icon: 'arrow.triangle.branch', enabled: m.canOpenScm, run: m.openScm }
    ]),
    section('terminal', [{ id: 'open-terminal', label: 'Open terminal', icon: 'terminal', run: m.openTerminal }])
  ].filter((n) => (n.children?.length ?? 0) > 0)
}
