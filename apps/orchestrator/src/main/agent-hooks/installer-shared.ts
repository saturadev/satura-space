import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { atomicWriteFileSync } from '../safe-fs'

export interface HookHome {
  home: string
  scriptDir: string
  endpoint: string
  disabled: string
}

export function hookHome(home: string): HookHome {
  const scriptDir = join(home, '.satura', 'agent-hooks')
  return { home, scriptDir, endpoint: join(scriptDir, 'endpoint'), disabled: join(scriptDir, 'disabled') }
}

export const USER_HOME = hookHome(homedir())
export const SCRIPT_DIR = USER_HOME.scriptDir
export const ENDPOINT_PATH = USER_HOME.endpoint
export const DISABLED_MARKER_PATH = USER_HOME.disabled
export const MANAGED_TIMEOUT = 10
export const MAX_CONFIG_BACKUPS = 5

export function posixSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function cmdLiteral(value: string): string {
  return value.replaceAll('%', '%%')
}

export function atomicWriteFile(path: string, content: string, mode?: number): void {
  mkdirSync(dirname(path), { recursive: true })
  atomicWriteFileSync(path, content, mode === undefined ? {} : { mode })
}

type FileSnapshot = { raw: string | null; mtimeMs: number | null }

function readSnapshot(path: string): FileSnapshot {
  let raw: string | null = null
  let mtimeMs: number | null = null
  try {
    mtimeMs = statSync(path).mtimeMs
    raw = readFileSync(path, 'utf-8')
  } catch {
  }
  return { raw, mtimeMs }
}

function sameSnapshot(a: FileSnapshot, b: FileSnapshot): boolean {
  return a.raw === b.raw && a.mtimeMs === b.mtimeMs
}

function backupStamp(now = new Date()): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}-${pad(now.getMilliseconds(), 3)}`
}

function listConfigBackups(path: string): string[] {
  const prefix = `${basename(path)}.bak.`
  try {
    return readdirSync(dirname(path))
      .filter((name) => name.startsWith(prefix))
      .sort()
      .map((name) => join(dirname(path), name))
  } catch {
    return []
  }
}

function backupConfigFile(path: string, content: string, max = MAX_CONFIG_BACKUPS): string | null {
  const latest = listConfigBackups(path).at(-1)
  if (latest) {
    try {
      if (readFileSync(latest, 'utf-8') === content) return latest
    } catch {
    }
  }
  const stamp = backupStamp()
  let target = `${path}.bak.${stamp}-000`
  for (let i = 1; existsSync(target); i++) target = `${path}.bak.${stamp}-${String(i).padStart(3, '0')}`
  try {
    writeFileSync(target, content, { encoding: 'utf-8', mode: 0o600 })
  } catch {
    return null
  }
  const all = listConfigBackups(path)
  for (const old of all.slice(0, Math.max(0, all.length - max))) {
    try {
      rmSync(old, { force: true })
    } catch {
    }
  }
  return target
}

export type ConfigUpdateResult = 'written' | 'unchanged' | 'skipped'

export function updateConfigFile(
  path: string,
  edit: (current: string | null) => string | null,
  opts: { backup?: boolean } = {}
): ConfigUpdateResult {
  let base = readSnapshot(path)
  let next = edit(base.raw)
  if (next === null) return 'skipped'
  if (next === base.raw) return 'unchanged'
  const fresh = readSnapshot(path)
  if (!sameSnapshot(base, fresh)) {
    console.warn(`[agent-hooks] ${path} changed while it was being updated; applying the edit to the new content`)
    base = fresh
    next = edit(base.raw)
    if (next === null) return 'skipped'
    if (next === base.raw) return 'unchanged'
  }
  if (opts.backup !== false && base.raw !== null) backupConfigFile(path, base.raw)
  atomicWriteFileSync(path, next)
  return 'written'
}

export function parseJsonConfig(raw: string | null, label: string): Record<string, unknown> | null {
  if (raw === null) return {}
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw
  if (text.trim() === '') return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
  }
  console.warn(`[agent-hooks] ${label} is not a JSON object; leaving it untouched`)
  return null
}

export function agentConfigDirPresent(dir: string, agent: string): boolean {
  if (existsSync(dir)) return true
  console.log(`[agent-hooks] ${agent}: ${dir} does not exist, skipping (agent not installed)`)
  return false
}

export function withHookScripts(paths: string[], write: () => void, update: () => ConfigUpdateResult): ConfigUpdateResult {
  const fresh = paths.filter((p) => !existsSync(p))
  write()
  const result = update()
  if (result === 'skipped') for (const p of fresh) removeFileQuietly(p)
  return result
}

export function removeFileQuietly(path: string): void {
  try {
    rmSync(path, { force: true })
  } catch {
  }
}

export function writePosixScript(path: string, body: string): void {
  atomicWriteFile(path, body)
  try {
    chmodSync(path, 0o755)
  } catch {
  }
}

export function endpointPath(): string {
  return process.env.SATURA_AGENT_HOOKS_ENDPOINT?.trim() || ENDPOINT_PATH
}

export function writeEndpoint(port: number, token: string): void {
  const file = endpointPath()
  try {
    atomicWriteFile(`${file}.header`, `X-Satura-Hook-Token: ${token}\n`, 0o600)
    atomicWriteFile(file, `port=${port}\ntoken=${token}\n`, 0o600)
  } catch {
  }
}

export function wrapPosixHookCommand(scriptPath: string): string {
  const posixPath = process.platform === 'win32' ? scriptPath.replaceAll('\\', '/') : scriptPath
  const quoted = posixSingleQuote(posixPath)
  return `if [ -x ${quoted} ]; then /bin/sh ${quoted}; fi`
}

const WINDOWS_CMD_SAFE_PATH = /^[A-Za-z0-9_.:\\~-]+$/

export function wrapWindowsHookCommand(scriptPath: string): string {
  if (WINDOWS_CMD_SAFE_PATH.test(scriptPath)) return scriptPath
  const command = `& '${scriptPath.replaceAll("'", "''")}'; exit $LASTEXITCODE`
  const encoded = Buffer.from(command, 'utf16le').toString('base64')
  return `powershell.exe -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`
}

export function managedCommandMatcher(scriptStem: string): (command: unknown) => boolean {
  return (command) => {
    if (typeof command !== 'string') return false
    const normalized = command.replaceAll('\\', '/')
    return normalized.includes('satura') && normalized.includes(scriptStem)
  }
}

export function buildPosixPayloadScript(hookPath: string, endpointFile = ENDPOINT_PATH): string {
  const endpoint =
    process.platform === 'win32' ? endpointFile.replaceAll('\\', '/') : endpointFile
  return `#!/bin/sh
ENDPOINT="\${SATURA_AGENT_HOOKS_ENDPOINT:-}"
[ -n "$ENDPOINT" ] || ENDPOINT=${posixSingleQuote(endpoint)}
if [ ! -f "$ENDPOINT" ]; then
  exit 0
fi
PORT=$(sed -n 's/^port=//p' "$ENDPOINT" 2>/dev/null)
TOKEN=$(sed -n 's/^token=//p' "$ENDPOINT" 2>/dev/null)
if [ -z "$PORT" ] || [ -z "$TOKEN" ] || [ -z "$SATURA_PANE_KEY" ] || [ ! -f "$ENDPOINT.header" ]; then
  exit 0
fi
payload=$(cat)
if [ -z "$payload" ]; then
  exit 0
fi
printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:$PORT${hookPath}" \\
  --connect-timeout 0.5 --max-time 2 \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -H @"$ENDPOINT.header" \\
  --data-urlencode "paneKey=$SATURA_PANE_KEY" \\
  --data-urlencode "payload@-" >/dev/null 2>&1 || true
exit 0
`
}

export function buildCmdPayloadScript(hookPath: string, endpointFile = ENDPOINT_PATH): string {
  return `@echo off
setlocal enabledelayedexpansion
set "ENDPOINT=%SATURA_AGENT_HOOKS_ENDPOINT%"
if "%ENDPOINT%"=="" set "ENDPOINT=${cmdLiteral(endpointFile)}"
if not exist "%ENDPOINT%" exit /b 0
set "PORT="
set "TOKEN="
for /f "usebackq tokens=1,* delims==" %%A in ("%ENDPOINT%") do (
  if "%%A"=="port" set "PORT=%%B"
  if "%%A"=="token" set "TOKEN=%%B"
)
if "%PORT%"=="" exit /b 0
if "%TOKEN%"=="" exit /b 0
if not exist "%ENDPOINT%.header" exit /b 0
if "%SATURA_PANE_KEY%"=="" exit /b 0
"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%PORT%${hookPath}" --connect-timeout 0.5 --max-time 2 -H "Content-Type: application/x-www-form-urlencoded" -H "@%ENDPOINT%.header" --data-urlencode "paneKey=%SATURA_PANE_KEY%" --data-urlencode "payload@-" >NUL 2>&1
exit /b 0
`
}
