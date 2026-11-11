export type HandleSide = 'main' | 'renderer'
export type HandleParams = Record<string, unknown>
export type HandleStatus = 'done' | 'error' | 'running' | 'stopped' | 'blocked'

export interface HandleInfo {
  name: string
  description: string
  side: HandleSide
  params: HandleParams
  long?: boolean
  agentOnly?: boolean
  released?: boolean
}

export interface HandleResult {
  handle: string
  status: HandleStatus
  value?: unknown
  error?: string
  run?: number
  dialogs?: string[]
  logs: string[]
  ms: number
  mark?: string
}

export interface RendererHandleCall {
  name: string
  params: HandleParams
  workspaceId: string | null
  projectRoot: string
}

export type RendererHandleReply = { ok: true; value: unknown } | { ok: false; error: string }

export function handleMatches(info: Pick<HandleInfo, 'name' | 'description'>, filter: string): boolean {
  const want = filter.trim().toLowerCase()
  if (!want) return true
  return info.name.toLowerCase().includes(want) || info.description.toLowerCase().includes(want)
}

export function withDefaults(defaults: HandleParams, raw: unknown): HandleParams {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as HandleParams) : {}
  return { ...defaults, ...given }
}
