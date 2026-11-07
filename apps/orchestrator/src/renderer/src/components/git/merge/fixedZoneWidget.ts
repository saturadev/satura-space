import type { editor } from 'monaco-editor'
import { h } from 'monaco-editor/esm/vs/base/browser/dom.js'
import { Event } from 'monaco-editor/esm/vs/base/common/event.js'
import { Disposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'

export abstract class FixedZoneWidget extends Disposable {
  private static counter = 0
  private readonly overlayWidgetId = `fixedZoneWidget-${FixedZoneWidget.counter++}`
  private readonly viewZoneId: string

  protected readonly widgetDomNode = h('div.fixed-zone-widget').root
  private readonly overlayWidget: editor.IOverlayWidget = {
    getId: () => this.overlayWidgetId,
    getDomNode: () => this.widgetDomNode,
    getPosition: () => null
  }

  constructor(
    private readonly editor: editor.ICodeEditor,
    viewZoneAccessor: editor.IViewZoneChangeAccessor,
    afterLineNumber: number,
    height: number,
    viewZoneIdsToCleanUp: string[],
  ) {
    super()

    this.viewZoneId = viewZoneAccessor.addZone({
      domNode: document.createElement('div'),
      afterLineNumber: afterLineNumber,
      heightInPx: height,
      ordinal: 50000 + 1,
      onComputedHeight: (height) => {
        this.widgetDomNode.style.height = `${height}px`
      },
      onDomNodeTop: (top) => {
        this.widgetDomNode.style.top = `${top}px`
      }
    })
    viewZoneIdsToCleanUp.push(this.viewZoneId)

    this._register(Event.runAndSubscribe(this.editor.onDidLayoutChange, () => {
      this.widgetDomNode.style.left = this.editor.getLayoutInfo().contentLeft + 'px'
    }))

    this.editor.addOverlayWidget(this.overlayWidget)

    this._register({
      dispose: () => {
        this.editor.removeOverlayWidget(this.overlayWidget)
      },
    })
  }
}
