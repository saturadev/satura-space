import type * as Monaco from 'monaco-editor'
import { monaco } from './monaco-setup'
import { openFileInWorkbench } from './open-file'

function modelPath(uri: Monaco.Uri): string | null {
  if (uri.scheme === 'file') return uri.path
  if (/^[a-zA-Z]$/.test(uri.scheme)) return `${uri.scheme.toUpperCase()}:${uri.path}`
  return null
}

function uriOf(path: string): Monaco.Uri {
  return monaco.Uri.parse(path)
}

interface NavPoint {
  path: string
  line: number
  column: number
}

const MAX_HISTORY = 100
const back: NavPoint[] = []
const forward: NavPoint[] = []

export function focusedEditor(): Monaco.editor.ICodeEditor | undefined {
  const all = monaco.editor.getEditors()
  return all.find((e) => e.hasTextFocus()) ?? all.find((e) => e.hasWidgetFocus())
}

function pointOf(editor: Monaco.editor.ICodeEditor | null | undefined): NavPoint | null {
  const model = editor?.getModel()
  const pos = editor?.getPosition()
  const path = model ? modelPath(model.uri) : null
  if (!path || !pos) return null
  return { path, line: pos.lineNumber, column: pos.column }
}

function same(a: NavPoint | undefined, b: NavPoint): boolean {
  return !!a && a.path === b.path && a.line === b.line
}

export function recordNavigation(editor: Monaco.editor.ICodeEditor | null | undefined): void {
  const p = pointOf(editor)
  if (!p || same(back.at(-1), p)) return
  back.push(p)
  if (back.length > MAX_HISTORY) back.shift()
  forward.length = 0
}

export function openLocation(path: string, line: number, column: number): void {
  const model = monaco.editor.getModel(uriOf(path))
  const editor = model ? monaco.editor.getEditors().find((e) => e.getModel() === model && e.hasTextFocus()) : undefined
  if (editor) {
    editor.setPosition({ lineNumber: line, column })
    editor.revealPositionInCenterIfOutsideViewport({ lineNumber: line, column })
    editor.focus()
    return
  }
  openFileInWorkbench({ file: path, line, column, text: true })
}

function jump(from: NavPoint[], to: NavPoint[]): void {
  const target = from.pop()
  if (!target) return
  const here = pointOf(focusedEditor())
  if (here) to.push(here)
  openLocation(target.path, target.line, target.column)
}

export function navigateBack(): void {
  jump(back, forward)
}

export function navigateForward(): void {
  jump(forward, back)
}

let installed = false

export function installEditorOpener(): void {
  if (installed) return
  installed = true
  monaco.editor.registerEditorOpener({
    openCodeEditor(source, resource, selectionOrPosition) {
      const path = modelPath(resource)
      if (!path) return false
      let line = 1
      let column = 1
      if (selectionOrPosition && 'startLineNumber' in selectionOrPosition) {
        line = selectionOrPosition.startLineNumber
        column = selectionOrPosition.startColumn
      } else if (selectionOrPosition) {
        line = selectionOrPosition.lineNumber
        column = selectionOrPosition.column
      }
      recordNavigation(source)
      openFileInWorkbench({ file: path, line, column, text: true })
      return true
    }
  })
}
