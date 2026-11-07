import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const COMMON_NAMES = ['zsh', 'bash', 'fish', 'sh', 'nu', 'tcsh', 'ksh', 'dash', 'pwsh', 'xonsh', 'elvish']
const COMMON_DIRS = ['/bin', '/usr/bin', '/usr/local/bin', '/opt/homebrew/bin', '/run/current-system/sw/bin']

export function listShells(): string[] {
  if (process.platform === 'win32') {
    const out = new Set<string>()
    if (process.env.COMSPEC) out.add(process.env.COMSPEC)
    out.add('powershell.exe')
    out.add('pwsh.exe')
    return [...out]
  }

  const found = new Set<string>()

  try {
    for (const line of readFileSync('/etc/shells', 'utf8').split('\n')) {
      const p = line.trim()
      if (p && !p.startsWith('#') && existsSync(p)) found.add(p)
    }
  } catch {
  }

  for (const dir of COMMON_DIRS) {
    for (const name of COMMON_NAMES) {
      const p = join(dir, name)
      if (existsSync(p)) found.add(p)
    }
  }

  if (process.env.SHELL && existsSync(process.env.SHELL)) found.add(process.env.SHELL)
  if (found.size === 0) found.add('/bin/zsh')

  return [...found].sort()
}
