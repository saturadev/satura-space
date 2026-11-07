import type { editor } from 'monaco-editor'
import { $, h, isInShadowDOM, reset } from 'monaco-editor/esm/vs/base/browser/dom.js'
import { createStyleSheet } from 'monaco-editor/esm/vs/base/browser/domStylesheets.js'
import { renderLabelWithIcons } from 'monaco-editor/esm/vs/base/browser/ui/iconLabel/iconLabels.js'
import { hash } from 'monaco-editor/esm/vs/base/common/hash.js'
import { Disposable, type IDisposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
import { EDITOR_FONT_DEFAULTS } from 'monaco-editor/esm/vs/editor/common/config/fontInfo.js'
import { monaco } from '../../../lib/editor/monaco-setup'
import { autorun, derived, transaction, type IObservable } from '../../../lib/git/merge/core/observable'
import { ModifiedBaseRange, ModifiedBaseRangeState, ModifiedBaseRangeStateKind } from '../../../lib/git/merge/model/modifiedBaseRange'
import { FixedZoneWidget } from './fixedZoneWidget'
import type { MergeEditorViewModel } from './viewModel'

const EditorOption = monaco.editor.EditorOption

export class ConflictActionsFactory extends Disposable {
  private readonly _styleClassName: string
  private readonly _styleElement: HTMLStyleElement

  constructor(private readonly _editor: editor.ICodeEditor) {
    super()

    this._register(this._editor.onDidChangeConfiguration((e) => {
      if (e.hasChanged(EditorOption.fontInfo) || e.hasChanged(EditorOption.codeLensFontSize) || e.hasChanged(EditorOption.codeLensFontFamily)) {
        this._updateLensStyle()
      }
    }))

    this._styleClassName = '_conflictActionsFactory_' + hash(this._editor.getId()).toString(16)
    this._styleElement = createStyleSheet(
      isInShadowDOM(this._editor.getContainerDomNode())
        ? this._editor.getContainerDomNode()
        : undefined, undefined, this._store
    )

    this._updateLensStyle()
  }

  private _updateLensStyle(): void {
    const { codeLensHeight, fontSize } = this._getLayoutInfo()
    const fontFamily = this._editor.getOption(EditorOption.codeLensFontFamily)
    const editorFontInfo = this._editor.getOption(EditorOption.fontInfo)

    const fontFamilyVar = `--codelens-font-family${this._styleClassName}`
    const fontFeaturesVar = `--codelens-font-features${this._styleClassName}`

    let newStyle = `
    .${this._styleClassName} { line-height: ${codeLensHeight}px; font-size: ${fontSize}px; padding-right: ${Math.round(fontSize * 0.5)}px; font-feature-settings: var(${fontFeaturesVar}) }
    .monaco-workbench .${this._styleClassName} span.codicon { line-height: ${codeLensHeight}px; font-size: ${fontSize}px; }
    `
    if (fontFamily) {
      newStyle += `${this._styleClassName} { font-family: var(${fontFamilyVar}), ${EDITOR_FONT_DEFAULTS.fontFamily}}`
    }
    this._styleElement.textContent = newStyle
    this._editor.getContainerDomNode().style?.setProperty(fontFamilyVar, fontFamily ?? 'inherit')
    this._editor.getContainerDomNode().style?.setProperty(fontFeaturesVar, editorFontInfo.fontFeatureSettings)
  }

  private _getLayoutInfo() {
    const lineHeightFactor = Math.max(1.3, this._editor.getOption(EditorOption.lineHeight) / this._editor.getOption(EditorOption.fontSize))
    let fontSize = this._editor.getOption(EditorOption.codeLensFontSize)
    if (!fontSize || fontSize < 5) {
      fontSize = (this._editor.getOption(EditorOption.fontSize) * .9) | 0
    }
    return {
      fontSize,
      codeLensHeight: (fontSize * lineHeightFactor) | 0,
    }
  }

  public createWidget(viewZoneChangeAccessor: editor.IViewZoneChangeAccessor, lineNumber: number, items: IObservable<IContentWidgetAction[]>, viewZoneIdsToCleanUp: string[]): IDisposable {
    const layoutInfo = this._getLayoutInfo()
    return new ActionsContentWidget(
      this._editor,
      viewZoneChangeAccessor,
      lineNumber,
      layoutInfo.codeLensHeight + 2,
      this._styleClassName,
      items,
      viewZoneIdsToCleanUp,
    )
  }
}

export class ActionsSource {
  constructor(
    private readonly viewModel: MergeEditorViewModel,
    private readonly modifiedBaseRange: ModifiedBaseRange,
  ) {
  }

  private getItemsInput(inputNumber: 1 | 2): IObservable<IContentWidgetAction[]> {
    return derived((reader) => {
      const viewModel = this.viewModel
      const modifiedBaseRange = this.modifiedBaseRange

      if (!viewModel.model.hasBaseRange(modifiedBaseRange)) {
        return []
      }

      const state = viewModel.model.getState(modifiedBaseRange).read(reader)
      const handled = viewModel.model.isHandled(modifiedBaseRange).read(reader)
      const model = viewModel.model

      const result: IContentWidgetAction[] = []

      const inputData = inputNumber === 1 ? viewModel.model.input1 : viewModel.model.input2
      const showNonConflictingChanges = viewModel.showNonConflictingChanges.read(reader)

      if (!modifiedBaseRange.isConflicting && handled && !showNonConflictingChanges) {
        return []
      }

      const otherInputNumber = inputNumber === 1 ? 2 : 1

      if (state.kind !== ModifiedBaseRangeStateKind.unrecognized && !state.isInputIncluded(inputNumber)) {
        if (!state.isInputIncluded(otherInputNumber) || !this.viewModel.shouldUseAppendInsteadOfAccept.read(reader)) {
          result.push(
            command(`Accept ${inputData.title}`, async () => {
              transaction((tx) => {
                model.setState(
                  modifiedBaseRange,
                  state.withInputValue(inputNumber, true, false),
                  inputNumber,
                  tx
                )
              })
            }, `Accept ${inputData.title} in the result document.`)
          )

          if (modifiedBaseRange.canBeCombined) {
            const commandName = modifiedBaseRange.isOrderRelevant
              ? `Accept Combination (${inputData.title} First)`
              : 'Accept Combination'

            result.push(
              command(commandName, async () => {
                transaction((tx) => {
                  model.setState(
                    modifiedBaseRange,
                    ModifiedBaseRangeState.base
                      .withInputValue(inputNumber, true)
                      .withInputValue(otherInputNumber, true, true),
                    true,
                    tx
                  )
                })
              }, 'Accept an automatic combination of both sides in the result document.'),
            )
          }
        } else {
          result.push(
            command(`Append ${inputData.title}`, async () => {
              transaction((tx) => {
                model.setState(
                  modifiedBaseRange,
                  state.withInputValue(inputNumber, true, false),
                  inputNumber,
                  tx
                )
              })
            }, `Append ${inputData.title} to the result document.`)
          )

          if (modifiedBaseRange.canBeCombined) {
            result.push(
              command('Accept Combination', async () => {
                transaction((tx) => {
                  model.setState(
                    modifiedBaseRange,
                    state.withInputValue(inputNumber, true, true),
                    inputNumber,
                    tx
                  )
                })
              }, 'Accept an automatic combination of both sides in the result document.'),
            )
          }
        }

        if (!model.isInputHandled(modifiedBaseRange, inputNumber).read(reader)) {
          result.push(
            command(
              'Ignore',
              async () => {
                transaction((tx) => {
                  model.setInputHandled(modifiedBaseRange, inputNumber, true, tx)
                })
              },
              "Don't take this side of the conflict."
            )
          )
        }

      }
      return result
    })
  }

  public readonly itemsInput1 = this.getItemsInput(1)
  public readonly itemsInput2 = this.getItemsInput(2)

  public readonly resultItems = derived(this, (reader) => {
    const viewModel = this.viewModel
    const modifiedBaseRange = this.modifiedBaseRange

    const state = viewModel.model.getState(modifiedBaseRange).read(reader)
    const model = viewModel.model

    const result: IContentWidgetAction[] = []

    if (state.kind === ModifiedBaseRangeStateKind.unrecognized) {
      result.push({
        text: 'Manual Resolution',
        tooltip: 'This conflict has been resolved manually.',
      })
    } else if (state.kind === ModifiedBaseRangeStateKind.base) {
      result.push({
        text: 'No Changes Accepted',
        tooltip: 'The current resolution of this conflict equals the common ancestor of both the right and left changes.',
      })

    } else {
      const labels = []
      if (state.includesInput1) {
        labels.push(model.input1.title)
      }
      if (state.includesInput2) {
        labels.push(model.input2.title)
      }
      if (state.kind === ModifiedBaseRangeStateKind.both && state.firstInput === 2) {
        labels.reverse()
      }
      result.push({
        text: `${labels.join(' + ')}`
      })
    }

    const stateToggles: IContentWidgetAction[] = []
    if (state.includesInput1) {
      stateToggles.push(
        command(
          `Remove ${model.input1.title}`,
          async () => {
            transaction((tx) => {
              model.setState(
                modifiedBaseRange,
                state.withInputValue(1, false),
                true,
                tx
              )
            })
          },
          `Remove ${model.input1.title} from the result document.`
        )
      )
    }
    if (state.includesInput2) {
      stateToggles.push(
        command(
          `Remove ${model.input2.title}`,
          async () => {
            transaction((tx) => {
              model.setState(
                modifiedBaseRange,
                state.withInputValue(2, false),
                true,
                tx
              )
            })
          },
          `Remove ${model.input2.title} from the result document.`
        )
      )
    }
    if (
      state.kind === ModifiedBaseRangeStateKind.both &&
      state.firstInput === 2
    ) {
      stateToggles.reverse()
    }
    result.push(...stateToggles)

    if (state.kind === ModifiedBaseRangeStateKind.unrecognized) {
      result.push(
        command(
          'Reset to base',
          async () => {
            transaction((tx) => {
              model.setState(
                modifiedBaseRange,
                ModifiedBaseRangeState.base,
                true,
                tx
              )
            })
          },
          'Reset this conflict to the common ancestor of both the right and left changes.'
        )
      )
    }

    return result
  })

  public readonly isEmpty = derived(this, (reader) => {
    return this.itemsInput1.read(reader).length + this.itemsInput2.read(reader).length + this.resultItems.read(reader).length === 0
  })

  public readonly inputIsEmpty = derived(this, (reader) => {
    return this.itemsInput1.read(reader).length + this.itemsInput2.read(reader).length === 0
  })
}

function command(title: string, action: () => Promise<void>, tooltip?: string): IContentWidgetAction {
  return {
    text: title,
    action,
    tooltip,
  }
}

export interface IContentWidgetAction {
  text: string
  tooltip?: string
  action?: () => Promise<void>
}

class ActionsContentWidget extends FixedZoneWidget {
  private readonly _domNode = h('div.merge-editor-conflict-actions').root

  constructor(
    editor: editor.ICodeEditor,
    viewZoneAccessor: editor.IViewZoneChangeAccessor,
    afterLineNumber: number,
    height: number,

    className: string,
    items: IObservable<IContentWidgetAction[]>,
    viewZoneIdsToCleanUp: string[],
  ) {
    super(editor, viewZoneAccessor, afterLineNumber, height, viewZoneIdsToCleanUp)

    this.widgetDomNode.appendChild(this._domNode)

    this._domNode.classList.add(className)

    this._register(autorun((reader) => {
      const i = items.read(reader)
      this.setState(i)
    }))
  }

  private setState(items: IContentWidgetAction[]) {
    const children: HTMLElement[] = []
    let isFirst = true
    for (const item of items) {
      if (isFirst) {
        isFirst = false
      } else {
        children.push($('span', undefined, ' | '))
      }
      const title = renderLabelWithIcons(item.text)

      if (item.action) {
        children.push($('a', { title: item.tooltip, role: 'button', onclick: () => item.action!() }, ...title))
      } else {
        children.push($('span', { title: item.tooltip }, ...title))
      }
    }

    reset(this._domNode, ...children)
  }
}
