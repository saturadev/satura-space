import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const WIN = process.platform === 'win32'
const HERE = dirname(fileURLToPath(import.meta.url))
const ORCH = join(HERE, '..')
const MCP_DIR = join(ORCH, '..', '..', 'packages', 'mcp')
const EXE = WIN ? 'satura-space-mcp.exe' : 'satura-space-mcp'
const DEST = join(ORCH, 'resources', 'mcp', EXE)
const SIDECAR = `${DEST}.build.json`
const VENV_PY = WIN ? join(MCP_DIR, '.venv', 'Scripts', 'python.exe') : join(MCP_DIR, '.venv', 'bin', 'python')
const BUILD_INFO = join(MCP_DIR, 'unity_mcp', '_build_info.py')
const ENGINE_PKG_JSON = join(ORCH, '..', '..', 'packages', 'saturaspace-engine', 'package.json')
const ORCH_PKG_JSON = join(ORCH, 'package.json')

const force = process.argv.includes('--force')
const checkOnly = process.argv.includes('--check')

function pkgVersion(pkgJsonPath) {
  try {
    return JSON.parse(readFileSync(pkgJsonPath, 'utf8')).version ?? null
  } catch {
    return null
  }
}

function writeBuildInfo() {
  const version = pkgVersion(ENGINE_PKG_JSON) ?? pkgVersion(ORCH_PKG_JSON) ?? ''
  const body = `VERSION = ${JSON.stringify(version)}\n`
  if (!existsSync(BUILD_INFO) || readFileSync(BUILD_INFO, 'utf8') !== body) {
    writeFileSync(BUILD_INFO, body)
  }
  return version
}

function sourceFiles() {
  const files = [
    'server.py',
    'satura-space-mcp.spec',
    'requirements.txt',
    'requirements-build.txt',
    'pyproject.toml'
  ].map((f) => join(MCP_DIR, f))
  const pkg = join(MCP_DIR, 'unity_mcp')
  for (const e of readdirSync(pkg, { recursive: true })) {
    const p = join(pkg, String(e))
    if (p.split(sep).includes('__pycache__')) continue
    if (p.endsWith('.py') && statSync(p).isFile()) files.push(p)
  }
  return files.filter(existsSync).sort()
}

function sourceDigest() {
  const h = createHash('sha256')
  for (const f of sourceFiles()) {
    h.update(relative(MCP_DIR, f).split(sep).join('/'))
    h.update('\0')
    h.update(readFileSync(f))
    h.update('\0')
  }
  return h.digest('hex')
}

function isFresh(digest) {
  if (!existsSync(DEST)) return false
  try {
    return JSON.parse(readFileSync(SIDECAR, 'utf8')).digest === digest
  } catch {
    return false
  }
}

function run(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, { stdio: 'inherit', cwd: MCP_DIR, ...opts })
  if (res.error) throw res.error
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${res.status}`)
}

function build(digest) {
  if (!existsSync(VENV_PY)) {
    console.log('[build-mcp] creating venv...')
    const py = WIN ? 'python' : 'python3'
    run(py, ['-m', 'venv', join(MCP_DIR, '.venv')])
  }
  console.log('[build-mcp] installing runtime + build deps...')
  run(VENV_PY, ['-m', 'pip', 'install', '-q', '-r', join(MCP_DIR, 'requirements.txt')])
  run(VENV_PY, ['-m', 'pip', 'install', '-q', '-r', join(MCP_DIR, 'requirements-build.txt')])
  console.log(`[build-mcp] freezing ${EXE} with PyInstaller...`)
  run(VENV_PY, ['-m', 'PyInstaller', join(MCP_DIR, 'satura-space-mcp.spec'), '--noconfirm', '--clean'])
  const out = join(MCP_DIR, 'dist', EXE)
  if (!existsSync(out)) throw new Error(`PyInstaller produced no binary at ${out}`)
  mkdirSync(dirname(DEST), { recursive: true })
  copyFileSync(out, DEST)
  writeFileSync(
    SIDECAR,
    JSON.stringify({ digest, builtAt: new Date().toISOString(), platform: process.platform, arch: process.arch }, null, 2)
  )
  console.log(`[build-mcp] OK -> ${DEST} (${statSync(DEST).size} bytes)`)
}

const version = writeBuildInfo()
if (!version) console.log('[build-mcp] WARNING: no product version found — the version guard will be off.')
const digest = sourceDigest()
if (!force && isFresh(digest)) {
  console.log(`[build-mcp] ${EXE} is up to date with packages/mcp sources.`)
  process.exit(0)
}
if (checkOnly) {
  console.error(
    `[build-mcp] STALE: ${EXE} does not match the current packages/mcp sources.\n` +
      '[build-mcp] Run `node scripts/build-mcp.mjs` (or npm run pack/dist, which do it automatically).'
  )
  process.exit(1)
}
console.log(
  existsSync(DEST)
    ? `[build-mcp] ${EXE} is stale (sources changed since it was built) — rebuilding.`
    : `[build-mcp] ${EXE} is missing — building.`
)
build(digest)
