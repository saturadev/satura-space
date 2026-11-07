import { createHash, randomBytes } from 'node:crypto'
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from './types'

export const DAEMON_SLOT_COUNT = 8

export type DaemonConnectionInfo = {
  socketPath: string
  tokenPath: string
  slot?: number
}

export type DaemonPidFile = {
  pid: number
  startedAtMs: number | null
  entryPath?: string
  appVersion?: string
  buildId?: string
}

export type LegacyDaemonInfo = {
  socketPath: string
  tokenPath: string
  slot: number
  buildId: string | null
  reason: string
}

export type DaemonProcessHandle = {
  info?: DaemonConnectionInfo
  legacy?: LegacyDaemonInfo[]
  shutdown(): Promise<void>
}

export type DaemonLauncher = (socketPath: string, tokenPath: string) => Promise<DaemonProcessHandle>

export type DaemonSpawnerOptions = {
  runtimeDir: string
  launcher: DaemonLauncher
}

export class DaemonSpawner {
  private runtimeDir: string
  private launcher: DaemonLauncher
  private handle: DaemonProcessHandle | null = null
  private socketPath: string
  private tokenPath: string

  constructor(opts: DaemonSpawnerOptions) {
    this.runtimeDir = opts.runtimeDir
    this.launcher = opts.launcher
    this.socketPath = getDaemonSocketPath(this.runtimeDir)
    this.tokenPath = getDaemonTokenPath(this.runtimeDir)
  }

  async ensureRunning(): Promise<DaemonConnectionInfo> {
    if (!this.handle) {
      this.handle = await this.launcher(this.socketPath, this.tokenPath)
    }
    return this.handle.info ?? { socketPath: this.socketPath, tokenPath: this.tokenPath, slot: 0 }
  }

  currentInfo(): DaemonConnectionInfo | null {
    return this.handle?.info ?? null
  }

  takeLegacy(): LegacyDaemonInfo[] {
    const legacy = this.handle?.legacy ?? []
    if (this.handle) this.handle.legacy = []
    return legacy
  }

  resetHandle(): void {
    this.handle = null
  }

  async shutdown(): Promise<void> {
    if (!this.handle) {
      return
    }
    const handle = this.handle
    this.handle = null
    await handle.shutdown()
  }
}

function slotSuffix(slot: number): string {
  return slot > 0 ? `-s${slot}` : ''
}

export function getDaemonSocketPath(
  runtimeDir: string,
  protocolVersion = PROTOCOL_VERSION,
  slot = 0
): string {
  if (process.platform === 'win32') {
    const named = readDaemonPipeName(runtimeDir, protocolVersion, slot)
    if (named) return named
    const suffix = createHash('sha256').update(runtimeDir).digest('hex').slice(0, 12)
    return `\\\\?\\pipe\\satura-terminal-host-v${protocolVersion}-${suffix}${slotSuffix(slot)}`
  }
  return join(runtimeDir, `daemon-v${protocolVersion}${slotSuffix(slot)}.sock`)
}

export function getDaemonPipeNamePath(
  runtimeDir: string,
  protocolVersion = PROTOCOL_VERSION,
  slot = 0
): string {
  return join(runtimeDir, `daemon-v${protocolVersion}${slotSuffix(slot)}.pipe`)
}

const PIPE_NAME = /^\\\\\?\\pipe\\satura-terminal-host-v\d+-[0-9a-f]{32}(-s\d+)?$/

export function readDaemonPipeName(runtimeDir: string, protocolVersion: number, slot: number): string | null {
  try {
    const name = readFileSync(getDaemonPipeNamePath(runtimeDir, protocolVersion, slot), 'utf8').trim()
    return PIPE_NAME.test(name) ? name : null
  } catch {
    return null
  }
}

export function assignDaemonPipeName(runtimeDir: string, protocolVersion = PROTOCOL_VERSION, slot = 0): string {
  const name = `\\\\?\\pipe\\satura-terminal-host-v${protocolVersion}-${randomBytes(16).toString('hex')}${slotSuffix(slot)}`
  writeFileSync(getDaemonPipeNamePath(runtimeDir, protocolVersion, slot), name, { mode: 0o600 })
  return name
}

export function forgetDaemonPipeName(runtimeDir: string, protocolVersion = PROTOCOL_VERSION, slot = 0): void {
  try {
    unlinkSync(getDaemonPipeNamePath(runtimeDir, protocolVersion, slot))
  } catch {
  }
}

export function getDaemonTokenPath(
  runtimeDir: string,
  protocolVersion = PROTOCOL_VERSION,
  slot = 0
): string {
  return join(runtimeDir, `daemon-v${protocolVersion}${slotSuffix(slot)}.token`)
}

export function getDaemonPidPath(
  runtimeDir: string,
  protocolVersion = PROTOCOL_VERSION,
  slot = 0
): string {
  return join(runtimeDir, `daemon-v${protocolVersion}${slotSuffix(slot)}.pid`)
}

export function parseDaemonRuntimeFileName(
  name: string
): { protocolVersion: number; slot: number; kind: 'sock' | 'token' | 'pid' | 'pipe' } | null {
  const match = /^daemon-v(\d+)(?:-s(\d+))?\.(sock|token|pid|pipe)$/.exec(name)
  if (!match) return null
  return {
    protocolVersion: Number(match[1]),
    slot: match[2] ? Number(match[2]) : 0,
    kind: match[3] as 'sock' | 'token' | 'pid' | 'pipe'
  }
}

export function serializeDaemonPidFile(pidFile: DaemonPidFile): string {
  return JSON.stringify(pidFile)
}
