import type { IEvent, Range, editor } from 'monaco-editor'
import { h } from 'monaco-editor/esm/vs/base/browser/dom.js'
import { ActionBar } from 'monaco-editor/esm/vs/base/browser/ui/actionbar/actionbar.js'
import { Action } from 'monaco-editor/esm/vs/base/common/actions.js'
import { Event } from 'monaco-editor/esm/vs/base/common/event.js'
import { Disposable, type IDisposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
import { Selection } from 'monaco-editor/esm/vs/editor/common/core/selection.js'
import { monaco } from '../../../../lib/editor/monaco-setup'
import { autorun, derived, observableFromEvent, observableValue, type IObservable } from '../../../../lib/git/merge/core/observable'
import { setStyle } from '../utils'
import type { MergeEditorViewModel } from '../viewModel'

export type CodeEditorWidget = editor.IStandaloneCodeEditor & {
  readonly onDidChangeViewZones: IEvent<void>
  hasModel(): boolean
  getBottomForLineNumber(lineNumber: number, includeViewZones?: boolean): number
  changeDecorations<T>(callback: (changeAccessor: { deltaDecorations(oldDecorations: readonly string[], newDecorations: readonly editor.IModelDeltaDecoration[]): string[] }) => T): T | null
}

export interface IView {
  readonly element: HTMLElement
  readonly minimumWidth: number
  readonly maximumWidth: number
  readonly minimumHeight: number
  readonly maximumHeight: number
  layout(width: number, height: number, top: number, left: number): void
}

export const DEFAULT_EDITOR_MIN_DIMENSIONS = { width: 220, height: 70 }
export const DEFAULT_EDITOR_MAX_DIMENSIONS = { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY }

export interface TitleMenuAction {
  readonly id: string
  readonly label: string
  readonly icon: string
  readonly run: () => void
}

export abstract class CodeEditorView extends Disposable {
  readonly model

  protected readonly htmlElements

  public readonly view: IView

  protected readonly checkboxesVisible
  protected readonly showDeletionMarkers
  protected readonly useSimplifiedDecorations

  public readonly editor: CodeEditorWidget

  public updateOptions(newOptions: Readonly<editor.IEditorOptions>): void {
    this.editor.updateOptions(newOptions)
  }

  public readonly isFocused

  public readonly cursorPosition

  public readonly selection

  public readonly cursorLineNumber

  constructor(
    public readonly viewModel: IObservable<undefined | MergeEditorViewModel>,
  ) {
    super()
    this.model = this.viewModel.map((m) => m?.model)
    this.htmlElements = h('div.code-view', [
      h('div.header@header', [
        h('span.title@title'),
        h('span.description@description'),
        h('span.detail@detail'),
        h('span.toolbar@toolbar'),
      ]),
      h('div.container', [
        h('div.gutter@gutterDiv'),
        h('div@editor'),
      ]),
    ])
    this.view = {
      element: this.htmlElements.root,
      minimumWidth: DEFAULT_EDITOR_MIN_DIMENSIONS.width,
      maximumWidth: DEFAULT_EDITOR_MAX_DIMENSIONS.width,
      minimumHeight: DEFAULT_EDITOR_MIN_DIMENSIONS.height,
      maximumHeight: DEFAULT_EDITOR_MAX_DIMENSIONS.height,
      layout: (width: number, height: number, top: number, left: number) => {
        setStyle(this.htmlElements.root, { width, height, top, left })
        this.editor.layout({
          width: width - this.htmlElements.gutterDiv.clientWidth,
          height: height - this.htmlElements.header.clientHeight,
        })
      }
    }
    this.checkboxesVisible = observableValue<boolean>('mergeEditor.showCheckboxes', false)
    this.showDeletionMarkers = observableValue<boolean>('mergeEditor.showDeletionMarkers', true)
    this.useSimplifiedDecorations = observableValue<boolean>('mergeEditor.useSimplifiedDecorations', false)
    this.editor = monaco.editor.create(this.htmlElements.editor, {
      folding: false,
      codeLens: false,
    }) as CodeEditorWidget
    this._register(this.editor)
    this.isFocused = observableFromEvent(this,
      Event.any(this.editor.onDidBlurEditorWidget, this.editor.onDidFocusEditorWidget),
      () => this.editor.hasWidgetFocus()
    )
    this.cursorPosition = observableFromEvent(this,
      this.editor.onDidChangeCursorPosition,
      () => this.editor.getPosition()
    )
    this.selection = observableFromEvent(this,
      this.editor.onDidChangeCursorSelection,
      () => this.editor.getSelections()
    )
    this.cursorLineNumber = this.cursorPosition.map((p) => p?.lineNumber)
  }
}

export function createSelectionsAutorun(
  codeEditorView: CodeEditorView,
  translateRange: (baseRange: Range, viewModel: MergeEditorViewModel) => Range
): IDisposable {
  const selections = derived((reader) => {
    const viewModel = codeEditorView.viewModel.read(reader)
    if (!viewModel) {
      return []
    }
    const baseRange = viewModel.selectionInBase.read(reader)
    if (!baseRange || baseRange.sourceEditor === codeEditorView) {
      return []
    }
    return baseRange.rangesInBase.map((r) => translateRange(r, viewModel))
  })

  return autorun((reader) => {
    const ranges = selections.read(reader)
    if (ranges.length === 0) {
      return
    }
    codeEditorView.editor.setSelections(ranges.map((r) => new Selection(r.startLineNumber, r.startColumn, r.endLineNumber, r.endColumn)))
  })
}

export class TitleMenu extends Disposable {
  constructor(
    actions: IObservable<readonly TitleMenuAction[]>,
    targetHtmlElement: HTMLElement,
  ) {
    super()

    const toolbar = this._register(new ActionBar(targetHtmlElement))
    this._register(autorun((reader) => {
      toolbar.clear()
      toolbar.push(actions.read(reader).map((a) => new Action(a.id, a.label, `codicon codicon-${a.icon}`, true, () => a.run())), { icon: true, label: false })
    }))
  }
}
