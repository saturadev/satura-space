import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const app = resolve(here, '../../../../apps/orchestrator')
const out = resolve(here, '../m/app')
const run = spawnSync('corepack', ['pnpm@10.34.9', 'exec', 'vite', 'build', '--config', 'vite.remote.config.ts', '--logLevel', 'warn'], { cwd: app, stdio: 'inherit', env: { ...process.env, SATURA_REMOTE_OUT: out } })
if (run.status !== 0) process.exit(run.status ?? 1)
const manifest = join(out, 'satura-remote.json')
if (!existsSync(join(out, 'app', 'index.html')) || !existsSync(join(out, 'm', 'index.html')) || !existsSync(manifest)) {
  console.error(`phone site build left no app/index.html, m/index.html or satura-remote.json in ${out}`)
  process.exit(1)
}
console.log(`phone site ${readFileSync(manifest, 'utf8')} built into ${out}`)
