import type { editor } from 'monaco-editor'
import { reset } from 'monaco-editor/esm/vs/base/browser/dom.js'
import { ActionBar } from 'monaco-editor/esm/vs/base/browser/ui/actionbar/actionbar.js'
import { renderLabelWithIcons } from 'monaco-editor/esm/vs/base/browser/ui/iconLabel/iconLabels.js'
import type { IAction } from 'monaco-editor/esm/vs/base/common/actions.js'
import { BugIndicatingError } from 'monaco-editor/esm/vs/base/common/errors.js'
import { monaco } from '../../../../lib/editor/monaco-setup'
import { CompareResult } from '../../../../lib/git/merge/core/arrays'
import { autorun, autorunWithStore, constObservable, derived, type IObservable } from '../../../../lib/git/merge/core/observable'
import { MergeEditorLineRange } from '../../../../lib/git/merge/model/lineRange'
import { join } from '../../../../lib/git/merge/utils'
import { applyObservableDecorations, type IModelDeltaDecoration } from '../utils'
import { handledConflictMinimapOverViewRulerColor, unhandledConflictMinimapOverViewRulerColor } from '../colors'
import { EditorGutter } from '../editorGutter'
import type { MergeEditorViewModel } from '../viewModel'
import { CodeEditorView, createSelectionsAutorun, TitleMenu } from './codeEditorView'

export class ResultCodeEditorView extends CodeEditorView {
  constructor(
    viewModel: IObservable<MergeEditorViewModel | undefined>,
    private readonly getResultLabel: () => string,
  ) {
    super(viewModel)

    this.htmlElements.gutterDiv.style.width = '5px'
    this.htmlElements.root.classList.add(`result`)

    this._register(
      autorunWithStore((reader, store) => {
        if (this.checkboxesVisible.read(reader)) {
          store.add(new EditorGutter(this.editor, this.htmlElements.gutterDiv, {
            getIntersectingGutterItems: (_range, _reader) => [],
            createView: (_item, _target) => { throw new BugIndicatingError() },
          }))
        }
      })
    )

    this._register(autorun((reader) => {
      const vm = this.viewModel.read(reader)
      if (!vm) {
        return
      }
      this.editor.setModel(vm.model.resultTextModel)
      reset(this.htmlElements.title, ...renderLabelWithIcons('Result'))
      reset(this.htmlElements.description, ...renderLabelWithIcons(this.getResultLabel()))
    }))


    const remainingConflictsActionBar = this._register(new ActionBar(this.htmlElements.detail))

    this._register(autorun((reader) => {
      const vm = this.viewModel.read(reader)
      if (!vm) {
        return
      }

      const model = vm.model
      if (!model) {
        return
      }
      const count = model.unhandledConflictsCount.read(reader)

      const text = count === 1
        ? `${count} Conflict Remaining`
        : `${count} Conflicts Remaining `

      remainingConflictsActionBar.clear()
      remainingConflictsActionBar.push({
        class: undefined,
        enabled: count > 0,
        id: 'nextConflict',
        label: text,
        run() {
          vm.goToNextModifiedBaseRange((m) => !model.isHandled(m).read(undefined))
        },
        tooltip: count > 0
          ? 'Go to next conflict'
          : 'All conflicts handled, the merge can be completed now.',
      } as IAction)
    }))


    this._register(applyObservableDecorations(this.editor, this.decorations))

    this._register(
      createSelectionsAutorun(this, (baseRange, viewModel) =>
        viewModel.model.translateBaseRangeToResult(baseRange)
      )
    )

    this._register(
      new TitleMenu(
        constObservable([
          { id: 'mergeEditor.resetResultToBaseAndAutoMerge', label: 'Reset Result', icon: 'discard', run: () => void this.viewModel.get()?.model.reset() }
        ]),
        this.htmlElements.toolbar
      )
    )
  }

  private readonly decorations = derived(this, (reader) => {
    const viewModel = this.viewModel.read(reader)
    if (!viewModel) {
      return []
    }
    const model = viewModel.model
    const textModel = model.resultTextModel
    const result = new Array<IModelDeltaDecoration>()

    const baseRangeWithStoreAndTouchingDiffs = join(
      model.modifiedBaseRanges.read(reader),
      model.baseResultDiffs.read(reader),
      (baseRange, diff) => baseRange.baseRange.intersectsOrTouches(diff.inputRange)
        ? CompareResult.neitherLessOrGreaterThan
        : MergeEditorLineRange.compareByStart(
          baseRange.baseRange,
          diff.inputRange
        )
    )

    const activeModifiedBaseRange = viewModel.activeModifiedBaseRange.read(reader)

    const showNonConflictingChanges = viewModel.showNonConflictingChanges.read(reader)

    for (const m of baseRangeWithStoreAndTouchingDiffs) {
      const modifiedBaseRange = m.left

      if (modifiedBaseRange) {
        const blockClassNames = ['merge-editor-block']
        let blockPadding: [top: number, right: number, bottom: number, left: number] = [0, 0, 0, 0]
        const isHandled = model.isHandled(modifiedBaseRange).read(reader)
        if (isHandled) {
          blockClassNames.push('handled')
        }
        if (modifiedBaseRange === activeModifiedBaseRange) {
          blockClassNames.push('focused')
          blockPadding = [0, 2, 0, 2]
        }
        if (modifiedBaseRange.isConflicting) {
          blockClassNames.push('conflicting')
        }
        blockClassNames.push('result')

        if (!modifiedBaseRange.isConflicting && !showNonConflictingChanges && isHandled) {
          continue
        }

        const range = model.getLineRangeInResult(modifiedBaseRange.baseRange, reader)
        result.push({
          range: range.toInclusiveRangeOrEmpty(),
          options: {
            showIfCollapsed: true,
            blockClassName: blockClassNames.join(' '),
            blockPadding,
            blockIsAfterEnd: range.startLineNumber > textModel.getLineCount(),
            description: 'Result Diff',
            minimap: {
              position: monaco.editor.MinimapPosition.Gutter,
              color: { id: isHandled ? handledConflictMinimapOverViewRulerColor : unhandledConflictMinimapOverViewRulerColor },
            },
            overviewRuler: modifiedBaseRange.isConflicting ? {
              position: monaco.editor.OverviewRulerLane.Center,
              color: { id: isHandled ? handledConflictMinimapOverViewRulerColor : unhandledConflictMinimapOverViewRulerColor },
            } : undefined
          }
        })
      }

      if (!modifiedBaseRange || modifiedBaseRange.isConflicting) {
        for (const diff of m.rights) {
          const range = diff.outputRange.toInclusiveRange()
          if (range) {
            result.push({
              range,
              options: {
                className: `merge-editor-diff result`,
                description: 'Merge Editor',
                isWholeLine: true,
              }
            })
          }

          if (diff.rangeMappings) {
            for (const d of diff.rangeMappings) {
              result.push({
                range: d.outputRange,
                options: {
                  className: `merge-editor-diff-word result`,
                  description: 'Merge Editor'
                }
              })
            }
          }
        }
      }
    }
    return result
  })
}
