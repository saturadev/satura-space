import * as vscode from './vscode'

export function provideTextDocumentContent(document: vscode.TextDocument, ranges: [vscode.Range, vscode.Range][]): string {
  let text = ''
  let lastPosition = new vscode.Position(0, 0)

  ranges.forEach(rangeObj => {
    const [conflictRange, fullRange] = rangeObj
    const { start, end } = conflictRange
    const { start: fullStart, end: fullEnd } = fullRange

    text += document.getText(new vscode.Range(lastPosition.line, lastPosition.character, fullStart.line, fullStart.character))
    text += document.getText(new vscode.Range(start.line, start.character, end.line, end.character))
    lastPosition = new vscode.Position(fullEnd.line, fullEnd.character)
  })

  const documentEnd = document.lineAt(document.lineCount - 1).range.end
  text += document.getText(new vscode.Range(lastPosition.line, lastPosition.character, documentEnd.line, documentEnd.character))

  return text
}
