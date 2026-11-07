import type * as Monaco from 'monaco-editor'
import * as vscode from './vscode'

export function toMonacoRange(range: vscode.Range): Monaco.IRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1
  }
}

export class ModelTextDocument extends vscode.TextDocument {
  constructor(readonly model: Monaco.editor.ITextModel) {
    super()
  }

  get uri(): string {
    return this.model.uri.toString()
  }

  get lineCount(): number {
    return this.model.getLineCount()
  }

  get eol(): string {
    return this.model.getEOL()
  }

  protected lineText(line: number): string {
    return this.model.getLineContent(line + 1)
  }

  override getText(range?: vscode.Range): string {
    if (!range) {
      return this.model.getValue()
    }
    return super.getText(range)
  }
}

export class MonacoTextEditor implements vscode.TextEditor {
  constructor(
    readonly editor: Monaco.editor.ICodeEditor,
    private readonly monaco: typeof Monaco
  ) {}

  get document(): vscode.TextDocument {
    return new ModelTextDocument(this.editor.getModel()!)
  }

  get selection(): vscode.Selection {
    const s = this.editor.getSelection()
    if (!s) {
      return new vscode.Selection(new vscode.Position(0, 0), new vscode.Position(0, 0))
    }
    return new vscode.Selection(
      new vscode.Position(s.selectionStartLineNumber - 1, s.selectionStartColumn - 1),
      new vscode.Position(s.positionLineNumber - 1, s.positionColumn - 1)
    )
  }

  set selection(value: vscode.Selection) {
    this.editor.setSelection({
      selectionStartLineNumber: value.anchor.line + 1,
      selectionStartColumn: value.anchor.character + 1,
      positionLineNumber: value.active.line + 1,
      positionColumn: value.active.character + 1
    })
  }

  edit(callback: (editBuilder: vscode.TextEditorEdit) => void): Promise<boolean> {
    const edits: Monaco.editor.IIdentifiedSingleEditOperation[] = []
    callback({ replace: (location, value) => edits.push({ range: toMonacoRange(location), text: value }) })
    if (!this.editor.getModel() || this.editor.getOption(this.monaco.editor.EditorOption.readOnly)) {
      return Promise.resolve(false)
    }
    this.editor.pushUndoStop()
    const applied = this.editor.executeEdits('merge-conflict', edits)
    this.editor.pushUndoStop()
    return Promise.resolve(applied)
  }

  revealRange(range: vscode.Range, revealType?: vscode.TextEditorRevealType): void {
    const r = toMonacoRange(range)
    const smooth = this.monaco.editor.ScrollType.Smooth
    switch (revealType ?? vscode.TextEditorRevealType.Default) {
      case vscode.TextEditorRevealType.InCenter:
        this.editor.revealRangeInCenter(r, smooth)
        break
      case vscode.TextEditorRevealType.InCenterIfOutsideViewport:
        this.editor.revealRangeInCenterIfOutsideViewport(r, smooth)
        break
      case vscode.TextEditorRevealType.AtTop:
        this.editor.revealRangeAtTop(r, smooth)
        break
      default:
        this.editor.revealRange(r, smooth)
    }
  }
}
