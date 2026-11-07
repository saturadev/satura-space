import type * as Monaco from 'monaco-editor'
import type * as interfaces from './interfaces'
import type { IDisposable } from './command-handler'
import type { MergeConflictHost } from './editor-host'
import { ModelTextDocument, toMonacoRange } from './monaco-text-editor'

function markerSide(name: string, side: 'current' | 'incoming'): string {
  if (name === 'Stashed changes') return 'your stash'
  if (name === 'Updated upstream') return 'your branch'
  if (!name || name === 'HEAD') return side === 'current' ? 'your HEAD' : 'the other branch'
  return name
}

export default class MergeConflictCodeLensProvider implements Monaco.languages.CodeLensProvider, IDisposable {
  private codeLensRegistrationHandle?: IDisposable | null
  private config?: interfaces.IExtensionConfiguration
  private tracker: interfaces.IDocumentMergeConflictTracker
  private readonly changeListeners = new Set<(e: this) => void>()
  private readonly editorsChanged: IDisposable

  constructor(
    trackerService: interfaces.IDocumentMergeConflictTrackerService,
    private readonly monaco: typeof Monaco,
    private readonly host: MergeConflictHost
  ) {
    this.tracker = trackerService.createTracker('codelens')
    this.editorsChanged = this.host.onDidChangeEditors(() => {
      for (const listener of [...this.changeListeners]) listener(this)
    })
  }

  onDidChange: Monaco.IEvent<this> = (listener) => {
    this.changeListeners.add(listener)
    return { dispose: () => this.changeListeners.delete(listener) }
  }

  begin(config: interfaces.IExtensionConfiguration) {
    this.config = config

    if (this.config.enableCodeLens) {
      this.registerCodeLensProvider()
    }
  }

  dispose() {
    this.editorsChanged.dispose()
    if (this.codeLensRegistrationHandle) {
      this.codeLensRegistrationHandle.dispose()
      this.codeLensRegistrationHandle = null
    }
  }

  async provideCodeLenses(model: Monaco.editor.ITextModel, _token: Monaco.CancellationToken): Promise<Monaco.languages.CodeLensList | null> {

    if (!this.config || !this.config.enableCodeLens) {
      return null
    }

    if (!this.host.handles(model)) {
      return null
    }

    const document = new ModelTextDocument(model)
    const conflicts = await this.tracker.getConflicts(document)
    const conflictsCount = conflicts?.length ?? 0
    this.host.setMergeConflictsCount(model, conflictsCount)

    if (!conflictsCount) {
      return null
    }

    const items: Monaco.languages.CodeLens[] = []

    conflicts.forEach(conflict => {
      this.host.rememberConflict(conflict, model)

      const acceptCurrentCommand: Monaco.languages.Command = {
        id: 'merge-conflict.accept.current',
        title: `Accept Current (${markerSide(conflict.current.name, 'current')})`,
        arguments: ['known-conflict', conflict]
      }

      const acceptIncomingCommand: Monaco.languages.Command = {
        id: 'merge-conflict.accept.incoming',
        title: `Accept Incoming (${markerSide(conflict.incoming.name, 'incoming')})`,
        arguments: ['known-conflict', conflict]
      }

      const acceptBothCommand: Monaco.languages.Command = {
        id: 'merge-conflict.accept.both',
        title: 'Accept Both Changes',
        arguments: ['known-conflict', conflict]
      }

      const diffCommand: Monaco.languages.Command = {
        id: 'merge-conflict.compare',
        title: 'Compare Changes',
        arguments: [conflict]
      }

      const range = toMonacoRange(document.lineAt(conflict.range.start.line).range)
      items.push(
        { range, command: acceptCurrentCommand },
        { range, command: acceptIncomingCommand },
        { range, command: acceptBothCommand },
        { range, command: diffCommand }
      )
    })

    return { lenses: items, dispose: () => {} }
  }

  private registerCodeLensProvider() {
    this.codeLensRegistrationHandle = this.monaco.languages.registerCodeLensProvider('*', this)
  }
}
