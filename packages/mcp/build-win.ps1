$ErrorActionPreference = 'Stop'
# Thin wrapper: the real build (venv + PyInstaller + copy into the orchestrator's
# resources/mcp + freshness sidecar) lives in apps/orchestrator/scripts/build-mcp.mjs so
# macOS, Windows, and the pack step all share one implementation. --force always rebuilds;
# `npm run pack`/`dist` run the same script without --force and rebuild only when stale.
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $dir '..\..\apps\orchestrator\scripts\build-mcp.mjs'

$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'Node.js not found on PATH (build-mcp.mjs needs it).' }

& $node $script --force
if ($LASTEXITCODE -ne 0) { throw "build-mcp.mjs failed with exit code $LASTEXITCODE" }
