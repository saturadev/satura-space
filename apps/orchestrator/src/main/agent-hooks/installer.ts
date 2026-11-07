import { join } from 'node:path'
import {
  MANAGED_TIMEOUT,
  agentConfigDirPresent,
  atomicWriteFile,
  cmdLiteral,
  parseJsonConfig,
  posixSingleQuote,
  removeFileQuietly,
  updateConfigFile,
  USER_HOME,
  writePosixScript,
  withHookScripts,
  type ConfigUpdateResult,
  type HookHome
} from './installer-shared'
import { applyManagedStatusLine, removeStatusLineFiles, restoreStatusLine } from './claude-statusline'

function claudePaths(h: HookHome): { sh: string; cmd: string; dir: string; settings: string } {
  const dir = join(h.home, '.claude')
  return { sh: join(h.scriptDir, 'claude-hook.sh'), cmd: join(h.scriptDir, 'claude-hook.cmd'), dir, settings: join(dir, 'settings.json') }
}

export const CLAUDE_EVENTS = [
  'SessionStart',
  'SessionEnd',
  'Stop',
  'StopFailure',
  'Notification',
  'PermissionRequest',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure'
] as const

function buildShScript(endpoint: string): string {
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
EVENT="$1"
if [ -z "$EVENT" ]; then
  exit 0
fi
post() {
  curl -sS -X POST "http://127.0.0.1:$PORT/hook/claude" \\
    --connect-timeout 0.5 --max-time 2 \\
    -H "Content-Type: application/x-www-form-urlencoded" \\
    -H @"$ENDPOINT.header" \\
    --data-urlencode "paneKey=$SATURA_PANE_KEY" \\
    --data-urlencode "event=$EVENT" \\
    "$@" >/dev/null 2>&1 || true
}
if [ -t 0 ]; then
  post
else
  post --data-urlencode "payload@-"
fi
exit 0
`
}

function buildCmdScript(endpoint: string): string {
  return `@echo off
setlocal enabledelayedexpansion
set "ENDPOINT=%SATURA_AGENT_HOOKS_ENDPOINT%"
if "%ENDPOINT%"=="" set "ENDPOINT=${cmdLiteral(endpoint)}"
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
set "EVENT=%~1"
if "%EVENT%"=="" exit /b 0
"%SystemRoot%\\System32\\curl.exe" -sS -X POST "http://127.0.0.1:%PORT%/hook/claude" --connect-timeout 0.5 --max-time 2 -H "Content-Type: application/x-www-form-urlencoded" -H "@%ENDPOINT%.header" --data-urlencode "paneKey=%SATURA_PANE_KEY%" --data-urlencode "event=%EVENT%" --data-urlencode "payload@-" >NUL 2>&1
exit /b 0
`
}

interface HookLeaf {
  type?: string
  command?: string
  timeout?: number
}

interface HookEntry {
  matcher?: string
  hooks?: HookLeaf[]
}

function isManagedCommand(command: unknown): boolean {
  if (typeof command !== 'string') return false
  const normalized = command.replaceAll('\\', '/')
  return normalized.includes('satura') && normalized.includes('claude-hook')
}

function managedCommand(event: string, h: HookHome): string {
  const { sh, cmd } = claudePaths(h)
  if (process.platform === 'win32') {
    return `if [ -f '${cmd}' ]; then '${cmd}' ${event}; fi`
  }
  return `if [ -x '${sh}' ]; then /bin/sh '${sh}' ${event}; fi`
}

function stripManagedEntries(list: unknown): HookEntry[] {
  if (!Array.isArray(list)) return []
  const out: HookEntry[] = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') {
      out.push(entry as HookEntry)
      continue
    }
    const e = entry as HookEntry
    if (!Array.isArray(e.hooks)) {
      out.push(e)
      continue
    }
    const hooks = e.hooks.filter((h) => !isManagedCommand(h?.command))
    if (hooks.length === 0) continue
    out.push({ ...e, hooks })
  }
  return out
}

function serialize(config: Record<string, unknown>): string {
  return `${JSON.stringify(config, null, 2)}\n`
}

function writeScripts(h: HookHome): void {
  const { sh, cmd } = claudePaths(h)
  writePosixScript(sh, buildShScript(h.endpoint))
  atomicWriteFile(cmd, buildCmdScript(h.endpoint))
}

export function installClaudeHooks(h: HookHome = USER_HOME): ConfigUpdateResult {
  const { dir, settings, sh, cmd } = claudePaths(h)
  if (!agentConfigDirPresent(dir, 'claude')) return 'skipped'
  return withHookScripts([sh, cmd], () => writeScripts(h), () => updateConfigFile(settings, (raw) => {
    const config = parseJsonConfig(raw, settings)
    if (!config) return null
    const hooks: Record<string, unknown> =
      config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
        ? { ...(config.hooks as Record<string, unknown>) }
        : {}
    for (const event of CLAUDE_EVENTS) {
      const cleaned = stripManagedEntries(hooks[event])
      cleaned.push({
        hooks: [{ type: 'command', command: managedCommand(event, h), timeout: MANAGED_TIMEOUT }]
      })
      hooks[event] = cleaned
    }
    const statusLine = applyManagedStatusLine(config.statusLine, h.scriptDir)
    return serialize(statusLine ? { ...config, hooks, statusLine } : { ...config, hooks })
  }))
}

export function uninstallClaudeHooks(h: HookHome = USER_HOME): ConfigUpdateResult {
  const { sh, cmd, settings } = claudePaths(h)
  let recovered = true
  let invalid = false
  const result = updateConfigFile(settings, (raw) => {
    if (raw === null) return null
    const config = parseJsonConfig(raw, settings)
    if (!config) {
      invalid = true
      return null
    }
    const next: Record<string, unknown> = { ...config }
    if (config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)) {
      const hooks: Record<string, unknown> = { ...(config.hooks as Record<string, unknown>) }
      for (const [event, list] of Object.entries(hooks)) {
        if (!Array.isArray(list)) continue
        const cleaned = stripManagedEntries(list)
        if (cleaned.length === 0) delete hooks[event]
        else hooks[event] = cleaned
      }
      if (Object.keys(hooks).length === 0) delete next.hooks
      else next.hooks = hooks
    }
    const restored = restoreStatusLine(config.statusLine, h.scriptDir)
    recovered = restored.recovered
    if (restored.slot) next.statusLine = restored.slot
    else delete next.statusLine
    return serialize(next)
  })
  if (!invalid) {
    removeFileQuietly(sh)
    removeFileQuietly(cmd)
    removeStatusLineFiles(h.scriptDir)
  }
  console.log(
    `[agent-hooks] claude: uninstall ${result}${recovered ? '' : ' (original statusLine was lost, managed one removed)'}`
  )
  return result
}
