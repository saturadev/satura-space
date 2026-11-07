import type * as Monaco from 'monaco-editor'
import type * as interfaces from './interfaces'
import type * as vscode from './vscode'
import type { ICommandHost, IConflictDiffRequest, IDisposable, IMergeConflictConfiguration } from './command-handler'
import { MonacoTextEditor, toMonacoRange } from './monaco-text-editor'

export interface MergeConflictCompareRequest {
  readonly title: string
  readonly original: string
  readonly modified: string
  readonly language: string
  readonly selection: Monaco.IRange
}

export interface MergeConflictEditorHooks {
  onConflictsCount(count: number): void
  onWarning(message: string): void
  onCompare(request: MergeConflictCompareRequest): void
}

export interface AttachedEditor {
  readonly editor: Monaco.editor.IStandaloneCodeEditor
  readonly textEditor: MonacoTextEditor
  readonly hooks: MergeConflictEditorHooks
  readonly countKey: Monaco.editor.IContextKey<number>
}

type Listener<T> = (value: T) => void

class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>()

  event = (listener: Listener<T>): IDisposable => {
    this.listeners.add(listener)
    return { dispose: () => this.listeners.delete(listener) }
  }

  fire(value: T): void {
    for (const listener of [...this.listeners]) listener(value)
  }
}

export class MergeConflictHost implements ICommandHost {
  readonly configuration: IMergeConflictConfiguration = { autoNavigateNextConflict: false }
  private readonly editors = new Set<AttachedEditor>()
  private lastFocused: AttachedEditor | undefined
  private readonly conflictModels = new WeakMap<interfaces.IDocumentMergeConflict, Monaco.editor.ITextModel>()
  private readonly conflictVersions = new WeakMap<interfaces.IDocumentMergeConflict, number>()
  private readonly didChangeVisibleTextEditors = new Emitter<AttachedEditor[]>()
  private readonly didChangeTextDocument = new Emitter<Monaco.editor.ITextModel>()
  private readonly didChangeEditors = new Emitter<void>()

  readonly onDidChangeVisibleTextEditors = this.didChangeVisibleTextEditors.event
  readonly onDidChangeTextDocument = this.didChangeTextDocument.event
  readonly onDidChangeEditors = this.didChangeEditors.event

  constructor(private readonly monaco: typeof Monaco) {}

  get visibleTextEditors(): AttachedEditor[] {
    return [...this.editors]
  }

  isVisible(attached: AttachedEditor): boolean {
    return this.editors.has(attached)
  }

  handles(model: Monaco.editor.ITextModel): boolean {
    return this.visibleTextEditors.some((e) => e.editor.getModel() === model)
  }

  rememberConflict(conflict: interfaces.IDocumentMergeConflict, model: Monaco.editor.ITextModel): void {
    this.conflictModels.set(conflict, model)
    this.conflictVersions.set(conflict, model.getVersionId())
  }

  isStaleConflict(args: unknown[]): boolean {
    const conflict = args[0] === 'known-conflict' ? args[1] : args[0]
    if (!conflict || typeof conflict !== 'object') return false
    const known = conflict as interfaces.IDocumentMergeConflict
    const model = this.conflictModels.get(known)
    const version = this.conflictVersions.get(known)
    return !!model && version !== undefined && (model.isDisposed() || model.getVersionId() !== version)
  }

  setMergeConflictsCount(model: Monaco.editor.ITextModel, count: number): void {
    for (const attached of this.editors) {
      if (attached.editor.getModel() !== model) continue
      attached.countKey.set(count)
      attached.hooks.onConflictsCount(count)
    }
  }

  registerCommand(id: string, handler: (...args: any[]) => unknown): IDisposable {
    return this.monaco.editor.registerCommand(id, (_accessor, ...args) => handler(...args))
  }

  activeTextEditor(args: unknown[]): vscode.TextEditor | undefined {
    const conflict = args[0] === 'known-conflict' ? args[1] : args[0]
    const model = conflict && typeof conflict === 'object' ? this.conflictModels.get(conflict as interfaces.IDocumentMergeConflict) : undefined
    const candidates = model ? this.visibleTextEditors.filter((e) => e.editor.getModel() === model) : this.visibleTextEditors
    const focused = candidates.find((e) => e.editor.hasTextFocus() || e.editor.hasWidgetFocus())
    if (focused) return focused.textEditor
    if (this.lastFocused && candidates.includes(this.lastFocused)) return this.lastFocused.textEditor
    return candidates[0]?.textEditor
  }

  private attachedFor(editor: vscode.TextEditor | undefined): AttachedEditor | undefined {
    if (!editor) return this.lastFocused
    return this.visibleTextEditors.find((e) => e.textEditor === editor)
  }

  showWarningMessage(message: string, editor?: vscode.TextEditor): void {
    this.attachedFor(editor)?.hooks.onWarning(message)
  }

  openDiff(editor: vscode.TextEditor, request: IConflictDiffRequest): void {
    const attached = this.attachedFor(editor)
    if (!attached) return
    attached.hooks.onCompare({
      title: request.title,
      original: request.original,
      modified: request.modified,
      language: attached.editor.getModel()?.getLanguageId() ?? 'plaintext',
      selection: toMonacoRange(request.selection)
    })
  }

  attach(
    editor: Monaco.editor.IStandaloneCodeEditor,
    hooks: MergeConflictEditorHooks,
    actions: (attached: AttachedEditor) => IDisposable[]
  ): () => void {
    const attached: AttachedEditor = {
      editor,
      textEditor: new MonacoTextEditor(editor, this.monaco),
      hooks,
      countKey: editor.createContextKey<number>('mergeConflictsCount', 0)
    }
    this.editors.add(attached)
    const disposables: IDisposable[] = [
      ...actions(attached),
      editor.onDidFocusEditorWidget(() => {
        this.lastFocused = attached
      }),
      editor.onDidChangeModelContent(() => {
        const model = editor.getModel()
        if (model) this.didChangeTextDocument.fire(model)
      }),
      editor.onDidChangeModel(() => {
        attached.countKey.set(0)
        hooks.onConflictsCount(0)
        this.didChangeVisibleTextEditors.fire([attached])
      })
    ]
    let detached = false
    const detach = (): void => {
      if (detached) return
      detached = true
      for (const d of disposables) d.dispose()
      this.editors.delete(attached)
      if (this.lastFocused === attached) this.lastFocused = undefined
      this.didChangeEditors.fire()
    }
    disposables.push(editor.onDidDispose(detach))
    this.didChangeVisibleTextEditors.fire([attached])
    this.didChangeEditors.fire()
    return detach
  }
}
