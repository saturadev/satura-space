import { spawn } from 'node:child_process'
import type { ClaudeUsageRemaining, RateLimitWindow } from '@shared/api'
import { cliAugmentedPath, resolveCliCommand } from '../agents/cli-command-resolver'

const PROBE_TIMEOUT_MS = 25_000
const REQUEST_ID = 'satura-usage'
const SESSION_MINUTES = 300
const WEEK_MINUTES = 10080

const PROBE_ARGS = [
  '-p',
  '--input-format',
  'stream-json',
  '--output-format',
  'stream-json',
  '--verbose',
  '--strict-mcp-config',
  '--mcp-config',
  '{"mcpServers":{}}'
]

interface RawWindow {
  utilization?: number | null
  resets_at?: string | null
}

interface RawScopedWindow extends RawWindow {
  display_name?: string | null
}

interface RawUsage {
  rate_limits_available?: boolean
  rate_limits?: {
    five_hour?: RawWindow | null
    seven_day?: RawWindow | null
    model_scoped?: RawScopedWindow[] | null
  } | null
}

interface ControlResponse {
  type?: string
  response?: {
    subtype?: string
    request_id?: string
    response?: unknown
    error?: string
  }
}

function mapWindow(raw: RawWindow | null | undefined, windowMinutes: number): RateLimitWindow | null {
  const used = raw?.utilization
  if (typeof used !== 'number' || !Number.isFinite(used)) return null
  const resets = raw?.resets_at ? Date.parse(raw.resets_at) : Number.NaN
  return {
    usedPercent: Math.max(0, Math.min(100, used)),
    windowMinutes,
    resetsAt: Number.isFinite(resets) ? resets : null
  }
}

function mapScopedWindow(raw: RawScopedWindow): RateLimitWindow | null {
  const window = mapWindow(raw, WEEK_MINUTES)
  const model = typeof raw.display_name === 'string' ? raw.display_name.trim() : ''
  return window && model ? { ...window, model } : null
}

export function mapUsageControlResponse(payload: unknown): ClaudeUsageRemaining {
  const base = {
    provider: 'claude' as const,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: null
  }
  const usage = (typeof payload === 'object' && payload !== null ? payload : {}) as RawUsage
  if (usage.rate_limits_available === false) {
    return { ...base, status: 'unavailable', error: 'This Claude login has no plan limits' }
  }
  const limits = usage.rate_limits
  if (!limits) return { ...base, status: 'unavailable' }
  const session = mapWindow(limits.five_hour, SESSION_MINUTES)
  const weekly = mapWindow(limits.seven_day, WEEK_MINUTES)
  const weeklyScoped = (limits.model_scoped ?? [])
    .map(mapScopedWindow)
    .filter((w): w is RateLimitWindow => w !== null)
  if (!session && !weekly && weeklyScoped.length === 0) return { ...base, status: 'unavailable' }
  return { ...base, session, weekly, weeklyScoped, status: 'ok' }
}

export async function fetchClaudeUsageRemaining(): Promise<ClaudeUsageRemaining> {
  const base = {
    provider: 'claude' as const,
    session: null,
    weekly: null,
    updatedAt: Date.now(),
    error: null
  }

  return new Promise<ClaudeUsageRemaining>((resolve) => {
    const command = resolveCliCommand('claude')
    const child = spawn(command, PROBE_ARGS, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: cliAugmentedPath() },
      windowsHide: true
    })

    let buffer = ''
    let stderr = ''
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: ClaudeUsageRemaining): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.stdout.off('data', onStdout)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      child.kill()
      resolve(result)
    }

    timer = setTimeout(
      () =>
        finish({ ...base, updatedAt: Date.now(), status: 'error', error: 'Claude usage timed out' }),
      PROBE_TIMEOUT_MS
    )

    function onStdout(chunk: Buffer): void {
      buffer += chunk.toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg: ControlResponse
        try {
          msg = JSON.parse(line) as ControlResponse
        } catch {
          continue
        }
        if (msg.type !== 'control_response') continue
        if (msg.response?.request_id !== REQUEST_ID) continue
        if (msg.response.subtype !== 'success') {
          finish({
            ...base,
            updatedAt: Date.now(),
            status: 'error',
            error: msg.response.error ?? 'Claude Code refused the usage request'
          })
          return
        }
        finish(mapUsageControlResponse(msg.response.response))
        return
      }
    }

    function onError(err: NodeJS.ErrnoException): void {
      const notFound = err.code === 'ENOENT'
      finish({
        ...base,
        updatedAt: Date.now(),
        status: notFound ? 'unavailable' : 'error',
        error: notFound ? 'Claude Code CLI not found' : err.message
      })
    }

    function onClose(): void {
      finish({
        ...base,
        updatedAt: Date.now(),
        status: 'error',
        error: stderr.trim().slice(-200) || 'Claude Code exited before returning usage'
      })
    }

    child.stdout.on('data', onStdout)
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-2000)
    })
    child.on('error', onError)
    child.on('close', onClose)

    child.stdin.on('error', () => {})
    child.stdin.write(
      `${JSON.stringify({ type: 'control_request', request_id: REQUEST_ID, request: { subtype: 'get_usage' } })}\n`
    )
    child.stdin.end()
  })
}
