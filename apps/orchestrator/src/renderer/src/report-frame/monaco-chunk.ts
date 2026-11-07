import * as monaco from 'monaco-editor/esm/vs/editor/edcore.main.js'
import 'satura:monaco-basic-languages'
import 'monaco-editor/min/vs/editor/editor.main.css'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker&inline'
import type * as Monaco from 'monaco-editor'
import { installTextMate } from '../lib/editor/textmate/textmate'
import { defineMonacoThemes, monacoThemeName } from '../lib/editor/monaco-themes'

const NO_UNICODE_HIGHLIGHT = { ambiguousCharacters: false, invisibleCharacters: false, nonBasicASCII: false } as const

;(globalThis as { MonacoEnvironment?: unknown }).MonacoEnvironment = { getWorker: () => new editorWorker() }

const api = monaco as unknown as typeof Monaco

api.editor.onDidCreateEditor((editor) => editor.updateOptions({ unicodeHighlight: NO_UNICODE_HIGHLIGHT }))

window.addEventListener('unhandledrejection', (event) => {
  const reason: unknown = event.reason
  if (reason instanceof Error && reason.name === 'Canceled' && reason.message === 'Canceled') event.preventDefault()
})

installTextMate(api)

;(globalThis as { __saturaMonacoKit?: unknown }).__saturaMonacoKit = { monaco: api, NO_UNICODE_HIGHLIGHT, defineMonacoThemes, monacoThemeName }
