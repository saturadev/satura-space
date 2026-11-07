import type { KeyToken } from '../shortcuts/shortcuts'

export const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent)

export interface Chord {
  code: string
  cmd?: boolean
  ctrl?: boolean
  alt?: boolean
  shift?: boolean
}

export interface Binding {
  mac?: Chord[]
  win?: Chord[]
  command: string
  when?: string
  label: string
}

export const IDEA_BINDINGS: Binding[] = [
  { label: 'Go to declaration', command: 'satura.idea.gotoDeclaration', mac: [{ code: 'KeyB', cmd: true }], win: [{ code: 'KeyB', ctrl: true }] },
  { label: 'Go to implementation(s)', command: 'satura.idea.gotoImplementation', mac: [{ code: 'KeyB', cmd: true, alt: true }], win: [{ code: 'KeyB', ctrl: true, alt: true }] },
  { label: 'Go to type declaration', command: 'satura.idea.gotoTypeDeclaration', mac: [{ code: 'KeyB', ctrl: true, shift: true }], win: [{ code: 'KeyB', ctrl: true, shift: true }] },
  { label: 'Find usages', command: 'satura.idea.findUsages', mac: [{ code: 'F7', alt: true }], win: [{ code: 'F7', alt: true }] },
  { label: 'Show usages', command: 'editor.action.referenceSearch.trigger', mac: [{ code: 'F7', cmd: true, alt: true }], win: [{ code: 'F7', ctrl: true, alt: true }] },
  { label: 'Highlight usages in file', command: 'editor.action.wordHighlight.trigger', mac: [{ code: 'F7', cmd: true, shift: true }], win: [{ code: 'F7', ctrl: true, shift: true }] },
  { label: 'File structure', command: 'editor.action.quickOutline', mac: [{ code: 'F12', cmd: true }], win: [{ code: 'F12', ctrl: true }] },
  { label: 'Navigate back', command: 'satura.idea.back', mac: [{ code: 'BracketLeft', cmd: true }, { code: 'ArrowLeft', cmd: true, alt: true }], win: [{ code: 'ArrowLeft', ctrl: true, alt: true }] },
  { label: 'Navigate forward', command: 'satura.idea.forward', mac: [{ code: 'BracketRight', cmd: true }, { code: 'ArrowRight', cmd: true, alt: true }], win: [{ code: 'ArrowRight', ctrl: true, alt: true }] },
  { label: 'Rename', command: 'editor.action.rename', mac: [{ code: 'F6', shift: true }], win: [{ code: 'F6', shift: true }] },
  { label: 'Show context actions / quick fix', command: 'editor.action.quickFix', mac: [{ code: 'Enter', alt: true }], win: [{ code: 'Enter', alt: true }] },
  { label: 'Refactor this', command: 'editor.action.refactor', mac: [{ code: 'KeyT', ctrl: true }], win: [{ code: 'KeyT', ctrl: true, alt: true, shift: true }] },
  { label: 'Reformat code', command: 'satura.idea.reformat', mac: [{ code: 'KeyL', cmd: true, alt: true }], win: [{ code: 'KeyL', ctrl: true, alt: true }] },
  { label: 'Optimize imports', command: 'editor.action.organizeImports', mac: [{ code: 'KeyO', ctrl: true, alt: true }], win: [{ code: 'KeyO', ctrl: true, alt: true }] },
  { label: 'Parameter info', command: 'editor.action.triggerParameterHints', mac: [{ code: 'KeyP', cmd: true }], win: [{ code: 'KeyP', ctrl: true }] },
  { label: 'Quick documentation', command: 'editor.action.showHover', mac: [{ code: 'KeyJ', ctrl: true }], win: [{ code: 'KeyQ', ctrl: true }] },
  { label: 'Next highlighted error', command: 'editor.action.marker.next', mac: [{ code: 'F2' }], win: [{ code: 'F2' }] },
  { label: 'Previous highlighted error', command: 'editor.action.marker.prev', mac: [{ code: 'F2', shift: true }], win: [{ code: 'F2', shift: true }] },
  { label: 'Basic completion', command: 'editor.action.triggerSuggest', mac: [{ code: 'Space', ctrl: true }], win: [{ code: 'Space', ctrl: true }] },
  { label: 'Smart completion', command: 'editor.action.triggerSuggest', mac: [{ code: 'Space', ctrl: true, shift: true }], win: [{ code: 'Space', ctrl: true, shift: true }] },
  { label: 'Delete line', command: 'editor.action.deleteLines', mac: [{ code: 'KeyY', cmd: true }, { code: 'Backspace', cmd: true }], win: [{ code: 'KeyY', ctrl: true }] },
  { label: 'Block comment', command: 'editor.action.blockComment', mac: [{ code: 'Slash', cmd: true, alt: true }], win: [{ code: 'Slash', ctrl: true, shift: true }] },
  { label: 'Extend selection', command: 'editor.action.smartSelect.expand', mac: [{ code: 'ArrowUp', alt: true }], win: [{ code: 'KeyW', ctrl: true }] },
  { label: 'Shrink selection', command: 'editor.action.smartSelect.shrink', mac: [{ code: 'ArrowDown', alt: true }], win: [{ code: 'KeyW', ctrl: true, shift: true }] },
  { label: 'Move line up', command: 'editor.action.moveLinesUpAction', mac: [{ code: 'ArrowUp', alt: true, shift: true }, { code: 'ArrowUp', cmd: true, shift: true }], win: [{ code: 'ArrowUp', alt: true, shift: true }, { code: 'ArrowUp', ctrl: true, shift: true }] },
  { label: 'Move line down', command: 'editor.action.moveLinesDownAction', mac: [{ code: 'ArrowDown', alt: true, shift: true }, { code: 'ArrowDown', cmd: true, shift: true }], win: [{ code: 'ArrowDown', alt: true, shift: true }, { code: 'ArrowDown', ctrl: true, shift: true }] },
  { label: 'Add next occurrence', command: 'editor.action.addSelectionToNextFindMatch', mac: [{ code: 'KeyG', ctrl: true }], win: [{ code: 'KeyJ', alt: true }] },
  { label: 'Select all occurrences', command: 'editor.action.selectHighlights', mac: [{ code: 'KeyG', ctrl: true, cmd: true }], win: [{ code: 'KeyJ', ctrl: true, alt: true, shift: true }] },
  { label: 'Join lines', command: 'editor.action.joinLines', mac: [{ code: 'KeyJ', ctrl: true, shift: true }], win: [{ code: 'KeyJ', ctrl: true, shift: true }] },
  { label: 'Toggle case', command: 'satura.idea.toggleCase', mac: [{ code: 'KeyU', cmd: true, shift: true }], win: [{ code: 'KeyU', ctrl: true, shift: true }] }
]

export function chordsOf(b: Binding): Chord[] {
  return (IS_MAC ? b.mac : b.win) ?? []
}

export function isIdeaChord(e: KeyboardEvent): boolean {
  for (const b of IDEA_BINDINGS) {
    for (const c of chordsOf(b)) {
      if (e.code !== c.code) continue
      if (e.altKey !== !!c.alt || e.shiftKey !== !!c.shift) continue
      if (IS_MAC ? e.metaKey !== !!c.cmd || e.ctrlKey !== !!c.ctrl : e.ctrlKey !== !!c.ctrl || e.metaKey) continue
      return true
    }
  }
  return false
}


const KEY_TOKENS: Record<string, string> = {
  ArrowUp: '↑',
  ArrowDown: '↓',
  ArrowLeft: '←',
  ArrowRight: '→',
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Enter: 'enter',
  Backspace: '⌫'
}

export function chordTokens(c: Chord): KeyToken[] {
  const out: KeyToken[] = []
  if (IS_MAC && c.ctrl) out.push('⌃')
  if (IS_MAC ? c.cmd : c.ctrl) out.push('mod')
  if (c.alt) out.push('alt')
  if (c.shift) out.push('shift')
  out.push(KEY_TOKENS[c.code] ?? c.code.replace(/^Key/, ''))
  return out
}
