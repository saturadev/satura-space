import type { IDiffLineRange, IDiffRangeMapping, IEditorWorkerService } from 'monaco-editor/esm/vs/editor/common/services/editorWorker.js'
import { assertFn, checkAdjacentItems } from '../core/assert'
import type { IReader } from '../core/observable'
import { MergeEditorLineRange } from './lineRange'
import { DetailedLineRangeMapping, RangeMapping } from './mapping'
import type { ITextModel } from './textModel'

export interface IMergeDiffComputer {
  computeDiff(textModel1: ITextModel, textModel2: ITextModel, reader: IReader): Promise<IMergeDiffComputerResult>
}

export interface IMergeDiffComputerResult {
  diffs: DetailedLineRangeMapping[] | null
}

export class MergeDiffComputer implements IMergeDiffComputer {
  private readonly mergeAlgorithm: 'legacy' | 'advanced' = 'advanced'

  constructor(
    private readonly editorWorkerService: IEditorWorkerService,
  ) {
  }

  async computeDiff(textModel1: ITextModel, textModel2: ITextModel, _reader: IReader): Promise<IMergeDiffComputerResult> {
    const diffAlgorithm = this.mergeAlgorithm
    const inputVersion = textModel1.getVersionId()
    const outputVersion = textModel2.getVersionId()

    const result = await this.editorWorkerService.computeDiff(
      textModel1.uri,
      textModel2.uri,
      {
        ignoreTrimWhitespace: false,
        maxComputationTimeMs: 0,
        computeMoves: false,
      },
      diffAlgorithm,
    )

    if (!result) {
      throw new Error('Diff computation failed')
    }

    if (textModel1.isDisposed() || textModel2.isDisposed()) {
      return { diffs: null }
    }

    const changes = result.changes.map((c) =>
      new DetailedLineRangeMapping(
        toLineRange(c.original),
        textModel1,
        toLineRange(c.modified),
        textModel2,
        c.innerChanges?.map((ic) => toRangeMapping(ic))
      )
    )

    const newInputVersion = textModel1.getVersionId()
    const newOutputVersion = textModel2.getVersionId()

    if (inputVersion !== newInputVersion || outputVersion !== newOutputVersion) {
      return { diffs: null }
    }

    assertFn(() => {
      return changes.length === 0 || (changes[0].inputRange.startLineNumber === changes[0].outputRange.startLineNumber &&
        checkAdjacentItems(changes,
          (m1, m2) => m2.inputRange.startLineNumber - m1.inputRange.endLineNumberExclusive === m2.outputRange.startLineNumber - m1.outputRange.endLineNumberExclusive &&
            m1.inputRange.endLineNumberExclusive < m2.inputRange.startLineNumber &&
            m1.outputRange.endLineNumberExclusive < m2.outputRange.startLineNumber,
        ))
    })

    return {
      diffs: changes
    }
  }
}

export function toLineRange(range: IDiffLineRange): MergeEditorLineRange {
  return MergeEditorLineRange.fromLength(range.startLineNumber, range.length)
}

export function toRangeMapping(mapping: IDiffRangeMapping): RangeMapping {
  return new RangeMapping(mapping.originalRange, mapping.modifiedRange)
}
