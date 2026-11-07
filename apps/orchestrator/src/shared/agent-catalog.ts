import type { AgentConfig, AgentId } from './types'

export interface AgentModelOption {
  value: string
  label: string
  hint?: string
}

export const CLAUDE_MODEL_OPTIONS: readonly AgentModelOption[] = [
  { value: 'opus', label: 'Opus', hint: 'Opus 4.8' },
  { value: 'sonnet', label: 'Sonnet', hint: 'Sonnet 5' },
  { value: 'haiku', label: 'Haiku', hint: 'Haiku 4.5' },
  { value: 'fable', label: 'Fable', hint: 'Fable 5' }
]

export const CLAUDE_EFFORT_OPTIONS: readonly AgentModelOption[] = [
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'XHigh' },
  { value: 'max', label: 'Max' }
]

export interface AgentCatalogEntry {
  id: AgentId
  label: string
  cmd: string
  detectAliases?: readonly string[]
  launchCmd?: string
  defaultArgs?: string
  faviconDomain?: string
  homepageUrl: string
  models?: readonly AgentModelOption[]
  efforts?: readonly AgentModelOption[]
  promptArg?: boolean
}

export const AGENT_CATALOG: readonly AgentCatalogEntry[] = [
  {
    id: 'claude',
    label: 'Claude Code',
    cmd: 'claude',
    defaultArgs: '--dangerously-skip-permissions',
    faviconDomain: 'claude.ai',
    homepageUrl: 'https://www.anthropic.com/claude-code',
    models: CLAUDE_MODEL_OPTIONS,
    efforts: CLAUDE_EFFORT_OPTIONS,
    promptArg: true
  },
  {
    id: 'codex',
    label: 'Codex',
    cmd: 'codex',
    faviconDomain: 'openai.com',
    homepageUrl: 'https://github.com/openai/codex',
    promptArg: true
  },
  {
    id: 'cursor',
    label: 'Cursor',
    cmd: 'cursor-agent',
    detectAliases: ['cursor-agent'],
    faviconDomain: 'cursor.com',
    homepageUrl: 'https://cursor.com/cli',
    promptArg: true
  },
  {
    id: 'grok',
    label: 'Grok Build',
    cmd: 'grok',
    faviconDomain: 'x.ai',
    homepageUrl: 'https://x.ai/cli'
  },
  {
    id: 'kimi',
    label: 'Kimi',
    cmd: 'kimi',
    faviconDomain: 'moonshot.cn',
    homepageUrl: 'https://www.kimi.com/code/docs/en/kimi-code-cli/getting-started.html'
  },
  {
    id: 'opencode',
    label: 'opencode',
    cmd: 'opencode',
    faviconDomain: 'opencode.ai',
    homepageUrl: 'https://opencode.ai'
  }
]

const BY_ID = new Map(AGENT_CATALOG.map((e) => [e.id, e]))

export function getAgentEntry(id: AgentId): AgentCatalogEntry | undefined {
  return BY_ID.get(id)
}

export function getAgentLabel(id: AgentId): string {
  return BY_ID.get(id)?.label ?? id
}

export function detectNamesFor(entry: AgentCatalogEntry): string[] {
  return [entry.cmd, ...(entry.detectAliases ?? [])]
}

export interface AgentCommandOpts {
  extraEnv?: Record<string, string>
}

function modelEffortArgs(entry: AgentCatalogEntry, config: AgentConfig | undefined): string[] {
  const out: string[] = []
  if (entry.models && config?.model) out.push('--model', config.model)
  if (entry.efforts && config?.effort) out.push('--effort', config.effort)
  return out
}

export function buildAgentLaunchCommand(entry: AgentCatalogEntry, config?: AgentConfig): string {
  const base = config?.cmd?.trim() || entry.launchCmd || entry.cmd
  const args = config?.args !== undefined ? config.args : (entry.defaultArgs ?? '')
  return [base, args, ...modelEffortArgs(entry, config)].filter(Boolean).join(' ').trim()
}

const RESUMABLE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/

export function isResumableSessionId(id: unknown): id is string {
  return typeof id === 'string' && RESUMABLE_SESSION_ID.test(id)
}

export function buildAgentResumeCommand(
  entry: AgentCatalogEntry,
  config: AgentConfig | undefined,
  sessionId: string
): string | null {
  if (entry.id !== 'claude' || !isResumableSessionId(sessionId)) return null
  return `${buildAgentLaunchCommand(entry, config)} --resume ${sessionId}`
}

export function buildAgentLaunchEnv(
  config?: AgentConfig,
  opts?: AgentCommandOpts
): Record<string, string> {
  return { ...opts?.extraEnv, ...config?.env }
}
