import type { TabContentType } from '@shared/types'
import type { AppState } from '../../store'
import { IDEA_BINDINGS, chordTokens, chordsOf } from '../editor/idea-bindings'

export const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent)

export function focusedPaneKind(s: AppState): TabContentType | null {
  const wsId = s.activeWorkspaceId
  if (!wsId) return null
  const groupId = s.activeGroupIdByWorkspace[wsId]
  const group = s.groupsByWorkspace[wsId]?.find((g) => g.id === groupId)
  const tabId = group?.activeTabId
  if (!tabId) return null
  const tab = (s.tabsByWorkspace[wsId] ?? []).find((t) => t.id === tabId)
  return tab?.contentType ?? null
}

export function focusedTabId(s: AppState): string | null {
  const wsId = s.activeWorkspaceId
  if (!wsId) return null
  const groupId = s.activeGroupIdByWorkspace[wsId]
  return s.groupsByWorkspace[wsId]?.find((g) => g.id === groupId)?.activeTabId ?? null
}

export function focusedTerminalRunsAgent(s: AppState): boolean {
  const wsId = s.activeWorkspaceId
  if (!wsId) return false
  const groupId = s.activeGroupIdByWorkspace[wsId]
  const group = s.groupsByWorkspace[wsId]?.find((g) => g.id === groupId)
  const tabId = group?.activeTabId
  if (!tabId) return false
  const tab = (s.tabsByWorkspace[wsId] ?? []).find((t) => t.id === tabId)
  if (tab?.contentType !== 'terminal' || !tab.agentId) return false
  return !s.exitedPtyIds.includes(tab.ptyId)
}

export function focusedPanePtyId(s: AppState): string | null {
  const wsId = s.activeWorkspaceId
  if (!wsId) return null
  const groupId = s.activeGroupIdByWorkspace[wsId]
  const group = s.groupsByWorkspace[wsId]?.find((g) => g.id === groupId)
  const tabId = group?.activeTabId
  if (!tabId) return null
  const tab = (s.tabsByWorkspace[wsId] ?? []).find((t) => t.id === tabId)
  return tab?.ptyId ?? null
}

export type KeyToken = 'mod' | 'shift' | 'alt' | 'enter' | 'esc' | 'dblclick' | (string & {})

export interface ShortcutRow {
  combos: KeyToken[][]
  action: string
  enabled: boolean
  note?: string
}

export interface ShortcutSection {
  title: string
  subtitle: string
  rows: ShortcutRow[]
}

export const SHORTCUT_SECTIONS: ShortcutSection[] = [
  {
    title: 'Workbench',
    subtitle:
      'Global — active in every pane, including a Unity Player that is not in Play Mode.',
    rows: [
      {
        combos: [['shift', 'shift']],
        action: 'Quick Open — fuzzy file finder',
        enabled: true,
        note: 'Tap Shift twice.'
      },
      {
        combos: [['mod', 'shift', 'F']],
        action: 'Find in files — open/focus an Explorer and switch it to Contents search',
        enabled: true
      }
    ]
  },
  {
    title: 'Terminal',
    subtitle: 'Active while a terminal pane is focused. All other keys go to the shell.',
    rows: [
      {
        combos: [['mod', '+']],
        action: 'Increase font size',
        enabled: true,
        note: 'Works even while an agent is running in the terminal.'
      },
      { combos: [['mod', '−']], action: 'Decrease font size', enabled: true },
      { combos: [['mod', '0']], action: 'Reset font size', enabled: true },
      {
        combos: IS_MAC ? [['mod', 'C']] : [['mod', 'C'], ['mod', 'shift', 'C']],
        action: 'Copy the selection',
        enabled: true,
        note: IS_MAC ? undefined : 'Ctrl+C with no selection sends an interrupt to the shell.'
      },
      {
        combos: IS_MAC
          ? [['mod', 'V']]
          : [['mod', 'V'], ['mod', 'shift', 'V'], ['shift', 'Insert']],
        action: 'Paste from the clipboard',
        enabled: true
      }
    ]
  },
  {
    title: 'File Viewer (Monaco)',
    subtitle: 'Active while the file viewer is focused.',
    rows: [
      { combos: [['mod', '+']], action: 'Increase font size', enabled: true },
      { combos: [['mod', '−']], action: 'Decrease font size', enabled: true },
      { combos: [['mod', '0']], action: 'Reset font size', enabled: true },
      {
        combos: [['mod', 'C'], ['mod', 'X'], ['mod', 'V']],
        action: 'Copy / cut / paste',
        enabled: true
      },
      { combos: [['mod', 'A']], action: 'Select all', enabled: true },
      ...(IS_MAC ? [] : [{ combos: [['alt', '↑']], action: 'Select the whole line', enabled: true }]),
      { combos: [['mod', 'D']], action: 'Duplicate the line', enabled: true },
      {
        combos: [['mod', '/']],
        action: 'Comment / uncomment the line or selection',
        enabled: true
      },
      {
        combos: IS_MAC ? [['mod', '←'], ['mod', '→']] : [['Home'], ['End']],
        action: 'Jump to line start / end',
        enabled: true,
        note: IS_MAC ? 'Add Shift to extend the selection.' : undefined
      },
      { combos: [['mod', 'S']], action: 'Save the file', enabled: true },
      { combos: [['mod', 'F']], action: 'Find in this file', enabled: true, note: 'Built into Monaco.' },
      {
        combos: [['mod', 'L']],
        action: 'Go to line',
        enabled: true
      },
      {
        combos: [
          ['mod', 'Z'],
          ['mod', 'shift', 'Z']
        ],
        action: 'Undo / redo',
        enabled: true,
        note: 'Built into Monaco.'
      },
      {
        combos: [['F1']],
        action: IS_MAC ? 'Quick documentation' : 'Command palette',
        enabled: IS_MAC,
        note: IS_MAC ? undefined : 'Disabled — the editor menu is trimmed to clipboard + our own actions.'
      }
    ]
  },
  {
    title: 'Code (IntelliJ IDEA keymap)',
    subtitle:
      'Works in the file viewer. C# code intelligence comes from Roslyn, the same language server the VS Code C# extension runs.',
    rows: IDEA_BINDINGS.filter((b) => chordsOf(b).length > 0).map((b) => ({
      combos: chordsOf(b).map(chordTokens),
      action: b.label,
      enabled: true
    }))
  },
  {
    title: 'Explorer',
    subtitle: 'Active while the Explorer is focused.',
    rows: [
      { combos: [['mod', 'shift', 'F']], action: 'Find in files (same as Workbench)', enabled: true },
      { combos: [['enter']], action: 'Confirm an inline rename / new file or folder', enabled: true },
      { combos: [['esc']], action: 'Cancel an inline rename / create', enabled: true },
      { combos: [['dblclick']], action: 'Rename a file or folder', enabled: true }
    ]
  },
  {
    title: 'Unity Player',
    subtitle:
      'In Play Mode every keystroke except Ctrl+P goes to the running game. Out of Play Mode the Workbench shortcuts work here too. Clicking a player captures the mouse when the game locks the cursor (Esc releases it).',
    rows: [
      {
        combos: [['mod', 'P']],
        action: 'Play / Stop the Unity Player',
        enabled: true,
        note: 'The only app shortcut that survives Play Mode.'
      },
      {
        combos: [['shift', 'shift'], ['mod', 'shift', 'F']],
        action: 'Quick Open / Find in files (same as Workbench)',
        enabled: true,
        note: 'Out of Play Mode only. Double-tapping Shift here also reaches the game as two Shift presses.'
      }
    ]
  },
  {
    title: 'Unity Console',
    subtitle: 'Active while a Unity Console pane is focused.',
    rows: [
      {
        combos: [['mod', 'F']],
        action: 'Find in console — focus the filter box',
        enabled: true
      }
    ]
  }
]
