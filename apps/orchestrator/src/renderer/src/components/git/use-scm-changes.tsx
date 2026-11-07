import { useEffect, useMemo, useRef, useState } from 'react'
import { ArchiveRestore, EyeOff, FileSymlink, FileText, History, Minus, PackageOpen, Plus, Undo2, X } from 'lucide-react'
import {
  MAYBE_REBASED_ERROR,
  RefType,
  Status,
  WORKTREE_REF,
  matchNeverCommit,
  normalizeNeverCommitEntry,
  type Change,
  type ScmConflictSides,
  type ScmEnvResidual,
  type ScmPullOptions,
  type ScmRepositoryState,
  type ScmResult,
  type ScmStashOptions,
  type ScmViewSettings,
  type Stash
} from '@shared/git-scm'
import { openFileInWorkbench } from '../../lib/editor/open-file'
import { compact as compactNodes, section, type ActionNode } from '../../lib/actions/action-tree'
import { requestChoice, requestConfirm } from '../../lib/confirm/confirm-store'
import { relativeTimeLong } from '../../lib/relative-time'
import { CommitType, acceptAllInText } from '../../lib/editor/merge-conflict/accept-all'
import { conflictSideNames } from '../../lib/git/conflict-sides'
import { joinPath, resourcePath, revealLabel } from '../../lib/git/scm-resource'
import { ResourceTree, countFiles, type IResourceNode } from '../../lib/git/resource-tree'
import type { ScmRepository } from './use-scm-repository'
import { EnvAddIcon, EnvKeepIcon } from './env-icons'

export type GroupId = 'merge' | 'index' | 'workingTree' | 'never' | 'stashes'

export interface Item {
  readonly change?: Change
  readonly entry?: string
  readonly residual?: ScmEnvResidual
}

export type StashPick = 'apply' | 'pop' | 'drop' | 'view'

export type Row =
  | { readonly type: 'group'; readonly id: GroupId; readonly label: string; readonly count: number }
  | {
      readonly type: 'folder'
      readonly group: GroupId
      readonly path: string
      readonly label: string
      readonly depth: number
      readonly collapsed: boolean
      readonly node: IResourceNode<Item>
      readonly count?: number
      readonly stash?: Stash
    }
  | {
      readonly type: 'file'
      readonly group: GroupId
      readonly path: string
      readonly depth: number
      readonly item: Item
      readonly stash?: Stash
    }
  | {
      readonly type: 'more'
      readonly group: GroupId
      readonly path: string
      readonly depth: number
      readonly remaining: number
      readonly stash?: Stash
    }
  | { readonly type: 'neverAdd' }
  | { readonly type: 'empty'; readonly text: string; readonly depth?: number }
  | { readonly type: 'stash'; readonly stash: Stash; readonly expanded: boolean }

export type MenuRow = Extract<Row, { type: 'folder' } | { type: 'file' }>

const CONFLICT_MARKERS = /^<{7}\s|^={7}$|^>{7}\s/m

const CONFLICT_WARNINGS = new Map<string, string>([
  ['Conflict', 'There are merge conflicts. Please resolve them before committing your changes.'],
  ['StashConflict', 'There are merge conflicts while applying the stash. Please resolve them before committing your changes.']
])

export function basename(path: string): string {
  return path.substring(path.lastIndexOf('/') + 1)
}

export function stashLabel(stash: Stash): string {
  return `#${stash.index}: ${stash.description}`
}

export function stashDescription(stash: Stash): string | undefined {
  if (!stash.commitDate && !stash.branchName) return undefined
  const segments: string[] = []
  if (stash.commitDate) segments.push(relativeTimeLong(stash.commitDate))
  if (stash.branchName) segments.push(stash.branchName)
  return segments.join(' • ')
}

export function isBothAddedOrModified(change: Change): boolean {
  return change.status === Status.BOTH_MODIFIED || change.status === Status.BOTH_ADDED
}

function isAnyDeleted(change: Change): boolean {
  return change.status === Status.DELETED_BY_THEM || change.status === Status.DELETED_BY_US
}

export function canOpenFile(change: Change | undefined): boolean {
  return !!change && change.status !== Status.DELETED && change.status !== Status.INDEX_DELETED
}

export function groupPaths(targets: readonly MenuRow[], groups: readonly GroupId[]): string[] {
  const out = new Set<string>()
  for (const t of targets) {
    if (!groups.includes(t.group)) continue
    if (t.type === 'folder') for (const p of collectPaths(t.node)) out.add(p)
    else if (t.item.change) out.add(resourcePath(t.item.change))
  }
  return [...out]
}

function residualPaths(targets: readonly MenuRow[]): string[] {
  const out = new Set<string>()
  for (const t of targets) {
    if (t.group !== 'workingTree') continue
    for (const item of t.type === 'folder' ? ResourceTree.collect(t.node) : [t.item]) {
      if (item.residual && item.change) out.add(resourcePath(item.change))
    }
  }
  return [...out]
}

export function neverTargetEntries(targets: readonly MenuRow[]): string[] {
  const out = new Set<string>()
  for (const t of targets) {
    if (t.group !== 'never') continue
    if (t.type === 'folder') for (const e of neverEntriesIn(t.node)) out.add(e)
    else if (t.item.entry) out.add(t.item.entry)
  }
  return [...out]
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`
}

function ancestorFolders(path: string): string[] {
  const parts = path.split('/')
  const out: string[] = []
  for (let i = parts.length - 1; i >= 1; i--) out.push(`${parts.slice(0, i).join('/')}/`)
  return out
}

export function collectPaths(node: IResourceNode<Item>): string[] {
  return ResourceTree.collect(node)
    .map((item) => (item.change ? resourcePath(item.change) : undefined))
    .filter((p): p is string => !!p)
}

function neverEntriesIn(node: IResourceNode<Item>): string[] {
  return ResourceTree.collect(node)
    .map((item) => item.entry)
    .filter((e): e is string => !!e)
}

export function useScmCommitMessage(state: ScmRepositoryState | null): [string, (value: string | ((prev: string) => string)) => void] {
  const [message, setMessage] = useState('')
  const rebaseCommit = state?.rebaseCommit
  const mergeMessage = state?.mergeMessage

  const lastRebase = useRef<string | undefined>(undefined)
  useEffect(() => {
    const hash = rebaseCommit?.hash
    if (lastRebase.current && !hash) setMessage('')
    else if (hash && hash !== lastRebase.current) setMessage(rebaseCommit.message)
    lastRebase.current = hash
  }, [rebaseCommit])

  const lastTemplate = useRef<string | undefined>(undefined)
  useEffect(() => {
    const previous = lastTemplate.current
    lastTemplate.current = mergeMessage
    if (mergeMessage === previous) return
    setMessage((current) => (!current || current === previous ? (mergeMessage ?? '') : current))
  }, [mergeMessage])

  return [message, setMessage]
}

export function useScmChanges(repo: ScmRepository, settings: ScmViewSettings, onSettings: (patch: Partial<ScmViewSettings>) => void) {
  const { api, root, state, busy, run, operationError } = repo
  const opErrorRef = useRef('')
  opErrorRef.current = operationError?.error.message ?? ''

  const neverCommit = state?.neverCommit ?? []
  const envUnsafe = useMemo(() => new Set(state?.envStagedUnsafe ?? []), [state])
  const stashes = useMemo(() => state?.stashes ?? [], [state])
  const rebaseCommit = state?.rebaseCommit
  const mergeInProgress = state?.mergeInProgress ?? false

  const groups = useMemo(() => {
    const merge = state?.mergeChanges ?? []
    const index = state?.indexChanges ?? []
    const residual = new Map((state?.envResidual ?? []).map((r) => [r.path, r]))
    const workingTree: Change[] = []
    const neverMatches = new Map<string, Change[]>()
    for (const entry of neverCommit) neverMatches.set(entry, [])
    for (const change of state?.workingTreeChanges ?? []) {
      const path = resourcePath(change)
      const entry = matchNeverCommit(path, neverCommit)
      if (entry) neverMatches.get(entry)?.push(change)
      if (!entry || residual.has(path)) workingTree.push(change)
    }

    const build = (changes: readonly Change[], flagNever: boolean): ResourceTree<Item> => {
      const tree = new ResourceTree<Item>()
      for (const change of changes) {
        const path = resourcePath(change)
        tree.add(path, flagNever ? { change, entry: matchNeverCommit(path, neverCommit), residual: residual.get(path) } : { change })
      }
      return tree
    }

    const neverTree = new ResourceTree<Item>()
    let neverCount = 0
    for (const entry of neverCommit) {
      const change = neverMatches.get(entry)?.[0]
      neverTree.add(entry, { change, entry })
      if (change) neverCount++
    }

    const trees = {
      merge: build(merge, false),
      index: build(index, true),
      workingTree: build(workingTree, true),
      never: neverTree
    } satisfies Record<Exclude<GroupId, 'stashes'>, ResourceTree<Item>>

    return {
      merge,
      index,
      workingTree,
      neverMatches,
      neverCount,
      trees,
      counts: {
        merge: countFiles(trees.merge.root),
        index: countFiles(trees.index.root),
        workingTree: countFiles(trees.workingTree.root),
        never: countFiles(trees.never.root)
      } satisfies Record<Exclude<GroupId, 'stashes'>, Map<string, number>>
    }
  }, [state, neverCommit])

  const mergeByPath = useMemo(() => new Map((state?.mergeChanges ?? []).map((c) => [resourcePath(c), c])), [state])

  const hasConflictMarkers = async (path: string): Promise<boolean> => {
    const result = await api.show(root, path, WORKTREE_REF)
    return result.ok && result.value.kind === 'text' && CONFLICT_MARKERS.test(result.value.text)
  }

  const stageDeletionConflict = async (change: Change): Promise<boolean> => {
    const name = basename(resourcePath(change))
    const byThem = change.status === Status.DELETED_BY_THEM
    const choice = await requestChoice({
      title: 'Merge Conflict',
      message: byThem
        ? `File "${name}" was deleted by them and modified by us.\n\nWhat would you like to do?`
        : `File "${name}" was deleted by us and modified by them.\n\nWhat would you like to do?`,
      confirmLabel: byThem ? 'Keep Our Version' : 'Keep Their Version',
      secondaryLabel: 'Delete File',
      danger: false
    })
    if (choice === 'cancel') return false
    const path = resourcePath(change)
    return choice === 'confirm'
      ? run('Stage', () => api.add(root, [path]), [path])
      : run('Stage', () => api.rm(root, [path]), [path])
  }

  const stage = async (paths: string[], all = false): Promise<boolean> => {
    const merge = paths.map((p) => mergeByPath.get(p)).filter((c): c is Change => !!c)
    if (merge.length === 0) return run('Stage', () => api.add(root, paths), paths)
    const possibleUnresolved = merge.filter(isBothAddedOrModified)
    const markers = await Promise.all(possibleUnresolved.map((c) => hasConflictMarkers(resourcePath(c))))
    const deletionConflicts = merge.filter(isAnyDeleted)
    const unresolved = [
      ...merge.filter((c) => !isBothAddedOrModified(c) && !isAnyDeleted(c)),
      ...possibleUnresolved.filter((_c, i) => markers[i])
    ]
    const confirmUnresolved = async (): Promise<boolean> => {
      if (unresolved.length === 0) return true
      const count = all ? merge.length : unresolved.length
      const first = all ? merge[0] : unresolved[0]
      return requestConfirm({
        title: 'Merge Conflicts',
        message:
          unresolved.length > 1
            ? `Are you sure you want to stage ${count} files with merge conflicts?`
            : `Are you sure you want to stage ${basename(resourcePath(first))} with merge conflicts?`,
        confirmLabel: 'Yes',
        danger: false
      })
    }
    if (!all && !(await confirmUnresolved())) return false
    for (const change of deletionConflicts) {
      if (!(await stageDeletionConflict(change))) return false
    }
    if (all && !(await confirmUnresolved())) return false
    const deleted = new Set(deletionConflicts.map(resourcePath))
    const rest = paths.filter((p) => all || !deleted.has(p))
    return rest.length > 0 ? run('Stage', () => api.add(root, rest), rest) : true
  }
  const unstage = (paths: string[]): Promise<boolean> => run('Unstage', () => api.revert(root, paths), paths)

  const pendingPaths = useMemo(() => new Set(repo.progress.flatMap((p) => p.paths)), [repo.progress])

  const discardable = useMemo(() => {
    const map = new Map(groups.workingTree.map((c) => [resourcePath(c), c]))
    for (const list of groups.neverMatches.values()) for (const c of list) map.set(resourcePath(c), c)
    return map
  }, [groups])

  const discard = async (paths: string[], wholeEnv: string[] = []): Promise<boolean> => {
    const whole = new Set(wholeEnv)
    const residual = new Set((state?.envResidual ?? []).map((r) => r.path))
    const picked = Array.from(new Set([...paths, ...wholeEnv]))
      .map((p) => discardable.get(p))
      .filter((c): c is Change => !!c)
    const outside = picked.filter((c) => residual.has(resourcePath(c)) && !whole.has(resourcePath(c))).map(resourcePath)
    let resources = picked.filter((c) => !outside.includes(resourcePath(c)))
    const discardOutside = (): Promise<ScmResult> =>
      outside.length > 0 ? api.discardOutsideEnv(root, outside) : Promise.resolve({ ok: true, value: undefined })
    if (resources.length === 0) {
      if (outside.length === 0) return false
      const ok = await requestConfirm({
        title: 'Discard Changes',
        message:
          outside.length === 1
            ? `Discard the changes outside your env edits in "${basename(outside[0])}"? Your env edits stay. You can't undo this.`
            : `Discard the changes outside your env edits in ${outside.length} files? Your env edits stay. You can't undo this.`,
        items: outside.length > 1 ? outside : undefined,
        confirmLabel: outside.length === 1 ? 'Discard' : `Discard ${outside.length} Files`
      })
      return ok ? run('Discard', discardOutside, outside) : false
    }
    const isUntracked = (c: Change): boolean => c.status === Status.UNTRACKED || c.status === Status.IGNORED
    const tracked = resources.filter((c) => !isUntracked(c))
    const untracked = resources.filter(isUntracked)
    const name = (c: Change): string => basename(resourcePath(c))
    const n = resources.length
    const rootPrefix = `${root.replace(/\/+$/, '')}/`
    const relative = (p: string): string => (p.startsWith(rootPrefix) ? p.slice(rootPrefix.length) : p)
    const listOf = (list: Change[]): string[] | undefined =>
      list.length > 1 ? list.map((c) => relative(resourcePath(c))) : undefined
    const envFiles = resources.filter((c) => !!matchNeverCommit(resourcePath(c), neverCommit))
    const envNote =
      envFiles.length === 0
        ? ''
        : n === 1
          ? '\n\nThis also drops your env edits in this file.'
          : envFiles.length === 1
            ? `\n\nThis also drops your env edits in "${name(envFiles[0])}".`
            : `\n\nThis also drops your env edits in ${envFiles.length} env files.`
    const outsideNote =
      outside.length === 0
        ? ''
        : outside.length === 1
          ? `\n\nIn "${basename(outside[0])}" only the changes outside your env edits are discarded. Your env edits stay.`
          : `\n\nIn ${outside.length} env files only the changes outside your env edits are discarded. Your env edits stay.`

    if (untracked.length === 0) {
      const allDeleted = resources.every((c) => c.status === Status.DELETED)
      const ok = await requestConfirm({
        title: allDeleted ? 'Restore Files' : 'Discard Changes',
        message:
          n === 1
            ? allDeleted
              ? `Restore "${name(resources[0])}"?`
              : `Discard changes in "${name(resources[0])}"? You can't undo this.${envNote}${outsideNote}`
            : allDeleted
              ? `Restore all ${n} files?`
              : `Discard all changes in ${n} files? You can't undo this.${envNote}${outsideNote}`,
        items: listOf(resources),
        confirmLabel: n === 1 ? (allDeleted ? 'Restore File' : 'Discard File') : allDeleted ? `Restore All ${n} Files` : `Discard All ${n} Files`
      })
      if (!ok) return false
    } else if (n === 1) {
      const ok = await requestConfirm({
        title: 'Move to Trash',
        message: `Move the untracked file "${name(resources[0])}" to the Trash?${envNote}${outsideNote}`,
        confirmLabel: 'Move to Trash'
      })
      if (!ok) return false
    } else if (tracked.length === 0) {
      const ok = await requestConfirm({
        title: 'Move to Trash',
        message: `Move ${n} untracked files to the Trash?${envNote}${outsideNote}`,
        items: listOf(resources),
        confirmLabel: `Move ${n} Files to Trash`
      })
      if (!ok) return false
    } else {
      const untrackedMessage =
        untracked.length === 1
          ? `The untracked file "${name(untracked[0])}" goes to the Trash.`
          : `${untracked.length} untracked files go to the Trash.`
      const trackedMessage =
        tracked.length === 1
          ? `Discard changes in "${name(tracked[0])}"?`
          : `Discard all changes in ${tracked.length} files?`
      const choice = await requestChoice({
        title: 'Discard Changes',
        message: `${untrackedMessage}\n\n${trackedMessage} You can't undo this.${envNote}${outsideNote}`,
        items: resources.map((c) => relative(resourcePath(c))),
        confirmLabel: `Discard All ${n} Files`,
        secondaryLabel: tracked.length === 1 ? 'Discard 1 Tracked File' : `Discard ${tracked.length} Tracked Files`
      })
      if (choice === 'cancel') return false
      if (choice === 'secondary') resources = tracked
    }

    const targets = resources.map(resourcePath)
    return run(
      'Discard',
      async (): Promise<ScmResult> => {
        const result = await discardOutside()
        return result.ok ? api.clean(root, targets) : result
      },
      [...outside, ...targets]
    )
  }

  const pull = (options: Omit<ScmPullOptions, 'ignoreRebaseWarning'>): Promise<boolean> =>
    run('Pull', async (): Promise<ScmResult> => {
      const result = await api.pull(root, options)
      if (result.ok || result.error.gitErrorCode !== MAYBE_REBASED_ERROR) return result
      const ok = await requestConfirm({
        title: 'Pull',
        message: result.error.message,
        confirmLabel: 'Pull',
        cancelLabel: "Don't Pull",
        danger: false
      })
      return ok ? api.pull(root, { ...options, ignoreRebaseWarning: true }) : { ok: true, value: undefined }
    })
  const forcePush = async (): Promise<boolean> => {
    if (settings.confirmForcePush) {
      const choice = await requestChoice({
        title: 'Force Push',
        message: 'You are about to force push your changes. This can be destructive and could overwrite changes made by others.\n\nAre you sure you want to continue?',
        confirmLabel: 'OK',
        secondaryLabel: "OK, Don't Ask Again"
      })
      if (choice === 'cancel') return false
      if (choice === 'secondary') onSettings({ confirmForcePush: false })
    }
    return run('Push', () => api.push(root, { force: true }))
  }
  const pullDefault = (): Promise<boolean> => pull({ rebase: settings.pullRebase, autoStash: settings.pullAutoStash })
  const push = (): Promise<boolean> => run('Push', () => api.push(root))
  const fetch = (): Promise<boolean> => run('Fetch', () => api.fetch(root))

  const createStash = (options: ScmStashOptions): Promise<boolean> => run('Stash', () => api.stash(root, options))
  const applyStash = (stash?: Stash): Promise<boolean> => run('Stash', () => api.stashApply(root, stash?.index))
  const popStash = (stash?: Stash): Promise<boolean> => run('Stash', () => api.stashPop(root, stash?.index))
  const dropStash = async (stash: Stash): Promise<boolean> => {
    const ok = await requestConfirm({
      title: 'Delete Stash',
      message: `Delete the stash "${stash.description}"? You can't undo this.`,
      confirmLabel: 'Delete'
    })
    return ok ? run('Stash', () => api.stashDrop(root, stash.index)) : false
  }
  const dropAllStashes = async (): Promise<boolean> => {
    if (stashes.length === 0) return run('Stash', () => api.stashDrop(root, undefined))
    const ok = await requestConfirm({
      title: 'Delete All Stashes',
      message:
        stashes.length === 1
          ? "Delete the only stash? You can't undo this."
          : `Delete all ${stashes.length} stashes? You can't undo this.`,
      confirmLabel: 'Delete All'
    })
    return ok ? run('Stash', () => api.stashDrop(root, undefined)) : false
  }
  const acceptAll = (paths: string[], type: CommitType): Promise<boolean> =>
    run('Merge', async (): Promise<ScmResult> => {
      const resolved: string[] = []
      for (const path of paths) {
        const shown = await api.show(root, path, WORKTREE_REF)
        if (!shown.ok) return shown
        if (shown.value.kind !== 'text') continue
        const next = acceptAllInText(shown.value.text, type)
        if (next === undefined) continue
        const written = await api.writeFile(root, path, next, shown.value.text)
        if (!written.ok) return written
        resolved.push(path)
      }
      return resolved.length > 0 ? api.add(root, resolved) : { ok: true, value: undefined }
    }, paths)
  const ignore = async (entries: string[]): Promise<boolean> => {
    const tracked = await api.trackedPaths(root, entries)
    if (!tracked.ok) return run('Ignore', async () => tracked)
    let untrack = false
    if (tracked.value.length > 0) {
      const n = tracked.value.length
      const choice = await requestChoice({
        title: 'Add to .gitignore',
        message: `${n === 1 ? `"${basename(tracked.value[0])}" is` : `${n} files are`} already tracked by git, so .gitignore alone won't hide ${n === 1 ? 'it' : 'them'}. Stop tracking ${n === 1 ? 'it' : 'them'}? Files stay on disk; the next commit removes them from the repository.`,
        items: n > 1 ? tracked.value : undefined,
        confirmLabel: 'Ignore and Stop Tracking',
        secondaryLabel: 'Only Add to .gitignore',
        danger: false
      })
      if (choice === 'cancel') return false
      untrack = choice === 'confirm'
    }
    return run('Ignore', () => api.addToGitignore(root, entries, untrack), entries.map((e) => e.replace(/\/$/, '')))
  }
  const abortRebase = (): Promise<boolean> => run('Abort', () => api.rebaseAbort(root))
  const abortMerge = (): Promise<boolean> => run('Abort', () => api.mergeAbort(root))
  const addNever = (paths: string[]): Promise<boolean> => {
    const add = paths.map(normalizeNeverCommitEntry).filter((p) => p)
    if (add.length === 0) return Promise.resolve(false)
    return run('NeverCommit', () => api.updateNeverCommit(root, { add }))
  }
  const keepEnv = (paths: string[]): Promise<boolean> =>
    paths.length > 0 ? run('NeverCommit', () => api.keepEnv(root, paths), paths) : Promise.resolve(false)
  const removeNever = (paths: string[]): Promise<boolean> => {
    if (paths.length === 0) return Promise.resolve(false)
    return run('NeverCommit', () => api.updateNeverCommit(root, { remove: paths }))
  }
  const stagedSet = useMemo(() => new Set((state?.indexChanges ?? []).map(resourcePath)), [state])
  const isStaged = (p: string): boolean => stagedSet.has(p)
  const unsafeSet = useMemo(() => new Set(state?.envStagedUnsafe ?? []), [state])
  const isEnvUnsafe = (p: string): boolean => unsafeSet.has(p)
  const unstaged = (paths: string[]): string[] => paths.filter((p) => !stagedSet.has(p))
  const changedUnder = (folder: string): string[] =>
    groups.workingTree.map(resourcePath).filter((p) => p.startsWith(folder) && !matchNeverCommit(p, neverCommit))
  const addTyped = (value: string): void => {
    const n = normalizeNeverCommitEntry(value.replace(/[\\/]+$/, ''))
    if (!n) return
    const inside = changedUnder(`${n}/`)
    void addNever(inside.length > 0 ? inside : [n])
  }

  const stagedCount = state?.indexChanges.length ?? 0
  const rebasing = !!rebaseCommit
  const continuing = rebasing || mergeInProgress
  const unresolvedConflicts = groups.merge.length > 0
  const canCommit = (text: string): boolean =>
    !!state && busy === null && (stagedCount > 0 || (continuing && !unresolvedConflicts)) && text.trim().length > 0

  const commitText = async (text: string, beforeRun?: () => void): Promise<boolean> => {
    if (!state || !canCommit(text)) return false
    const staged = state.indexChanges
    const neverStaged = staged.filter((c) => envUnsafe.has(resourcePath(c)))
    if (neverStaged.length > 0) {
      const all = neverStaged.length === staged.length
      const one = neverStaged.length === 1
      const ok = await requestConfirm({
        title: 'Env edits are staged',
        message: all
          ? one
            ? 'The staged file still has env edits. Unstage it?'
            : `All ${staged.length} staged files still have env edits. Unstage them?`
          : `${neverStaged.length} of the staged files still ${one ? 'has' : 'have'} env edits. Unstage ${one ? 'it' : 'those'} and commit the rest?`,
        confirmLabel: all ? 'Unstage' : 'Unstage and Commit'
      })
      if (!ok || !(await unstage(neverStaged.map(resourcePath))) || all) return false
    }
    beforeRun?.()
    return run('Commit', () => api.commit(root, text))
  }

  const conflictWarning = operationError?.error.gitErrorCode ? CONFLICT_WARNINGS.get(operationError.error.gitErrorCode) : undefined

  const HEAD = state?.HEAD
  const branchLabel = HEAD
    ? HEAD.type === RefType.Head && HEAD.name
      ? HEAD.name
      : (HEAD.name ?? HEAD.commit?.substring(0, 8) ?? 'HEAD')
    : ''
  const headLabel = rebasing ? `${branchLabel} (Rebasing)` : branchLabel
  const ahead = HEAD?.ahead ?? 0
  const behind = HEAD?.behind ?? 0

  const must = (label: string, p: Promise<boolean>) => async (): Promise<void> => {
    if (!(await p)) throw new Error(opErrorRef.current ? `${label} failed: ${opErrorRef.current}` : `${label} failed`)
  }
  const idle = busy === null
  const pushTitle = HEAD?.upstream ? (ahead ? `Push (${ahead} outgoing)` : 'Push') : 'Publish Branch'
  const pullTitle = settings.pullRebase ? 'Pull (Rebase)' : 'Pull'
  const syncChanges = async (): Promise<void> => {
    await must('Pull', pullDefault())()
    await must('Push', push())()
  }
  const branchNodes = (copy: (text: string, x: number, y: number) => void): ActionNode[] =>
    compactNodes([
      section('sync', [
        !!HEAD?.upstream && { id: 'scm.branch.sync', label: 'Sync Changes', hint: `${behind}↓ ${ahead}↑`, icon: 'arrow.triangle.2.circlepath', enabled: idle, run: syncChanges },
        { id: 'scm.branch.pull', label: behind ? `${pullTitle} (${behind} incoming)` : pullTitle, icon: 'arrow.down', enabled: idle, run: () => must('Pull', pullDefault())() },
        { id: 'scm.branch.push', label: pushTitle, icon: 'arrow.up', enabled: idle, run: () => must('Push', push())() },
        { id: 'scm.branch.fetch', label: 'Fetch', icon: 'icloud.and.arrow.down', enabled: idle, run: () => must('Fetch', fetch())() }
      ]),
      section('branch', [
        rebasing && { id: 'scm.branch.abortRebase', label: 'Abort Rebase', icon: 'xmark.circle', destructive: true, run: () => must('Abort', abortRebase())() },
        mergeInProgress && { id: 'scm.branch.abortMerge', label: 'Abort Merge', icon: 'xmark.circle', destructive: true, run: () => must('Abort', abortMerge())() },
        !!HEAD?.name && { id: 'scm.branch.copyName', label: 'Copy Branch Name', icon: 'doc.on.doc', run: (_v?: string, at?: { x: number; y: number }) => copy(HEAD?.name ?? '', at?.x ?? 0, at?.y ?? 0) },
        !!HEAD?.upstream && { id: 'scm.branch.copyUpstream', label: 'Copy Upstream Name', icon: 'doc.on.clipboard', run: (_v?: string, at?: { x: number; y: number }) => copy(`${HEAD?.upstream?.remote}/${HEAD?.upstream?.name}`, at?.x ?? 0, at?.y ?? 0) }
      ], branchLabel)
    ])
  const pullOptionsNode = (): ActionNode => ({
    id: 'scm.pullOptions',
    label: 'Pull options',
    icon: 'slider.horizontal.3',
    enabled: idle,
    children: [
      { id: 'scm.pullOptions.rebase', label: 'Rebase instead of merge', checked: settings.pullRebase, run: () => onSettings({ pullRebase: !settings.pullRebase }) },
      { id: 'scm.pullOptions.autostash', label: 'Stash and reapply local changes', checked: settings.pullAutoStash, run: () => onSettings({ pullAutoStash: !settings.pullAutoStash }) }
    ]
  })
  const pushOptionsNode = (): ActionNode => ({ id: 'scm.pushOptions', label: 'Push options', icon: 'arrow.up.circle', enabled: idle, children: [{ id: 'scm.pushOptions.force', label: 'Force Push', hint: '--force-with-lease', destructive: true, run: () => void forcePush() }] })
  const panelNodes = (o: {
    detailOpen: boolean
    message: string
    commit: (value?: string) => Promise<boolean>
    onAddEnvInline: () => void
    more: ActionNode[]
  }): ActionNode[] =>
    compactNodes([
      section('commit', [
        {
          id: 'scm.commit',
          label: continuing ? 'Continue' : stagedCount > 0 ? `Commit ${plural(stagedCount, 'file')}` : 'Commit',
          icon: 'checkmark',
          primary: !o.detailOpen,
          enabled: !!state && idle && (stagedCount > 0 || (continuing && !unresolvedConflicts)),
          input: { title: continuing ? 'Continue' : 'Commit', message: branchLabel ? `On "${branchLabel}"` : undefined, placeholder: 'Message', initial: o.message, submit: 'Commit' },
          shortcut: 'mod+enter',
          run: async (value) => {
            if (!(await o.commit(value))) throw new Error(value !== undefined && !value.trim() ? 'Write a commit message' : opErrorRef.current ? `Commit failed: ${opErrorRef.current}` : 'Commit failed')
          }
        }
      ]),
      section('toolbar', [
        { id: 'scm.toolbar.pull', label: behind ? `${pullTitle} (${behind} incoming)` : pullTitle, icon: 'arrow.down', primary: !o.detailOpen, enabled: idle, run: () => must('Pull', pullDefault())() },
        { id: 'scm.toolbar.push', label: pushTitle, icon: 'arrow.up', primary: !o.detailOpen, enabled: idle, run: () => must('Push', push())() },
        { id: 'scm.toolbar.fetch', label: 'Fetch', icon: 'icloud.and.arrow.down', enabled: idle, run: () => must('Fetch', fetch())() },
        { id: 'scm.toolbar.refresh', label: 'Refresh', icon: 'arrow.clockwise', run: () => repo.refresh() },
        pullOptionsNode(),
        pushOptionsNode()
      ]),
      section('groups', [
        groups.index.length > 0 && { id: 'scm.group.unstageAll', label: 'Unstage All Changes', icon: 'minus.circle', run: () => must('Unstage', unstage(groups.index.map(resourcePath)))() },
        groups.workingTree.length > 0 && { id: 'scm.group.stageAll', label: 'Stage All Changes', icon: 'plus.circle', run: () => must('Stage', stage(groups.workingTree.map(resourcePath)))() },
        groups.workingTree.length > 0 && { id: 'scm.group.discardAll', label: 'Discard All Changes', icon: 'arrow.uturn.backward.circle', destructive: true, run: () => must('Discard', discard(groups.workingTree.map(resourcePath)))() },
        groups.merge.length > 0 && { id: 'scm.group.stageMerge', label: 'Stage All Merge Changes', icon: 'plus.circle.fill', run: () => must('Stage', stage(groups.merge.map(resourcePath), true))() },
        { id: 'scm.group.addEnv', label: 'Add a file', icon: 'leaf', input: { title: 'Env Changes', message: 'Commits made here leave these files out.', placeholder: 'path/to/file', submit: 'Add' }, run: (v) => (v === undefined ? o.onAddEnvInline() : must('Env Changes', addNever([v]))()) }
      ]),
      { id: 'scm.more', label: 'More Actions...', icon: 'ellipsis.circle', children: o.more }
    ])

  return {
    neverCommit,
    envUnsafe,
    stashes,
    rebaseCommit,
    mergeInProgress,
    groups,
    mergeByPath,
    pendingPaths,
    discardable,
    stage,
    unstage,
    discard,
    pull,
    pullDefault,
    push,
    fetch,
    forcePush,
    createStash,
    applyStash,
    popStash,
    dropStash,
    dropAllStashes,
    acceptAll,
    ignore,
    abortRebase,
    abortMerge,
    addNever,
    keepEnv,
    removeNever,
    isStaged,
    isEnvUnsafe,
    unstaged,
    changedUnder,
    addTyped,
    stagedCount,
    rebasing,
    continuing,
    unresolvedConflicts,
    canCommit,
    commitText,
    conflictWarning,
    HEAD,
    branchLabel,
    headLabel,
    ahead,
    behind,
    must,
    idle,
    pushTitle,
    pullTitle,
    syncChanges,
    branchNodes,
    pullOptionsNode,
    pushOptionsNode,
    panelNodes
  }
}

export type ScmChanges = ReturnType<typeof useScmChanges>

export const STASH_INPUT = { title: 'Stash message', message: 'Optionally provide a stash message', placeholder: 'Stash message', submit: 'Stash' }

export function stashCreateNodes(onStash: (options: Omit<ScmStashOptions, 'message'>, message?: string) => void, order: 'scm' | 'repositories'): ActionNode[] {
  const stash: ActionNode = { id: 'scm.stash', label: 'Stash Changes', hint: 'stash', icon: 'archivebox', input: STASH_INPUT, run: (v) => onStash({}, v) }
  const untracked: ActionNode = { id: 'scm.stash.untracked', label: 'Stash Changes and New Files', hint: 'stash -u', icon: 'archivebox.fill', input: STASH_INPUT, run: (v) => onStash({ includeUntracked: true }, v) }
  const staged: ActionNode = { id: 'scm.stash.staged', label: 'Stash Only Staged Changes', hint: 'stash -S', icon: 'tray.and.arrow.down', input: STASH_INPUT, run: (v) => onStash({ staged: true }, v) }
  return order === 'scm' ? [stash, untracked, staged] : [section('stash', [stash]), section('stash2', [staged, untracked])]
}

export function moreActionNodes({
  rebasing,
  mergeInProgress,
  onPull,
  onPullRebase,
  onPush,
  onForcePush,
  onFetch,
  onAbortRebase,
  onAbortMerge,
  onStash,
  onApplyLatest,
  onPopLatest,
  onDropAll,
  onPick,
  stashes
}: {
  rebasing: boolean
  mergeInProgress: boolean
  onPull: () => void
  onPullRebase: () => void
  onPush: () => void
  onForcePush: () => void
  onFetch: () => void
  onAbortRebase: () => void
  onAbortMerge: () => void
  onStash: (options: Omit<ScmStashOptions, 'message'>, message?: string) => void
  onApplyLatest: () => void
  onPopLatest: () => void
  onDropAll: () => void
  onPick: (kind: StashPick, stash?: Stash) => void
  stashes: Stash[]
}): ActionNode[] {
  const pickNode = (kind: StashPick, id: string, label: string, hint: string, icon: string): ActionNode => ({
    id,
    label,
    hint,
    icon,
    expand: () => onPick(kind),
    children: stashes.length
      ? stashes.map((st) => ({ id: `${id}:${st.hash}`, label: stashLabel(st), hint: stashDescription(st), run: () => onPick(kind, st) }))
      : [{ id: `${id}:none`, label: 'This repository has no stashes.', enabled: false }]
  })
  return compactNodes([
    section('sync', [
      { id: 'scm.pull', label: 'Pull', icon: 'arrow.down', run: onPull },
      { id: 'scm.pullRebase', label: 'Pull (Rebase)', icon: 'arrow.down.to.line', run: onPullRebase },
      { id: 'scm.push', label: 'Push', icon: 'arrow.up', run: onPush },
      { id: 'scm.forcePush', label: 'Force Push', hint: '--force-with-lease', icon: 'exclamationmark.arrow.triangle.2.circlepath', destructive: true, run: onForcePush },
      { id: 'scm.fetch', label: 'Fetch', icon: 'icloud.and.arrow.down', run: onFetch }
    ]),
    (rebasing || mergeInProgress) &&
      section(
        'commit',
        [
          rebasing && { id: 'scm.abortRebase', label: 'Abort Rebase', icon: 'xmark.circle', destructive: true, run: onAbortRebase },
          mergeInProgress && { id: 'scm.abortMerge', label: 'Abort Merge', icon: 'xmark.circle', destructive: true, run: onAbortMerge }
        ],
        'Commit'
      ),
    section('stash', stashCreateNodes(onStash, 'scm'), 'Stash'),
    section('pop', [
      { id: 'scm.popLatest', label: 'Restore and Remove Latest Stash', hint: 'pop', icon: 'shippingbox.and.arrow.backward', run: onPopLatest },
      pickNode('pop', 'scm.popPick', 'Restore and Remove Stash…', 'pop', 'shippingbox.and.arrow.backward.fill')
    ]),
    section('apply', [
      { id: 'scm.applyLatest', label: 'Restore Latest Stash, Keep a Copy', hint: 'apply', icon: 'arrow.uturn.backward.square', run: onApplyLatest },
      pickNode('apply', 'scm.applyPick', 'Restore Stash, Keep a Copy…', 'apply', 'arrow.uturn.backward.square.fill')
    ]),
    section('drop', [
      pickNode('drop', 'scm.dropPick', 'Delete Stash…', 'drop', 'trash'),
      { id: 'scm.dropAll', label: 'Delete All Stashes…', hint: 'clear', icon: 'trash.fill', destructive: true, run: onDropAll }
    ]),
    section('view', [pickNode('view', 'scm.viewPick', 'Show Stash Files…', 'show', 'doc.text.magnifyingglass')])
  ])
}

export function stashItemNodes({
  stash,
  onView,
  onApply,
  onPop,
  onDrop,
  onCopy
}: {
  stash: Stash
  onView: () => void
  onApply: () => void
  onPop: () => void
  onDrop: () => void
  onCopy: (text: string, x: number, y: number) => void
}): ActionNode[] {
  const copy = (text: string) => (_v?: string, at?: { x: number; y: number }): void => onCopy(text, at?.x ?? 0, at?.y ?? 0)
  return compactNodes([
    section('show', [{ id: 'stash.show', label: 'Show Files', hint: 'show', icon: 'doc.text.magnifyingglass', run: onView }]),
    section('restore', [
      { id: 'stash.pop', label: 'Restore and Remove', hint: 'pop', icon: 'shippingbox.and.arrow.backward', glyph: <PackageOpen size={14} />, swipe: 'pop', run: onPop },
      { id: 'stash.apply', label: 'Restore, Keep a Copy', hint: 'apply', icon: 'arrow.uturn.backward.square', glyph: <ArchiveRestore size={14} />, swipe: 'apply', run: onApply }
    ]),
    section('drop', [{ id: 'stash.drop', label: 'Delete', hint: 'drop', icon: 'trash', destructive: true, swipe: 'drop', run: onDrop }]),
    section('copy', [
      !!stash.branchName && { id: 'stash.copyBranch', label: 'Copy Branch Name', icon: 'doc.on.doc', run: copy(stash.branchName ?? '') },
      { id: 'stash.copyName', label: 'Copy Stash Name', icon: 'doc.on.clipboard', run: copy(stash.description) }
    ])
  ])
}

export interface ChangeMenuArgs {
  targets: MenuRow[]
  at: { x: number; y: number }
  root: string
  onOpenFile?: (path: string) => void
  conflictSides?: ScmConflictSides
  onAcceptAll: (paths: string[], type: CommitType) => void
  onIgnore: (entries: string[]) => void
  onStage: (paths: string[]) => void
  onUnstage: (paths: string[]) => void
  onDiscard: (paths: string[], wholeEnv: string[]) => void
  isDiscardable: (path: string) => boolean
  onNever: (paths: string[]) => void
  onKeepEnv: (paths: string[]) => void
  onRemoveNever: (paths: string[]) => void
  changedUnder: (folder: string) => string[]
  isStaged: (path: string) => boolean
  isEnvUnsafe: (path: string) => boolean
  onReveal: (path: string) => void
  onCopy: (text: string, x: number, y: number) => void
  onShowHistory: (paths: string[]) => void
}

export function changeMenuNodes({
  targets,
  at,
  root,
  onOpenFile,
  conflictSides,
  onAcceptAll,
  onIgnore,
  onStage,
  onUnstage,
  onDiscard,
  isDiscardable,
  onNever,
  onKeepEnv,
  onRemoveNever,
  changedUnder,
  isStaged,
  isEnvUnsafe,
  onReveal,
  onCopy,
  onShowHistory
}: ChangeMenuArgs): ActionNode[] {
  const single = targets.length === 1 ? targets[0] : undefined
  const many = targets.length > 1
  const stagePaths = groupPaths(targets, ['workingTree', 'merge'])
  const mergePaths = groupPaths(targets, ['merge'])
  const sideNames = conflictSides ?? conflictSideNames('unknown')
  const ignoreEntries = Array.from(
    new Set(
      targets
        .filter((t) => !t.stash && t.group !== 'merge' && t.path !== '.gitignore')
        .map((t) => (t.type === 'folder' ? `${t.path}/` : t.path))
    )
  )
  const unstagePaths = groupPaths(targets, ['index'])
  const discardWorking = groupPaths(targets, ['workingTree']).filter(isDiscardable)
  const discardWhole = groupPaths(targets, ['never']).filter(isDiscardable)
  const discardPaths = Array.from(new Set([...discardWorking, ...discardWhole]))
  const discardOnlyNonEnv = discardWhole.length === 0 && discardWorking.length > 0 && discardWorking.every((p) => residualPaths(targets).includes(p))
  const neverEntries = neverTargetEntries(targets)
  const working = targets.filter((t) => t.group === 'workingTree')
  const allKeep = residualPaths(targets)
  const keepPaths = allKeep.filter((p) => !isEnvUnsafe(p))
  const allNeverAdd = groupPaths(working, ['workingTree']).filter((p) => !allKeep.includes(p))
  const neverAdd = allNeverAdd.filter((p) => !isStaged(p))
  const singleFile = single?.type === 'file' && !single.item.residual ? single : undefined
  const singleStaged = !!singleFile && isStaged(singleFile.path)
  const paths = Array.from(new Set(targets.map((t) => t.path)))
  const folders =
    single && single.group === 'workingTree'
      ? (single.type === 'folder' ? [`${single.path}/`, ...ancestorFolders(single.path)] : ancestorFolders(single.path))
          .map((folder) => ({ folder, files: changedUnder(folder).filter((p) => !isStaged(p)) }))
          .filter((f) => f.files.length > 0)
      : []
  const skipped = single
    ? single.type === 'folder'
      ? changedUnder(`${single.path}/`).filter(isStaged).length
      : singleStaged || (single.type === 'file' && single.item.residual && isEnvUnsafe(single.path)) ? 1 : 0
    : allNeverAdd.length - neverAdd.length + (allKeep.length - keepPaths.length)
  const count = (n: number): string => (many ? ` (${plural(n, 'file')})` : '')
  const hasTop = discardPaths.length > 0 || stagePaths.length > 0 || mergePaths.length > 0 || unstagePaths.length > 0 || keepPaths.length > 0 || neverEntries.length > 0
  const canAddEnv = !!singleFile || folders.length > 0 || (many && neverAdd.length > 0) || skipped > 0
  const openable = onOpenFile
    ? targets
        .filter((t) => t.type === 'file' && (t.item.change ? canOpenFile(t.item.change) : !!t.item.entry))
        .map((t) => t.path)
    : []

  const copyAt = (text: string) => (_v?: string, p?: { x: number; y: number }): void => {
    const pt = p ?? at
    onCopy(text, pt.x, pt.y)
  }
  return compactNodes([
    onOpenFile && openable.length > 0 && section('open', [{ id: 'scm.openFile', label: 'Open File', icon: 'doc.text.magnifyingglass', glyph: <FileSymlink size={14} />, run: () => openable.forEach(onOpenFile) }]),
    hasTop &&
      section('change', [
        stagePaths.length > 0 && { id: 'scm.stage', label: `Stage Changes${count(stagePaths.length)}`, icon: 'plus', glyph: <Plus size={14} />, swipe: 'stage', run: () => onStage(stagePaths) },
        discardPaths.length > 0 && {
          id: 'scm.discard',
          label: `${discardOnlyNonEnv ? 'Discard Only Non-Env Changes' : 'Discard Changes'}${count(discardPaths.length)}`,
          icon: 'arrow.uturn.backward',
          glyph: <Undo2 size={14} />,
          destructive: true,
          swipe: 'discard',
          run: () => onDiscard(discardWorking, discardWhole)
        },
        mergePaths.length > 0 && { id: 'scm.acceptCurrent', label: `Accept All Current (${sideNames.current})`, icon: 'arrow.left.square', run: () => onAcceptAll(mergePaths, CommitType.Current) },
        mergePaths.length > 0 && { id: 'scm.acceptIncoming', label: `Accept All Incoming (${sideNames.incoming})`, icon: 'arrow.right.square', run: () => onAcceptAll(mergePaths, CommitType.Incoming) },
        keepPaths.length > 0 && { id: 'scm.keepEnv', label: `Keep as Env${count(keepPaths.length)}`, icon: 'leaf', glyph: <EnvKeepIcon size={14} className="shrink-0" />, run: () => onKeepEnv(keepPaths) },
        unstagePaths.length > 0 && { id: 'scm.unstage', label: `Unstage Changes${count(unstagePaths.length)}`, icon: 'minus', glyph: <Minus size={14} />, swipe: 'unstage', run: () => onUnstage(unstagePaths) },
        neverEntries.length > 0 && { id: 'scm.removeNever', label: `Remove from Env Changes${count(neverEntries.length)}`, icon: 'xmark', glyph: <X size={14} />, run: () => onRemoveNever(neverEntries) }
      ]),
    section('file', [
      single && single.type !== 'folder' && { id: 'scm.openFileEditor', label: 'Open File', icon: 'doc.text', glyph: <FileText size={14} />, run: () => openFileInWorkbench({ file: joinPath(root, single.path), preview: false }) },
      {
        id: 'scm.history',
        label: single ? (single.type === 'folder' ? 'Show Folder History' : 'Show File History') : `Show History of ${plural(targets.length, 'Item')}`,
        icon: 'clock.arrow.circlepath',
        glyph: <History size={14} />,
        run: () => onShowHistory(paths)
      },
      ignoreEntries.length > 0 && {
        id: 'scm.gitignore',
        label: ignoreEntries.length > 1 ? `Add ${plural(ignoreEntries.length, 'Item')} to .gitignore` : single?.type === 'folder' ? 'Add Folder to .gitignore' : 'Add to .gitignore',
        icon: 'eye.slash',
        glyph: <EyeOff size={14} />,
        run: () => onIgnore(ignoreEntries)
      }
    ]),
    single && section('reveal', [{ id: 'scm.reveal', label: revealLabel(), icon: 'folder', run: () => onReveal(single.path) }]),
    section('copy', [
      { id: 'scm.copyPath', label: many ? `Copy ${plural(paths.length, 'Path')}` : 'Copy Path', icon: 'doc.on.doc', run: copyAt(paths.map((p) => joinPath(root, p)).join('\n')) },
      { id: 'scm.copyRelPath', label: many ? `Copy ${plural(paths.length, 'Relative Path')}` : 'Copy Relative Path', icon: 'doc.on.clipboard', run: copyAt(paths.join('\n')) }
    ]),
    working.length > 0 &&
      canAddEnv && {
        ...section(
          'env',
          [
            singleFile && { id: 'scm.env.file', label: `This File${singleStaged ? ' (staged)' : ''}`, icon: 'leaf', glyph: <EnvAddIcon size={13} className="shrink-0" />, enabled: !singleStaged, run: () => onNever([singleFile.path]) },
            ...(single
              ? folders.map(({ folder, files }) => ({
                  id: `scm.env.folder:${folder}`,
                  label: `Changed files in ${folder}`,
                  hint: String(files.length),
                  icon: 'folder.badge.plus',
                  glyph: <EnvAddIcon size={13} className="shrink-0" />,
                  run: () => onNever(files)
                }))
              : []),
            many && neverAdd.length > 0 && { id: 'scm.env.selection', label: 'Changed files in the selection', hint: String(neverAdd.length), icon: 'checklist', glyph: <EnvAddIcon size={13} className="shrink-0" />, run: () => onNever(neverAdd) }
          ],
          'Env changes'
        ),
        header: (
          <div className="max-w-[300px] px-3 pb-1 pt-1.5">
            <div className="flex items-center gap-1.5 text-xs font-medium text-ink-3">
              Env changes
              <span className="rounded bg-white/10 px-1 py-px text-[10px] font-medium normal-case tracking-normal text-ink-3">
                Satura Space only
              </span>
            </div>
            <div className="mt-0.5 text-[11px] leading-snug text-zinc-500">
              Commits made here leave these files out. Git and .gitignore stay as they are. A folder adds only
              the files changed in it right now, not the folder itself.
            </div>
          </div>
        ),
        footer:
          skipped > 0 ? (
            <div className="max-w-[300px] px-3 pb-1.5 pt-1 text-[11px] leading-snug text-zinc-500">
              {skipped === 1 ? 'A staged file is' : `${skipped} staged files are`} left out. Unstage first to add{' '}
              {skipped === 1 ? 'it' : 'them'} to Env Changes.
            </div>
          ) : null
      }
  ])
}
