import type { IRange, editor } from 'monaco-editor'
import { DisposableStore, type IDisposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
import { autorunOpts, type IObservable } from '../../../lib/git/merge/core/observable'
import type { CodeEditorWidget } from './editors/codeEditorView'

export interface IModelDecorationOptions extends editor.IModelDecorationOptions {
  description: string
}

export interface IModelDeltaDecoration {
  range: IRange
  options: IModelDecorationOptions
}

export function setStyle(
  element: HTMLElement,
  style: {
    width?: number | string
    height?: number | string
    left?: number | string
    top?: number | string
  }
): void {
  Object.entries(style).forEach(([key, value]) => {
    element.style.setProperty(key, toSize(value))
  })
}

function toSize(value: number | string): string {
  return typeof value === 'number' ? `${value}px` : value
}

export function applyObservableDecorations(editor: CodeEditorWidget, decorations: IObservable<IModelDeltaDecoration[]>): IDisposable {
  const d = new DisposableStore()
  let decorationIds: string[] = []
  d.add(autorunOpts({ debugName: () => `Apply decorations from ${decorations.debugName}` }, (reader) => {
    const d = decorations.read(reader)
    editor.changeDecorations((a) => {
      decorationIds = a.deltaDecorations(decorationIds, d)
    })
  }))
  d.add({
    dispose: () => {
      editor.changeDecorations((a) => {
        decorationIds = a.deltaDecorations(decorationIds, [])
      })
    }
  })
  return d
}
