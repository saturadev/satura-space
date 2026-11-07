import { existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  atomicWriteFile,
  cmdLiteral,
  managedCommandMatcher,
  posixSingleQuote,
  removeFileQuietly,
  SCRIPT_DIR,
  writePosixScript
} from './installer-shared'

export const STATUSLINE_HOOK_PATH = '/statusline/claude'

const MIN_POST_INTERVAL_SECONDS = 15
const isManagedStatusLine = managedCommandMatcher('claude-statusline')

export interface StatusLineSlot {
  type?: string
  command?: string
  [key: string]: unknown
}

export interface StatusLineScriptPaths {
  endpoint: string
  stamp: string
}

interface InstallPaths {
  sh: string
  cmd: string
  wrapped: string
  script: StatusLineScriptPaths
}

function installPaths(root: string): InstallPaths {
  return {
    sh: join(root, 'satura-claude-statusline.sh'),
    cmd: join(root, 'satura-claude-statusline.cmd'),
    wrapped: join(root, 'claude-statusline-wrapped.json'),
    script: { endpoint: join(root, 'endpoint'), stamp: join(tmpdir(), 'satura-claude-statusline-last') }
  }
}

export function buildStatusLineShScript(inner: string, paths: StatusLineScriptPaths): string {
  const render = inner ? `printf '%s' "$payload" | sh -c ${posixSingleQuote(inner)} || true` : ':'
  return `#!/bin/sh
ENDPOINT=${posixSingleQuote(paths.endpoint)}
STAMP=${posixSingleQuote(paths.stamp)}
payload=$(cat)
satura_post() {
  [ -f "$ENDPOINT" ] || return 0
  PORT=$(sed -n 's/^port=//p' "$ENDPOINT" 2>/dev/null)
  TOKEN=$(sed -n 's/^token=//p' "$ENDPOINT" 2>/dev/null)
  [ -n "$PORT" ] || return 0
  [ -n "$TOKEN" ] || return 0
  [ -f "$ENDPOINT.header" ] || return 0
  now=$(date +%s 2>/dev/null) || return 0
  case "$now" in 0|[1-9]|[1-9][0-9]*) ;; *) return 0 ;; esac
  if [ -f "$STAMP" ]; then
    last=
    IFS= read -r last <"$STAMP" 2>/dev/null || :
    case "$last" in 0|[1-9]|[1-9][0-9]*) ;; *) last= ;; esac
    if [ -n "$last" ]; then
      elapsed=$((now - last))
      if [ "$elapsed" -ge 0 ] && [ "$elapsed" -lt ${MIN_POST_INTERVAL_SECONDS} ]; then
        return 0
      fi
    fi
  fi
  printf '%s' "$now" >"$STAMP" 2>/dev/null || :
  printf '%s' "$payload" | curl -sS -X POST "http://127.0.0.1:$PORT${STATUSLINE_HOOK_PATH}" \\
    --connect-timeout 0.5 --max-time 2 \\
    -H "Content-Type: application/x-www-form-urlencoded" \\
    -H @"$ENDPOINT.header" \\
    --data-urlencode "configDir=\${CLAUDE_CONFIG_DIR:-}" \\
    --data-urlencode "payload@-" >/dev/null 2>&1 || :
}
case "$payload" in
  *'"rate_limits"'*) satura_post ;;
esac
${render}
exit 0
`
}

function buildCmdScript(endpoint: string): string {
  return `@echo off
setlocal enabledelayedexpansion
set "ENDPOINT=${cmdLiteral(endpoint)}"
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
set "PAYLOAD_FILE=%TEMP%\\satura-claude-statusline.tmp"
more > "%PAYLOAD_FILE%" 2>nul
"%SystemRoot%\\System32\\findstr.exe" /c:\\"rate_limits\\" "%PAYLOAD_FILE%" >nul 2>nul
if errorlevel 1 goto :cleanup
set "CONFIG_DIR_FIELD=configDir="
if defined CLAUDE_CONFIG_DIR set "CONFIG_DIR_FIELD=configDir=%CLAUDE_CONFIG_DIR%"
"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%PORT%${STATUSLINE_HOOK_PATH}" --connect-timeout 0.5 --max-time 2 -H "Content-Type: application/x-www-form-urlencoded" -H "@%ENDPOINT%.header" --data-urlencode "%CONFIG_DIR_FIELD%" --data-urlencode "payload@%PAYLOAD_FILE%" >NUL 2>&1
:cleanup
del "%PAYLOAD_FILE%" >nul 2>nul
exit /b 0
`
}

const ORIGINAL_ARG = '--satura-original='

function managedCommand(paths: InstallPaths, inner: string): string {
  if (process.platform === 'win32') return paths.cmd
  const base = `/bin/sh ${posixSingleQuote(paths.sh)}`
  return inner ? `${base} ${ORIGINAL_ARG}${Buffer.from(inner, 'utf8').toString('base64')}` : base
}

function decodeEmbeddedOriginal(command: string): string | null {
  const match = /--satura-original=([A-Za-z0-9+/=]+)/.exec(command)
  if (!match) return null
  try {
    return Buffer.from(match[1], 'base64').toString('utf8')
  } catch {
    return null
  }
}

function readWrapped(path: string): string | null {
  try {
    if (!existsSync(path)) return null
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf-8'))
    const command = (parsed as { command?: unknown })?.command
    return typeof command === 'string' ? command : null
  } catch {
    return null
  }
}

function asSlot(slot: unknown): StatusLineSlot | null {
  return slot && typeof slot === 'object' && !Array.isArray(slot) ? (slot as StatusLineSlot) : null
}

function recoverOriginal(paths: InstallPaths, currentCommand: string): string | null {
  return readWrapped(paths.wrapped) ?? decodeEmbeddedOriginal(currentCommand)
}

export function applyManagedStatusLine(slot: unknown, root = SCRIPT_DIR): StatusLineSlot | null {
  const paths = installPaths(root)
  const current = asSlot(slot)
  const currentCommand = typeof current?.command === 'string' ? current.command : ''
  const wasManaged = isManagedStatusLine(currentCommand)
  let inner = currentCommand
  if (wasManaged) {
    const recovered = recoverOriginal(paths, currentCommand)
    if (recovered === null) {
      console.warn(
        `[agent-hooks] Claude statusLine is managed but its original command is lost (${paths.wrapped} missing); leaving the statusLine as it is`
      )
      if (process.platform !== 'win32' && !existsSync(paths.sh)) {
        writePosixScript(paths.sh, buildStatusLineShScript('', paths.script))
      }
      return current
    }
    inner = recovered
  }

  if (inner && process.platform === 'win32') return current

  atomicWriteFile(paths.wrapped, `${JSON.stringify({ command: inner }, null, 2)}\n`)

  if (process.platform === 'win32') atomicWriteFile(paths.cmd, buildCmdScript(paths.script.endpoint))
  else writePosixScript(paths.sh, buildStatusLineShScript(inner, paths.script))

  return { ...(current ?? {}), type: 'command', command: managedCommand(paths, inner) }
}

export type StatusLineRestore = { slot: StatusLineSlot | undefined; recovered: boolean }

export function restoreStatusLine(slot: unknown, root = SCRIPT_DIR): StatusLineRestore {
  const paths = installPaths(root)
  const current = asSlot(slot)
  const currentCommand = typeof current?.command === 'string' ? current.command : ''
  if (!isManagedStatusLine(currentCommand)) {
    return { slot: current ?? undefined, recovered: true }
  }
  const original = recoverOriginal(paths, currentCommand)
  if (original === null) {
    console.warn('[agent-hooks] Claude statusLine original command is lost; removing the managed statusLine')
    return { slot: undefined, recovered: false }
  }
  if (!original) return { slot: undefined, recovered: true }
  return { slot: { ...current, type: 'command', command: original }, recovered: true }
}

export function removeStatusLineFiles(root = SCRIPT_DIR): void {
  const paths = installPaths(root)
  removeFileQuietly(paths.sh)
  removeFileQuietly(paths.cmd)
  removeFileQuietly(paths.wrapped)
}
