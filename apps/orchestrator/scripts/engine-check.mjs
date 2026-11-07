import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_PROJECT } from './test-project.mjs'

const appDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const engineDir = resolve(appDir, '..', '..', 'packages', 'saturaspace-engine')
const PKG_PREFIXES = ['Packages/com.saturaspace.engine/', 'Packages/com.saturaspace.sdk/', '/packages/saturaspace-sdk/']

const args = process.argv.slice(2)
const flag = (name) => {
  const i = args.indexOf(name)
  if (i === -1) return null
  const value = args[i + 1]
  args.splice(i, 2)
  return value ?? null
}
const showWarnings = args.includes('--warnings')
const projectArg = flag('--project')

const project = resolve(projectArg || TEST_PROJECT)
if (!existsSync(join(project, 'Assets'))) {
  console.error(
    `[engine-check] need a Unity project that has compiled the engine once: --project <path> or SATURA_TEST_PROJECT (got "${project}")`
  )
  process.exit(3)
}

const version = /m_EditorVersion:\s*(\S+)/.exec(readFileSync(join(project, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8'))?.[1]
const scripting = `/Applications/Unity/Hub/Editor/${version}/Unity.app/Contents/Resources/Scripting/DotNetSdk`
const dotnetSdkDir = join(scripting, 'sdk')
const dotnetSdk = existsSync(dotnetSdkDir) ? readdirSync(dotnetSdkDir).sort().pop() : null
const dotnet = join(scripting, 'dotnet')
const csc = dotnetSdk ? join(dotnetSdkDir, dotnetSdk, 'Roslyn', 'bincore', 'csc.dll') : ''
if (!existsSync(dotnet) || !existsSync(csc)) {
  console.error(`[engine-check] Unity ${version}'s Roslyn is missing (${csc || dotnetSdkDir})`)
  process.exit(2)
}

const bee = join(project, 'Library', 'Bee', 'artifacts')
const dag = existsSync(bee)
  ? readdirSync(bee)
      .filter((d) => d.endsWith('.dag') && existsSync(join(bee, d, 'SaturaSpace.Engine.Editor.rsp')))
      .sort((a, b) => statSync(join(bee, b)).mtimeMs - statSync(join(bee, a)).mtimeMs)[0]
  : null
if (!dag) {
  console.error(`[engine-check] ${project} has no compiled engine yet (Library/Bee/artifacts/*.dag/SaturaSpace.Engine.Editor.rsp)`)
  process.exit(2)
}
const dagRel = `Library/Bee/artifacts/${dag}`

function asmdefDirs() {
  const out = new Map()
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (e.name.endsWith('.asmdef')) {
        const name = JSON.parse(readFileSync(full, 'utf8')).name
        if (name) out.set(name, dir)
      }
    }
  }
  walk(engineDir)
  return out
}

function sourcesUnder(root, otherRoots) {
  const out = []
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) {
        if (!otherRoots.has(full)) walk(full)
      } else if (e.name.endsWith('.cs')) out.push(full)
    }
  }
  walk(root)
  return out.sort()
}

const roots = asmdefDirs()
const allRootDirs = new Set(roots.values())
const assemblies = [...roots.keys()].filter((name) => existsSync(join(project, dagRel, `${name}.rsp`)))
const outDir = mkdtempSync(join(tmpdir(), 'engine-check-'))
const built = new Map()

const order = []
const deps = new Map(
  assemblies.map((name) => {
    const rsp = readFileSync(join(project, dagRel, `${name}.rsp`), 'utf8')
    return [name, assemblies.filter((other) => other !== name && rsp.includes(`/${other}.ref.dll"`))]
  })
)
const visit = (name, seen = new Set()) => {
  if (order.includes(name) || seen.has(name)) return
  seen.add(name)
  for (const d of deps.get(name) ?? []) visit(d, seen)
  order.push(name)
}
for (const name of assemblies) visit(name)

let failed = 0
const started = Date.now()
for (const name of order) {
  const own = roots.get(name)
  const others = new Set([...allRootDirs].filter((d) => d !== own))
  const lines = readFileSync(join(project, dagRel, `${name}.rsp`), 'utf8').split(/\r?\n/)
  const kept = []
  for (const line of lines) {
    if (!line.trim()) continue
    if (line.startsWith('-out:') || line.startsWith('-refout:')) continue
    if (line.startsWith('"') && PKG_PREFIXES.some((p) => line.includes(p)) && line.endsWith('.cs"')) continue
    const ref = /^-r:"(.*)\/([^/]+)\.ref\.dll"$/.exec(line)
    if (ref && built.has(ref[2]) && existsSync(built.get(ref[2]))) {
      kept.push(`-r:"${built.get(ref[2])}"`)
      continue
    }
    kept.push(line)
  }
  const dll = join(outDir, `${name}.dll`)
  kept.push(`-out:"${dll}"`)
  for (const file of sourcesUnder(own, others)) kept.push(`"${file}"`)
  const rspPath = join(outDir, `${name}.rsp`)
  writeFileSync(rspPath, kept.join('\n') + '\n')
  const t = Date.now()
  const r = spawnSync(dotnet, [csc, '-nologo', `@${rspPath}`], { cwd: project, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.split('\n').filter(Boolean)
  const errors = out.filter((l) => /\berror\b/.test(l))
  const warnings = out.filter((l) => /\bwarning\b/.test(l))
  built.set(name, dll)
  const label = `${name} (${relative(engineDir, own) || '.'}): ${errors.length} error(s), ${warnings.length} warning(s), ${((Date.now() - t) / 1000).toFixed(1)}s`
  console.log(`[engine-check] ${label}`)
  for (const l of errors.slice(0, 60)) console.log(`  ${l.replace(engineDir + '/', '')}`)
  if (showWarnings) for (const l of warnings) console.log(`  ${l.replace(engineDir + '/', '')}`)
  if (r.status !== 0 || errors.length) failed++
}
rmSync(outDir, { recursive: true, force: true })
console.log(`[engine-check] ${failed ? 'FAILED' : 'ok'}: ${order.length} engine assemblies against ${project} (Unity ${version}) in ${((Date.now() - started) / 1000).toFixed(1)}s`)
process.exit(failed ? 1 : 0)
