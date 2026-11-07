import { Range } from 'monaco-editor/esm/vs/editor/common/core/range.js'
import { LineRange } from '../core/lineRange'
import { MAX_SAFE_SMALL_INTEGER } from '../core/misc'
import type { ITextModel } from './textModel'

export class MergeEditorLineRange extends LineRange {
  static fromLineNumbers(startLineNumber: number, endExclusiveLineNumber: number): MergeEditorLineRange {
    return MergeEditorLineRange.fromLength(startLineNumber, endExclusiveLineNumber - startLineNumber)
  }

  static fromLength(startLineNumber: number, length: number): MergeEditorLineRange {
    return new MergeEditorLineRange(startLineNumber, startLineNumber + length)
  }

  public override join(other: MergeEditorLineRange): MergeEditorLineRange {
    return MergeEditorLineRange.fromLineNumbers(Math.min(this.startLineNumber, other.startLineNumber), Math.max(this.endLineNumberExclusive, other.endLineNumberExclusive))
  }

  public isAfter(range: MergeEditorLineRange): boolean {
    return this.startLineNumber >= range.endLineNumberExclusive
  }

  public isBefore(range: MergeEditorLineRange): boolean {
    return range.startLineNumber >= this.endLineNumberExclusive
  }

  public override delta(lineDelta: number): MergeEditorLineRange {
    return MergeEditorLineRange.fromLength(this.startLineNumber + lineDelta, this.length)
  }

  public deltaEnd(delta: number): MergeEditorLineRange {
    return MergeEditorLineRange.fromLength(this.startLineNumber, this.length + delta)
  }

  public deltaStart(lineDelta: number): MergeEditorLineRange {
    return MergeEditorLineRange.fromLength(this.startLineNumber + lineDelta, this.length - lineDelta)
  }

  public getLines(model: ITextModel): string[] {
    const result = new Array(this.length)
    for (let i = 0; i < this.length; i++) {
      result[i] = model.getLineContent(this.startLineNumber + i)
    }
    return result
  }

  public toInclusiveRangeOrEmpty(): Range {
    if (this.isEmpty) {
      return new Range(this.startLineNumber, 1, this.startLineNumber, 1)
    }
    return new Range(this.startLineNumber, 1, this.endLineNumberExclusive - 1, MAX_SAFE_SMALL_INTEGER)
  }
}
