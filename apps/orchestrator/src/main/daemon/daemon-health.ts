import { execFile, execFileSync } from 'node:child_process'
import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { connect, type Socket } from 'node:net'
import { promisify } from 'node:util'
import {
  getProcessOutputFields,
  iterateProcessOutputLines
} from '../../shared/process-output-field-scanner'
const isStartupDiagnosticsEnabled = (): boolean => false
const logStartupDiagnostic = (_event: string, _details?: Record<string, unknown>): void => {}
import { encodeNdjson } from './ndjson'
import { getDaemonPidPath } from './daemon-spawner'
import {
  PROTOCOL_VERSION,
  type HelloMessage,
  type HelloResponse,
  type SystemResolverHealth,
  type SystemResolverHealthResult
} from './types'

const HEALTH_CHECK_TIMEOUT_MS = process.platform === 'win32' ? 5_000 : 3_000
const RESOLVER_HEALTH_CHECK_TIMEOUT_MS = 3_000
const KILL_WAIT_MS = 3_000
const KILL_POLL_MS = 100
const START_TIME_TOLERANCE_MS = 1_500

export type DaemonHealth = 'healthy' | 'unreachable' | 'pty-spawn-unhealthy'

export type DaemonHealthResult = {
  health: DaemonHealth
  buildId: string | null
}

type ParsedDaemonPid = {
  pid: number
  startedAtMs: number | null
  entryPath: string | null
  appVersion: string | null
  buildId: string | null
}

function canConnectSocket(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve(false)
      return
    }
    const sock = connect({ path: socketPath })
    let settled = false
    const cleanup = (): void => {
      clearTimeout(timer)
      sock.off('connect', onConnect)
      sock.off('error', onError)
    }
    const settle = (result: boolean): void => {
      if (settled) {
        return
      }
      settled = true
      cleanup()
      resolve(result)
    }
    const onConnect = (): void => {
      settle(true)
      sock.destroy()
    }
    const onError = (): void => {
      settle(false)
    }
    const timer = setTimeout(() => {
      settle(false)
      sock.destroy()
    }, 500)
    sock.on('connect', onConnect)
    sock.on('error', onError)
  })
}

export function checkDaemonHealth(socketPath: string, tokenPath: string): Promise<DaemonHealthResult> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' && !existsSync(socketPath)) {
      resolve({ health: 'unreachable', buildId: null })
      return
    }

    let token: string
    try {
      token = readFileSync(tokenPath, 'utf8').trim()
    } catch {
      resolve({ health: 'unreachable', buildId: null })
      return
    }

    let settled = false
    let sock: Socket | null = null
    let buildId: string | null = null
    const settle = (health: DaemonHealth): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      removeSocketListeners()
      sock?.destroy()
      resolve({ health, buildId })
    }
    const removeSocketListeners = (): void => {
      sock?.off('error', onError)
      sock?.off('connect', onConnect)
      sock?.off('data', onData)
    }
    const onError = (): void => settle('unreachable')
    const onConnect = (): void => {
      const hello: HelloMessage = {
        type: 'hello',
        version: PROTOCOL_VERSION,
        token,
        clientId: 'health-check',
        role: 'control'
      }
      sock?.write(encodeNdjson(hello))
    }
    const onData = (chunk: Buffer): void => {
      if (settled) {
        return
      }
      buffer += chunk.toString()
      for (;;) {
        const newlineIdx = buffer.indexOf('\n')
        if (newlineIdx === -1) {
          break
        }
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) {
          continue
        }

        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          settle('unreachable')
          return
        }

        if (message.type === 'hello') {
          if (!(message as HelloResponse).ok) {
            settle('unreachable')
            return
          }
          const reported = (message as HelloResponse).buildId
          buildId = typeof reported === 'string' ? reported : null
          sock?.write(encodeNdjson({ id: 'health-1', type: 'ptySpawnHealth' }))
          continue
        }

        if (message.id === 'health-1') {
          settle(message.ok === true ? 'healthy' : 'pty-spawn-unhealthy')
          return
        }
      }
    }
    const timer = setTimeout(() => settle('unreachable'), HEALTH_CHECK_TIMEOUT_MS)

    sock = connect({ path: socketPath })
    sock.on('error', onError)
    sock.on('connect', onConnect)

    let buffer = ''
    sock.on('data', onData)
  })
}

function isSystemResolverHealth(value: unknown): value is SystemResolverHealth {
  return value === 'healthy' || value === 'unhealthy' || value === 'unknown'
}

export function getMacDaemonSystemResolverHealth(
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION
): Promise<SystemResolverHealth> {
  if (process.platform !== 'darwin') {
    return Promise.resolve('unknown')
  }

  return new Promise((resolve) => {
    if (!existsSync(socketPath)) {
      resolve('unknown')
      return
    }

    let token: string
    try {
      token = readFileSync(tokenPath, 'utf8').trim()
    } catch {
      resolve('unknown')
      return
    }

    let settled = false
    let sock: Socket | null = null
    const settle = (result: SystemResolverHealth): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      removeSocketListeners()
      sock?.destroy()
      resolve(result)
    }
    const removeSocketListeners = (): void => {
      sock?.off('error', onError)
      sock?.off('connect', onConnect)
      sock?.off('data', onData)
    }
    const onError = (): void => settle('unknown')
    const onConnect = (): void => {
      const hello: HelloMessage = {
        type: 'hello',
        version: protocolVersion,
        token,
        clientId: 'resolver-health-check',
        role: 'control'
      }
      sock?.write(encodeNdjson(hello))
    }
    const onData = (chunk: Buffer): void => {
      if (settled) {
        return
      }
      buffer += chunk.toString()
      for (;;) {
        const newlineIdx = buffer.indexOf('\n')
        if (newlineIdx === -1) {
          break
        }
        const line = buffer.slice(0, newlineIdx)
        buffer = buffer.slice(newlineIdx + 1)
        if (!line) {
          continue
        }

        let message: Record<string, unknown>
        try {
          message = JSON.parse(line) as Record<string, unknown>
        } catch {
          settle('unknown')
          return
        }

        if (message.type === 'hello') {
          if (!(message as HelloResponse).ok) {
            settle('unknown')
            return
          }
          sock?.write(encodeNdjson({ id: 'resolver-health-1', type: 'systemResolverHealth' }))
          continue
        }

        if (message.id === 'resolver-health-1') {
          if (!message.ok || typeof message.payload !== 'object' || message.payload === null) {
            settle('unknown')
            return
          }
          const payload = message.payload as Partial<SystemResolverHealthResult>
          settle(isSystemResolverHealth(payload.health) ? payload.health : 'unknown')
          return
        }
      }
    }
    const timer = setTimeout(() => settle('unknown'), RESOLVER_HEALTH_CHECK_TIMEOUT_MS)

    sock = connect({ path: socketPath })
    sock.on('error', onError)
    sock.on('connect', onConnect)

    let buffer = ''
    sock.on('data', onData)
  })
}

function commandLineMatchesDaemon(
  commandLine: string,
  socketPath: string,
  tokenPath: string
): boolean {
  return (
    commandLine.includes('daemon-entry') &&
    commandLine.includes(socketPath) &&
    commandLine.includes(tokenPath)
  )
}

export function parseDaemonPidFile(contents: string): ParsedDaemonPid | null {
  const trimmed = contents.trim()
  try {
    const parsed = JSON.parse(trimmed) as {
      pid?: unknown
      startedAtMs?: unknown
      entryPath?: unknown
      appVersion?: unknown
      buildId?: unknown
    }
    if (typeof parsed.pid === 'number' && Number.isFinite(parsed.pid)) {
      return {
        pid: parsed.pid,
        startedAtMs:
          typeof parsed.startedAtMs === 'number' && Number.isFinite(parsed.startedAtMs)
            ? parsed.startedAtMs
            : null,
        entryPath: typeof parsed.entryPath === 'string' ? parsed.entryPath : null,
        appVersion: typeof parsed.appVersion === 'string' ? parsed.appVersion : null,
        buildId: typeof parsed.buildId === 'string' ? parsed.buildId : null
      }
    }
  } catch {
  }

  const pid = Number(trimmed)
  return Number.isFinite(pid)
    ? { pid, startedAtMs: null, entryPath: null, appVersion: null, buildId: null }
    : null
}

function getLinuxProcessStartedAtMs(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
    const startTicks = parseLinuxProcStartTicks(stat)
    const bootTimeSeconds = parseLinuxBootTimeSeconds(readFileSync('/proc/stat', 'utf8'))
    const ticksPerSecond = Number(
      execFileSync('getconf', ['CLK_TCK'], { encoding: 'utf8', timeout: 1_000 }).trim()
    )
    if (
      !Number.isFinite(startTicks) ||
      !Number.isFinite(bootTimeSeconds) ||
      !Number.isFinite(ticksPerSecond) ||
      ticksPerSecond <= 0
    ) {
      return null
    }
    return bootTimeSeconds * 1000 + (startTicks / ticksPerSecond) * 1000
  } catch {
    return null
  }
}

export function parseLinuxProcStartTicks(stat: string): number {
  const commandEndIndex = stat.lastIndexOf(')')
  if (commandEndIndex === -1) {
    return Number.NaN
  }

  const fields = getProcessOutputFields(stat.slice(commandEndIndex + 1), 20)
  return Number(fields[19])
}

export function parseLinuxBootTimeSeconds(procStat: string): number {
  for (const line of iterateProcessOutputLines(procStat)) {
    if (!line.startsWith('btime ')) {
      continue
    }
    return Number(getProcessOutputFields(line, 2)[1])
  }
  return Number.NaN
}

export function getProcessStartedAtMs(pid: number): number | null {
  if (process.platform === 'linux') {
    return getLinuxProcessStartedAtMs(pid)
  }

  if (process.platform === 'win32') {
    return null
  }

  try {
    const output = execFileSync('ps', ['-p', String(pid), '-o', 'lstart='], {
      encoding: 'utf8',
      timeout: 2_000
    }).trim()
    const startedAtMs = Date.parse(output)
    return Number.isFinite(startedAtMs) ? startedAtMs : null
  } catch {
    return null
  }
}

export function startTimeMatches(pid: number, expectedStartedAtMs: number | null): boolean {
  if (expectedStartedAtMs === null) {
    return true
  }

  const actualStartedAtMs = getProcessStartedAtMs(pid)
  if (actualStartedAtMs === null) {
    return true
  }

  return Math.abs(actualStartedAtMs - expectedStartedAtMs) <= START_TIME_TOLERANCE_MS
}

const execFileAsync = promisify(execFile)

async function queryWindowsProcessCommandLine(pid: number): Promise<string | null> {
  const startedAt = performance.now()
  try {
    const { stdout } = await execFileAsync(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`
      ],
      {
        encoding: 'utf8',
        timeout: 3_000
      }
    )
    return stdout
  } catch {
    return null
  } finally {
    if (isStartupDiagnosticsEnabled()) {
      logStartupDiagnostic('daemon-pid-check', {
        t: Math.round(performance.now()),
        pid,
        ms: Math.round(performance.now() - startedAt)
      })
    }
  }
}

async function isDaemonProcess(
  pid: number,
  socketPath: string,
  tokenPath: string,
  startedAtMs: number | null
): Promise<boolean> {
  try {
    process.kill(pid, 0)
  } catch {
    return false
  }

  if (process.platform === 'win32') {
    const output = await queryWindowsProcessCommandLine(pid)
    if (output === null) {
      return false
    }
    return (
      commandLineMatchesDaemon(output, socketPath, tokenPath) && startTimeMatches(pid, startedAtMs)
    )
  }

  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8')
    return (
      commandLineMatchesDaemon(cmdline, socketPath, tokenPath) && startTimeMatches(pid, startedAtMs)
    )
  } catch {
    try {
      const output = execFileSync('ps', ['-p', String(pid), '-o', 'command='], {
        encoding: 'utf8',
        timeout: 2_000
      })
      return (
        commandLineMatchesDaemon(output, socketPath, tokenPath) &&
        startTimeMatches(pid, startedAtMs)
      )
    } catch {
      return false
    }
  }
}

export async function readVerifiedDaemonPid(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION,
  slot = 0
): Promise<ParsedDaemonPid | null> {
  let parsedPid: ParsedDaemonPid | null
  try {
    parsedPid = parseDaemonPidFile(
      readFileSync(getDaemonPidPath(runtimeDir, protocolVersion, slot), 'utf8')
    )
  } catch {
    return null
  }

  if (
    !parsedPid ||
    !(await isDaemonProcess(parsedPid.pid, socketPath, tokenPath, parsedPid.startedAtMs))
  ) {
    return null
  }

  return parsedPid
}

export async function killStaleDaemon(
  runtimeDir: string,
  socketPath: string,
  tokenPath: string,
  protocolVersion = PROTOCOL_VERSION,
  slot = 0
): Promise<boolean> {
  const pidPath = getDaemonPidPath(runtimeDir, protocolVersion, slot)
  let killedDaemon = false
  try {
    const parsedPid = parseDaemonPidFile(readFileSync(pidPath, 'utf8'))
    if (
      parsedPid &&
      (await isDaemonProcess(parsedPid.pid, socketPath, tokenPath, parsedPid.startedAtMs))
    ) {
      const { pid, startedAtMs } = parsedPid
      process.kill(pid, 'SIGTERM')
      const deadline = Date.now() + KILL_WAIT_MS
      let exited = false
      while (Date.now() < deadline) {
        try {
          process.kill(pid, 0)
        } catch {
          exited = true
          break
        }
        await new Promise((resolve) => setTimeout(resolve, KILL_POLL_MS))
      }
      if (!exited) {
        if (!(await isDaemonProcess(pid, socketPath, tokenPath, startedAtMs))) {
          console.warn('[daemon] Skipping SIGKILL for stale daemon: reason=pid_recycled')
          exited = true
          killedDaemon = true
        } else {
          try {
            process.kill(pid, 'SIGKILL')
            exited = true
          } catch {
          }
        }
      }
      killedDaemon = killedDaemon || exited
    }
  } catch {
  }

  try {
    unlinkSync(pidPath)
  } catch {
  }

  const socketIsLive = await canConnectSocket(socketPath)
  if (process.platform !== 'win32' && existsSync(socketPath) && (killedDaemon || !socketIsLive)) {
    try {
      unlinkSync(socketPath)
    } catch {
    }
  }
  return killedDaemon
}
