export const SATURA_EXEC_PATH = '/exec'
export const SATURA_EXEC_ANSWER_PATH = '/exec/answer'
export const DEFAULT_SCRIPT_TIMEOUT_S = 300
export const MAX_SCRIPT_TIMEOUT_S = 3600
export const MAX_SCRIPT_CHARS = 200_000
export const MAX_SHOTS = 8
export const MAX_RESULT_CHARS = 100_000
export const MAX_LOG_CHARS = 100_000

export function cutResult(json: string): string {
  if (json.length <= MAX_RESULT_CHARS) return json
  let text = json
  try {
    const parsed: unknown = JSON.parse(json)
    if (typeof parsed === 'string') text = parsed
  } catch {
    text = json
  }
  return JSON.stringify(`${text.slice(0, MAX_RESULT_CHARS)}\n... (cut: the result is ${text.length} characters, the first ${MAX_RESULT_CHARS} are shown. Return less, like a slice, a filter or a count.)`)
}

export interface SaturaExecRequest {
  paneKey?: unknown
  projectRoot?: unknown
  code?: unknown
  timeout?: unknown
  command?: unknown
  drift?: unknown
  caller?: unknown
  peer?: unknown
  origin?: unknown
}

export interface ScriptFailure {
  name: string
  message: string
  stack: string
}

export interface ScriptLog {
  level: string
  text: string
}

export interface ScriptShot {
  mime: string
  data: string
  width: number
  height: number
}

export interface ScriptStep {
  label: string
  ok: boolean
  ms: number
}

export interface PeerAnswer {
  ok: boolean
  value?: unknown
  name?: string
  error?: string
  notes?: string[]
  images?: { mime: string; data: string }[]
}

export interface ExecPeer {
  call(fn: string, args: Record<string, unknown>): Promise<PeerAnswer>
}

export interface SaturaExecReply {
  ok: boolean
  error?: string
  result?: string
  failure?: ScriptFailure
  logs: ScriptLog[]
  shots: ScriptShot[]
  ms: number
  drift?: string
  steps?: ScriptStep[]
  notes?: string[]
}

export function clampTimeoutSeconds(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_SCRIPT_TIMEOUT_S
  return Math.min(MAX_SCRIPT_TIMEOUT_S, Math.max(1, n))
}

export function cleanPaneKey(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const key = raw.trim()
  return key && !key.includes('${') && !/\s/.test(key) ? key : ''
}
