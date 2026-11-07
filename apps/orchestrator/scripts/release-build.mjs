import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const require = createRequire(import.meta.url)
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const cli = resolve(dirname(require.resolve('electron-vite/package.json')), 'bin/electron-vite.js')

const viteCli = resolve(dirname(require.resolve('vite/package.json')), 'bin/vite.js')

const r = spawnSync(process.execPath, [cli, 'build'], {
  cwd: appDir,
  env: process.env,
  stdio: 'inherit'
})
if (r.status !== 0) process.exit(r.status ?? 1)
const remote = spawnSync(process.execPath, [viteCli, 'build', '-c', 'vite.remote.config.ts'], { cwd: appDir, env: process.env, stdio: 'inherit' })
process.exit(remote.status ?? 1)
