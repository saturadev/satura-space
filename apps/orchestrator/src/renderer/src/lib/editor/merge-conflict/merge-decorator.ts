import type * as Monaco from 'monaco-editor'
import type * as interfaces from './interfaces'
import type * as vscode from './vscode'
import type { IDisposable } from './command-handler'
import type { AttachedEditor, MergeConflictHost } from './editor-host'
import { ModelTextDocument, toMonacoRange } from './monaco-text-editor'
import './merge-conflict.css'

export default class MergeDecorator implements IDisposable {

  private decorations: { [key: string]: Monaco.editor.IModelDecorationOptions } = {}

  private decorationUsesWholeLine: boolean = true

  private config?: interfaces.IExtensionConfiguration
  private tracker: interfaces.IDocumentMergeConflictTracker
  private updating = new Map<AttachedEditor, boolean>()
  private collections = new Map<AttachedEditor, Map<string, Monaco.editor.IEditorDecorationsCollection>>()
  private subscriptions: IDisposable[] = []

  constructor(
    trackerService: interfaces.IDocumentMergeConflictTrackerService,
    private readonly monaco: typeof Monaco,
    private readonly host: MergeConflictHost
  ) {
    this.tracker = trackerService.createTracker('decorator')
  }

  begin(config: interfaces.IExtensionConfiguration) {
    this.config = config
    this.registerDecorationTypes(config)

    this.host.visibleTextEditors.forEach(e => this.applyDecorations(e))

    this.subscriptions.push(this.host.onDidChangeTextDocument(model => {
      this.applyDecorationsFromEvent(model)
    }))

    this.subscriptions.push(this.host.onDidChangeVisibleTextEditors((e) => {
      e.forEach(e => this.applyDecorations(e))
    }))

    this.subscriptions.push(this.host.onDidChangeEditors(() => {
      for (const editor of [...this.collections.keys()]) {
        if (!this.host.isVisible(editor)) {
          this.collections.delete(editor)
        }
      }
    }))
  }

  private registerDecorationTypes(config: interfaces.IExtensionConfiguration) {

    this.decorations = {}

    if (!config.enableDecorations || !config.enableEditorOverview) {
      return
    }

    if (config.enableDecorations || config.enableEditorOverview) {
      this.decorations['current.content'] = this.generateBlockRenderOptions('merge-conflict-current-content', 'editorOverviewRuler.currentContentForeground', config)

      this.decorations['incoming.content'] = this.generateBlockRenderOptions('merge-conflict-incoming-content', 'editorOverviewRuler.incomingContentForeground', config)

      this.decorations['commonAncestors.content'] = this.generateBlockRenderOptions('merge-conflict-common-content', 'editorOverviewRuler.commonContentForeground', config)
    }

    if (config.enableDecorations) {
      this.decorations['current.header'] = {
        isWholeLine: this.decorationUsesWholeLine,
        className: 'merge-conflict-current-header',
        inlineClassName: 'merge-conflict-foreground',
        afterContentClassName: 'merge-conflict-current-header-after'
      }

      this.decorations['commonAncestors.header'] = {
        isWholeLine: this.decorationUsesWholeLine,
        className: 'merge-conflict-common-header',
        inlineClassName: 'merge-conflict-foreground'
      }

      this.decorations['splitter'] = {
        isWholeLine: this.decorationUsesWholeLine,
        className: 'merge-conflict-splitter',
        inlineClassName: 'merge-conflict-foreground'
      }

      this.decorations['incoming.header'] = {
        isWholeLine: this.decorationUsesWholeLine,
        className: 'merge-conflict-incoming-header',
        inlineClassName: 'merge-conflict-foreground',
        afterContentClassName: 'merge-conflict-incoming-header-after'
      }
    }
  }

  dispose() {
    this.subscriptions.forEach(s => s.dispose())
    this.subscriptions = []
    for (const editor of this.collections.keys()) {
      this.removeDecorations(editor)
    }
    this.collections.clear()
    this.decorations = {}
  }

  private generateBlockRenderOptions(className: string, overviewRulerColor: string, config: interfaces.IExtensionConfiguration): Monaco.editor.IModelDecorationOptions {

    const renderOptions: Monaco.editor.IModelDecorationOptions = {
      ...(config.enableDecorations ? { className, isWholeLine: this.decorationUsesWholeLine } : {}),
      ...(config.enableEditorOverview
        ? { overviewRuler: { color: { id: overviewRulerColor }, position: this.monaco.editor.OverviewRulerLane.Full } }
        : {})
    }

    return renderOptions
  }

  private applyDecorationsFromEvent(eventDocument: Monaco.editor.ITextModel) {
    for (const editor of this.host.visibleTextEditors) {
      if (editor.editor.getModel() === eventDocument) {
        this.applyDecorations(editor)
      }
    }
  }

  private async applyDecorations(editor: AttachedEditor) {
    const model = editor?.editor.getModel()
    if (!editor || !model) { return }

    if (!this.config || (!this.config.enableDecorations && !this.config.enableEditorOverview)) {
      return
    }

    if (this.updating.get(editor)) {
      return
    }

    try {
      this.updating.set(editor, true)

      const conflicts = await this.tracker.getConflicts(new ModelTextDocument(model))
      if (!this.host.isVisible(editor)) {
        return
      }

      if (conflicts.length === 0) {
        this.removeDecorations(editor)
        return
      }

      const matchDecorations: { [key: string]: vscode.Range[] } = {}

      const pushDecoration = (key: string, d: vscode.Range) => {
        matchDecorations[key] = matchDecorations[key] || []
        matchDecorations[key].push(d)
      }

      conflicts.forEach(conflict => {
        if (!conflict.current.decoratorContent.isEmpty) {
          pushDecoration('current.content', conflict.current.decoratorContent)
        }
        if (!conflict.incoming.decoratorContent.isEmpty) {
          pushDecoration('incoming.content', conflict.incoming.decoratorContent)
        }

        conflict.commonAncestors.forEach(commonAncestorsRegion => {
          if (!commonAncestorsRegion.decoratorContent.isEmpty) {
            pushDecoration('commonAncestors.content', commonAncestorsRegion.decoratorContent)
          }
        })

        if (this.config!.enableDecorations) {
          pushDecoration('current.header', conflict.current.header)
          pushDecoration('splitter', conflict.splitter)
          pushDecoration('incoming.header', conflict.incoming.header)

          conflict.commonAncestors.forEach(commonAncestorsRegion => {
            pushDecoration('commonAncestors.header', commonAncestorsRegion.header)
          })
        }
      })

      Object.keys(this.decorations).forEach(decorationKey => {
        this.setDecorations(editor, decorationKey, matchDecorations[decorationKey] ?? [])
      })

    } finally {
      this.updating.delete(editor)
    }
  }

  private setDecorations(editor: AttachedEditor, decorationKey: string, ranges: vscode.Range[]) {
    const options = this.decorations[decorationKey]
    if (!options) {
      return
    }
    let byKey = this.collections.get(editor)
    if (!byKey) {
      byKey = new Map()
      this.collections.set(editor, byKey)
    }
    let collection = byKey.get(decorationKey)
    if (!collection) {
      if (ranges.length === 0) {
        return
      }
      collection = editor.editor.createDecorationsCollection()
      byKey.set(decorationKey, collection)
    }
    collection.set(ranges.map(range => ({ range: toMonacoRange(range), options })))
  }

  private removeDecorations(editor: AttachedEditor) {
    Object.keys(this.decorations).forEach(decorationKey => {
      this.setDecorations(editor, decorationKey, [])
    })
  }
}
