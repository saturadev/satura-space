export type AgentWaitKind = 'permission' | 'question' | 'input'

export type AgentSignal =
  | { type: 'session'; reason: string }
  | { type: 'prompt' }
  | { type: 'tool'; phase: 'start' | 'end'; tool: string; id: string; input: unknown; child: string }
  | { type: 'wait'; kind: AgentWaitKind; tool: string; id: string; input: unknown; child: string; message: string }
  | { type: 'wait-end'; child: string }
  | { type: 'batch'; ids: string[]; child: string }
  | { type: 'stop'; interrupted: boolean; failed: boolean; message: string }

const QUESTION_TOOLS = new Set(['askuserquestion', 'ask_user_question', 'request_user_input'])
const SESSION_START_SOURCES = new Set(['startup', 'resume', 'clear'])
const GROK_PERMISSION_RE = /permission|approval|approve|allow|confirm|action required|needs input/i

export function parseJsonObject(raw: string): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

export function readString(source: Record<string, unknown> | null, key: string): string {
  const value = source?.[key]
  return typeof value === 'string' ? value : ''
}

function pascal(name: string): string {
  if (!name.includes('_')) return name ? name[0].toUpperCase() + name.slice(1) : name
  return name
    .split('_')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1).toLowerCase())
    .join('')
}

function isQuestionTool(tool: string): boolean {
  return QUESTION_TOOLS.has(tool.toLowerCase())
}

function toolOf(p: Record<string, unknown> | null): { tool: string; id: string; input: unknown } {
  return {
    tool: readString(p, 'tool_name') || readString(p, 'toolName'),
    id: readString(p, 'tool_use_id') || readString(p, 'toolUseId'),
    input: p?.tool_input ?? p?.toolInput
  }
}

function eventName(event: string, p: Record<string, unknown> | null): string {
  return pascal(event || readString(p, 'hook_event_name') || readString(p, 'hookEventName'))
}

function claudeStyle(name: string, p: Record<string, unknown> | null, agent: string): AgentSignal | null {
  const child = readString(p, 'agent_id')
  const { tool, id, input } = toolOf(p)
  switch (name) {
    case 'SessionStart': {
      const source = readString(p, 'source') || 'startup'
      if (child || !SESSION_START_SOURCES.has(source)) return null
      return { type: 'session', reason: source }
    }
    case 'SessionEnd':
      return child ? null : { type: 'session', reason: 'end' }
    case 'UserPromptSubmit':
      return child ? null : { type: 'prompt' }
    case 'PreToolUse':
      if (isQuestionTool(tool)) return { type: 'wait', kind: 'question', tool, id, input, child, message: '' }
      return { type: 'tool', phase: 'start', tool, id, input, child }
    case 'PostToolUse':
    case 'PostToolUseFailure':
      return { type: 'tool', phase: 'end', tool, id, input, child }
    case 'PermissionRequest':
      return { type: 'wait', kind: isQuestionTool(tool) ? 'question' : 'permission', tool, id, input, child, message: '' }
    case 'Elicitation':
      return { type: 'wait', kind: 'input', tool: readString(p, 'mcp_server_name'), id: '', input: undefined, child, message: readString(p, 'message') }
    case 'ElicitationResult':
      return { type: 'wait-end', child }
    case 'PostToolBatch': {
      const calls = Array.isArray(p?.tool_calls) ? (p?.tool_calls as unknown[]) : []
      const ids = calls
        .map((c) => (c && typeof c === 'object' ? readString(c as Record<string, unknown>, 'tool_use_id') : ''))
        .filter(Boolean)
      return ids.length ? { type: 'batch', ids, child } : null
    }
    case 'Stop':
    case 'StopFailure':
    case 'StopCancelled':
      if (child) return null
      return {
        type: 'stop',
        interrupted: name === 'StopCancelled' || p?.is_interrupt === true,
        failed: name === 'StopFailure',
        message: readString(p, 'last_assistant_message')
      }
    case 'Notification':
      return notification(agent, p, child)
    default:
      return null
  }
}

function notification(agent: string, p: Record<string, unknown> | null, child: string): AgentSignal | null {
  const type = readString(p, 'notification_type').toLowerCase()
  const message = readString(p, 'message')
  if (agent === 'grok') {
    if (type === 'idle_prompt') return { type: 'stop', interrupted: false, failed: false, message: '' }
    if (type ? type.includes('permission') : GROK_PERMISSION_RE.test(message)) {
      return { type: 'wait', kind: 'permission', tool: '', id: '', input: undefined, child, message }
    }
    return null
  }
  if (type === 'elicitation_dialog') return { type: 'wait', kind: 'input', tool: '', id: '', input: undefined, child, message }
  return null
}

function cursor(name: string, p: Record<string, unknown> | null): AgentSignal | null {
  const { tool, id, input } = toolOf(p)
  switch (name) {
    case 'beforeSubmitPrompt':
      return { type: 'prompt' }
    case 'preToolUse':
    case 'beforeShellExecution':
    case 'beforeMCPExecution':
      return { type: 'tool', phase: 'start', tool: tool || name, id, input: input ?? p?.command, child: '' }
    case 'postToolUse':
    case 'postToolUseFailure':
      return { type: 'tool', phase: 'end', tool: tool || name, id, input, child: '' }
    case 'stop': {
      const status = readString(p, 'status').toLowerCase()
      return { type: 'stop', interrupted: status === 'aborted', failed: status === 'error', message: '' }
    }
    default:
      return null
  }
}

export function normalizeHookEvent(agent: string, event: string, payload: string): AgentSignal | null {
  const p = parseJsonObject(payload)
  if (agent === 'cursor') {
    const name = readString(p, 'hook_event_name') || readString(p, 'hookEventName') || event
    return cursor(name, p)
  }
  const name = eventName(event, p)
  if (!name) return null
  return claudeStyle(name, p, agent)
}
