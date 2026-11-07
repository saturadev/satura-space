import type * as Monaco from 'monaco-editor'
import { censusTrack } from '@shared/census'

type Editor = Monaco.editor.IStandaloneCodeEditor

const editors = new Set<Editor>()
censusTrack('monaco-editor-registry.editors', editors)

export function registerMonacoEditor(editor: Editor): () => void {
  editors.add(editor)
  return () => {
    editors.delete(editor)
  }
}

export function findFocusedMonacoEditor(): Editor | undefined {
  for (const editor of editors) {
    if (editor.hasTextFocus()) return editor
  }
  return undefined
}
