import type * as Monaco from 'monaco-editor'
import DocumentTracker from './document-tracker'
import CodeLensProvider from './codelens-provider'
import CommandHandler, { type IDisposable } from './command-handler'
import Decorator from './merge-decorator'
import type * as interfaces from './interfaces'
import { MergeConflictHost, type MergeConflictEditorHooks } from './editor-host'

export type { MergeConflictCompareRequest, MergeConflictEditorHooks } from './editor-host'

export const MERGE_CONFLICT_COMMANDS: readonly { readonly id: string; readonly title: string }[] = [
  { id: 'merge-conflict.accept.all-current', title: 'Accept All Current' },
  { id: 'merge-conflict.accept.all-incoming', title: 'Accept All Incoming' },
  { id: 'merge-conflict.accept.all-both', title: 'Accept All Both' },
  { id: 'merge-conflict.accept.current', title: 'Accept Current' },
  { id: 'merge-conflict.accept.incoming', title: 'Accept Incoming' },
  { id: 'merge-conflict.accept.selection', title: 'Accept Selection' },
  { id: 'merge-conflict.accept.both', title: 'Accept Both' },
  { id: 'merge-conflict.next', title: 'Next Conflict' },
  { id: 'merge-conflict.previous', title: 'Previous Conflict' },
  { id: 'merge-conflict.compare', title: 'Compare Current Conflict' }
]

export const MERGE_CONFLICT_MENU_GROUP = 'merge-conflict'

const MERGE_CONFLICTS_WHEN = 'mergeConflictsCount && mergeConflictsCount != 0'

export default class ServiceWrapper implements IDisposable {

  private services: IDisposable[] = []
  readonly host: MergeConflictHost
  commandHandler: CommandHandler | undefined

  constructor(private readonly monaco: typeof Monaco) {
    this.host = new MergeConflictHost(monaco)
  }

  begin() {

    const configuration = this.createExtensionConfiguration()
    const documentTracker = new DocumentTracker()
    const commandHandler = new CommandHandler(documentTracker, this.host)
    const codeLensProvider = new CodeLensProvider(documentTracker, this.monaco, this.host)
    const decorator = new Decorator(documentTracker, this.monaco, this.host)
    this.commandHandler = commandHandler

    this.services.push(
      documentTracker,
      commandHandler,
      codeLensProvider,
      decorator
    )

    commandHandler.begin()
    codeLensProvider.begin(configuration)
    decorator.begin(configuration)
  }

  createExtensionConfiguration(): interfaces.IExtensionConfiguration {
    const codeLensEnabled: boolean = true
    const decoratorsEnabled: boolean = true

    return {
      enableCodeLens: codeLensEnabled,
      enableDecorations: decoratorsEnabled,
      enableEditorOverview: decoratorsEnabled
    }
  }

  dispose() {
    this.services.forEach(disposable => disposable.dispose())
    this.services = []
  }
}

let services: ServiceWrapper | undefined

export function attachMergeConflicts(
  editor: Monaco.editor.IStandaloneCodeEditor,
  monaco: typeof Monaco,
  hooks: MergeConflictEditorHooks
): () => void {
  if (!services) {
    services = new ServiceWrapper(monaco)
    services.begin()
  }
  const commandHandler = services.commandHandler!
  return services.host.attach(editor, hooks, (attached) =>
    MERGE_CONFLICT_COMMANDS.map((command, index) =>
      editor.addAction({
        id: command.id,
        label: command.title,
        precondition: MERGE_CONFLICTS_WHEN,
        contextMenuGroupId: MERGE_CONFLICT_MENU_GROUP,
        contextMenuOrder: index,
        run: () => commandHandler.execute(command.id, attached.textEditor)
      })
    )
  )
}
