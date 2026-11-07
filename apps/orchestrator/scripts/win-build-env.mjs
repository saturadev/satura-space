import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

function findVsWithCppTools() {
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  const vswhere = join(programFilesX86, 'Microsoft Visual Studio', 'Installer', 'vswhere.exe')
  if (!existsSync(vswhere)) return null
  try {
    const out = execFileSync(
      vswhere,
      [
        '-products', '*',
        '-prerelease',
        '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
        '-property', 'installationPath',
        '-format', 'value'
      ],
      { encoding: 'utf8' }
    )
    const path = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean)
    return path && existsSync(path) ? path : null
  } catch {
    return null
  }
}

export function winBuildEnv(base = process.env) {
  if (process.platform !== 'win32') return base
  const env = { ...base }
  delete env.NoDefaultCurrentDirectoryInExePath
  if (!env.GYP_MSVS_OVERRIDE_PATH) {
    const vs = findVsWithCppTools()
    if (vs) {
      env.GYP_MSVS_OVERRIDE_PATH = vs
      console.log(`[win-build-env] using VS toolset at ${vs}`)
    } else {
      console.log('[win-build-env] no VS install with VC.Tools found via vswhere; relying on node-gyp defaults')
    }
  }
  return env
}
