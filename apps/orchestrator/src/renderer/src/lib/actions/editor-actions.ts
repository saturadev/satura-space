import type * as Monaco from 'monaco-editor'
import { IDEA_BINDINGS, type Chord } from '../editor/idea-bindings'
import { section, type ActionNode } from './action-tree'

const CODE_KEYS: Record<string, string> = {
  ArrowUp: 'up',
  ArrowDown: 'down',
  ArrowLeft: 'left',
  ArrowRight: 'right',
  BracketLeft: '[',
  BracketRight: ']',
  Slash: '/',
  Enter: 'enter',
  Backspace: 'backspace',
  Space: 'space'
}

export function chordShortcut(c: Chord): string {
  const key = CODE_KEYS[c.code] ?? (c.code.startsWith('Key') ? c.code.slice(3).toLowerCase() : c.code.startsWith('Digit') ? c.code.slice(5) : c.code)
  return [c.ctrl && 'ctrl', c.alt && 'alt', c.shift && 'shift', c.cmd && 'mod', key].filter(Boolean).join('+')
}

export interface EditorActionOptions {
  readOnly: boolean
  onSave: () => void
  onToggleWrap: () => void
  onToggleBlame?: () => void
  blameAvailable: boolean
  onCopyReference: () => void
  onFontSize: (delta: number | 'reset') => void
}

export function editorNodes(editor: Monaco.editor.IStandaloneCodeEditor, o: EditorActionOptions): ActionNode[] {
  const act = (id: string) => (): void => {
    void editor.getAction(id)?.run()
  }
  const trigger = (command: string) => (): void => {
    const action = editor.getAction(command)
    if (action) void action.run()
    else editor.trigger('remote', command, null)
  }
  const model = editor.getModel() as (Monaco.editor.ITextModel & { canUndo?: () => boolean; canRedo?: () => boolean }) | null
  const canUndo = !o.readOnly && (model?.canUndo?.() ?? true)
  const canRedo = !o.readOnly && (model?.canRedo?.() ?? true)
  return [
    section('edit', [
      { id: 'editor.undo', label: 'Undo', icon: 'arrow.uturn.backward', shortcut: 'mod+z', role: 'undo', primary: !o.readOnly, enabled: canUndo, run: trigger('undo') },
      { id: 'editor.redo', label: 'Redo', icon: 'arrow.uturn.forward', shortcut: 'mod+shift+z', role: 'redo', primary: !o.readOnly, enabled: canRedo, run: trigger('redo') },
      !o.readOnly && { id: 'editor.save', label: 'Save the file', icon: 'square.and.arrow.down', shortcut: 'mod+s', run: o.onSave },
      { id: 'editor.find', label: 'Find in this file', icon: 'magnifyingglass', shortcut: 'mod+f', run: act('actions.find') },
      { id: 'editor.gotoLine', label: 'Go to line', icon: 'number', shortcut: 'mod+l', run: act('editor.action.gotoLine') },
      { id: 'editor.selectAll', label: 'Select all', icon: 'selection.pin.in.out', shortcut: 'mod+a', run: trigger('editor.action.selectAll') },
      !o.readOnly && { id: 'editor.duplicate', label: 'Duplicate the line', icon: 'plus.square.on.square', shortcut: 'mod+d', run: act('editor.action.copyLinesDownAction') },
      !o.readOnly && { id: 'editor.comment', label: 'Comment / uncomment the line or selection', icon: 'number.square', shortcut: 'mod+/', run: act('editor.action.commentLine') }
    ]),
    section('view', [
      { id: 'editor.copyRef', label: 'Copy Reference (path:line)', icon: 'doc.on.doc', run: o.onCopyReference },
      { id: 'editor.wrap', label: 'Toggle Auto Wrap', icon: 'text.word.spacing', run: o.onToggleWrap },
      o.onToggleBlame && { id: 'editor.blame', label: 'Toggle Git Blame', icon: 'person.text.rectangle', enabled: o.blameAvailable, run: o.onToggleBlame },
      {
        id: 'editor.font',
        label: 'Font size',
        icon: 'textformat.size',
        children: [
          { id: 'editor.font.up', label: 'Increase font size', icon: 'plus.magnifyingglass', shortcut: 'mod+plus', run: () => o.onFontSize(1) },
          { id: 'editor.font.down', label: 'Decrease font size', icon: 'minus.magnifyingglass', shortcut: 'mod+minus', run: () => o.onFontSize(-1) },
          { id: 'editor.font.reset', label: 'Reset font size', icon: 'arrow.counterclockwise', shortcut: 'mod+0', run: () => o.onFontSize('reset') }
        ]
      }
    ]),
    section('code', [
      {
        id: 'editor.code',
        label: 'Code',
        icon: 'chevron.left.forwardslash.chevron.right',
        children: IDEA_BINDINGS.filter((b) => !o.readOnly || !/delete|move|join|toggleCase|reformat|organize|rename|blockComment|refactor|quickFix/i.test(b.command)).map((b, i) => ({
          id: `editor.idea.${i}`,
          label: b.label,
          shortcut: b.mac?.[0] ? chordShortcut(b.mac[0]) : undefined,
          run: trigger(b.command)
        }))
      }
    ])
  ]
}
