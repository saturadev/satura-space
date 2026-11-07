import { loader } from '@monaco-editor/react'
import * as monaco from 'monaco-editor'
import { typescript as ts } from 'monaco-editor'
import 'monaco-editor/min/vs/editor/editor.main.css'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'
import { installTextMate } from './textmate/textmate'

globalThis.MonacoEnvironment = {
  getWorker(_workerId, label) {
    switch (label) {
      case 'json':
        return new jsonWorker()
      case 'css':
      case 'scss':
      case 'less':
        return new cssWorker()
      case 'html':
      case 'handlebars':
      case 'razor':
        return new htmlWorker()
      case 'typescript':
      case 'javascript':
        return new tsWorker()
      default:
        return new editorWorker()
    }
  }
}

const diagnosticsOptions = {
  noSemanticValidation: true,
  noSuggestionDiagnostics: true,
  noSyntaxValidation: true
}
ts.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
ts.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)

ts.typescriptDefaults.setCompilerOptions({
  ...ts.typescriptDefaults.getCompilerOptions(),
  jsx: ts.JsxEmit.Preserve
})
ts.javascriptDefaults.setCompilerOptions({
  ...ts.javascriptDefaults.getCompilerOptions(),
  jsx: ts.JsxEmit.Preserve
})

export const NO_UNICODE_HIGHLIGHT = {
  ambiguousCharacters: false,
  invisibleCharacters: false,
  nonBasicASCII: false
} as const

function unicodeHighlightOn(editor: monaco.editor.ICodeEditor): boolean {
  const o = editor.getOption(monaco.editor.EditorOption.unicodeHighlighting)
  return o.ambiguousCharacters !== false || o.invisibleCharacters !== false || o.nonBasicASCII !== false
}

monaco.editor.onDidCreateEditor((editor) => {
  editor.updateOptions({ unicodeHighlight: NO_UNICODE_HIGHLIGHT })
  editor.onDidChangeConfiguration((e) => {
    if (e.hasChanged(monaco.editor.EditorOption.unicodeHighlighting) && unicodeHighlightOn(editor)) {
      editor.updateOptions({ unicodeHighlight: NO_UNICODE_HIGHLIGHT })
    }
  })
})

window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  if (reason instanceof Error && reason.name === 'Canceled' && reason.message === 'Canceled') {
    event.preventDefault()
  }
})

installTextMate(monaco)

loader.config({ monaco })

export { monaco }
