export class Position {
  constructor(
    readonly line: number,
    readonly character: number
  ) {}

  isBefore(other: Position): boolean {
    if (this.line < other.line) {
      return true
    }
    if (other.line < this.line) {
      return false
    }
    return this.character < other.character
  }

  isBeforeOrEqual(other: Position): boolean {
    if (this.line < other.line) {
      return true
    }
    if (other.line < this.line) {
      return false
    }
    return this.character <= other.character
  }

  isAfter(other: Position): boolean {
    return !this.isBeforeOrEqual(other)
  }

  isEqual(other: Position): boolean {
    return this.line === other.line && this.character === other.character
  }
}

export class Range {
  readonly start: Position
  readonly end: Position

  constructor(start: Position, end: Position)
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number)
  constructor(a: Position | number, b: Position | number, c?: number, d?: number) {
    const start = typeof a === 'number' ? new Position(a, b as number) : a
    const end = typeof a === 'number' ? new Position(c as number, d as number) : (b as Position)
    if (start.isBeforeOrEqual(end)) {
      this.start = start
      this.end = end
    } else {
      this.start = end
      this.end = start
    }
  }

  get isEmpty(): boolean {
    return this.start.isEqual(this.end)
  }

  contains(positionOrRange: Position | Range): boolean {
    if (positionOrRange instanceof Range) {
      return this.contains(positionOrRange.start) && this.contains(positionOrRange.end)
    }
    if (positionOrRange.isBefore(this.start)) {
      return false
    }
    if (this.end.isBefore(positionOrRange)) {
      return false
    }
    return true
  }

  isEqual(other: Range): boolean {
    return this.start.isEqual(other.start) && this.end.isEqual(other.end)
  }
}

export class Selection extends Range {
  constructor(
    readonly anchor: Position,
    readonly active: Position
  ) {
    super(anchor, active)
  }
}

export interface TextLine {
  readonly lineNumber: number
  readonly text: string
  readonly range: Range
  readonly rangeIncludingLineBreak: Range
  readonly firstNonWhitespaceCharacterIndex: number
  readonly isEmptyOrWhitespace: boolean
}

export abstract class TextDocument {
  abstract readonly uri: string
  abstract readonly lineCount: number
  abstract readonly eol: string
  protected abstract lineText(line: number): string

  lineAt(line: number): TextLine {
    const text = this.lineText(line)
    const range = new Range(line, 0, line, text.length)
    const rangeIncludingLineBreak = line < this.lineCount - 1 ? new Range(line, 0, line + 1, 0) : range
    const firstNonWhitespaceCharacterIndex = /^(\s*)/.exec(text)![1].length
    return {
      lineNumber: line,
      text,
      range,
      rangeIncludingLineBreak,
      firstNonWhitespaceCharacterIndex,
      isEmptyOrWhitespace: firstNonWhitespaceCharacterIndex === text.length
    }
  }

  getText(range?: Range): string {
    const lineCount = this.lineCount
    if (!range) {
      const lines: string[] = []
      for (let i = 0; i < lineCount; i++) {
        lines.push(this.lineText(i))
      }
      return lines.join(this.eol)
    }
    const start = this.validatePosition(range.start)
    const end = this.validatePosition(range.end)
    if (start.line === end.line) {
      return this.lineText(start.line).substring(start.character, end.character)
    }
    const parts = [this.lineText(start.line).substring(start.character)]
    for (let i = start.line + 1; i < end.line; i++) {
      parts.push(this.lineText(i))
    }
    parts.push(this.lineText(end.line).substring(0, end.character))
    return parts.join(this.eol)
  }

  validatePosition(position: Position): Position {
    const lineCount = this.lineCount
    if (lineCount === 0) {
      return new Position(0, 0)
    }
    if (position.line < 0) {
      return new Position(0, 0)
    }
    if (position.line >= lineCount) {
      const last = lineCount - 1
      return new Position(last, this.lineText(last).length)
    }
    const length = this.lineText(position.line).length
    return new Position(position.line, Math.max(0, Math.min(position.character, length)))
  }
}

export class StringTextDocument extends TextDocument {
  readonly eol: string
  private readonly lines: string[]

  constructor(
    readonly uri: string,
    text: string
  ) {
    super()
    this.eol = text.includes('\r\n') ? '\r\n' : '\n'
    this.lines = text.split(/\r\n|\r|\n/)
  }

  get lineCount(): number {
    return this.lines.length
  }

  protected lineText(line: number): string {
    return this.lines[line] ?? ''
  }
}

export interface TextEditorEdit {
  replace(location: Range, value: string): void
}

export enum TextEditorRevealType {
  Default = 0,
  InCenter = 1,
  InCenterIfOutsideViewport = 2,
  AtTop = 3
}

export interface TextEditor {
  readonly document: TextDocument
  selection: Selection
  edit(callback: (editBuilder: TextEditorEdit) => void): Promise<boolean>
  revealRange(range: Range, revealType?: TextEditorRevealType): void
}
