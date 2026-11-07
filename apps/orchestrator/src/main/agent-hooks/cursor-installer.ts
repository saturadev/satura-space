import { join } from 'node:path'
import {
  agentConfigDirPresent,
  atomicWriteFile,
  buildCmdPayloadScript,
  buildPosixPayloadScript,
  MANAGED_TIMEOUT,
  managedCommandMatcher,
  parseJsonConfig,
  removeFileQuietly,
  updateConfigFile,
  USER_HOME,
  withHookScripts,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  writePosixScript,
  type ConfigUpdateResult,
  type HookHome
} from './installer-shared'

const CURSOR_EVENTS = [
  'beforeSubmitPrompt',
  'stop',
  'preToolUse',
  'postToolUse',
  'postToolUseFailure',
  'beforeShellExecution',
  'beforeMCPExecution'
] as const

function cursorPaths(h: HookHome): { dir: string; hooks: string; sh: string; cmd: string } {
  const dir = join(h.home, '.cursor')
  return { dir, hooks: join(dir, 'hooks.json'), sh: join(h.scriptDir, 'cursor-hook.sh'), cmd: join(h.scriptDir, 'cursor-hook.cmd') }
}

const isManaged = managedCommandMatcher('cursor-hook')

interface CursorHookDefinition {
  command?: unknown
  hooks?: { command?: unknown }[]
}

function hasManagedCommand(definition: unknown): boolean {
  if (!definition || typeof definition !== 'object') return false
  const d = definition as CursorHookDefinition
  if (isManaged(d.command)) return true
  return Array.isArray(d.hooks) && d.hooks.some((h) => isManaged(h?.command))
}

function sweepManaged(hooks: Record<string, unknown>): boolean {
  let changed = false
  for (const [event, definitions] of Object.entries(hooks)) {
    if (!Array.isArray(definitions)) continue
    const cleaned = definitions.filter((d) => !hasManagedCommand(d))
    if (cleaned.length === definitions.length) continue
    changed = true
    if (cleaned.length === 0) delete hooks[event]
    else hooks[event] = cleaned
  }
  return changed
}

function managedCommand(sh: string, cmd: string): string {
  return process.platform === 'win32'
    ? wrapWindowsHookCommand(cmd)
    : wrapPosixHookCommand(sh)
}

function hooksOf(config: Record<string, unknown>): Record<string, unknown> {
  return config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)
    ? { ...(config.hooks as Record<string, unknown>) }
    : {}
}

export function installCursorHooks(h: HookHome = USER_HOME): ConfigUpdateResult {
  const { dir, hooks: HOOKS_PATH, sh: SH_PATH, cmd: CMD_PATH } = cursorPaths(h)
  if (!agentConfigDirPresent(dir, 'cursor')) return 'skipped'
  const write = (): void => {
    writePosixScript(SH_PATH, buildPosixPayloadScript('/hook/cursor', h.endpoint))
    if (process.platform === 'win32') atomicWriteFile(CMD_PATH, buildCmdPayloadScript('/hook/cursor', h.endpoint))
  }
  return withHookScripts(process.platform === 'win32' ? [SH_PATH, CMD_PATH] : [SH_PATH], write, () => updateConfigFile(HOOKS_PATH, (raw) => {
    const config = parseJsonConfig(raw, HOOKS_PATH)
    if (!config) return null
    const hooks = hooksOf(config)
    sweepManaged(hooks)
    const command = managedCommand(SH_PATH, CMD_PATH)
    for (const event of CURSOR_EVENTS) {
      const current = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : []
      hooks[event] = [...current, { command, timeout: MANAGED_TIMEOUT }]
    }
    const next = { ...config, version: config.version ?? 1, hooks }
    return `${JSON.stringify(next, null, 2)}\n`
  }))
}

export function uninstallCursorHooks(h: HookHome = USER_HOME): ConfigUpdateResult {
  const { hooks: HOOKS_PATH, sh: SH_PATH, cmd: CMD_PATH } = cursorPaths(h)
  const result = updateConfigFile(HOOKS_PATH, (raw) => {
    if (raw === null) return null
    const config = parseJsonConfig(raw, HOOKS_PATH)
    if (!config) return null
    const hooks = hooksOf(config)
    if (!sweepManaged(hooks)) return raw
    return `${JSON.stringify({ ...config, hooks }, null, 2)}\n`
  })
  removeFileQuietly(SH_PATH)
  removeFileQuietly(CMD_PATH)
  return result
}
