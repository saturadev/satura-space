import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  agentConfigDirPresent,
  buildPosixPayloadScript,
  MANAGED_TIMEOUT,
  removeFileQuietly,
  updateConfigFile,
  USER_HOME,
  wrapPosixHookCommand,
  writePosixScript,
  withHookScripts,
  type ConfigUpdateResult,
  type HookHome
} from './installer-shared'

const KIMI_EVENTS = [
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure'
] as const

const BLOCK_START = '# >>> satura-managed-kimi-hooks >>>'
const BLOCK_END = '# <<< satura-managed-kimi-hooks <<<'

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const MANAGED_BLOCK_RE = new RegExp(
  `\\n*${escapeRegExp(BLOCK_START)}[\\s\\S]*?(?:${escapeRegExp(BLOCK_END)}[^\\n]*|$)`,
  'g'
)

function kimiConfigPath(h: HookHome): string {
  const home = h === USER_HOME ? process.env.KIMI_CODE_HOME?.trim() || join(homedir(), '.kimi-code') : join(h.home, '.kimi-code')
  return join(home, 'config.toml')
}

function tomlBasicString(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
  return `"${escaped}"`
}

function buildManagedBlock(command: string): string {
  const commandLiteral = tomlBasicString(command)
  const entries = KIMI_EVENTS.map((event) =>
    [
      '[[hooks]]',
      `event = "${event}"`,
      `command = ${commandLiteral}`,
      `timeout = ${MANAGED_TIMEOUT}`
    ].join('\n')
  )
  return [BLOCK_START, ...entries, BLOCK_END].join('\n')
}

function findHooksKeyConflict(text: string): string | null {
  let table: string | null = null
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].replace(/^\s+/, '')
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('[[')) {
      table = line.slice(2, line.indexOf(']]') === -1 ? undefined : line.indexOf(']]')).trim()
      continue
    }
    if (line.startsWith('[')) {
      table = line.slice(1, line.indexOf(']') === -1 ? undefined : line.indexOf(']')).trim()
      if (table === 'hooks' || table.startsWith('hooks.')) return `line ${i + 1}: [${table}] table`
      continue
    }
    if (table === null && /^(?:hooks|"hooks"|'hooks')\s*[.=]/.test(line)) return `line ${i + 1}: root hooks key`
  }
  return null
}

function withoutManagedBlock(text: string): string {
  return text.replace(MANAGED_BLOCK_RE, '').replace(/\s+$/, '')
}

export function installKimiHooks(h: HookHome = USER_HOME): ConfigUpdateResult {
  const configPath = kimiConfigPath(h)
  const SH_PATH = join(h.scriptDir, 'kimi-hook.sh')
  if (!agentConfigDirPresent(dirname(configPath), 'kimi')) return 'skipped'
  return withHookScripts([SH_PATH], () => writePosixScript(SH_PATH, buildPosixPayloadScript('/hook/kimi', h.endpoint)), () => updateConfigFile(configPath, (text) => {
    const withoutManaged = withoutManagedBlock(text ?? '')
    const conflict = findHooksKeyConflict(withoutManaged)
    if (conflict) {
      console.warn(
        `[agent-hooks] kimi: ${configPath} already defines hooks as a key or table (${conflict}); adding [[hooks]] would break it, skipping`
      )
      return null
    }
    const block = buildManagedBlock(wrapPosixHookCommand(SH_PATH))
    return withoutManaged.length > 0 ? `${withoutManaged}\n\n${block}\n` : `${block}\n`
  }))
}

export function uninstallKimiHooks(h: HookHome = USER_HOME): ConfigUpdateResult {
  const configPath = kimiConfigPath(h)
  const SH_PATH = join(h.scriptDir, 'kimi-hook.sh')
  const result = updateConfigFile(configPath, (text) => {
    if (text === null) return null
    const stripped = withoutManagedBlock(text)
    return stripped.length > 0 ? `${stripped}\n` : ''
  })
  removeFileQuietly(SH_PATH)
  return result
}
