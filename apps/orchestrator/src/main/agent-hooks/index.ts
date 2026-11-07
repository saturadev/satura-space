import {
  AgentHookServer,
  type SaturaExecHandler,
  type AgentHookEventHandler,
  type AgentSessionHandler
} from './hook-server'
import { existsSync } from 'node:fs'
import { ipcMain } from 'electron'
import { publishClaudeStatusLineUsage } from '../ipc/claude-usage'
import { installClaudeHooks, uninstallClaudeHooks } from './installer'
import { installCursorHooks, uninstallCursorHooks } from './cursor-installer'
import { installGrokHooks, uninstallGrokHooks } from './grok-installer'
import { installKimiHooks, uninstallKimiHooks } from './kimi-installer'
import {
  atomicWriteFile,
  DISABLED_MARKER_PATH,
  endpointPath,
  removeFileQuietly,
  writeEndpoint
} from './installer-shared'
import { sharedConfigOwner } from '../dev-instance'

const server = new AgentHookServer()
let active = false
let forward: AgentHookEventHandler | null = null
let forwardSession: AgentSessionHandler | null = null

export function getAgentHookEnv(ptyId: string): Record<string, string> {
  if (!active) return {}
  const own = sharedConfigOwner() ? (process.env.SATURA_AGENT_HOOKS_ENDPOINT ?? '').trim() : ''
  return own ? { ...server.buildPtyEnv(ptyId), SATURA_AGENT_HOOKS_ENDPOINT: own } : server.buildPtyEnv(ptyId)
}

export function setSaturaExecHandler(handler: SaturaExecHandler | null): void {
  server.setExecHandler(handler)
}

export async function refreshAgentHooks(): Promise<void> {
  if (active) return
  const owner = sharedConfigOwner()
  const ownEndpoint = owner ? (process.env.SATURA_AGENT_HOOKS_ENDPOINT ?? '').trim() : ''
  if (owner && !ownEndpoint) {
    console.log(`[agent-hooks] off in ${owner}: ~/.satura, ~/.claude and the other agent configs belong to the main app`)
    return
  }
  server.setHandler(forward)
  server.setSessionHandler(forwardSession)
  server.setStatusLineHandler(publishClaudeStatusLineUsage)
  try {
    await server.start()
  } catch {
    return
  }
  const ep = server.endpoint()
  if (ep) writeEndpoint(ep.port, ep.token)
  if (ownEndpoint) {
    console.log(`[agent-hooks] ${owner}: endpoint ${endpointPath()}, agent configs in ~ left to the main app`)
    active = true
    return
  }
  if (existsSync(DISABLED_MARKER_PATH)) {
    console.log(`[agent-hooks] agent config hooks are uninstalled (${DISABLED_MARKER_PATH}); not installing them`)
  } else {
    installAllAgentHooks()
  }
  active = true
}

const INSTALLERS: [string, () => string][] = [
  ['claude', installClaudeHooks],
  ['kimi', installKimiHooks],
  ['cursor', installCursorHooks],
  ['grok', installGrokHooks]
]

function installAllAgentHooks(): void {
  for (const [agent, install] of INSTALLERS) {
    try {
      const result = install()
      if (result !== 'skipped') console.log(`[agent-hooks] ${agent}: hooks ${result}`)
    } catch (err) {
      console.warn(`[agent-hooks] ${agent}: install failed`, err)
    }
  }
}

export type AgentHooksUninstallResult = { ok: boolean; message: string }

export function uninstallAgentHooks(): AgentHooksUninstallResult {
  const owner = sharedConfigOwner()
  if (owner) {
    return { ok: false, message: `agent configs in ~ belong to the main app, not ${owner}` }
  }
  const failures: string[] = []
  const steps: [string, () => unknown][] = [
    ['claude', uninstallClaudeHooks],
    ['kimi', uninstallKimiHooks],
    ['cursor', uninstallCursorHooks],
    ['grok', uninstallGrokHooks]
  ]
  for (const [agent, uninstall] of steps) {
    try {
      uninstall()
    } catch (err) {
      failures.push(`${agent}: ${err instanceof Error ? err.message : String(err)}`)
    }
  }
  try {
    atomicWriteFile(DISABLED_MARKER_PATH, `${new Date().toISOString()}\n`)
  } catch {
  }
  const message = failures.length ? `uninstalled with errors: ${failures.join('; ')}` : 'agent hooks uninstalled'
  console.log(`[agent-hooks] ${message}`)
  return { ok: failures.length === 0, message }
}

export function reinstallAgentHooks(): AgentHooksUninstallResult {
  const owner = sharedConfigOwner()
  if (owner) {
    return { ok: false, message: `agent configs in ~ belong to the main app, not ${owner}` }
  }
  removeFileQuietly(DISABLED_MARKER_PATH)
  installAllAgentHooks()
  return { ok: true, message: 'agent hooks installed' }
}

let handlersRegistered = false

export function registerAgentHookHandlers(): void {
  if (handlersRegistered) return
  handlersRegistered = true
  ipcMain.handle('agent-hooks:uninstall', () => uninstallAgentHooks())
  ipcMain.handle('agent-hooks:reinstall', () => reinstallAgentHooks())
}

export async function initAgentHooks(
  onEvent: AgentHookEventHandler,
  onSession?: AgentSessionHandler
): Promise<void> {
  forward = onEvent
  forwardSession = onSession
    ? (ptyId, info) => {
        if (info.event === 'SessionStart' || info.event === 'SessionEnd') {
          console.log(
            `[claude-session] pty=${ptyId} ${info.event}${info.source ? `(${info.source})` : ''} session=${info.sessionId}`
          )
        }
        onSession(ptyId, info)
      }
    : null
  await refreshAgentHooks()
}
