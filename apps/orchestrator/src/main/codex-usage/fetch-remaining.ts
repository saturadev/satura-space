import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'
import type { CodexUsageRemaining, RateLimitWindow } from '@shared/api'
import { cliAugmentedPath, resolveCliCommand } from '../agents/cli-command-resolver'

const RPC_TIMEOUT_MS = 10_000
const CODEX_RPC_ARGS = [
  '-c',
  'approval_policy=never',
  '-c',
  'features.plugins=false',
  '-s',
  'read-only',
  '-a',
  'never',
  'app-server'
]

interface RpcRateWindow {
  usedPercent?: number
  windowDurationMins?: number
  resetsAt?: number
}
interface RpcRateLimitsResponse {
  rateLimits?: { primary?: RpcRateWindow; secondary?: RpcRateWindow }
}
interface RpcResponse {
  id?: number
  result?: unknown
  error?: { code: number; message: string }
}

function codexAuthExists(): boolean {
  const home = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  try {
    return existsSync(join(home, 'auth.json'))
  } catch {
    return false
  }
}

function mapWindow(raw: RpcRateWindow | undefined, windowMinutes: number): RateLimitWindow | null {
  if (!raw || typeof raw.usedPercent !== 'number') return null
  return {
    usedPercent: Math.max(0, Math.min(100, raw.usedPercent)),
    windowMinutes: typeof raw.windowDurationMins === 'number' ? raw.windowDurationMins : windowMinutes,
    resetsAt: typeof raw.resetsAt === 'number' ? raw.resetsAt * 1000 : null
  }
}

export async function fetchCodexUsageRemaining(): Promise<CodexUsageRemaining> {
  const base = { provider: 'codex' as const, session: null, weekly: null, updatedAt: Date.now() }

  if (!codexAuthExists()) {
    return { ...base, status: 'unavailable', error: 'Codex not signed in' }
  }

  return new Promise<CodexUsageRemaining>((resolve) => {
    const command = resolveCliCommand('codex')
    const child = spawn(command, CODEX_RPC_ARGS, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: cliAugmentedPath() },
      windowsHide: true
    })

    let buffer = ''
    let stderr = ''
    let rpcId = 0
    let rateLimitsId: number | null = null
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (result: CodexUsageRemaining): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      child.stdout.off('data', onStdout)
      child.removeListener('error', onError)
      child.removeListener('close', onClose)
      child.kill()
      resolve(result)
    }

    const send = (method: string, params?: unknown): number => {
      const id = ++rpcId
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params: params ?? {} })}\n`)
      return id
    }
    const notify = (method: string): void => {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params: {} })}\n`)
    }

    timer = setTimeout(
      () => finish({ ...base, updatedAt: Date.now(), status: 'error', error: 'Codex usage timed out' }),
      RPC_TIMEOUT_MS
    )

    const initId = send('initialize', { clientInfo: { name: 'satura-space', version: app.getVersion() } })

    function onStdout(chunk: Buffer): void {
      buffer += chunk.toString()
      let nl: number
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).trim()
        buffer = buffer.slice(nl + 1)
        if (!line) continue
        let msg: RpcResponse
        try {
          msg = JSON.parse(line) as RpcResponse
        } catch {
          continue
        }
        if (msg.id == null) continue
        if (msg.id === initId) {
          notify('initialized')
          rateLimitsId = send('account/rateLimits/read')
          continue
        }
        if (rateLimitsId !== null && msg.id === rateLimitsId) {
          if (msg.error) {
            finish({ ...base, updatedAt: Date.now(), status: 'error', error: msg.error.message })
            return
          }
          const limits = (msg.result as RpcRateLimitsResponse | undefined)?.rateLimits
          finish({
            provider: 'codex',
            session: mapWindow(limits?.primary, 300),
            weekly: mapWindow(limits?.secondary, 10080),
            updatedAt: Date.now(),
            error: null,
            status: 'ok'
          })
          return
        }
      }
    }

    function onError(err: NodeJS.ErrnoException): void {
      const notFound = err.code === 'ENOENT'
      finish({
        ...base,
        updatedAt: Date.now(),
        status: notFound ? 'unavailable' : 'error',
        error: notFound ? 'Codex CLI not found' : err.message
      })
    }

    function onClose(): void {
      finish({
        ...base,
        updatedAt: Date.now(),
        status: 'error',
        error: stderr.trim().slice(-200) || 'Codex exited before returning usage'
      })
    }

    child.stdout.on('data', onStdout)
    child.stderr.on('data', (c: Buffer) => {
      stderr = (stderr + c.toString()).slice(-2000)
    })
    child.on('error', onError)
    child.on('close', onClose)
  })
}
