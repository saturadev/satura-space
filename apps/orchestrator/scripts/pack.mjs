import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, rmSync } from 'node:fs'

// The bundled MCP binary is a gitignored PyInstaller artifact; packing a stale one ships an
// MCP that can't talk to the (always freshly copied) engine. Rebuild it here if its recorded
// source digest doesn't match packages/mcp — a failed rebuild must abort the pack.
const mcpGuard = spawnSync(process.execPath, ['scripts/build-mcp.mjs'], { stdio: 'inherit' })
if (mcpGuard.status !== 0) {
  console.error('[pack] MCP binary build/freshness check failed — aborting.')
  process.exit(mcpGuard.status ?? 1)
}

process.env.SATURA_ENGINE_DIR = '../../packages/saturaspace-engine'

// Windows signing (opt-in via SATURA_WIN_SIGN=1, see PACKAGING.md). build/sign-win.cjs does the
// actual signtool call; publisherName is only passed on signed runs so unsigned builds keep an
// app-update.yml with no publisher pinned.
const winSignArgs = []
if (process.env.SATURA_WIN_SIGN === '1') {
  const publisher = process.env.SATURA_WIN_PUBLISHER
  if (!publisher) {
    console.error('[pack] SATURA_WIN_SIGN=1 requires SATURA_WIN_PUBLISHER (the certificate CN) — aborting.')
    process.exit(1)
  }
  winSignArgs.push(`-c.win.signtoolOptions.publisherName=${publisher}`)
}

const GUARDED = ['package.json', 'pnpm-lock.yaml']
const snapshots = GUARDED.filter((f) => existsSync(f)).map((f) => [f, `${f}.pkgbak`])

for (const [f, bak] of snapshots) copyFileSync(f, bak)

const isWin = process.platform === 'win32'
const builder = isWin
  ? 'node_modules\\.bin\\electron-builder.cmd'
  : 'node_modules/.bin/electron-builder'
const args = [...process.argv.slice(2), ...winSignArgs]
const res = isWin
  ? spawnSync(`"${builder}"`, args.map((a) => `"${a}"`), { stdio: 'inherit', shell: true })
  : spawnSync(builder, args, { stdio: 'inherit' })

for (const [f, bak] of snapshots) {
  try {
    copyFileSync(bak, f)
    rmSync(bak)
  } catch {
  }
}

process.exit(res.status ?? (res.error ? 1 : 0))
