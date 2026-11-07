import { spawnSync, execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { winBuildEnv } from './win-build-env.mjs'

const require = createRequire(import.meta.url)
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const env = winBuildEnv({ ...process.env })

function installElectronBinary() {
  const electronDir = dirname(require.resolve('electron/package.json'))
  if (existsSync(join(electronDir, 'path.txt')) && existsSync(join(electronDir, 'dist'))) return
  console.log('[postinstall] download Electron binary')
  const r = spawnSync(process.execPath, [join(electronDir, 'install.js')], {
    cwd: electronDir,
    env,
    stdio: 'inherit'
  })
  if (r.status === 0) return
  console.error('[postinstall] FATAL: Electron binary download failed')
  process.exit(r.status ?? 1)
}

function rebuildNodePty() {
  const cli = join(dirname(require.resolve('@electron/rebuild')), 'cli.js')
  console.log('[postinstall] electron-rebuild node-pty')
  const r = spawnSync(process.execPath, [cli, '-f', '-w', 'node-pty'], { cwd: root, env, stdio: 'inherit' })
  if (r.status === 0) return
  if (process.platform === 'win32') {
    console.warn(
      '[postinstall] node-pty Electron rebuild failed; falling back to its shipped N-API prebuild ' +
        '(ABI-stable under Electron). Terminals will use the prebuilt pty.node.'
    )
    const prebuilt = join(
      root,
      'node_modules',
      'node-pty',
      'prebuilds',
      `${process.platform}-${process.arch}`,
      'pty.node'
    )
    if (!existsSync(prebuilt)) {
      console.error(`[postinstall] FATAL: no node-pty prebuild at ${prebuilt}`)
      process.exit(1)
    }
    return
  }
  console.error('[postinstall] FATAL: node-pty rebuild failed')
  process.exit(r.status ?? 1)
}

function buildNative() {
  console.log('[postinstall] build-native (shared-surface)')
  execFileSync(process.execPath, [join(root, 'scripts', 'build-native.mjs')], {
    cwd: root,
    env,
    stdio: 'inherit'
  })
}

installElectronBinary()
rebuildNodePty()
buildNative()
