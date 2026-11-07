import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

export function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform === 'win32') return true
    accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

export function execNames(cmd: string): string[] {
  if (process.platform !== 'win32') return [cmd]
  const exts = (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
  return [...exts.flatMap((e) => [cmd + e, cmd + e.toLowerCase()]), cmd]
}

function nvmNodeBinDirs(): string[] {
  const root = join(homedir(), '.nvm', 'versions', 'node')
  try {
    return readdirSync(root).map((v) => join(root, v, 'bin'))
  } catch {
    return []
  }
}

export function cliCandidateDirs(): string[] {
  const pathDirs = (process.env.PATH ?? process.env.Path ?? '').split(delimiter).filter(Boolean)
  const home = homedir()
  const extra = [
    join(home, '.local', 'bin'),
    join(home, '.volta', 'bin'),
    join(home, '.asdf', 'shims'),
    join(home, '.bun', 'bin'),
    join(home, '.yarn', 'bin'),
    join(home, 'Library', 'pnpm'),
    join(home, '.local', 'share', 'pnpm'),
    join(home, '.cargo', 'bin'),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    ...nvmNodeBinDirs()
  ]
  return [...new Set([...pathDirs, ...extra])]
}

export function resolveCliCommand(cmd: string): string {
  for (const dir of cliCandidateDirs()) {
    for (const exe of execNames(cmd)) {
      const candidate = join(dir, exe)
      if (isExecutable(candidate)) return candidate
    }
  }
  return cmd
}

export function cliAugmentedPath(): string {
  return cliCandidateDirs().join(delimiter)
}

export function applyCliAugmentedPath(env: Record<string, string>): void {
  const key = Object.keys(env).find((k) => /^path$/i.test(k)) ?? 'PATH'
  const current = (env[key] ?? '').split(delimiter).filter(Boolean)
  const seen = new Set(current.map((d) => normalizeDir(d)))
  const added: string[] = []
  for (const dir of cliCandidateDirs()) {
    const norm = normalizeDir(dir)
    if (seen.has(norm)) continue
    seen.add(norm)
    added.push(dir)
  }
  if (added.length === 0) return
  env[key] = [...current, ...added].join(delimiter)
}

function normalizeDir(dir: string): string {
  const trimmed = dir.replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? trimmed.toLowerCase().replace(/\//g, '\\') : trimmed
}
