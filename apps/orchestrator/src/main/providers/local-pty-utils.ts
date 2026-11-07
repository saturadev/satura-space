import { basename, join } from 'node:path'
import { existsSync, accessSync, statSync, chmodSync, constants as fsConstants } from 'node:fs'
import type * as pty from 'node-pty'
import { wrapShellSpawnForMacosTccAttribution } from './macos-tcc-login-shell'

let didEnsureSpawnHelperExecutable = false

function toUnpackedAsarPath(candidate: string): string {
  return candidate
    .replace(/app\.asar([/\\])/, 'app.asar.unpacked$1')
    .replace(/node_modules\.asar([/\\])/, 'node_modules.asar.unpacked$1')
}

export function getNodePtySpawnHelperCandidates(): string[] {
  const unixTerminalPath = require.resolve('node-pty/lib/unixTerminal.js')
  const packageRoot =
    basename(unixTerminalPath) === 'unixTerminal.js'
      ? unixTerminalPath.replace(/[/\\]lib[/\\]unixTerminal\.js$/, '')
      : unixTerminalPath

  return [
    join(packageRoot, 'build', 'Release', 'spawn-helper'),
    join(packageRoot, 'build', 'Debug', 'spawn-helper'),
    join(packageRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper')
  ].map(toUnpackedAsarPath)
}

export function getShellValidationError(shellPath: string): string | null {
  if (!existsSync(shellPath)) {
    return (
      `Shell "${shellPath}" does not exist. ` +
      `Set a valid SHELL environment variable or install zsh/bash.`
    )
  }
  try {
    accessSync(shellPath, fsConstants.X_OK)
  } catch {
    return `Shell "${shellPath}" is not executable. Check file permissions.`
  }
  return null
}

export function ensureNodePtySpawnHelperExecutable(): void {
  if (didEnsureSpawnHelperExecutable || process.platform === 'win32') {
    return
  }
  didEnsureSpawnHelperExecutable = true

  try {
    for (const candidate of getNodePtySpawnHelperCandidates()) {
      if (!existsSync(candidate)) {
        continue
      }
      const mode = statSync(candidate).mode
      if ((mode & 0o111) !== 0) {
        return
      }
      chmodSync(candidate, mode | 0o755)
      return
    }
  } catch (error) {
    console.warn(
      `[pty] Failed to ensure node-pty spawn-helper is executable: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

function throwMissingWorkingDirectory(cwd: string): never {
  throw new Error(
    `Working directory "${cwd}" does not exist. ` +
      `It may have been deleted or is on an unmounted volume.`
  )
}

export function validateWorkingDirectory(cwd: string): void {
  if (!existsSync(cwd)) {
    throwMissingWorkingDirectory(cwd)
  }
  if (!statSync(cwd).isDirectory()) {
    throw new Error(`Working directory "${cwd}" is not a directory.`)
  }
}

export type ShellSpawnParams = {
  shellPath: string
  shellArgs: string[]
  termName?: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
  ptySpawn: typeof pty.spawn
}

export type ShellSpawnResult = {
  process: pty.IPty
  shellPath: string
}

function windowsConptyDllOptions(): { useConptyDll: true } | Record<string, never> {
  return process.platform === 'win32' ? { useConptyDll: true } : {}
}

export function spawnShellWithFallback(params: ShellSpawnParams): ShellSpawnResult {
  const {
    shellPath,
    shellArgs,
    termName = 'xterm-256color',
    cols,
    rows,
    cwd,
    env,
    ptySpawn
  } = params
  let primaryError: string | null = null

  if (process.platform !== 'win32') {
    primaryError = getShellValidationError(shellPath)
  }

  if (!primaryError) {
    try {
      const wrapped = wrapShellSpawnForMacosTccAttribution(shellPath, shellArgs, env)
      return {
        process: ptySpawn(wrapped.file, wrapped.args, {
          name: termName,
          cols,
          rows,
          cwd,
          env,
          ...windowsConptyDllOptions()
        }),
        shellPath
      }
    } catch (err) {
      primaryError = err instanceof Error ? err.message : String(err)
    }
  }

  if (process.platform !== 'win32') {
    const fallbackShells = ['/bin/zsh', '/bin/bash', '/bin/sh'].filter((s) => s !== shellPath)
    for (const fallback of fallbackShells) {
      if (getShellValidationError(fallback)) {
        continue
      }
      try {
        env.SHELL = fallback
        const wrapped = wrapShellSpawnForMacosTccAttribution(fallback, ['-l'], env)
        const proc = ptySpawn(wrapped.file, wrapped.args, {
          name: termName,
          cols,
          rows,
          cwd,
          env
        })
        console.warn(
          `[pty] Primary shell "${shellPath}" failed (${primaryError ?? 'unknown error'}), fell back to "${fallback}"`
        )
        return { process: proc, shellPath: fallback }
      } catch {
      }
    }
  }

  const diag = [
    `shell: ${shellPath}`,
    `cwd: ${cwd}`,
    `arch: ${process.arch}`,
    `platform: ${process.platform} ${process.getSystemVersion?.() ?? ''}`
  ].join(', ')
  throw new Error(
    `Failed to spawn shell "${shellPath}": ${primaryError ?? 'unknown error'} (${diag}). ` +
      `If this persists, please file an issue.`
  )
}
