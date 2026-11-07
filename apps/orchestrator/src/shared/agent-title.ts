export type AgentTitleStatus = 'working' | 'idle' | 'needs-input'

const GEMINI_WORKING = '✦'
const GEMINI_SILENT_WORKING = '⏲'
const GEMINI_IDLE = '◇'
const GEMINI_PERMISSION = '✋'
const CLAUDE_IDLE = '✳'

const ACTION_MARKER_RE = /^\[\s*[.!]\s*\]\s*action required\b/i
const SEGMENT_SPLIT_RE = /\s+[|·]\s+|\s+-\s+/
const NEEDS_INPUT_SEGMENT_RE =
  /^(?:action required|waiting for (?:your )?(?:input|approval|permission)|needs? (?:your )?(?:input|approval|permission)|permission (?:required|needed|requested))$/i
const WORKING_SEGMENT_RE = /^(?:working|thinking|running)$/i
const IDLE_SEGMENT_RE = /^(?:ready|idle|done)$/i

function containsSpinner(title: string): boolean {
  for (const ch of title) {
    const cp = ch.codePointAt(0)
    if (cp === undefined) continue
    if (cp >= 0x2800 && cp <= 0x28ff) return true
    if (cp >= 0x25d0 && cp <= 0x25d3) return true
  }
  return false
}

function segments(title: string): string[] {
  return title
    .split(SEGMENT_SPLIT_RE)
    .map((s) => s.trim().replace(/^\[(.*)\]$/, '$1').trim())
    .filter(Boolean)
}

export function detectAgentStatusFromTitle(title: string | undefined | null): AgentTitleStatus | null {
  if (!title) return null

  if (title.includes(GEMINI_PERMISSION)) return 'needs-input'
  if (ACTION_MARKER_RE.test(title.trim())) return 'needs-input'
  if (title.includes(GEMINI_WORKING) || title.includes(GEMINI_SILENT_WORKING)) return 'working'
  if (title.includes(GEMINI_IDLE)) return 'idle'

  if (title.startsWith(`${CLAUDE_IDLE} `) || title === CLAUDE_IDLE) return 'idle'

  if (containsSpinner(title)) return 'working'

  if (title.startsWith('. ')) return 'working'
  if (title.startsWith('* ')) return 'idle'

  const parts = segments(title)
  if (parts.some((s) => NEEDS_INPUT_SEGMENT_RE.test(s))) return 'needs-input'
  if (parts.some((s) => WORKING_SEGMENT_RE.test(s))) return 'working'
  if (parts.some((s) => IDLE_SEGMENT_RE.test(s))) return 'idle'

  return null
}

const STATUS_GLYPH_RE = /^(?:[✳✦⏲◇✋⠀-⣿◐-◓]️?|[.*](?= ))\s*/u

export function stripAgentStatusGlyph(title: string): string {
  return title.replace(STATUS_GLYPH_RE, '') || title
}
