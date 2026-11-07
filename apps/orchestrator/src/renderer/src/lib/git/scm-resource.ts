import { ENV_REF, INDEX_REF, Status, WORKTREE_REF, type Change } from '@shared/git-scm'

export function joinPath(root: string, rel: string): string {
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'
  return `${root.replace(/[\\/]+$/, '')}${sep}${sep === '\\' ? rel.replace(/\//g, '\\') : rel}`
}

export function revealLabel(): string {
  const platform = navigator.platform || navigator.userAgent
  if (/Mac/i.test(platform)) return 'Reveal in Finder'
  if (/Win/i.test(platform)) return 'Reveal in File Explorer'
  return 'Open Containing Folder'
}

export const gitDecoration = {
  addedResourceForeground: '#4cc38a',
  modifiedResourceForeground: '#e8a54d',
  deletedResourceForeground: '#ef6e6b',
  renamedResourceForeground: '#4cc38a',
  untrackedResourceForeground: '#4cc38a',
  ignoredResourceForeground: '#6b717b',
  stageModifiedResourceForeground: '#e8a54d',
  stageDeletedResourceForeground: '#ef6e6b',
  conflictingResourceForeground: '#ef6e6b'
}

export function getStatusLetter(type: Status): string {
  switch (type) {
    case Status.INDEX_MODIFIED:
    case Status.MODIFIED:
      return 'M'
    case Status.INDEX_ADDED:
    case Status.INTENT_TO_ADD:
      return 'A'
    case Status.INDEX_DELETED:
    case Status.DELETED:
      return 'D'
    case Status.INDEX_RENAMED:
    case Status.INTENT_TO_RENAME:
      return 'R'
    case Status.TYPE_CHANGED:
      return 'T'
    case Status.UNTRACKED:
      return 'U'
    case Status.IGNORED:
      return 'I'
    case Status.INDEX_COPIED:
      return 'C'
    case Status.BOTH_DELETED:
    case Status.ADDED_BY_US:
    case Status.DELETED_BY_THEM:
    case Status.ADDED_BY_THEM:
    case Status.DELETED_BY_US:
    case Status.BOTH_ADDED:
    case Status.BOTH_MODIFIED:
      return '!'
    default:
      return ''
  }
}

export function getStatusText(type: Status): string {
  switch (type) {
    case Status.INDEX_MODIFIED: return 'Index Modified'
    case Status.MODIFIED: return 'Modified'
    case Status.INDEX_ADDED: return 'Index Added'
    case Status.INDEX_DELETED: return 'Index Deleted'
    case Status.DELETED: return 'Deleted'
    case Status.INDEX_RENAMED: return 'Index Renamed'
    case Status.INDEX_COPIED: return 'Index Copied'
    case Status.UNTRACKED: return 'Untracked'
    case Status.IGNORED: return 'Ignored'
    case Status.INTENT_TO_ADD: return 'Intent to Add'
    case Status.INTENT_TO_RENAME: return 'Intent to Rename'
    case Status.TYPE_CHANGED: return 'Type Changed'
    case Status.BOTH_DELETED: return 'Conflict: Both Deleted'
    case Status.ADDED_BY_US: return 'Conflict: Added By Us'
    case Status.DELETED_BY_THEM: return 'Conflict: Deleted By Them'
    case Status.ADDED_BY_THEM: return 'Conflict: Added By Them'
    case Status.DELETED_BY_US: return 'Conflict: Deleted By Us'
    case Status.BOTH_ADDED: return 'Conflict: Both Added'
    case Status.BOTH_MODIFIED: return 'Conflict: Both Modified'
    default: return ''
  }
}

export function getStatusColor(type: Status): string {
  switch (type) {
    case Status.INDEX_MODIFIED:
      return gitDecoration.stageModifiedResourceForeground
    case Status.MODIFIED:
    case Status.TYPE_CHANGED:
      return gitDecoration.modifiedResourceForeground
    case Status.INDEX_DELETED:
      return gitDecoration.stageDeletedResourceForeground
    case Status.DELETED:
      return gitDecoration.deletedResourceForeground
    case Status.INDEX_ADDED:
    case Status.INTENT_TO_ADD:
      return gitDecoration.addedResourceForeground
    case Status.INDEX_COPIED:
    case Status.INDEX_RENAMED:
    case Status.INTENT_TO_RENAME:
      return gitDecoration.renamedResourceForeground
    case Status.UNTRACKED:
      return gitDecoration.untrackedResourceForeground
    case Status.IGNORED:
      return gitDecoration.ignoredResourceForeground
    default:
      return gitDecoration.conflictingResourceForeground
  }
}

export function getStrikeThrough(type: Status): boolean {
  switch (type) {
    case Status.DELETED:
    case Status.BOTH_DELETED:
    case Status.DELETED_BY_THEM:
    case Status.DELETED_BY_US:
    case Status.INDEX_DELETED:
      return true
    default:
      return false
  }
}

export function resourcePath(change: Change): string {
  if (
    change.renamePath &&
    (change.status === Status.MODIFIED ||
      change.status === Status.DELETED ||
      change.status === Status.INDEX_RENAMED ||
      change.status === Status.INDEX_COPIED ||
      change.status === Status.INTENT_TO_RENAME)
  ) {
    return change.renamePath
  }
  return change.path
}

export interface GitSide {
  readonly path: string
  readonly ref: string
}

export interface DiffSides {
  readonly original?: GitSide
  readonly modified?: GitSide
  readonly title: string
}

function basename(path: string): string {
  const i = path.lastIndexOf('/')
  return i === -1 ? path : path.substring(i + 1)
}

export function getResourceDiffSides(change: Change, indexChanges: readonly Change[]): DiffSides {
  const path = resourcePath(change)
  const inIndex = indexChanges.some((r) => resourcePath(r) === path)
  let original: GitSide | undefined
  let modified: GitSide | undefined

  switch (change.status) {
    case Status.INDEX_MODIFIED:
    case Status.INDEX_RENAMED:
    case Status.INTENT_TO_RENAME:
    case Status.TYPE_CHANGED:
      original = { path: change.originalPath, ref: 'HEAD' }
      break
    case Status.MODIFIED:
      original = { path, ref: inIndex ? INDEX_REF : 'HEAD' }
      break
    case Status.DELETED_BY_US:
    case Status.DELETED_BY_THEM:
      original = { path, ref: ':1' }
      break
  }

  switch (change.status) {
    case Status.INDEX_MODIFIED:
    case Status.INDEX_ADDED:
    case Status.INDEX_COPIED:
    case Status.INDEX_RENAMED:
      modified = { path, ref: INDEX_REF }
      break
    case Status.INDEX_DELETED:
    case Status.DELETED:
      original = { path, ref: 'HEAD' }
      break
    case Status.DELETED_BY_US:
      original = { path, ref: ':3' }
      break
    case Status.DELETED_BY_THEM:
      original = { path, ref: ':2' }
      break
    case Status.MODIFIED:
    case Status.UNTRACKED:
    case Status.IGNORED:
    case Status.INTENT_TO_ADD:
    case Status.INTENT_TO_RENAME:
    case Status.TYPE_CHANGED: {
      const indexStatus = indexChanges.find((r) => resourcePath(r) === path)
      modified = { path: indexStatus?.renamePath ?? path, ref: WORKTREE_REF }
      break
    }
    case Status.BOTH_ADDED:
    case Status.BOTH_MODIFIED:
      modified = { path, ref: WORKTREE_REF }
      break
  }

  return { original, modified, title: getTitle(change) }
}

export function getEnvDiffSides(path: string): DiffSides {
  return {
    original: { path, ref: INDEX_REF },
    modified: { path, ref: ENV_REF },
    title: `${basename(path)} (New Changes Only)`
  }
}

function getTitle(change: Change): string {
  const name = basename(resourcePath(change))

  switch (change.status) {
    case Status.INDEX_MODIFIED:
    case Status.INDEX_RENAMED:
    case Status.INDEX_ADDED:
      return `${name} (Index)`
    case Status.MODIFIED:
    case Status.BOTH_ADDED:
    case Status.BOTH_MODIFIED:
      return `${name} (Working Tree)`
    case Status.INDEX_DELETED:
    case Status.DELETED:
      return `${name} (Deleted)`
    case Status.DELETED_BY_US:
      return `${name} (Theirs)`
    case Status.DELETED_BY_THEM:
      return `${name} (Ours)`
    case Status.UNTRACKED:
      return `${name} (Untracked)`
    case Status.INTENT_TO_ADD:
    case Status.INTENT_TO_RENAME:
      return `${name} (Intent to add)`
    case Status.TYPE_CHANGED:
      return `${name} (Type changed)`
    default:
      return name
  }
}

export function getHistoryChangeDiffSides(change: Change, parentRef: string | undefined, ref: string): DiffSides {
  const name = basename(change.path)
  const original =
    parentRef && change.status !== Status.INDEX_ADDED && change.status !== Status.UNTRACKED
      ? { path: change.originalPath, ref: parentRef }
      : undefined
  const modified = change.status === Status.DELETED || change.status === Status.INDEX_DELETED
    ? undefined
    : { path: change.renamePath ?? change.path, ref }
  const shortRef = ref.substring(0, 8)
  const shortParent = parentRef ? parentRef.substring(0, 8) : ''
  return { original, modified, title: shortParent ? `${name} (${shortParent} ↔ ${shortRef})` : `${name} (${shortRef})` }
}
