import { BrowserWindow, ipcMain, webContents } from 'electron'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, type Settings } from '@shared/types'
import type { ExecRendererRequest } from '@shared/agent-exec'
import type { TunerTabInfo } from '@shared/tuner-find'
import type { PaneAct, PaneModel } from '@shared/pane-plan'
import { loadState } from '../persistence'
import { detectInstalledAgents } from '../agents/agent-path-detection'
import { getLocalPtyProvider, ptyOwnerWebContentsId } from '../ipc/pty'
import { ensureSspaceDirSync } from '../sspace'
import { createAgentExecService, type AgentExecService } from './service'
import { censusTrack } from '@shared/census'

const REQUEST_TIMEOUT_MS = 10_000
const READY_POLL_MS = 500
const READY_AGENT_MS = 2000
const READY_QUIET_MS = 1500

let seq = 0
let service: AgentExecService | null = null
const waiting = new Map<number, (result: unknown) => void>()
censusTrack('index.waiting', waiting)

function requestRenderer(wcId: number, request: ExecRendererRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  const wc = webContents.fromId(wcId)
  if (!wc || wc.isDestroyed()) return Promise.resolve(null)
  const reqId = ++seq
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiting.delete(reqId)
      resolve(null)
    }, timeoutMs)
    waiting.set(reqId, (result) => {
      clearTimeout(timer)
      waiting.delete(reqId)
      resolve(result)
    })
    wc.send('agent-exec:request', { reqId, request })
  })
}

export function rendererCall(wcId: number, request: ExecRendererRequest, timeoutMs = REQUEST_TIMEOUT_MS): Promise<unknown> {
  return requestRenderer(wcId, request, timeoutMs)
}

export function collectReportIn(wcId: number, file: string, root: string): Promise<unknown> {
  return requestRenderer(wcId, { kind: 'reportExport', payload: { file, root } }, 10 * 60_000)
}

export function driveWorkspace(wcId: number, workspaceId: string, on: boolean): Promise<unknown> {
  return requestRenderer(wcId, { kind: 'drive', payload: { workspaceId, on } })
}

export async function tunerTabs(wcId: number, workspaceId: string, show?: string): Promise<TunerTabInfo[] | null> {
  const r = await requestRenderer(wcId, { kind: 'tuners', payload: { workspaceId, ...(show ? { show } : {}) } })
  return Array.isArray(r) ? (r as TunerTabInfo[]) : null
}

export async function paneModel(
  wcId: number,
  workspaceId: string,
  ptyId?: string,
  opts: { take?: boolean; act?: PaneAct; groupId?: string } = {}
): Promise<(PaneModel & { placed?: unknown }) | null> {
  const r = await requestRenderer(wcId, { kind: 'panes', payload: { workspaceId, ...(ptyId ? { ptyId } : {}), ...opts } })
  return r && typeof r === 'object' ? (r as PaneModel & { placed?: unknown }) : null
}

function settings(): Settings {
  return { ...DEFAULT_SETTINGS, ...loadState().settings }
}

function shellPath(): string {
  const override = settings().terminalShell
  if (override) return override
  if (process.platform === 'win32') return process.env.COMSPEC || 'powershell.exe'
  return process.env.SHELL || '/bin/zsh'
}

function writePromptFile(cwd: string, rel: string, text: string): boolean {
  if (!cwd) return false
  try {
    const file = join(cwd, rel)
    ensureSspaceDirSync(join(cwd, '.sspace'))
    mkdirSync(dirname(file), { recursive: true })
    writeFileSync(file, text, 'utf8')
    return true
  } catch (e) {
    console.log(`[agent-exec] prompt file write failed: ${(e as Error).message}`)
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

async function agentInFront(ptyId: string): Promise<boolean> {
  if (process.platform === 'win32') return true
  const provider = getLocalPtyProvider()
  if (!provider) return false
  return provider.hasChildProcesses(ptyId).catch(() => false)
}

async function waitForAgentReady(ptyId: string, timeoutMs: number): Promise<boolean> {
  const provider = getLocalPtyProvider()
  if (!provider) return false
  let lastOutput = Date.now()
  let exited = false
  const offData = provider.onData(({ id }) => {
    if (id === ptyId) lastOutput = Date.now()
  })
  const offExit = provider.onExit(({ id }) => {
    if (id === ptyId) exited = true
  })
  try {
    const deadline = Date.now() + timeoutMs
    let agentSince = 0
    while (!exited && Date.now() < deadline) {
      await sleep(READY_POLL_MS)
      const running = await provider.hasChildProcesses(ptyId).catch(() => false)
      if (!running) {
        agentSince = 0
        continue
      }
      agentSince ||= Date.now()
      const now = Date.now()
      if (now - agentSince >= READY_AGENT_MS && now - lastOutput >= READY_QUIET_MS) return true
    }
    return false
  } finally {
    offData()
    offExit()
  }
}

export function registerAgentExecHandlers(): void {
  ipcMain.on('agent-exec:reply', (_e, msg: { reqId?: number; result?: unknown }) => {
    const done = typeof msg?.reqId === 'number' ? waiting.get(msg.reqId) : undefined
    done?.(msg.result ?? null)
  })
  ipcMain.handle('agent-exec:tell', (_e, msg: { paneKey?: unknown; text?: unknown; wait?: unknown }) =>
    agentExecService().tell(typeof msg?.paneKey === 'string' ? msg.paneKey : '', typeof msg?.text === 'string' ? msg.text : '', msg?.wait === true)
  )
  service = createAgentExecService({
    ownerOf: ptyOwnerWebContentsId,
    windowIds: () =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed())
        .map((w) => w.webContents.id),
    request: requestRenderer,
    write: (ptyId, data) => getLocalPtyProvider()?.write(ptyId, data),
    settings,
    launchable: (agentId) =>
      settings().agents[agentId]?.enabled !== false && detectInstalledAgents().includes(agentId),
    shell: shellPath,
    platform: process.platform,
    newPtyId: randomUUID,
    writePromptFile,
    agentInFront,
    waitForAgentReady,
    sleep
  })
}

export function agentExecService(): AgentExecService {
  if (!service) throw new Error('Satura Space is still starting up.')
  return service
}
