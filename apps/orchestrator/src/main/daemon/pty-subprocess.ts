import { homedir } from 'node:os'
import { basename } from 'node:path'
import { spawn as ptySpawn } from 'node-pty'
import type { SubprocessHandle } from './session'
import { isValidPtySize, normalizePtySize } from './daemon-pty-size'
import { removeInheritedNoColor } from '../pty/terminal-color-env'
import { removeInheritedAgentSession } from '../pty/agent-session-env'
import { applyCliAugmentedPath } from '../agents/cli-command-resolver'
import { resolveSafePtyDefaultCwd } from '../providers/pty-default-cwd'
import {
  spawnShellWithFallback,
  validateWorkingDirectory,
  ensureNodePtySpawnHelperExecutable
} from '../providers/local-pty-utils'

const PRE_LISTENER_BUFFER_MAX_CHARS = 512 * 1024
const PTY_SPAWN_HEALTH_RETRY_ATTEMPTS = 2

export type PtySubprocessOptions = {
  sessionId: string
  cols: number
  rows: number
  cwd?: string
  env?: Record<string, string>
  shellOverride?: string
}

function resolveShell(override?: string): { shell: string; args: string[] } {
  if (process.platform === 'win32') {
    const shell = override || process.env.COMSPEC || 'powershell.exe'
    const name = basename(shell).toLowerCase()
    if (name === 'powershell.exe' || name === 'pwsh.exe' || name === 'powershell' || name === 'pwsh') {
      return { shell, args: ['-NoLogo'] }
    }
    return { shell, args: [] }
  }
  return { shell: override || process.env.SHELL || '/bin/zsh', args: ['-l'] }
}

function buildEnv(extraEnv: Record<string, string> | undefined): Record<string, string> {
  const inherited = { ...(process.env as Record<string, string>) }
  removeInheritedAgentSession(inherited)
  const env: Record<string, string> = {
    ...inherited,
    ...extraEnv,
    TERM: 'xterm-256color',
    COLORTERM: 'truecolor',
    TERM_PROGRAM: 'SaturaSpace'
  }
  applyCliAugmentedPath(env)
  removeInheritedNoColor(env)
  delete env.ELECTRON_RUN_AS_NODE
  return env
}

export function createPtySubprocess(opts: PtySubprocessOptions): SubprocessHandle {
  const size = normalizePtySize(opts.cols, opts.rows)
  const cwd = opts.cwd || process.env.HOME || homedir()
  const effectiveCwd = directoryExists(cwd) ? cwd : resolveSafePtyDefaultCwd()

  const { shell, args } = resolveShell(opts.shellOverride)
  const env = buildEnv(opts.env)

  const spawned = spawnShellWithFallback({
    shellPath: shell,
    shellArgs: args,
    termName: 'xterm-256color',
    cols: size.cols,
    rows: size.rows,
    cwd: effectiveCwd,
    env,
    ptySpawn
  })
  const proc = spawned.process

  let dead = false
  let disposed = false
  let nodePtyKillIssued = false
  let onDataCb: ((data: string) => void) | null = null
  let onExitCb: ((code: number) => void) | null = null
  let pendingPreListenerData: string[] = []
  let pendingPreListenerDataChars = 0
  let pendingPreListenerExitCode: number | null = null

  function flushPreListenerData(): void {
    if (!onDataCb || pendingPreListenerData.length === 0) {
      return
    }
    const buffered = pendingPreListenerData.join('')
    pendingPreListenerData = []
    pendingPreListenerDataChars = 0
    onDataCb(buffered)
  }

  proc.onData((data) => {
    if (onDataCb) {
      onDataCb(data)
      return
    }
    pendingPreListenerData.push(data)
    pendingPreListenerDataChars += data.length
    while (pendingPreListenerDataChars > PRE_LISTENER_BUFFER_MAX_CHARS && pendingPreListenerData.length > 1) {
      const dropped = pendingPreListenerData.shift() as string
      pendingPreListenerDataChars -= dropped.length
    }
  })

  proc.onExit(({ exitCode }) => {
    dead = true
    if (onExitCb) {
      flushPreListenerData()
      onExitCb(exitCode)
    } else {
      pendingPreListenerExitCode = exitCode
    }
  })

  return {
    pid: proc.pid,
    getForegroundProcess: () => {
      if (dead) {
        return null
      }
      try {
        return proc.process ?? null
      } catch {
        return null
      }
    },
    write: (data) => {
      if (dead) {
        return
      }
      try {
        proc.write(data)
      } catch {
        dead = true
      }
    },
    resize: (cols, rows) => {
      if (dead || !isValidPtySize(cols, rows)) {
        return
      }
      try {
        proc.resize(cols, rows)
      } catch {
        dead = true
      }
    },
    clear: () => {
      if (dead) {
        return
      }
      try {
        proc.clear()
      } catch {
      }
    },
    kill: () => {
      if (dead) {
        return
      }
      try {
        nodePtyKillIssued = true
        proc.kill()
      } catch {
        dead = true
      }
    },
    forceKill: () => {
      if (dead) {
        return
      }
      try {
        process.kill(proc.pid, 'SIGKILL')
      } catch {
        try {
          nodePtyKillIssued = true
          proc.kill()
        } catch {
        }
      }
    },
    signal: (sig) => {
      if (dead) {
        return
      }
      try {
        process.kill(proc.pid, sig)
      } catch {
      }
    },
    onData: (cb) => {
      onDataCb = cb
      flushPreListenerData()
    },
    onExit: (cb) => {
      onExitCb = cb
      if (pendingPreListenerExitCode !== null) {
        const code = pendingPreListenerExitCode
        pendingPreListenerExitCode = null
        flushPreListenerData()
        cb(code)
      }
    },
    dispose: () => {
      if (disposed) {
        return
      }
      disposed = true
      dead = true
      onDataCb = null
      onExitCb = null
      pendingPreListenerData = []
      pendingPreListenerDataChars = 0
      pendingPreListenerExitCode = null
      void nodePtyKillIssued
      ;(proc as unknown as { kill: (sig?: string) => void }).kill = () => {}
      try {
        ;(proc as unknown as { destroy?: () => void }).destroy?.()
      } catch {
      }
    }
  }
}

function directoryExists(path: string): boolean {
  try {
    validateWorkingDirectory(path)
    return true
  } catch {
    return false
  }
}

export async function checkPtySpawnHealth(): Promise<void> {
  ensureNodePtySpawnHelperExecutable()
  let lastError: unknown
  for (let attempt = 1; attempt <= PTY_SPAWN_HEALTH_RETRY_ATTEMPTS; attempt++) {
    try {
      await runSinglePtySpawnHealthProbe()
      return
    } catch (err) {
      lastError = err
      if (attempt < PTY_SPAWN_HEALTH_RETRY_ATTEMPTS) {
        console.warn(
          `[daemon] PTY spawn health probe attempt ${attempt} failed; retrying`,
          err instanceof Error ? err.message : err
        )
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError))
}

function runSinglePtySpawnHealthProbe(): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    let probe: ReturnType<typeof ptySpawn> | null = null
    const disposeProbe = (): void => {
      if (!probe) {
        return
      }
      try {
        probe.kill()
      } catch {
      }
      try {
        ;(probe as unknown as { destroy?: () => void }).destroy?.()
      } catch {
      }
    }
    const finish = (err?: Error): void => {
      if (settled) {
        return
      }
      settled = true
      clearTimeout(timer)
      if (err) {
        reject(err)
      } else {
        resolve()
      }
    }
    const timer = setTimeout(() => {
      if (settled) {
        return
      }
      finish(new Error('PTY spawn health probe timed out'))
      disposeProbe()
    }, 4000)
    try {
      const win = process.platform === 'win32'
      const shell = win
        ? process.env.COMSPEC || 'powershell.exe'
        : process.env.SHELL || '/bin/zsh'
      const probeArgs = !win
        ? ['-c', 'exit 0']
        : /^cmd(\.exe)?$/i.test(basename(shell))
          ? ['/d', '/c', 'exit 0']
          : ['-NoLogo', '-NoProfile', '-Command', 'exit 0']
      probe = ptySpawn(shell, probeArgs, {
        name: 'xterm-256color',
        cols: 80,
        rows: 24,
        cwd: resolveSafePtyDefaultCwd(),
        env: buildEnv(undefined),
        ...(win ? { useConptyDll: true } : {})
      })
      const spawned = probe
      spawned.onExit(() => {
        try {
          ;(spawned as unknown as { destroy?: () => void }).destroy?.()
        } catch {
        }
        finish()
      })
    } catch (err) {
      finish(err instanceof Error ? err : new Error(String(err)))
    }
  })
}
