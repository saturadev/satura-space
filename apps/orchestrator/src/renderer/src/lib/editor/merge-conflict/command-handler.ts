import * as vscode from './vscode'
import * as interfaces from './interfaces'
import { provideTextDocumentContent } from './content-provider'

interface IDocumentMergeConflictNavigationResults {
  canNavigate: boolean
  conflict?: interfaces.IDocumentMergeConflict
}

enum NavigationDirection {
  Forwards,
  Backwards
}

export interface IDisposable {
  dispose(): void
}

export interface IMergeConflictConfiguration {
  autoNavigateNextConflict: boolean
}

export interface IConflictDiffRequest {
  readonly title: string
  readonly original: string
  readonly modified: string
  readonly selection: vscode.Range
}

export interface ICommandHost {
  readonly configuration: IMergeConflictConfiguration
  registerCommand(id: string, handler: (...args: any[]) => unknown): IDisposable
  activeTextEditor(args: unknown[]): vscode.TextEditor | undefined
  isStaleConflict(args: unknown[]): boolean
  showWarningMessage(message: string, editor?: vscode.TextEditor): void
  openDiff(editor: vscode.TextEditor, request: IConflictDiffRequest): void
}

type TextEditorCommand = (editor: vscode.TextEditor, ...args: any[]) => Promise<void>

export default class CommandHandler implements IDisposable {

  private disposables: IDisposable[] = []
  private tracker: interfaces.IDocumentMergeConflictTracker
  private readonly commands = new Map<string, TextEditorCommand>()

  constructor(trackerService: interfaces.IDocumentMergeConflictTrackerService, private readonly host: ICommandHost) {
    this.tracker = trackerService.createTracker('commands')
  }

  begin() {
    this.disposables.push(
      this.registerTextEditorCommand('merge-conflict.accept.current', this.acceptCurrent),
      this.registerTextEditorCommand('merge-conflict.accept.incoming', this.acceptIncoming),
      this.registerTextEditorCommand('merge-conflict.accept.selection', this.acceptSelection),
      this.registerTextEditorCommand('merge-conflict.accept.both', this.acceptBoth),
      this.registerTextEditorCommand('merge-conflict.accept.all-current', this.acceptAllCurrent),
      this.registerTextEditorCommand('merge-conflict.accept.all-incoming', this.acceptAllIncoming),
      this.registerTextEditorCommand('merge-conflict.accept.all-both', this.acceptAllBoth),
      this.registerTextEditorCommand('merge-conflict.next', this.navigateNext),
      this.registerTextEditorCommand('merge-conflict.previous', this.navigatePrevious),
      this.registerTextEditorCommand('merge-conflict.compare', this.compare)
    )
  }

  execute(command: string, editor: vscode.TextEditor, ...args: any[]): Promise<void> | undefined {
    const cb = this.commands.get(command)
    return cb && cb.call(this, editor, ...args)
  }

  private registerTextEditorCommand(command: string, cb: TextEditorCommand) {
    this.commands.set(command, cb)
    const registration = this.host.registerCommand(command, (...args) => {
      if (this.host.isStaleConflict(args)) return undefined
      const editor = this.host.activeTextEditor(args)
      return editor && cb.call(this, editor, ...args)
    })
    return {
      dispose: () => {
        this.commands.delete(command)
        registration.dispose()
      }
    }
  }

  acceptCurrent(editor: vscode.TextEditor, ...args: any[]): Promise<void> {
    return this.accept(interfaces.CommitType.Current, editor, ...args)
  }

  acceptIncoming(editor: vscode.TextEditor, ...args: any[]): Promise<void> {
    return this.accept(interfaces.CommitType.Incoming, editor, ...args)
  }

  acceptBoth(editor: vscode.TextEditor, ...args: any[]): Promise<void> {
    return this.accept(interfaces.CommitType.Both, editor, ...args)
  }

  acceptAllCurrent(editor: vscode.TextEditor): Promise<void> {
    return this.acceptAll(interfaces.CommitType.Current, editor)
  }

  acceptAllIncoming(editor: vscode.TextEditor): Promise<void> {
    return this.acceptAll(interfaces.CommitType.Incoming, editor)
  }

  acceptAllBoth(editor: vscode.TextEditor): Promise<void> {
    return this.acceptAll(interfaces.CommitType.Both, editor)
  }

  async compare(editor: vscode.TextEditor, conflict: interfaces.IDocumentMergeConflict | null) {

    if (!conflict) {
      conflict = await this.findConflictContainingSelection(editor)

      if (!conflict) {
        this.host.showWarningMessage('Editor cursor is not within a merge conflict', editor)
        return
      }
    }

    const conflicts = await this.tracker.getConflicts(editor.document)

    if (!conflicts) {
      this.host.showWarningMessage('Editor cursor is not within a merge conflict', editor)
      return
    }

    const leftRanges = conflicts.map((conflict): [vscode.Range, vscode.Range] => [conflict.current.content, conflict.range])
    const rightRanges = conflicts.map((conflict): [vscode.Range, vscode.Range] => [conflict.incoming.content, conflict.range])

    let mergeConflictLineOffsets = 0
    for (const nextconflict of conflicts) {
      if (nextconflict.range.isEqual(conflict.range)) {
        break
      } else {
        mergeConflictLineOffsets += (nextconflict.range.end.line - nextconflict.range.start.line) - (nextconflict.incoming.content.end.line - nextconflict.incoming.content.start.line)
      }
    }
    const selection = new vscode.Range(
      conflict.range.start.line - mergeConflictLineOffsets, conflict.range.start.character,
      conflict.range.start.line - mergeConflictLineOffsets, conflict.range.start.character
    )

    const document = editor.document
    const docPath = document.uri
    const fileName = decodeURIComponent(docPath.substring(docPath.lastIndexOf('/') + 1))
    const title = `${fileName}: Current Changes ↔ Incoming Changes`

    this.host.openDiff(editor, {
      title,
      original: provideTextDocumentContent(document, leftRanges),
      modified: provideTextDocumentContent(document, rightRanges),
      selection
    })
  }

  navigateNext(editor: vscode.TextEditor): Promise<void> {
    return this.navigate(editor, NavigationDirection.Forwards)
  }

  navigatePrevious(editor: vscode.TextEditor): Promise<void> {
    return this.navigate(editor, NavigationDirection.Backwards)
  }

  async acceptSelection(editor: vscode.TextEditor): Promise<void> {
    const conflict = await this.findConflictContainingSelection(editor)

    if (!conflict) {
      this.host.showWarningMessage('Editor cursor is not within a merge conflict', editor)
      return
    }

    let typeToAccept: interfaces.CommitType
    let tokenAfterCurrentBlock: vscode.Range = conflict.splitter

    if (conflict.commonAncestors.length > 0) {
      tokenAfterCurrentBlock = conflict.commonAncestors[0].header
    }

    if (editor.selection.active.isBefore(tokenAfterCurrentBlock.start)) {
      typeToAccept = interfaces.CommitType.Current
    }
    else if (editor.selection.active.isAfter(conflict.splitter.end)) {
      typeToAccept = interfaces.CommitType.Incoming
    }
    else if (editor.selection.active.isBefore(conflict.splitter.start)) {
      this.host.showWarningMessage('Editor cursor is within the common ancestors block, please move it to either the "current" or "incoming" block', editor)
      return
    }
    else {
      this.host.showWarningMessage('Editor cursor is within the merge conflict splitter, please move it to either the "current" or "incoming" block', editor)
      return
    }

    this.tracker.forget(editor.document)
    await conflict.commitEdit(typeToAccept, editor)
  }

  dispose() {
    this.disposables.forEach(disposable => disposable.dispose())
    this.disposables = []
  }

  private async navigate(editor: vscode.TextEditor, direction: NavigationDirection): Promise<void> {
    const navigationResult = await this.findConflictForNavigation(editor, direction)

    if (!navigationResult) {
      if (this.host.configuration.autoNavigateNextConflict) {
        return
      }
      this.host.showWarningMessage('No merge conflicts found in this file', editor)
      return
    }
    else if (!navigationResult.canNavigate) {
      this.host.showWarningMessage('No other merge conflicts within this file', editor)
      return
    }
    else if (!navigationResult.conflict) {
      return
    }

    editor.selection = new vscode.Selection(navigationResult.conflict.range.start, navigationResult.conflict.range.start)
    editor.revealRange(navigationResult.conflict.range, vscode.TextEditorRevealType.Default)
  }

  private async accept(type: interfaces.CommitType, editor: vscode.TextEditor, ...args: any[]): Promise<void> {

    let conflict: interfaces.IDocumentMergeConflict | null

    if (args[0] === 'known-conflict') {
      conflict = args[1]
    }
    else {
      conflict = await this.findConflictContainingSelection(editor)
    }

    if (!conflict) {
      this.host.showWarningMessage('Editor cursor is not within a merge conflict', editor)
      return
    }

    this.tracker.forget(editor.document)
    await conflict.commitEdit(type, editor)

    if (this.host.configuration.autoNavigateNextConflict) {
      this.navigateNext(editor)
    }

  }

  private async acceptAll(type: interfaces.CommitType, editor: vscode.TextEditor): Promise<void> {
    const conflicts = await this.tracker.getConflicts(editor.document)

    if (!conflicts || conflicts.length === 0) {
      this.host.showWarningMessage('No merge conflicts found in this file', editor)
      return
    }

    this.tracker.forget(editor.document)

    await editor.edit((edit) => conflicts.forEach(conflict => {
      conflict.applyEdit(type, editor.document, edit)
    }))
  }

  private async findConflictContainingSelection(editor: vscode.TextEditor, conflicts?: interfaces.IDocumentMergeConflict[]): Promise<interfaces.IDocumentMergeConflict | null> {

    if (!conflicts) {
      conflicts = await this.tracker.getConflicts(editor.document)
    }

    if (!conflicts || conflicts.length === 0) {
      return null
    }

    for (const conflict of conflicts) {
      if (conflict.range.contains(editor.selection.active)) {
        return conflict
      }
    }

    return null
  }

  private async findConflictForNavigation(editor: vscode.TextEditor, direction: NavigationDirection, conflicts?: interfaces.IDocumentMergeConflict[]): Promise<IDocumentMergeConflictNavigationResults | null> {
    if (!conflicts) {
      conflicts = await this.tracker.getConflicts(editor.document)
    }

    if (!conflicts || conflicts.length === 0) {
      return null
    }

    const selection = editor.selection.active
    if (conflicts.length === 1) {
      if (conflicts[0].range.contains(selection)) {
        return {
          canNavigate: false
        }
      }

      return {
        canNavigate: true,
        conflict: conflicts[0]
      }
    }

    let predicate: (_conflict: interfaces.IDocumentMergeConflict) => boolean
    let fallback: () => interfaces.IDocumentMergeConflict
    let scanOrder: interfaces.IDocumentMergeConflict[]

    if (direction === NavigationDirection.Forwards) {
      predicate = (conflict) => selection.isBefore(conflict.range.start)
      fallback = () => conflicts![0]
      scanOrder = conflicts
    } else if (direction === NavigationDirection.Backwards) {
      predicate = (conflict) => selection.isAfter(conflict.range.start)
      fallback = () => conflicts![conflicts!.length - 1]
      scanOrder = conflicts.slice().reverse()
    } else {
      throw new Error(`Unsupported direction ${direction}`)
    }

    for (const conflict of scanOrder) {
      if (predicate(conflict) && !conflict.range.contains(selection)) {
        return {
          canNavigate: true,
          conflict: conflict
        }
      }
    }

    return {
      canNavigate: true,
      conflict: fallback()
    }
  }
}
