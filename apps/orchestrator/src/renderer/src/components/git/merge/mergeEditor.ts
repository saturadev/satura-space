import type { editor } from 'monaco-editor'
import { reset } from 'monaco-editor/esm/vs/base/browser/dom.js'
import { Disposable, DisposableStore, MutableDisposable, type IDisposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
import { monaco } from '../../../lib/editor/monaco-setup'
import { isDefined } from '../../../lib/git/merge/core/misc'
import { autorun, autorunWithStore, observableValue, transaction, type IObservable, type IReader } from '../../../lib/git/merge/core/observable'
import type { MergeEditorModel } from '../../../lib/git/merge/model/mergeEditorModel'
import { deepMerge } from '../../../lib/git/merge/utils'
import { BaseCodeEditorView } from './editors/baseCodeEditorView'
import { InputCodeEditorView } from './editors/inputCodeEditorView'
import { ResultCodeEditorView } from './editors/resultCodeEditorView'
import { MergeEditorGrid, type GridNodeDescriptor } from './grid'
import { ScrollSynchronizer } from './scrollSynchronizer'
import { MergeEditorViewModel } from './viewModel'
import { ViewZoneComputer } from './viewZones'
import './colors'
import './mergeEditor.css'

export type MergeEditorLayoutKind = 'mixed' | 'columns'

export interface IMergeEditorLayout {
  readonly kind: MergeEditorLayoutKind
  readonly showBase: boolean
  readonly showBaseAtTop: boolean
}

export type IMergeEditorViewState = editor.ICodeEditorViewState & {
  readonly input1State?: editor.ICodeEditorViewState
  readonly input2State?: editor.ICodeEditorViewState
  readonly focusIndex: number
}

let storedLayout: IMergeEditorLayout = { kind: 'mixed', showBase: false, showBaseAtTop: true }
let storedShowNonConflictingChanges = false

class MergeEditorLayoutStore {
  get value() {
    return storedLayout
  }

  set value(value: IMergeEditorLayout) {
    storedLayout = value
  }
}

export class MergeEditor extends Disposable {
  private readonly _sessionDisposables
  private readonly _viewModel

  public get viewModel(): IObservable<MergeEditorViewModel | undefined> {
    return this._viewModel
  }

  private rootHtmlElement: HTMLElement | undefined
  private readonly _grid
  private readonly input1View
  private readonly baseView
  private readonly baseViewOptions
  private readonly input2View

  private readonly inputResultView
  private readonly _layoutMode
  private readonly _layoutModeObs

  private readonly viewZoneComputer

  private readonly scrollSynchronizer

  private readonly baseViewDisposables

  private readonly showNonConflictingChanges

  constructor(
    parent: HTMLElement,
    private readonly getResultLabel: () => string,
    options: editor.IEditorOptions,
  ) {
    super()
    this._sessionDisposables = new DisposableStore()
    this._viewModel = observableValue<MergeEditorViewModel | undefined>(this, undefined)
    this._grid = this._register(new MutableDisposable<MergeEditorGrid>())
    this.input1View = this._register(new InputCodeEditorView(1, this._viewModel))
    this.baseView = observableValue<BaseCodeEditorView | undefined>(this, undefined)
    this.baseViewOptions = observableValue<Readonly<editor.IEditorOptions> | undefined>(this, undefined)
    this.input2View = this._register(new InputCodeEditorView(2, this._viewModel))
    this.inputResultView = this._register(new ResultCodeEditorView(this._viewModel, this.getResultLabel))
    this._layoutMode = new MergeEditorLayoutStore()
    this._layoutModeObs = observableValue(this, this._layoutMode.value)
    this.viewZoneComputer = new ViewZoneComputer(
      this.input1View.editor,
      this.input2View.editor,
      this.inputResultView.editor,
    )
    this._register({ dispose: () => this.viewZoneComputer.dispose() })
    this.scrollSynchronizer = this._register(new ScrollSynchronizer(this._viewModel, this.input1View, this.input2View, this.baseView, this.inputResultView, this._layoutModeObs))
    this.baseViewDisposables = this._register(new DisposableStore())
    this.showNonConflictingChanges = observableValue(this, storedShowNonConflictingChanges)
    this._register(this._sessionDisposables)

    this.rootHtmlElement = parent
    parent.classList.add('merge-editor')
    this.applyLayout(this._layoutMode.value)
    this.applyOptions(options)
  }

  get layoutMode(): IObservable<IMergeEditorLayout> {
    return this._layoutModeObs
  }

  get showNonConflictingChangesValue(): IObservable<boolean> {
    return this.showNonConflictingChanges
  }

  get resultEditor(): editor.IStandaloneCodeEditor {
    return this.inputResultView.editor
  }

  get editors(): editor.IStandaloneCodeEditor[] {
    return [this.input1View.editor, this.input2View.editor, this.inputResultView.editor, this.baseView.get()?.editor].filter(isDefined)
  }

  private applyOptions(options: editor.IEditorOptions): void {
    const inputOptions: editor.IEditorOptions = deepMerge<editor.IEditorOptions>(options, {
      minimap: { enabled: false },
      glyphMargin: false,
      lineNumbersMinChars: 2
    })

    const readOnlyInputOptions: editor.IEditorOptions = deepMerge<editor.IEditorOptions>(inputOptions, {
      readOnly: true,
      readOnlyMessage: undefined
    })

    this.input1View.updateOptions(readOnlyInputOptions)
    this.input2View.updateOptions(readOnlyInputOptions)
    this.baseViewOptions.set({ ...this.input2View.editor.getRawOptions() }, undefined)
    this.inputResultView.updateOptions(inputOptions)
  }

  layout(width: number, height: number): void {
    this._grid.value?.layout(width, height)
  }

  setInput(model: MergeEditorModel, viewState: IMergeEditorViewState | undefined): void {
    this._sessionDisposables.clear()
    transaction((tx) => {
      this._viewModel.set(undefined, tx)
    })

    const viewModel = new MergeEditorViewModel(
      model,
      this.input1View,
      this.input2View,
      this.inputResultView,
      this.baseView,
      this.showNonConflictingChanges,
    )

    transaction((tx) => {
      this._viewModel.set(viewModel, tx)
    })
    this._sessionDisposables.add(viewModel)

    const viewZoneRegistrationStore = new DisposableStore()
    this._sessionDisposables.add(viewZoneRegistrationStore)
    this._sessionDisposables.add(autorunWithStore((reader) => {
      const baseView = this.baseView.read(reader)

      const resultScrollTop = this.inputResultView.editor.getScrollTop()
      this.scrollSynchronizer.stopSync()

      viewZoneRegistrationStore.clear()

      this.inputResultView.editor.changeViewZones((resultViewZoneAccessor) => {
        const layout = this._layoutModeObs.read(reader)
        const shouldAlignResult = layout.kind === 'columns'
        const shouldAlignBase = layout.kind === 'mixed' && !layout.showBaseAtTop

        this.input1View.editor.changeViewZones((input1ViewZoneAccessor) => {
          this.input2View.editor.changeViewZones((input2ViewZoneAccessor) => {
            if (baseView) {
              baseView.editor.changeViewZones((baseViewZoneAccessor) => {
                viewZoneRegistrationStore.add(this.setViewZones(reader,
                  viewModel,
                  this.input1View.editor,
                  input1ViewZoneAccessor,
                  this.input2View.editor,
                  input2ViewZoneAccessor,
                  baseView.editor,
                  baseViewZoneAccessor,
                  shouldAlignBase,
                  this.inputResultView.editor,
                  resultViewZoneAccessor,
                  shouldAlignResult
                ))
              })
            } else {
              viewZoneRegistrationStore.add(this.setViewZones(reader,
                viewModel,
                this.input1View.editor,
                input1ViewZoneAccessor,
                this.input2View.editor,
                input2ViewZoneAccessor,
                undefined,
                undefined,
                false,
                this.inputResultView.editor,
                resultViewZoneAccessor,
                shouldAlignResult
              ))
            }
          })
        })
      })

      this.inputResultView.editor.setScrollTop(resultScrollTop, monaco.editor.ScrollType.Smooth)

      this.scrollSynchronizer.startSync()
      this.scrollSynchronizer.updateScrolling()
    }))

    if (viewState) {
      this._applyViewState(viewState)
    } else {
      let disposed = false
      this._sessionDisposables.add({ dispose: () => { disposed = true } })
      void model.onInitialized.then(() => {
        if (disposed) {
          return
        }
        const firstConflict = model.modifiedBaseRanges.get().find((r) => r.isConflicting)
        if (!firstConflict) {
          return
        }
        this.input1View.editor.revealLineInCenter(firstConflict.input1Range.startLineNumber)
        transaction((tx) => {
          viewModel.setActiveModifiedBaseRange(firstConflict, tx)
        })
      })
    }
  }

  private setViewZones(
    reader: IReader,
    viewModel: MergeEditorViewModel,
    input1Editor: editor.ICodeEditor,
    input1ViewZoneAccessor: editor.IViewZoneChangeAccessor,
    input2Editor: editor.ICodeEditor,
    input2ViewZoneAccessor: editor.IViewZoneChangeAccessor,
    baseEditor: editor.ICodeEditor | undefined,
    baseViewZoneAccessor: editor.IViewZoneChangeAccessor | undefined,
    shouldAlignBase: boolean,
    resultEditor: editor.ICodeEditor,
    resultViewZoneAccessor: editor.IViewZoneChangeAccessor,
    shouldAlignResult: boolean,
  ): IDisposable {
    const input1ViewZoneIds: string[] = []
    const input2ViewZoneIds: string[] = []
    const baseViewZoneIds: string[] = []
    const resultViewZoneIds: string[] = []

    const viewZones = this.viewZoneComputer.computeViewZones(reader, viewModel, {
      codeLensesVisible: true,
      showNonConflictingChanges: this.showNonConflictingChanges.read(reader),
      shouldAlignBase,
      shouldAlignResult,
    })

    const disposableStore = new DisposableStore()

    if (baseViewZoneAccessor) {
      for (const v of viewZones.baseViewZones) {
        v.create(baseViewZoneAccessor, baseViewZoneIds, disposableStore)
      }
    }

    for (const v of viewZones.resultViewZones) {
      v.create(resultViewZoneAccessor, resultViewZoneIds, disposableStore)
    }

    for (const v of viewZones.input1ViewZones) {
      v.create(input1ViewZoneAccessor, input1ViewZoneIds, disposableStore)
    }

    for (const v of viewZones.input2ViewZones) {
      v.create(input2ViewZoneAccessor, input2ViewZoneIds, disposableStore)
    }

    disposableStore.add({
      dispose: () => {
        input1Editor.changeViewZones((a) => {
          for (const zone of input1ViewZoneIds) {
            a.removeZone(zone)
          }
        })
        input2Editor.changeViewZones((a) => {
          for (const zone of input2ViewZoneIds) {
            a.removeZone(zone)
          }
        })
        baseEditor?.changeViewZones((a) => {
          for (const zone of baseViewZoneIds) {
            a.removeZone(zone)
          }
        })
        resultEditor.changeViewZones((a) => {
          for (const zone of resultViewZoneIds) {
            a.removeZone(zone)
          }
        })
      }
    })

    return disposableStore
  }

  clearInput(): void {
    this._sessionDisposables.clear()
    transaction((tx) => {
      this._viewModel.set(undefined, tx)
    })

    for (const { editor } of [this.input1View, this.input2View, this.inputResultView]) {
      editor.setModel(null)
    }
    this.baseView.get()?.editor.setModel(null)
  }

  focus(): void {
    this.inputResultView.editor.focus()
  }

  hasFocus(): boolean {
    for (const { editor } of [this.input1View, this.input2View, this.inputResultView]) {
      if (editor.hasTextFocus()) {
        return true
      }
    }
    return false
  }

  public toggleBase(): void {
    this.setLayout({
      ...this._layoutMode.value,
      showBase: !this._layoutMode.value.showBase
    })
  }

  public toggleShowBaseTop(): void {
    const showBaseTop = this._layoutMode.value.showBase && this._layoutMode.value.showBaseAtTop
    this.setLayout({
      ...this._layoutMode.value,
      showBaseAtTop: true,
      showBase: !showBaseTop,
    })
  }

  public toggleShowBaseCenter(): void {
    const showBaseCenter = this._layoutMode.value.showBase && !this._layoutMode.value.showBaseAtTop
    this.setLayout({
      ...this._layoutMode.value,
      showBaseAtTop: false,
      showBase: !showBaseCenter,
    })
  }

  public setLayoutKind(kind: MergeEditorLayoutKind): void {
    this.setLayout({
      ...this._layoutMode.value,
      kind
    })
  }

  public setLayout(newLayout: IMergeEditorLayout): void {
    const value = this._layoutMode.value
    if (JSON.stringify(value) === JSON.stringify(newLayout)) {
      return
    }
    this.applyLayout(newLayout)
  }

  private applyLayout(layout: IMergeEditorLayout): void {
    transaction((tx) => {
      if (layout.showBase && !this.baseView.get()) {
        this.baseViewDisposables.clear()
        const baseView = this.baseViewDisposables.add(
          new BaseCodeEditorView(
            this.viewModel
          )
        )
        this.baseViewDisposables.add(autorun((reader) => {
          const options = this.baseViewOptions.read(reader)
          if (options) {
            baseView.updateOptions(options)
          }
        }))
        this.baseView.set(baseView, tx)
      } else if (!layout.showBase && this.baseView.get()) {
        this.baseView.set(undefined, tx)
        this.baseViewDisposables.clear()
      }

      if (layout.kind === 'mixed') {
        this.setGrid([
          layout.showBaseAtTop && layout.showBase ? {
            size: 38,
            data: this.baseView.get()!.view
          } : undefined,
          {
            size: 38,
            groups: [
              { data: this.input1View.view },
              !layout.showBaseAtTop && layout.showBase ? { data: this.baseView.get()!.view } : undefined,
              { data: this.input2View.view }
            ].filter(isDefined)
          },
          {
            size: 62,
            data: this.inputResultView.view
          },
        ].filter(isDefined))
      } else if (layout.kind === 'columns') {
        this.setGrid([
          layout.showBase ? {
            size: 40,
            data: this.baseView.get()!.view
          } : undefined,
          {
            size: 60,
            groups: [{ data: this.input1View.view }, { data: this.inputResultView.view }, { data: this.input2View.view }]
          },
        ].filter(isDefined))
      }

      this._layoutMode.value = layout
      this._layoutModeObs.set(layout, tx)
    })
  }

  private setGrid(descriptor: GridNodeDescriptor[]) {
    let width = -1
    let height = -1
    if (this._grid.value) {
      width = this._grid.value.width
      height = this._grid.value.height
    }
    this._grid.value = new MergeEditorGrid(descriptor)

    reset(this.rootHtmlElement!, this._grid.value.element)
    if (width !== -1) {
      this._grid.value.layout(width, height)
    }
  }

  private _applyViewState(state: IMergeEditorViewState | undefined) {
    if (!state) {
      return
    }
    this.inputResultView.editor.restoreViewState(state)
    if (state.input1State) {
      this.input1View.editor.restoreViewState(state.input1State)
    }
    if (state.input2State) {
      this.input2View.editor.restoreViewState(state.input2State)
    }
    if (state.focusIndex >= 0) {
      [this.input1View.editor, this.input2View.editor, this.inputResultView.editor][state.focusIndex].focus()
    }
  }

  computeEditorViewState(): IMergeEditorViewState | undefined {
    const result = this.inputResultView.editor.saveViewState()
    if (!result) {
      return undefined
    }
    const input1State = this.input1View.editor.saveViewState() ?? undefined
    const input2State = this.input2View.editor.saveViewState() ?? undefined
    const focusIndex = [this.input1View.editor, this.input2View.editor, this.inputResultView.editor].findIndex((editor) => editor.hasWidgetFocus())
    return { ...result, input1State, input2State, focusIndex }
  }

  public toggleShowNonConflictingChanges(): void {
    this.showNonConflictingChanges.set(!this.showNonConflictingChanges.get(), undefined)
    storedShowNonConflictingChanges = this.showNonConflictingChanges.get()
  }

  public toggleBetweenInputs(): void {
    const input1IsFocused = this.input1View.editor.hasWidgetFocus()

    if (input1IsFocused) {
      this.input2View.editor.focus()
    } else {
      this.input1View.editor.focus()
    }
  }

  override dispose(): void {
    this._sessionDisposables.clear()
    this._grid.clear()
    super.dispose()
  }
}
