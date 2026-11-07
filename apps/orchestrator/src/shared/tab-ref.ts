import type { TabContentType } from './types'

export interface ExecTab {
  id: string
  ptyId: string
  label: string
  kind: string
  agent: string | null
  pane: number | null
  shown: boolean
  focused: boolean
  phone?: boolean
}

export const TAB_KIND: Record<TabContentType, string> = {
  terminal: 'terminal',
  'unity-instance-player': 'unity',
  'unity-console': 'console',
  'file-viewer': 'viewer',
  tuner: 'tuner',
  'unity-scratchpad': 'scratchpads',
  'git-scm': 'git',
  dashboard: 'dashboard'
}

const KIND_WORDS: Record<string, string> = {
  agent: 'terminal',
  game: 'unity',
  player: 'unity',
  'unity player': 'unity',
  'unity console': 'console',
  file: 'viewer',
  report: 'viewer',
  scratchpad: 'scratchpads'
}

function listOf(tabs: readonly ExecTab[]): string {
  return tabs.map((t) => `"${t.label}" (${t.kind})`).join(', ') || 'none'
}

export function findTabRef(tabs: readonly ExecTab[], raw: unknown): { ok: true; tab: ExecTab } | { ok: false; error: string } {
  const ref = typeof raw === 'string' ? raw.trim() : raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string' ? String((raw as { id: string }).id) : ''
  if (!ref) return { ok: false, error: `Pass the tab's id, label or kind. Tabs: ${listOf(tabs)}.` }
  const low = ref.toLowerCase()
  const byId = tabs.find((t) => t.id === ref || t.ptyId === ref) ?? (ref.length >= 6 ? tabs.find((t) => t.id.startsWith(ref) || t.ptyId.startsWith(ref)) : undefined)
  if (byId) return { ok: true, tab: byId }
  const exact = tabs.filter((t) => t.label.toLowerCase() === low)
  if (exact.length === 1) return { ok: true, tab: exact[0] }
  if (exact.length > 1) return { ok: false, error: `${exact.length} tabs are called "${ref}". Pass one of their ids: ${exact.map((t) => t.id).join(', ')}.` }
  const kind = KIND_WORDS[low] ?? low
  const ofKind = tabs.filter((t) => t.kind === kind || (low === 'agent' && !!t.agent))
  if (ofKind.length === 1) return { ok: true, tab: ofKind[0] }
  if (ofKind.length > 1) {
    const named = ofKind.filter((t) => t.focused || t.shown)
    if (named.length === 1) return { ok: true, tab: named[0] }
    return { ok: false, error: `${ofKind.length} ${kind} tabs are open: ${listOf(ofKind)}. Pass the label or id of one.` }
  }
  const part = tabs.filter((t) => t.label.toLowerCase().includes(low))
  if (part.length === 1) return { ok: true, tab: part[0] }
  if (part.length > 1) return { ok: false, error: `"${ref}" matches ${part.length} tabs: ${listOf(part)}. Pass the full label or the id.` }
  return { ok: false, error: `No tab "${ref}" in this workspace. Tabs: ${listOf(tabs)}.` }
}
