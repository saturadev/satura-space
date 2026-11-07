import { CommitType } from './interfaces'
import { MergeConflictParser } from './merge-conflict-parser'
import * as vscode from './vscode'

export { CommitType }

export function acceptAllInText(text: string, type: CommitType): string | undefined {
  const document = new vscode.StringTextDocument('', text)
  if (!MergeConflictParser.containsConflict(document)) {
    return undefined
  }
  const conflicts = MergeConflictParser.scanDocument(document)
  if (conflicts.length === 0) {
    return undefined
  }
  const edits: { range: vscode.Range; newText: string }[] = []
  conflicts.forEach(conflict => {
    conflict.applyEdit(type, document, { replace: (range, newText) => edits.push({ range, newText }) })
  })
  let result = ''
  let last = new vscode.Position(0, 0)
  const end = document.lineAt(document.lineCount - 1).range.end
  for (const edit of edits) {
    result += document.getText(new vscode.Range(last, edit.range.start)) + edit.newText
    last = edit.range.end
  }
  return result + document.getText(new vscode.Range(last, end))
}
