import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = resolve(appDir, '..', '..')
const bin = (pkg, entry) => resolve(dirname(require.resolve(`${pkg}/package.json`)), entry)
const tsc = bin('typescript', 'bin/tsc')

const args = process.argv.slice(2)
const all = args.includes('--all')
const base = args.find((a) => a.startsWith('--base='))?.slice('--base='.length) ?? 'HEAD'

const cacheDir = join(tmpdir(), `satura-check-${createHash('sha1').update(appDir).digest('hex').slice(0, 10)}`)
mkdirSync(cacheDir, { recursive: true })

function git(gitArgs) {
  const r = spawnSync('git', gitArgs, { cwd: repoDir, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  return (r.stdout ?? '').split('\n').map((l) => l.trim()).filter(Boolean)
}

const changed = [
  ...new Set([...git(['diff', '--name-only', base]), ...git(['ls-files', '--others', '--exclude-standard'])])
]
const appRel = relative(repoDir, appDir)
const inApp = changed.filter((f) => f.startsWith(`${appRel}/`)).map((f) => f.slice(appRel.length + 1))
const engineChanged = changed.some((f) => f.startsWith('packages/saturaspace-engine/') && f.endsWith('.cs'))
const isCode = (f) => /\.(ts|tsx|mts|cts)$/.test(f)

const projects = new Set()
for (const f of inApp.filter(isCode)) {
  if (f.startsWith('src/shared/')) {
    projects.add('node')
    projects.add('web')
  } else if (f.startsWith('src/renderer/')) projects.add('web')
  else if (f.startsWith('src/') || /^electron\.vite.*\.ts$/.test(f)) projects.add('node')
}
if (all || inApp.some((f) => /^tsconfig.*\.json$|^package\.json$/.test(f))) for (const p of ['node', 'web']) projects.add(p)

function run(label, cmd, cmdArgs) {
  const started = Date.now()
  return new Promise((done) => {
    const child = spawn(cmd, cmdArgs, { cwd: appDir, env: process.env })
    let out = ''
    child.stdout.on('data', (b) => (out += b))
    child.stderr.on('data', (b) => (out += b))
    child.on('close', (code) => done({ label, code, out, secs: ((Date.now() - started) / 1000).toFixed(1) }))
  })
}

const jobs = []
for (const p of projects) {
  jobs.push(
    run(`tsc ${p}`, process.execPath, [
      tsc,
      '--noEmit',
      '--incremental',
      '--tsBuildInfoFile',
      join(cacheDir, `${p}.tsbuildinfo`),
      '-p',
      `tsconfig.${p}.json`
    ])
  )
}
if (engineChanged) jobs.push(run('engine C#', process.execPath, [join(appDir, 'scripts', 'engine-check.mjs')]))

if (jobs.length === 0) {
  console.log(`[check] nothing to check: no TypeScript or engine changes against ${base}`)
  process.exit(0)
}

let failed = 0
for (const r of await Promise.all(jobs)) {
  const skipped = r.label === 'engine C#' && r.code === 3
  const ok = r.code === 0 || skipped
  if (!ok) failed++
  console.log(`[check] ${skipped ? 'skip' : ok ? 'ok  ' : 'FAIL'} ${r.label} (${r.secs}s)`)
  const lines = r.out.split('\n')
  const shown = ok
    ? lines.filter((l) => /\[engine-check\] (ok|FAILED):/.test(l))
    : lines.filter((l) => l.trim()).slice(-80)
  if (skipped) shown.push(...lines.filter((l) => l.includes('[engine-check]')))
  for (const l of shown) console.log(`       ${l}`)
}
process.exit(failed ? 1 : 0)
