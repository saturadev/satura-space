import { Disposable, DisposableStore } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
import { IEditorWorkerService } from 'monaco-editor/esm/vs/editor/common/services/editorWorker.js'
import { StandaloneServices } from 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js'
import { IUndoRedoService } from 'monaco-editor/esm/vs/platform/undoRedo/common/undoRedo.js'
import { WORKTREE_REF, type Change, type GitScmApi, type ScmConflictSides, type ScmResult } from '@shared/git-scm'
import { conflictSideNames } from '../conflict-sides'
import { monaco } from '../../editor/monaco-setup'
import { languageFromPath } from '../../editor/language-from-path'
import { observableValue, type IObservable } from './core/observable'
import { MergeDiffComputer } from './model/diffComputer'
import { MergeEditorModel, type InputData } from './model/mergeEditorModel'
import type { ITextModel } from './model/textModel'
import { censusTrack } from '@shared/census'

export const conflictMarkers = {
  start: '<<<<<<<',
  end: '>>>>>>>',
}

export class MergeEditorLoadError extends Error { }

interface InputSource {
  path: string
  ref: string
  title?: string
  description?: string
  detail?: string
}

export interface MergeEditorSources {
  readonly isRebasing: boolean
  readonly base: string
  readonly input1: InputSource & { text: string }
  readonly input2: InputSource & { text: string }
  readonly result: string
}

function unwrap<T>(result: ScmResult<T>): T {
  if (!result.ok) {
    throw new Error(result.error.message)
  }
  return result.value
}

async function showText(api: GitScmApi, root: string, path: string, ref: string): Promise<string> {
  const content = unwrap(await api.show(root, path, ref))
  if (content.kind === 'text') {
    return content.text
  }
  if (content.kind === 'missing') {
    return ''
  }
  throw new MergeEditorLoadError(content.kind === 'binary'
    ? 'Binary files can\'t be merged in the merge editor.'
    : 'This file is too large for the merge editor.')
}

function findFirstConflictMarker(lines: readonly string[]): { currentChangeLabel: string; incomingChangeLabel: string } | undefined {
  const conflictMarkerStart = '<<<<<<<'
  const conflictMarkerEnd = '>>>>>>>'
  let inConflict = false
  let currentChangeLabel: string = ''
  let incomingChangeLabel: string = ''
  let hasConflict = false

  for (const lineStr of lines) {
    if (!inConflict) {
      if (lineStr.startsWith(conflictMarkerStart)) {
        currentChangeLabel = lineStr.substring(conflictMarkerStart.length).trim()
        inConflict = true
        hasConflict = true
      }
    } else {
      if (lineStr.startsWith(conflictMarkerEnd)) {
        incomingChangeLabel = lineStr.substring(conflictMarkerStart.length).trim()
        inConflict = false
        break
      }
    }
  }
  if (hasConflict) {
    return {
      currentChangeLabel,
      incomingChangeLabel
    }
  }
  return undefined
}

export async function loadMergeEditorSources(api: GitScmApi, root: string, path: string, isRebasing: boolean, sides?: ScmConflictSides): Promise<MergeEditorSources> {
  const result = await showText(api, root, path, WORKTREE_REF)

  let isStashConflict = false
  try {
    const firstConflictInfo = findFirstConflictMarker(result.split(/\r\n|\r|\n/))
    isStashConflict = firstConflictInfo?.incomingChangeLabel === 'Stashed changes'
  } catch (error) {
    console.error(error)
  }

  const kind = sides?.kind ?? (isRebasing ? 'rebase' : isStashConflict ? 'stash' : 'merge')
  const fallback = conflictSideNames(kind)
  let current: InputSource = { path, ref: ':2', title: `Current (${sides?.current ?? fallback.current})` }
  let incoming: InputSource = { path, ref: ':3', title: `Incoming (${sides?.incoming ?? fallback.incoming})` }

  const otherHead = kind === 'rebase' ? 'REBASE_HEAD' : kind === 'merge' ? 'MERGE_HEAD' : kind === 'cherryPick' ? 'CHERRY_PICK_HEAD' : undefined
  if (otherHead) try {
    const [head, rebaseOrMergeHead, oursDiff, theirsDiff] = await Promise.all([
      api.getCommit(root, 'HEAD').then(unwrap),
      api.getCommit(root, otherHead).then(unwrap),
      api.diffBetween(root, otherHead, 'HEAD').then(unwrap),
      api.diffBetween(root, 'HEAD', otherHead).then(unwrap)
    ])

    const oursDiffFile: Change | undefined = oursDiff?.find((diff) => diff.path === path)
    const theirsDiffFile: Change | undefined = theirsDiff?.find((diff) => diff.path === path)

    current = {
      ...current,
      detail: head.refNames.map((s) => s.replace(/^HEAD ->/, '')).join(', '),
      description: '$(git-commit) ' + head.hash.substring(0, 7),
      path: theirsDiffFile ? theirsDiffFile.originalPath : path,
      ref: head.hash
    }

    incoming = {
      ...incoming,
      detail: rebaseOrMergeHead.refNames.join(', '),
      description: '$(git-commit) ' + rebaseOrMergeHead.hash.substring(0, 7),
      path: oursDiffFile ? oursDiffFile.originalPath : path,
      ref: rebaseOrMergeHead.hash
    }
  } catch (error) {
    console.error(`FAILED to read HEAD, ${otherHead} commits`)
    console.error(error)
  }

  const input1 = kind === 'rebase' ? current : incoming
  const input2 = kind === 'rebase' ? incoming : current

  const [base, input1Text, input2Text] = await Promise.all([
    showText(api, root, path, ':1').catch((e) => {
      if (e instanceof MergeEditorLoadError) throw e
      return ''
    }),
    showText(api, root, input1.path, input1.ref),
    showText(api, root, input2.path, input2.ref)
  ])

  return {
    isRebasing,
    base,
    input1: { ...input1, text: input1Text },
    input2: { ...input2, text: input2Text },
    result
  }
}

export function sameSources(a: MergeEditorSources, b: MergeEditorSources): boolean {
  return a.result === b.result && sameInputs(a, b)
}

export function sameInputs(a: MergeEditorSources, b: MergeEditorSources): boolean {
  return a.isRebasing === b.isRebasing
    && a.base === b.base
    && a.input1.text === b.input1.text
    && a.input2.text === b.input2.text
    && a.input1.title === b.input1.title
    && a.input2.title === b.input2.title
    && a.input1.description === b.input1.description
    && a.input2.description === b.input2.description
}

let modelSeq = 0

export class WorkspaceMergeEditorInputModel extends Disposable {
  public readonly isDirty: IObservable<boolean>
  private readonly _isDirty
  private savedAlternativeVersionId: number
  public viewState: unknown
  private users = 0

  constructor(
    public readonly model: MergeEditorModel,
    private readonly disposableStore: DisposableStore,
    savedAlternativeVersionId: number,
    private _sources: MergeEditorSources,
    private readonly writeResult: (content: string) => Promise<void>,
  ) {
    super()
    this.savedAlternativeVersionId = savedAlternativeVersionId
    this._isDirty = observableValue(this, this.computeDirty())
    this.isDirty = this._isDirty
    this._register(this.model.resultTextModel.onDidChangeContent(() => {
      this._isDirty.set(this.computeDirty(), undefined)
    }))
  }

  public acquire(): void {
    this.users++
  }

  public release(): number {
    this.users = Math.max(0, this.users - 1)
    return this.users
  }

  public get inUse(): boolean {
    return this.users > 0
  }

  public get sources(): MergeEditorSources {
    return this._sources
  }

  private computeDirty(): boolean {
    return this.model.resultTextModel.getAlternativeVersionId() !== this.savedAlternativeVersionId
  }

  public override dispose(): void {
    this.disposableStore.dispose()
    super.dispose()
  }

  public async accept(): Promise<void> {
    await this.save()
  }

  async save(): Promise<void> {
    const versionId = this.model.resultTextModel.getAlternativeVersionId()
    const content = this.model.resultTextModel.getValue()
    await this.writeResult(content)
    this._sources = { ...this._sources, result: content }
    this.savedAlternativeVersionId = versionId
    this._isDirty.set(this.computeDirty(), undefined)
  }
}

export async function createWorkspaceMergeEditorInputModel(
  sources: MergeEditorSources,
  path: string,
  writeResult: (content: string) => Promise<void>
): Promise<WorkspaceMergeEditorInputModel> {
  const store = new DisposableStore()
  const seq = ++modelSeq
  const language = languageFromPath(path)
  const create = (scheme: string, text: string): ITextModel =>
    store.add(monaco.editor.createModel(text, language, monaco.Uri.from({ scheme, path: `/${path}`, query: String(seq) })) as ITextModel)

  const base = create('merge-editor-base', sources.base)
  const input1Data: InputData = {
    textModel: create('merge-editor-input1', sources.input1.text),
    title: sources.input1.title,
    description: sources.input1.description,
    detail: sources.input1.detail,
  }
  const input2Data: InputData = {
    textModel: create('merge-editor-input2', sources.input2.text),
    title: sources.input2.title,
    description: sources.input2.description,
    detail: sources.input2.detail,
  }
  const result = create('merge-editor-result', sources.result)
  const savedAlternativeVersionId = result.getAlternativeVersionId()

  const lines = result.getLinesContent()
  const hasConflictMarkers = lines.some((l) => l.startsWith(conflictMarkers.start))
  const resetResult = hasConflictMarkers

  const mergeDiffComputer = new MergeDiffComputer(StandaloneServices.get(IEditorWorkerService))

  const model = new MergeEditorModel(
    base,
    input1Data,
    input2Data,
    result,
    mergeDiffComputer,
    {
      resetResult
    },
    StandaloneServices.get(IUndoRedoService),
  )
  store.add(model)

  try {
    await model.onInitialized
  } catch (error) {
    store.dispose()
    throw error
  }

  return new WorkspaceMergeEditorInputModel(model, store, savedAlternativeVersionId, sources, writeResult)
}

const sessions = new Map<string, Promise<WorkspaceMergeEditorInputModel>>()
censusTrack('mergeEditorInputModel.sessions', sessions)

function sessionKey(root: string, path: string): string {
  return `${root}\u0000${path}`
}

export function getMergeEditorSession(root: string, path: string): Promise<WorkspaceMergeEditorInputModel> | undefined {
  return sessions.get(sessionKey(root, path))
}

export function setMergeEditorSession(root: string, path: string, session: Promise<WorkspaceMergeEditorInputModel>): Promise<WorkspaceMergeEditorInputModel> {
  sessions.set(sessionKey(root, path), session)
  session.catch(() => {
    if (sessions.get(sessionKey(root, path)) === session) {
      sessions.delete(sessionKey(root, path))
    }
  })
  return session
}

export function deleteMergeEditorSession(root: string, path: string, session: Promise<WorkspaceMergeEditorInputModel>): void {
  if (sessions.get(sessionKey(root, path)) === session) {
    sessions.delete(sessionKey(root, path))
  }
}
