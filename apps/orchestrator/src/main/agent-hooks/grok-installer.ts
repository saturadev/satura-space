import { join } from 'node:path'
import {
  agentConfigDirPresent,
  atomicWriteFile,
  buildCmdPayloadScript,
  buildPosixPayloadScript,
  MANAGED_TIMEOUT,
  removeFileQuietly,
  USER_HOME,
  wrapPosixHookCommand,
  wrapWindowsHookCommand,
  writePosixScript,
  type HookHome
} from './installer-shared'

const GROK_PLAIN_EVENTS = ['UserPromptSubmit', 'Notification', 'Stop', 'SessionEnd'] as const
const GROK_TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const

function grokPaths(h: HookHome): { dir: string; hooks: string; sh: string; cmd: string } {
  const dir = join(h.home, '.grok')
  return { dir, hooks: join(dir, 'hooks', 'satura-status.json'), sh: join(h.scriptDir, 'grok-hook.sh'), cmd: join(h.scriptDir, 'grok-hook.cmd') }
}

export function installGrokHooks(h: HookHome = USER_HOME): 'written' | 'skipped' {
  const { dir, hooks: HOOKS_PATH, sh: SH_PATH, cmd: CMD_PATH } = grokPaths(h)
  if (!agentConfigDirPresent(dir, 'grok')) return 'skipped'
  writePosixScript(SH_PATH, buildPosixPayloadScript('/hook/grok', h.endpoint))
  if (process.platform === 'win32') atomicWriteFile(CMD_PATH, buildCmdPayloadScript('/hook/grok', h.endpoint))
  const command =
    process.platform === 'win32' ? wrapWindowsHookCommand(CMD_PATH) : wrapPosixHookCommand(SH_PATH)
  const hook = { type: 'command', command, timeout: MANAGED_TIMEOUT }
  const hooks: Record<string, unknown> = {}
  for (const event of GROK_PLAIN_EVENTS) hooks[event] = [{ hooks: [hook] }]
  for (const event of GROK_TOOL_EVENTS) hooks[event] = [{ matcher: '*', hooks: [hook] }]
  atomicWriteFile(HOOKS_PATH, `${JSON.stringify({ hooks }, null, 2)}\n`)
  return 'written'
}

export function uninstallGrokHooks(h: HookHome = USER_HOME): void {
  const { hooks: HOOKS_PATH, sh: SH_PATH, cmd: CMD_PATH } = grokPaths(h)
  removeFileQuietly(HOOKS_PATH)
  removeFileQuietly(SH_PATH)
  removeFileQuietly(CMD_PATH)
}
