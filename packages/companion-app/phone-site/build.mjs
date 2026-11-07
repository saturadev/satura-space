import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const app = join(repo, 'apps/orchestrator')
const out = resolve(process.env.SATURA_PHONE_OUT || join(here, 'dist'))
const relay = process.env.SATURA_PHONE_RELAY || 'wss://relay.saturaspace.com/ws'
const account = process.env.SATURA_PHONE_ACCOUNT ?? 'https://app.saturaspace.com'
const MANIFEST = 'phone-app.json'
const UNSERVED = new Set(['_headers', '_redirects', MANIFEST])
const TEXT = /\.(html|js|mjs|css|json|webmanifest|txt|svg|map)$/
const REQUIRED = ['m/index.html', 'm/entry.js', 'app/index.html', 'app/home.html', 'app/media-sw.js', 'app/report-frame/boot.html', 'satura-remote.json', 'phone-config.json', '_headers', '_redirects', '404.html']

function fail(text) {
  console.error(`phone site: ${text}`)
  process.exit(1)
}

function walk(dir, prefix = '') {
  const list = []
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = `${prefix}${e.name}`
    if (e.isDirectory()) list.push(...walk(join(dir, e.name), `${rel}/`))
    else if (e.isFile()) list.push(rel)
    else fail(`${rel} is neither a file nor a folder`)
  }
  return list
}

function commit() {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: repo, encoding: 'utf8' }).trim()
    if (dirty) console.warn('phone site: the working tree has uncommitted changes, so this build may not match its commit')
    return sha
  } catch (e) {
    fail(`can't read the git commit: ${e.message}`)
  }
}

const vite = join(app, 'node_modules/vite/bin/vite.js')
if (!existsSync(vite)) fail(`no vite in ${app}; install its dependencies first`)
rmSync(out, { recursive: true, force: true })
const run = spawnSync(process.execPath, [vite, 'build', '--config', 'vite.remote.config.ts', '--logLevel', 'warn'], {
  cwd: app,
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production', SATURA_REMOTE_OUT: out, SATURA_PHONE_RELAY: relay, SATURA_PHONE_ACCOUNT: account }
})
if (run.status !== 0) process.exit(run.status ?? 1)

const files = walk(out).sort()
for (const f of REQUIRED) if (!files.includes(f)) fail(`the build left no ${f} in ${out}`)
const leaks = [repo, homedir(), out].filter((p) => p.length > 1)
for (const f of files) {
  if (!TEXT.test(f)) continue
  const text = readFileSync(join(out, f), 'utf8')
  const hit = leaks.find((p) => text.includes(p))
  if (hit) fail(`${f} contains the build machine path ${hit}`)
}

const manifest = { commit: commit(), files: {} }
let bytes = 0
for (const f of files) {
  if (UNSERVED.has(f)) continue
  const body = readFileSync(join(out, f))
  bytes += body.length
  manifest.files[f] = createHash('sha256').update(body).digest('hex')
}
const text = `${JSON.stringify(manifest, null, 2)}\n`
writeFileSync(join(out, MANIFEST), text)
console.log(`phone site built into ${out}: ${Object.keys(manifest.files).length} files, ${(bytes / 1048576).toFixed(1)} MB, commit ${manifest.commit}, relay ${relay}, account ${account || 'none'}`)
console.log(`${MANIFEST} sha256 ${createHash('sha256').update(text).digest('hex')}`)
