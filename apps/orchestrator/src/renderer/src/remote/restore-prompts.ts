import { create } from 'zustand'
import { cleanRestorePrompts, describeRestorePrompts, openRowKey, type ClaudeRestorePromptState } from '@shared/claude-sessions'
import type { Tab } from '@shared/types'
import { wsTransport } from './ws-transport'

export const useRestorePrompts = create<{ prompts: Record<string, ClaudeRestorePromptState> }>()(() => ({ prompts: {} }))

let said = ''

export function applyRestorePrompts(raw: unknown): void {
  const list = cleanRestorePrompts(raw)
  const text = describeRestorePrompts(list)
  if (text !== said) {
    console.info(`[claude-resume] phone has the desktop's restore prompts: ${text}${said && said !== 'none' && text === 'none' ? ' (answered)' : ''}`)
    said = text
  }
  const prompts: Record<string, ClaudeRestorePromptState> = {}
  for (const p of list) prompts[p.workspaceId] = p
  useRestorePrompts.setState({ prompts })
}

export function installRestorePrompts(): void {
  wsTransport.on('remote:restorePrompts', (list: unknown) => applyRestorePrompts(list))
}

export function dropRestorePrompt(workspaceId: string, promptId: string): void {
  const cur = useRestorePrompts.getState().prompts
  if (cur[workspaceId]?.id !== promptId) return
  const prompts = { ...cur }
  delete prompts[workspaceId]
  useRestorePrompts.setState({ prompts })
}

export function takeChecked(workspaceId: string, promptId: string, checked: unknown): void {
  const cur = useRestorePrompts.getState().prompts
  const prompt = cur[workspaceId]
  if (!prompt || prompt.id !== promptId || !Array.isArray(checked)) return
  const keys = new Set([...prompt.open, ...prompt.other].map((r) => r.key))
  const next = checked.filter((k): k is string => typeof k === 'string' && keys.has(k))
  if (next.join('\n') === prompt.checked.join('\n')) return
  useRestorePrompts.setState({ prompts: { ...cur, [workspaceId]: { ...prompt, checked: next } } })
}

export function isHeldTab(prompt: ClaudeRestorePromptState | undefined, tab: Pick<Tab, 'ptyId'> | undefined): boolean {
  if (!prompt || !tab) return false
  const key = openRowKey(tab)
  return prompt.open.some((r) => r.key === key)
}

export function heldTabId(prompt: ClaudeRestorePromptState | undefined, tabs: readonly Tab[]): string | null {
  if (!prompt) return null
  for (const row of prompt.open) {
    const tab = tabs.find((t) => openRowKey(t) === row.key)
    if (tab) return tab.id
  }
  return null
}
