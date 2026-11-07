export enum Status {
  INDEX_MODIFIED,
  INDEX_ADDED,
  INDEX_DELETED,
  INDEX_RENAMED,
  INDEX_COPIED,

  MODIFIED,
  DELETED,
  UNTRACKED,
  IGNORED,
  INTENT_TO_ADD,
  INTENT_TO_RENAME,
  TYPE_CHANGED,

  ADDED_BY_US,
  ADDED_BY_THEM,
  DELETED_BY_US,
  DELETED_BY_THEM,
  BOTH_ADDED,
  BOTH_DELETED,
  BOTH_MODIFIED
}

export enum RefType {
  Head,
  RemoteHead,
  Tag
}

export interface Ref {
  readonly type: RefType
  readonly name?: string
  readonly commit?: string
  readonly remote?: string
}

export interface UpstreamRef {
  readonly remote: string
  readonly name: string
  readonly commit?: string
}

export interface Branch extends Ref {
  readonly upstream?: UpstreamRef
  readonly ahead?: number
  readonly behind?: number
}

export interface Remote {
  readonly name: string
  readonly fetchUrl?: string
  readonly pushUrl?: string
  readonly isReadOnly: boolean
}

export interface CommitShortStat {
  readonly files: number
  readonly insertions: number
  readonly deletions: number
}

export interface Commit {
  readonly hash: string
  readonly message: string
  readonly parents: string[]
  readonly authorDate?: number
  readonly authorName?: string
  readonly authorEmail?: string
  readonly commitDate?: number
  readonly refNames: string[]
  readonly shortStat?: CommitShortStat
}

export interface Change {
  readonly path: string
  readonly originalPath: string
  readonly renamePath?: string
  readonly status: Status
}

export interface DiffChange extends Change {
  readonly insertions: number
  readonly deletions: number
}

export interface ScmDiffExplanation {
  readonly oldMode?: string
  readonly newMode?: string
  readonly oldObject?: string
  readonly newObject?: string
  readonly oldTarget?: string
  readonly newTarget?: string
  readonly sameContent?: boolean
  readonly refreshed?: boolean
}

export interface ScmDiffStat {
  readonly path: string
  readonly insertions: number
  readonly deletions: number
  readonly binary: boolean
}

export interface Stash {
  readonly hash: string
  readonly parents: string[]
  readonly index: number
  readonly description: string
  readonly branchName: string
  readonly authorDate?: number
  readonly commitDate?: number
}

export interface ScmStashDetails {
  readonly changes: Change[]
  readonly untracked: string[]
}

export interface ScmStashOptions {
  readonly message?: string
  readonly includeUntracked?: boolean
  readonly staged?: boolean
}

export interface ScmPullOptions {
  readonly rebase: boolean
  readonly autoStash: boolean
  readonly ignoreRebaseWarning?: boolean
}

export interface ScmPushOptions {
  readonly force?: boolean
}

export const MAYBE_REBASED_ERROR = 'MaybeRebased'
export const STALE_CONTENT_ERROR = 'StaleContent'

export interface ScmRepositoryState {
  readonly root: string
  readonly HEAD?: Branch
  readonly refs: Ref[]
  readonly remotes: Remote[]
  readonly stashes: Stash[]
  readonly rebaseCommit?: Commit
  readonly mergeInProgress: boolean
  readonly mergeMessage?: string
  readonly conflictSides?: ScmConflictSides
  readonly mergeChanges: Change[]
  readonly indexChanges: Change[]
  readonly workingTreeChanges: Change[]
  readonly neverCommit: string[]
  readonly envResidual: ScmEnvResidual[]
  readonly envStagedUnsafe: string[]
  readonly isRepositoryHuge?: { readonly limit: number }
}

export type ScmConflictKind = 'merge' | 'squash' | 'rebase' | 'cherryPick' | 'revert' | 'stash' | 'unknown'

export interface ScmConflictSides {
  readonly kind: ScmConflictKind
  readonly current: string
  readonly incoming: string
}

export interface ScmEnvResidual {
  readonly path: string
  readonly conflict: boolean
}

export interface ScmLogOptions {
  readonly refNames: string[]
  readonly maxEntries: number
  readonly skip?: number
  readonly paths?: string[]
  readonly search?: ScmLogSearch
}

export type ScmLogSearchMode = 'hash' | 'message'

export interface ScmLogSearch {
  readonly text: string
  readonly by: ScmLogSearchMode
}

export const INDEX_REF = ':'
export const WORKTREE_REF = ''
export const ENV_REF = '~env'

export type ScmFileContent =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'binary'; readonly size: number }
  | { readonly kind: 'tooLarge'; readonly size: number }
  | { readonly kind: 'missing' }

export type ScmImageContent =
  | { readonly kind: 'image'; readonly mime: string; readonly base64: string; readonly size: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'tooLarge'; readonly size: number }

const IMAGE_MIME_TYPES = new Map<string, string>([
  ['png', 'image/png'],
  ['jpg', 'image/jpeg'],
  ['jpeg', 'image/jpeg'],
  ['gif', 'image/gif'],
  ['webp', 'image/webp'],
  ['bmp', 'image/bmp'],
  ['svg', 'image/svg+xml'],
  ['ico', 'image/x-icon'],
  ['avif', 'image/avif']
])

export function imageMimeType(path: string): string | undefined {
  const name = path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 ? IMAGE_MIME_TYPES.get(name.slice(dot + 1).toLowerCase()) : undefined
}

export interface ScmGitError {
  readonly message: string
  readonly stdout?: string
  readonly stderr?: string
  readonly exitCode?: number
  readonly gitErrorCode?: string
  readonly gitCommand?: string
  readonly gitArgs?: string[]
}

export type ScmResult<T = void> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ScmGitError }

export type ScmRemoteOperation = 'Fetch' | 'Pull' | 'Push'

export interface ScmRemoteProgress {
  readonly operation: ScmRemoteOperation
  readonly text?: string
  readonly percent?: number
  readonly cancelling?: boolean
}

export interface GitScmApi {
  getState(root: string): Promise<ScmResult<ScmRepositoryState>>
  log(root: string, options: ScmLogOptions): Promise<ScmResult<Commit[]>>
  getCommit(root: string, ref: string): Promise<ScmResult<Commit>>
  getMergeBase(root: string, ref1: string, ref2: string): Promise<ScmResult<string | undefined>>
  diffBetweenWithStats(
    root: string,
    ref1: string | undefined,
    ref2: string
  ): Promise<ScmResult<DiffChange[]>>
  diffBetween(root: string, ref1: string | undefined, ref2: string): Promise<ScmResult<Change[]>>
  patch(root: string, path: string, originalPath: string, originalRef: string, modifiedRef: string): Promise<ScmResult<string>>
  explainDiff(
    root: string,
    path: string,
    originalPath: string,
    originalRef: string,
    modifiedRef: string,
    checkContent: boolean
  ): Promise<ScmResult<ScmDiffExplanation>>
  diffStats(
    root: string,
    ref1: string | undefined,
    ref2: string,
    paths: string[]
  ): Promise<ScmResult<ScmDiffStat[]>>
  compareCommits(root: string, ref1: string, ref2: string): Promise<ScmResult<Change[]>>
  compareCommitsStats(root: string, ref1: string, ref2: string, paths: string[]): Promise<ScmResult<ScmDiffStat[]>>
  show(root: string, path: string, ref: string): Promise<ScmResult<ScmFileContent>>
  showImage(root: string, path: string, ref: string): Promise<ScmResult<ScmImageContent>>
  revealInFolder(root: string, path: string): Promise<ScmResult>
  add(root: string, paths: string[]): Promise<ScmResult>
  revert(root: string, paths: string[]): Promise<ScmResult>
  stageContent(root: string, path: string, content: string, unstage?: boolean): Promise<ScmResult>
  discardEnvLines(root: string, path: string, content: string, expected?: string): Promise<ScmResult>
  discardOutsideEnv(root: string, paths: string[]): Promise<ScmResult>
  rm(root: string, paths: string[]): Promise<ScmResult>
  commit(root: string, message: string): Promise<ScmResult>
  fetch(root: string): Promise<ScmResult>
  pull(root: string, options: ScmPullOptions): Promise<ScmResult>
  push(root: string, options?: ScmPushOptions): Promise<ScmResult>
  cancelRemote(root: string): Promise<ScmResult<boolean>>
  rebaseAbort(root: string): Promise<ScmResult>
  clean(root: string, paths: string[]): Promise<ScmResult>
  merge(root: string, ref: string): Promise<ScmResult>
  mergeAbort(root: string): Promise<ScmResult>
  stash(root: string, options: ScmStashOptions): Promise<ScmResult>
  stashApply(root: string, index: number | undefined): Promise<ScmResult>
  stashPop(root: string, index: number | undefined): Promise<ScmResult>
  stashDrop(root: string, index: number | undefined): Promise<ScmResult>
  stashShow(root: string, index: number): Promise<ScmResult<ScmStashDetails>>
  writeFile(root: string, path: string, content: string, expected?: string): Promise<ScmResult>
  trackedPaths(root: string, entries: string[]): Promise<ScmResult<string[]>>
  addToGitignore(root: string, entries: string[], untrack: boolean): Promise<ScmResult<string[]>>
  updateNeverCommit(root: string, change: NeverCommitChange): Promise<ScmResult<string[]>>
  keepEnv(root: string, paths: string[]): Promise<ScmResult>
  getSettings(root: string): Promise<ScmResult<ScmViewSettings>>
  setSettings(root: string, settings: ScmViewSettings): Promise<ScmResult<ScmViewSettings>>
  watch(root: string): Promise<void>
  unwatch(root: string): Promise<void>
  onDidChange(cb: (root: string) => void): () => void
  onRemoteProgress(cb: (root: string, progress: ScmRemoteProgress | null) => void): () => void
}

export const GIT_SETTINGS_FILE = 'git-settings.json'

export type ScmGraphFilter = 'auto' | 'all'

export interface ScmViewSettings {
  readonly diffHideUnchanged: boolean
  readonly diffSideBySide: boolean
  readonly graphFilter: ScmGraphFilter
  readonly pullRebase: boolean
  readonly pullAutoStash: boolean
  readonly confirmForcePush: boolean
}

export const DEFAULT_SCM_VIEW_SETTINGS: ScmViewSettings = {
  diffHideUnchanged: true,
  diffSideBySide: true,
  graphFilter: 'auto',
  pullRebase: true,
  pullAutoStash: true,
  confirmForcePush: true
}

export interface ScmSettingsFile {
  version: 1
  diff: { hideUnchanged: boolean; sideBySide: boolean }
  graph: { filter: ScmGraphFilter }
  pull: { rebase: boolean; autoStash: boolean }
  push: { confirmForce: boolean }
}

function pick<T>(value: unknown, valid: (v: unknown) => v is T, fallback: T): T {
  return valid(value) ? value : fallback
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'
const isFilter = (v: unknown): v is ScmGraphFilter => v === 'auto' || v === 'all'

export function normalizeScmViewSettings(raw: unknown): ScmViewSettings {
  const d = DEFAULT_SCM_VIEW_SETTINGS
  const o = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    diffHideUnchanged: pick(o.diffHideUnchanged, isBool, d.diffHideUnchanged),
    diffSideBySide: pick(o.diffSideBySide, isBool, d.diffSideBySide),
    graphFilter: pick(o.graphFilter, isFilter, d.graphFilter),
    pullRebase: pick(o.pullRebase, isBool, d.pullRebase),
    pullAutoStash: pick(o.pullAutoStash, isBool, d.pullAutoStash),
    confirmForcePush: pick(o.confirmForcePush, isBool, d.confirmForcePush)
  }
}

export function parseScmSettingsFile(raw: string): ScmViewSettings {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return DEFAULT_SCM_VIEW_SETTINGS
  }
  const o = data && typeof data === 'object' && !Array.isArray(data) ? (data as Record<string, unknown>) : {}
  const diff = o.diff && typeof o.diff === 'object' ? (o.diff as Record<string, unknown>) : {}
  const graph = o.graph && typeof o.graph === 'object' ? (o.graph as Record<string, unknown>) : {}
  const pull = o.pull && typeof o.pull === 'object' ? (o.pull as Record<string, unknown>) : {}
  const push = o.push && typeof o.push === 'object' ? (o.push as Record<string, unknown>) : {}
  return normalizeScmViewSettings({
    diffHideUnchanged: diff.hideUnchanged,
    diffSideBySide: diff.sideBySide,
    graphFilter: graph.filter,
    pullRebase: pull.rebase,
    pullAutoStash: pull.autoStash,
    confirmForcePush: push.confirmForce
  })
}

export function toScmSettingsFile(settings: ScmViewSettings): ScmSettingsFile {
  return {
    version: 1,
    diff: { hideUnchanged: settings.diffHideUnchanged, sideBySide: settings.diffSideBySide },
    graph: { filter: settings.graphFilter },
    pull: { rebase: settings.pullRebase, autoStash: settings.pullAutoStash },
    push: { confirmForce: settings.confirmForcePush }
  }
}

export const NEVER_COMMIT_DIR = '.sspace'
export const NEVER_COMMIT_FILE = 'never-commit.json'
export const ENV_BLOB_DIR = 'env'

export interface EnvSnapshot {
  readonly env: string
  readonly base: string
}

export interface NeverCommitChange {
  readonly add?: string[]
  readonly remove?: string[]
}

export interface NeverCommitFile {
  version: 1
  entries: string[]
  snapshots?: Record<string, EnvSnapshot>
}

export function normalizeNeverCommitEntry(raw: string): string {
  let p = raw.replace(/\\/g, '/').trim()
  if (p.endsWith('/')) return ''
  p = p.replace(/^(\.\/)+/, '').replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!p || p === '.' || p.split('/').includes('..')) return ''
  return p
}

export function normalizeNeverCommitEntries(raw: readonly string[]): string[] {
  const out = new Set<string>()
  for (const r of raw) {
    const n = normalizeNeverCommitEntry(r)
    if (n) out.add(n)
  }
  return [...out].sort()
}

export function matchNeverCommit(path: string, entries: readonly string[]): string | undefined {
  const p = path.replace(/\\/g, '/')
  return entries.includes(p) ? p : undefined
}
