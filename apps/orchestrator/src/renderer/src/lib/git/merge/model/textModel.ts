import type { Selection, editor } from 'monaco-editor'
import type { UndoRedoGroup } from 'monaco-editor/esm/vs/platform/undoRedo/common/undoRedo.js'

export interface ITextModel extends editor.ITextModel {
  pushEditOperations(
    beforeCursorState: Selection[] | null,
    editOperations: editor.IIdentifiedSingleEditOperation[],
    cursorStateComputer: editor.ICursorStateComputer,
    group?: UndoRedoGroup
  ): Selection[] | null
}

export type IIdentifiedSingleEditOperation = editor.IIdentifiedSingleEditOperation
