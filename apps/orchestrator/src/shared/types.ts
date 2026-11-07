import type { PersistedSession, UsageProvider } from './api'

export type AgentId = string

export type ThemeId = 'dark'
export const DEFAULT_THEME: ThemeId = 'dark'

export interface AgentConfig {
  enabled: boolean
  cmd?: string
  args?: string
  env?: Record<string, string>
  model?: string
  effort?: string
}

export interface Settings {
  defaultAgent: AgentId | null
  agents: Record<AgentId, AgentConfig>
  favoriteAgents: AgentId[]
  defaultProjectsFolder: string
  remoteRelayUrl?: string
  terminalFontSize: number
  editorFontSize: number
  claudeVirtualizedRenderer: boolean
  terminalShell?: string
  appZoomFactor: number
  reportZoom?: number
  unityPlayerVolume: number
  unityPlayerMuted: boolean
  devSimulateNoUnityHub: boolean
  theme: ThemeId
  startScreenEffect: boolean
  driftSpotlight: boolean
  agentAlertHighlight: boolean
  agentAlertSound: boolean
  agentAlertVolume: number
  agentAlertFinishedSound: string
  agentAlertAttentionSound: string
  notifyAgentFinished: boolean
  notifyAgentNeedsYou: boolean
  defaultTerminalCount: number
  hiddenUsageProviders: UsageProvider[]
}

export const USAGE_PROVIDERS: UsageProvider[] = ['claude', 'codex', 'kimi']

export const visibleUsageProviders = (hidden: readonly UsageProvider[] | undefined): UsageProvider[] =>
  USAGE_PROVIDERS.filter((p) => !(hidden ?? []).includes(p))

export const DEFAULT_TERMINAL_FONT_SIZE = 14
export const DEFAULT_EDITOR_FONT_SIZE = 13
export const MIN_FONT_SIZE = 8
export const MAX_FONT_SIZE = 32

export const DEFAULT_APP_ZOOM = 1
export const MIN_APP_ZOOM = 0.5
export const MAX_APP_ZOOM = 2
export const APP_ZOOM_STEPS = [0.7, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2]

export const clampAppZoom = (n: number): number =>
  Math.max(MIN_APP_ZOOM, Math.min(MAX_APP_ZOOM, n))

export const REPORT_ZOOM_STEPS = [0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

export function stepReportZoom(current: number | undefined, delta: number | 'reset'): number {
  if (delta === 'reset') return 1
  const z = Number.isFinite(current) ? (current as number) : 1
  if (delta > 0) return REPORT_ZOOM_STEPS.find((s) => s > z + 0.001) ?? REPORT_ZOOM_STEPS[REPORT_ZOOM_STEPS.length - 1]
  return [...REPORT_ZOOM_STEPS].reverse().find((s) => s < z - 0.001) ?? REPORT_ZOOM_STEPS[0]
}

export interface RemotePrefs {
  reportScale?: number
  terminalFontSize?: number
}

export const PHONE_REPORT_SCALE = 1
export const PHONE_TERMINAL_FONT_SIZE = 12
export const PHONE_MIN_TERMINAL_FONT = 8
export const PHONE_MAX_TERMINAL_FONT = 24

export const clampPhoneReportScale = (n: number): number =>
  Math.round(Math.max(0.6, Math.min(2, n)) * 100) / 100

export const clampPhoneTerminalFont = (n: number): number =>
  Math.round(Math.max(PHONE_MIN_TERMINAL_FONT, Math.min(PHONE_MAX_TERMINAL_FONT, n)))

export interface Workspace {
  id: string
  name: string
  folderPath?: string

  worktreePath?: string
  createdAt: number
}

export interface Worktree {
  id: string
  workspaceId: string
  name: string
  path: string
  createdAt: number
}

export type TabContentType =
  | 'terminal'
  | 'unity-instance-player'
  | 'unity-console'
  | 'file-viewer'
  | 'tuner'
  | 'unity-scratchpad'
  | 'git-scm'
  | 'dashboard'

export interface TunerTarget {
  kind: 'view' | 'file'
  id: string
  filter?: string
}

export interface Tab {
  id: string
  worktreeId: string
  groupId: string
  contentType: TabContentType
  ptyId: string
  label: string
  generatedLabel?: string | null
  customLabel?: string | null
  agentId?: AgentId | null
  claudeSessionId?: string | null
  parentPtyId?: string | null
  tuner?: TunerTarget | null
  scratchpadId?: string | null
  attachedTo?: string | null
  reportGroup?: ReportGroupPrefs | null

  preview?: boolean
  sortOrder: number
  createdAt: number
}

export interface ReportGroupPrefs {
  closed?: string[]
  order?: string[]
}

export interface TabGroup {
  id: string
  activeTabId: string | null
  tabOrder: string[]
  hidden?: boolean
}

export type TabGroupLayoutNode =
  | { type: 'leaf'; groupId: string }
  | {
      type: 'split'
      direction: 'horizontal' | 'vertical'
      first: TabGroupLayoutNode
      second: TabGroupLayoutNode
      ratio?: number
    }

export const SCHEMA_VERSION = 1

export interface PersistedState {
  schemaVersion: number
  settings: Settings
  recentFolders: string[]
  auth?: { token: string; email: string; enc: boolean } | null
  session?: PersistedSession | null
}

export const DEFAULT_SETTINGS: Settings = {
  defaultAgent: null,
  agents: {},
  favoriteAgents: ['claude', 'codex', 'cursor'],
  defaultProjectsFolder: '',
  terminalFontSize: DEFAULT_TERMINAL_FONT_SIZE,
  editorFontSize: DEFAULT_EDITOR_FONT_SIZE,
  claudeVirtualizedRenderer: true,
  appZoomFactor: DEFAULT_APP_ZOOM,
  unityPlayerVolume: 1,
  unityPlayerMuted: false,
  devSimulateNoUnityHub: false,
  theme: DEFAULT_THEME,
  startScreenEffect: true,
  driftSpotlight: true,
  agentAlertHighlight: true,
  agentAlertSound: true,
  agentAlertVolume: 0.7,
  agentAlertFinishedSound: 'chime-success',
  agentAlertAttentionSound: 'chime-warning',
  notifyAgentFinished: true,
  notifyAgentNeedsYou: true,
  defaultTerminalCount: 1,
  hiddenUsageProviders: []
}

export const DEFAULT_STATE: PersistedState = {
  schemaVersion: SCHEMA_VERSION,
  settings: DEFAULT_SETTINGS,
  recentFolders: [],
  auth: null,
  session: null
}
