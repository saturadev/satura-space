import { monaco } from './monaco-setup'
import { focusedEditor, navigateBack, navigateForward, recordNavigation } from './navigation'
import { IDEA_BINDINGS, IS_MAC, chordsOf, type Chord } from './idea-bindings'

const TEXT = 'editorTextFocus'

const MONACO_KEY: Record<string, string> = {
  ArrowUp: 'UpArrow',
  ArrowDown: 'DownArrow',
  ArrowLeft: 'LeftArrow',
  ArrowRight: 'RightArrow'
}

function keybinding(c: Chord): number {
  const name = MONACO_KEY[c.code] ?? c.code
  let k = monaco.KeyCode[name as keyof typeof monaco.KeyCode] as number
  if (IS_MAC) {
    if (c.cmd) k |= monaco.KeyMod.CtrlCmd
    if (c.ctrl) k |= monaco.KeyMod.WinCtrl
  } else if (c.ctrl) {
    k |= monaco.KeyMod.CtrlCmd
  }
  if (c.alt) k |= monaco.KeyMod.Alt
  if (c.shift) k |= monaco.KeyMod.Shift
  return k
}

function runAction(id: string, record: boolean): void {
  const editor = focusedEditor()
  if (!editor) return
  if (record) recordNavigation(editor)
  void editor.getAction(id)?.run()
}

let installed = false

export function installIdeaKeymap(): void {
  if (installed) return
  installed = true
  monaco.editor.registerCommand('satura.idea.gotoDeclaration', () => runAction('editor.action.revealDefinition', true))
  monaco.editor.registerCommand('satura.idea.gotoImplementation', () => runAction('editor.action.goToImplementation', true))
  monaco.editor.registerCommand('satura.idea.gotoTypeDeclaration', () => runAction('editor.action.goToTypeDefinition', true))
  monaco.editor.registerCommand('satura.idea.findUsages', () => runAction('editor.action.goToReferences', true))
  monaco.editor.registerCommand('satura.idea.back', () => navigateBack())
  monaco.editor.registerCommand('satura.idea.forward', () => navigateForward())
  monaco.editor.registerCommand('satura.idea.reformat', () => {
    const editor = focusedEditor()
    const sel = editor?.getSelection()
    runAction(sel && !sel.isEmpty() ? 'editor.action.formatSelection' : 'editor.action.formatDocument', false)
  })
  monaco.editor.registerCommand('satura.idea.toggleCase', () => {
    const editor = focusedEditor()
    const model = editor?.getModel()
    const sel = editor?.getSelection()
    if (!editor || !model || !sel) return
    const text = sel.isEmpty() ? (model.getWordAtPosition(sel.getStartPosition())?.word ?? '') : model.getValueInRange(sel)
    const upper = text === text.toUpperCase() && text !== text.toLowerCase()
    runAction(upper ? 'editor.action.transformToLowercase' : 'editor.action.transformToUppercase', false)
  })
  const rules: { keybinding: number; command: string; when?: string }[] = []
  for (const b of IDEA_BINDINGS) {
    for (const c of chordsOf(b)) rules.push({ keybinding: keybinding(c), command: b.command, when: b.when ?? TEXT })
  }
  monaco.editor.addKeybindingRules(rules)
}
