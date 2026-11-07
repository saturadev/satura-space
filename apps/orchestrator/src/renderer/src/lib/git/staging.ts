export interface LineChange {
  readonly originalStartLineNumber: number
  readonly originalEndLineNumber: number
  readonly modifiedStartLineNumber: number
  readonly modifiedEndLineNumber: number
}

export class Position {
  constructor(readonly line: number, readonly character: number) { }

  isBefore(other: Position): boolean {
    return this.line < other.line || (this.line === other.line && this.character < other.character)
  }

  isAfter(other: Position): boolean {
    return other.isBefore(this)
  }
}

export class Range {
  readonly start: Position
  readonly end: Position

  constructor(startLine: number | Position, startCharacter: number | Position, endLine?: number, endCharacter?: number) {
    if (startLine instanceof Position && startCharacter instanceof Position) {
      this.start = startLine
      this.end = startCharacter
    } else {
      this.start = new Position(startLine as number, startCharacter as number)
      this.end = new Position(endLine ?? 0, endCharacter ?? 0)
    }
  }

  intersection(other: Range): Range | undefined {
    const start = this.start.isBefore(other.start) ? other.start : this.start
    const end = this.end.isBefore(other.end) ? this.end : other.end
    if (start.isAfter(end)) {
      return undefined
    }
    return new Range(start, end)
  }
}

interface TextLine {
  readonly range: Range
}

export class TextDocument {
  private readonly lines: string[] = []
  private readonly eols: string[] = []
  private readonly offsets: number[] = []

  constructor(readonly text: string) {
    const re = /\r\n|\r|\n/g
    let last = 0
    let match: RegExpExecArray | null
    while ((match = re.exec(text))) {
      this.offsets.push(last)
      this.lines.push(text.substring(last, match.index))
      this.eols.push(match[0])
      last = match.index + match[0].length
    }
    this.offsets.push(last)
    this.lines.push(text.substring(last))
    this.eols.push('')
  }

  get lineCount(): number {
    return this.lines.length
  }

  lineAt(line: number): TextLine {
    const length = this.lines[line]?.length ?? 0
    return { range: new Range(line, 0, line, length) }
  }

  private offsetAt(position: Position): number {
    if (position.line >= this.lines.length) {
      return this.text.length
    }
    const line = Math.max(0, position.line)
    return this.offsets[line] + Math.min(Math.max(0, position.character), this.lines[line].length)
  }

  getText(range: Range): string {
    return this.text.substring(this.offsetAt(range.start), this.offsetAt(range.end))
  }
}

export function applyLineChanges(original: TextDocument, modified: TextDocument, diffs: LineChange[]): string {
  const result: string[] = []
  let currentLine = 0

  for (const diff of diffs) {
    const isInsertion = diff.originalEndLineNumber === 0
    const isDeletion = diff.modifiedEndLineNumber === 0

    let endLine = isInsertion ? diff.originalStartLineNumber : diff.originalStartLineNumber - 1
    let endCharacter = 0

    if (isDeletion && diff.originalEndLineNumber === original.lineCount) {
      endLine -= 1
      endCharacter = original.lineAt(endLine).range.end.character
    }

    result.push(original.getText(new Range(currentLine, 0, endLine, endCharacter)))

    if (!isDeletion) {
      let fromLine = diff.modifiedStartLineNumber - 1
      let fromCharacter = 0

      if (isInsertion && diff.originalStartLineNumber === original.lineCount) {
        fromLine -= 1
        fromCharacter = modified.lineAt(fromLine).range.end.character
      }

      result.push(modified.getText(new Range(fromLine, fromCharacter, diff.modifiedEndLineNumber, 0)))
    }

    currentLine = isInsertion ? diff.originalStartLineNumber : diff.originalEndLineNumber
  }

  result.push(original.getText(new Range(currentLine, 0, original.lineCount, 0)))

  return result.join('')
}

export interface LineSelection {
  readonly startLine: number
  readonly endLine: number
}

export function toLineRanges(selections: readonly LineSelection[], textDocument: TextDocument): Range[] {
  const lineRanges = selections.map((s) => {
    const startLine = textDocument.lineAt(s.startLine)
    const endLine = textDocument.lineAt(s.endLine)
    return new Range(startLine.range.start, endLine.range.end)
  })

  lineRanges.sort((a, b) => a.start.line - b.start.line)

  const result = lineRanges.reduce((result, l) => {
    if (result.length === 0) {
      result.push(l)
      return result
    }

    const [last, ...rest] = result
    const intersection = l.intersection(last)

    if (intersection) {
      return [intersection, ...rest]
    }

    if (l.start.line === last.end.line + 1) {
      const merge = new Range(last.start, l.end)
      return [merge, ...rest]
    }

    return [l, ...result]
  }, [] as Range[])

  result.reverse()

  return result
}

export function getModifiedRange(textDocument: TextDocument, diff: LineChange): Range {
  if (diff.modifiedEndLineNumber === 0) {
    if (diff.modifiedStartLineNumber === 0) {
      return new Range(textDocument.lineAt(diff.modifiedStartLineNumber).range.end, textDocument.lineAt(diff.modifiedStartLineNumber).range.start)
    } else if (textDocument.lineCount === diff.modifiedStartLineNumber) {
      return new Range(textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end, textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end)
    } else {
      return new Range(textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.end, textDocument.lineAt(diff.modifiedStartLineNumber).range.start)
    }
  } else {
    return new Range(textDocument.lineAt(diff.modifiedStartLineNumber - 1).range.start, textDocument.lineAt(diff.modifiedEndLineNumber - 1).range.end)
  }
}

export function intersectDiffWithRange(textDocument: TextDocument, diff: LineChange, range: Range): LineChange | null {
  const modifiedRange = getModifiedRange(textDocument, diff)
  const intersection = range.intersection(modifiedRange)

  if (!intersection) {
    return null
  }

  if (diff.modifiedEndLineNumber === 0) {
    return diff
  } else {
    const modifiedStartLineNumber = intersection.start.line + 1
    const modifiedEndLineNumber = intersection.end.line + 1

    if (diff.originalEndLineNumber - diff.originalStartLineNumber === diff.modifiedEndLineNumber - diff.modifiedStartLineNumber) {
      const delta = modifiedStartLineNumber - diff.modifiedStartLineNumber
      const length = modifiedEndLineNumber - modifiedStartLineNumber

      return {
        originalStartLineNumber: diff.originalStartLineNumber + delta,
        originalEndLineNumber: diff.originalStartLineNumber + delta + length,
        modifiedStartLineNumber,
        modifiedEndLineNumber
      }
    } else {
      return {
        originalStartLineNumber: diff.originalStartLineNumber,
        originalEndLineNumber: diff.originalEndLineNumber,
        modifiedStartLineNumber,
        modifiedEndLineNumber
      }
    }
  }
}

export function invertLineChange(diff: LineChange): LineChange {
  return {
    modifiedStartLineNumber: diff.originalStartLineNumber,
    modifiedEndLineNumber: diff.originalEndLineNumber,
    originalStartLineNumber: diff.modifiedStartLineNumber,
    originalEndLineNumber: diff.modifiedEndLineNumber
  }
}

export function selectedLineChanges(textDocument: TextDocument, changes: readonly LineChange[], selections: readonly LineSelection[]): LineChange[] {
  const selectedLines = toLineRanges(selections, textDocument)
  return changes
    .map((diff) => selectedLines.reduce<LineChange | null>((result, range) => result || intersectDiffWithRange(textDocument, diff, range), null))
    .filter((d): d is LineChange => !!d)
}

export function changeAtLine(textDocument: TextDocument, changes: readonly LineChange[], line: number): LineChange | undefined {
  const lineRange = toLineRanges([{ startLine: line, endLine: line }], textDocument)[0]
  return changes.find((diff) => !!lineRange.intersection(getModifiedRange(textDocument, diff)))
}
