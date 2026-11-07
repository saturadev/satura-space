import { app, ipcMain } from 'electron'
import { freemem, totalmem } from 'node:os'
import { basename } from 'node:path'
import type { ResourceSession, ResourceSnapshot } from '@shared/api'
import { getDaemonProvider } from '../daemon/daemon-init'
import { unityProvider } from '../unity/unity-instance-provider'
import { enumerateProcesses, pidMetrics, sumSubtree } from '../resources/process-sampler'
import { buildWindowTopology, findUnityAttribution } from '../resources/topology'
import { readScratchpadName } from '../unity/scratchpad-store'
import { listWindows } from '../window/window-manager'
import { listSessionWindows } from '../session-registry'
import { startSystemSampler, systemLoad } from '../resources/system-sampler'

function currentTopology(): ReturnType<typeof buildWindowTopology> {
  const registry = new Map(listSessionWindows().map((w) => [w.id, w.snapshot]))
  return buildWindowTopology(
    listWindows().map((info) => ({
      id: info.id,
      label: info.label,
      focused: info.focused,
      workspace: registry.get(info.id)?.session?.workspace
    }))
  )
}

const SNAPSHOT_TTL_MS = 1500
let inflight: Promise<ResourceSnapshot> | null = null
let cached: { at: number; snapshot: ResourceSnapshot } | null = null

function sharedSnapshot(): Promise<ResourceSnapshot> {
  if (cached && Date.now() - cached.at < SNAPSHOT_TTL_MS) return Promise.resolve(cached.snapshot)
  if (inflight) return inflight
  const p = buildSnapshot()
    .then((snapshot) => {
      cached = { at: Date.now(), snapshot }
      return snapshot
    })
    .finally(() => {
      if (inflight === p) inflight = null
    })
  inflight = p
  return p
}

async function buildSnapshot(): Promise<ResourceSnapshot> {
  const provider = getDaemonProvider()
  const terminals = provider
    ? (await provider.listSessions()).map((s) => ({
        id: s.sessionId,
        pid: s.pid ?? 0,
        cwd: s.cwd ?? undefined,
        label: undefined as string | undefined
      }))
    : []
  const unity = unityProvider.listInstances()
  const index = await enumerateProcesses()
  const { windows, ptyToWorkspace, unityCandidates } = currentTopology()

  const claimed = new Set<number>()
  const sessions: ResourceSession[] = []

  let appCpu: number | null = null
  let appMemory: number | null = null
  if (index) {
    appCpu = 0
    appMemory = 0
    for (const m of app.getAppMetrics()) {
      claimed.add(m.pid)
      const host = pidMetrics(index, m.pid)
      appCpu += host?.cpu ?? m.cpu?.percentCPUUsage ?? 0
      appMemory += host?.memory ?? (m.memory?.workingSetSize ?? 0) * 1024
    }
  }
  sessions.push({
    kind: 'app',
    id: 'orchestrator',
    pid: process.pid,
    label: 'Internal',
    cpu: appCpu,
    memory: appMemory
  })

  for (const t of terminals) {
    const m = index ? sumSubtree(index, t.pid, claimed) : null
    const attr = ptyToWorkspace.get(t.id)
    sessions.push({
      kind: 'terminal',
      id: t.id,
      pid: t.pid,
      label: attr?.label || t.label?.trim() || 'Terminal',
      cpu: m ? m.cpu : null,
      memory: m ? m.memory : null,
      cwd: t.cwd || undefined,
      windowId: attr?.windowId,
      workspaceId: attr?.workspaceId
    })
  }
  for (const u of unity) {
    const m = index && u.pid != null ? sumSubtree(index, u.pid, claimed) : null
    const attr = findUnityAttribution(unityCandidates, u.realProjectPath)
    sessions.push({
      kind: 'unity',
      id: u.id,
      pid: u.pid ?? 0,
      label: basename(u.realProjectPath) || 'Unity',
      cpu: m ? m.cpu : null,
      memory: m ? m.memory : null,
      projectPath: u.realProjectPath,
      unityKind: u.kind,
      scratchpadName: readScratchpadName(u.realProjectPath) ?? undefined,
      windowId: attr?.windowId,
      workspaceId: attr?.workspaceId
    })
  }

  let totalCpu = 0
  let totalMemory = 0
  for (const s of sessions) {
    totalCpu += s.cpu ?? 0
    totalMemory += s.memory ?? 0
  }

  return {
    sessions,
    windows,
    totalCpu,
    totalMemory,
    hostMemory: totalmem(),
    freeMemory: freemem()
  }
}

export function registerResourceHandlers(): void {
  ipcMain.handle('resources:getSnapshot', (): Promise<ResourceSnapshot> => sharedSnapshot())
  ipcMain.handle('system:load', (_e, since?: number) => systemLoad(Number(since) || 0))
  startSystemSampler()
}
