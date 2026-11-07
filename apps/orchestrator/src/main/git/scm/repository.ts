import { promises as fs } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import {
  ENV_REF,
  INDEX_REF,
  MAYBE_REBASED_ERROR,
  RefType,
  STALE_CONTENT_ERROR,
  Status,
  WORKTREE_REF,
  imageMimeType,
  normalizeNeverCommitEntries,
  type Branch,
  type Change,
  type Commit,
  type DiffChange,
  type EnvSnapshot,
  type GitScmApi,
  type NeverCommitChange,
  type Ref,
  type Remote,
  type ScmConflictSides,
  type ScmDiffExplanation,
  type ScmDiffStat,
  type ScmEnvResidual,
  type ScmFileContent,
  type ScmGitError,
  type ScmImageContent,
  type ScmLogOptions,
  type ScmLogSearch,
  type ScmPullOptions,
  type ScmPushOptions,
  type ScmRemoteOperation,
  type ScmRepositoryState,
  type ScmResult,
  type ScmStashDetails,
  type ScmStashOptions,
  type Stash
} from '@shared/git-scm'
import {
  ForcePushMode,
  GitError,
  GitErrorCodes,
  getGit,
  type IFileStatus,
  type LogOptions,
  type LsTreeElement,
  type RefQuery,
  type Repository as BaseRepository,
  type SpawnOptions
} from './git'
import { RemoteOperation, tidyProgressOutput } from './remote-operation'
import {
  envBlobPath,
  gitBlobSha,
  readNeverCommitData,
  resolveNeverCommitDir,
  writeEnvBlob,
  updateNeverCommitData,
  type NeverCommitData
} from './never-commit-store'
import { readScmSettings, writeScmSettings } from './settings-store'
import { isDescendant, pathEquals, timeout } from './util'
import { censusTrack } from '@shared/census'
import { atomicWriteFile, isInside, trashPath } from '../../safe-fs'

export const MAX_SHOW_BYTES = 5 * 1024 * 1024
export const BINARY_SNIFF_BYTES = 8000
export const MAX_IMAGE_BYTES = 25 * 1024 * 1024
export const LFS_POINTER_MAX_BYTES = 1024

const LFS_POINTER_PREFIX = Buffer.from('version https://git-lfs.github.com/spec/v1')
const ENV_MERGE_LABELS: [string, string, string] = ['working file', 'env snapshot', 'without env edits']
const ENV_MERGE_ATTRIBUTES = ['merge', 'text', 'binary']
const REGULAR_FILE_MODE = /^100(644|755)$/

type RawContent =
  | { readonly kind: 'bytes'; readonly buffer: Buffer }
  | { readonly kind: 'missing' }
  | { readonly kind: 'tooLarge'; readonly size: number }

interface EnvStore {
  readonly dir: string
  readonly data: NeverCommitData
}

interface Operation {
  readonly retry: boolean
}

const FORCE_PUSH_REJECTED = 'Can\'t force push refs to remote. The tip of the remote-tracking branch has been updated since the last checkout. Try running "Pull" first to pull the latest changes from the remote branch.'
const PUSH_ERROR_MESSAGES = new Map<string, string>([
  [GitErrorCodes.PushRejected, 'Can\'t push refs to remote. Try running "Pull" first to integrate your changes.'],
  [GitErrorCodes.ForcePushWithLeaseRejected, FORCE_PUSH_REJECTED],
  [GitErrorCodes.ForcePushWithLeaseIfIncludesRejected, FORCE_PUSH_REJECTED]
])

const Operation = {
  Add: { retry: false } as Operation,
  Clean: { retry: false } as Operation,
  Commit: { retry: false } as Operation,
  Diff: { retry: false } as Operation,
  Fetch: { retry: true } as Operation,
  GetObjectFiles: { retry: false } as Operation,
  GetRefs: { retry: false } as Operation,
  Log: { retry: false } as Operation,
  Merge: { retry: false } as Operation,
  MergeAbort: { retry: false } as Operation,
  MergeBase: { retry: false } as Operation,
  Pull: { retry: true } as Operation,
  Push: { retry: false } as Operation,
  RebaseAbort: { retry: false } as Operation,
  RebaseContinue: { retry: false } as Operation,
  Remove: { retry: false } as Operation,
  RevertFiles: { retry: false } as Operation,
  Show: { retry: false } as Operation,
  Stage: { retry: false } as Operation,
  Stash: { retry: false } as Operation
}

type PullFlags = Omit<ScmPullOptions, 'rebase'>

interface GitResourceGroups {
  indexGroup: Change[]
  mergeGroup: Change[]
  workingTreeGroup: Change[]
}

function toChange(type: Status, rawPath: string, rawRename: string | undefined): Change {
  const resourcePath = rawRename && (type === Status.MODIFIED || type === Status.DELETED || type === Status.INDEX_RENAMED || type === Status.INDEX_COPIED || type === Status.INTENT_TO_RENAME)
    ? rawRename
    : rawPath
  return { path: resourcePath, originalPath: rawPath, renamePath: rawRename, status: type }
}

export function toResourceGroups(status: IFileStatus[], untrackedChanges: 'mixed' | 'separate' | 'hidden' = 'mixed'): GitResourceGroups {
  const indexGroup: Change[] = [],
    mergeGroup: Change[] = [],
    workingTreeGroup: Change[] = []

  status.forEach((raw) => {
    const renamePath = raw.rename ? raw.rename : undefined

    switch (raw.x + raw.y) {
      case '??': switch (untrackedChanges) {
        case 'mixed': return workingTreeGroup.push(toChange(Status.UNTRACKED, raw.path, undefined))
        default: return undefined
      }
      case '!!': switch (untrackedChanges) {
        case 'mixed': return workingTreeGroup.push(toChange(Status.IGNORED, raw.path, undefined))
        default: return undefined
      }
      case 'DD': return mergeGroup.push(toChange(Status.BOTH_DELETED, raw.path, undefined))
      case 'AU': return mergeGroup.push(toChange(Status.ADDED_BY_US, raw.path, undefined))
      case 'UD': return mergeGroup.push(toChange(Status.DELETED_BY_THEM, raw.path, undefined))
      case 'UA': return mergeGroup.push(toChange(Status.ADDED_BY_THEM, raw.path, undefined))
      case 'DU': return mergeGroup.push(toChange(Status.DELETED_BY_US, raw.path, undefined))
      case 'AA': return mergeGroup.push(toChange(Status.BOTH_ADDED, raw.path, undefined))
      case 'UU': return mergeGroup.push(toChange(Status.BOTH_MODIFIED, raw.path, undefined))
    }

    switch (raw.x) {
      case 'M': indexGroup.push(toChange(Status.INDEX_MODIFIED, raw.path, undefined)); break
      case 'A': indexGroup.push(toChange(Status.INDEX_ADDED, raw.path, undefined)); break
      case 'D': indexGroup.push(toChange(Status.INDEX_DELETED, raw.path, undefined)); break
      case 'R': indexGroup.push(toChange(Status.INDEX_RENAMED, raw.path, renamePath)); break
      case 'C': indexGroup.push(toChange(Status.INDEX_COPIED, raw.path, renamePath)); break
    }

    switch (raw.y) {
      case 'M': workingTreeGroup.push(toChange(Status.MODIFIED, raw.path, renamePath)); break
      case 'D': workingTreeGroup.push(toChange(Status.DELETED, raw.path, renamePath)); break
      case 'A': workingTreeGroup.push(toChange(Status.INTENT_TO_ADD, raw.path, renamePath)); break
      case 'R': workingTreeGroup.push(toChange(Status.INTENT_TO_RENAME, raw.path, renamePath)); break
      case 'T': workingTreeGroup.push(toChange(Status.TYPE_CHANGED, raw.path, renamePath)); break
    }

    return undefined
  })

  return { indexGroup, mergeGroup, workingTreeGroup }
}

function hasDotGitSegment(relativePath: string): boolean {
  return relativePath.split(/[\\/]/).some((segment) => segment.toLowerCase() === '.git')
}

async function resolveExisting(target: string): Promise<string> {
  const rest: string[] = []
  let current = target
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...rest)
    } catch {
      const parent = path.dirname(current)
      if (parent === current) {
        return target
      }
      rest.unshift(path.basename(current))
      current = parent
    }
  }
}

function tempEnvPath(): string {
  return path.join(tmpdir(), `sspace-env-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
}

function isText(buffer: Buffer): boolean {
  return !buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)
}

function sniff(buffer: Buffer): ScmFileContent {
  if (buffer.length > MAX_SHOW_BYTES) {
    return { kind: 'tooLarge', size: buffer.length }
  }
  if (buffer.subarray(0, BINARY_SNIFF_BYTES).includes(0)) {
    return { kind: 'binary', size: buffer.length }
  }
  return { kind: 'text', text: buffer.toString('utf8') }
}

export function isEnvMergeable(attributes: ReadonlyMap<string, string> | undefined): boolean {
  if (!attributes) {
    return false
  }
  const binary = attributes.get('binary') ?? 'unspecified'
  const text = attributes.get('text') ?? 'unspecified'
  const merge = attributes.get('merge') ?? 'unspecified'
  return (binary === 'unspecified' || binary === 'unset')
    && text !== 'unset'
    && (merge === 'unspecified' || merge === 'set' || merge === 'text')
}

export function isLfsPointer(buffer: Buffer): boolean {
  return buffer.length < LFS_POINTER_MAX_BYTES && buffer.subarray(0, LFS_POINTER_PREFIX.length).equals(LFS_POINTER_PREFIX)
}

function lfsPointerSize(pointer: Buffer): number | undefined {
  const match = /^size (\d+)$/m.exec(pointer.toString('utf8'))
  return match ? Number(match[1]) : undefined
}

export class Repository {

  private _EMPTY_TREE: string | undefined
  private remote: RemoteOperation | undefined

  constructor(readonly repository: BaseRepository) { }

  get root(): string {
    return this.repository.root
  }

  async getState(): Promise<ScmRepositoryState> {
    const [HEAD, remotes, env, rebaseCommit, mergeInProgress, mergeMessage, stashes] = await Promise.all([
      this.repository.getHEADRef(),
      this.repository.getRemotes(),
      this.readEnv(),
      this.getRebaseCommit(),
      this.isMergeInProgress(),
      this.getInputTemplate(),
      this.getStashes()
    ])

    const [{ resourceGroups, isRepositoryHuge }, refs] = await Promise.all([
      this.getStatus(),
      this.getRefs({})
    ])

    const [{ envResidual, envStagedUnsafe }, conflictSides] = await Promise.all([
      this.classifyEnv(env, resourceGroups),
      resourceGroups.mergeGroup.length > 0 ? this.getConflictSides(HEAD, refs, resourceGroups.mergeGroup) : Promise.resolve(undefined)
    ])

    return {
      root: this.root,
      HEAD,
      refs,
      remotes,
      stashes,
      ...(rebaseCommit ? { rebaseCommit } : {}),
      mergeInProgress,
      ...(mergeMessage ? { mergeMessage } : {}),
      ...(conflictSides ? { conflictSides } : {}),
      mergeChanges: resourceGroups.mergeGroup,
      indexChanges: resourceGroups.indexGroup,
      workingTreeChanges: resourceGroups.workingTreeGroup,
      neverCommit: env.data.entries,
      envResidual,
      envStagedUnsafe,
      ...(isRepositoryHuge ? { isRepositoryHuge } : {})
    }
  }

  private async getRebaseCommit(): Promise<Commit | undefined> {
    const rebaseHeadPath = path.join(this.repository.dotGit.path, 'REBASE_HEAD')
    const rebaseApplyPath = path.join(this.repository.dotGit.path, 'rebase-apply')
    const rebaseMergePath = path.join(this.repository.dotGit.path, 'rebase-merge')

    try {
      const [rebaseApplyExists, rebaseMergePathExists, rebaseHead] = await Promise.all([
        exists(rebaseApplyPath),
        exists(rebaseMergePath),
        fs.readFile(rebaseHeadPath, 'utf8')
      ])
      if (!rebaseApplyExists && !rebaseMergePathExists) {
        return undefined
      }
      return await this.getCommit(rebaseHead.trim())
    } catch (err) {
      return undefined
    }
  }

  private async getConflictSides(HEAD: Branch | undefined, refs: Ref[], conflicts: Change[]): Promise<ScmConflictSides> {
    const dotGit = this.repository.dotGit.path
    const read = (name: string): Promise<string | undefined> => fs.readFile(path.join(dotGit, name), 'utf8').then((s) => s.trim(), () => undefined)
    const short = (hash: string | undefined): string => (hash ?? '').substring(0, 7)
    const refName = (hash: string | undefined): string | undefined => {
      if (!hash) return undefined
      const matches = refs.filter((r) => r.commit === hash && r.name && !r.name.endsWith('/HEAD'))
      return (matches.find((r) => r.type === RefType.Head) ?? matches.find((r) => r.type === RefType.RemoteHead) ?? matches[0])?.name
    }
    const yours = HEAD?.name ? `your branch ${HEAD.name}` : `your detached HEAD ${short(HEAD?.commit)}`

    const [mergeHead, mergeMsg, squashMsg, cherryPickHead, revertHead, rebaseMergeHead, rebaseApplyHead, rebaseMergeOnto, rebaseApplyOnto, rebaseHead] = await Promise.all([
      read('MERGE_HEAD'),
      read('MERGE_MSG'),
      read('SQUASH_MSG'),
      read('CHERRY_PICK_HEAD'),
      read('REVERT_HEAD'),
      read('rebase-merge/head-name'),
      read('rebase-apply/head-name'),
      read('rebase-merge/onto'),
      read('rebase-apply/onto'),
      read('REBASE_HEAD')
    ])

    const rebaseBranch = rebaseMergeHead ?? rebaseApplyHead
    const rebaseOnto = rebaseMergeOnto ?? rebaseApplyOnto
    if (rebaseBranch !== undefined || rebaseOnto !== undefined) {
      const branch = rebaseBranch?.replace(/^refs\/heads\//, '')
      const onto = refName(rebaseOnto) ?? short(rebaseOnto)
      return {
        kind: 'rebase',
        current: `${onto}, the branch you rebase onto`,
        incoming: rebaseHead
          ? `your commit ${short(rebaseHead)}${branch && branch !== 'detached HEAD' ? ` from ${branch}` : ''}`
          : `your commits${branch ? ` from ${branch}` : ''}`
      }
    }

    if (mergeHead) {
      const first = mergeHead.split(/\r?\n/)[0]
      const quoted = mergeMsg?.split(/\r?\n/)[0].match(/^Merge (?:remote-tracking )?(?:branch|tag)(?:es)? '([^']+)'(?: of (\S+))?/)
      const from = quoted ? (quoted[2] ? `${quoted[1]} of ${quoted[2]}` : quoted[1]) : refName(first) ?? short(first)
      return { kind: 'merge', current: yours, incoming: `branch ${from}` }
    }

    if (cherryPickHead) {
      return { kind: 'cherryPick', current: yours, incoming: `cherry-picked commit ${short(cherryPickHead)}` }
    }

    if (revertHead) {
      return { kind: 'revert', current: yours, incoming: `revert of commit ${short(revertHead)}` }
    }

    if (squashMsg !== undefined) {
      return { kind: 'squash', current: yours, incoming: 'the squash-merged branch' }
    }

    for (const change of conflicts.filter((c) => c.status === Status.BOTH_MODIFIED || c.status === Status.BOTH_ADDED).slice(0, 5)) {
      const working = await this.readWorkingTree(change.path, MAX_SHOW_BYTES).catch(() => undefined)
      if (!working || working.kind !== 'bytes') continue
      const marker = working.buffer.toString('utf8').match(/^>>>>>>> (.*)$/m)
      if (!marker) continue
      if (marker[1].trim() === 'Stashed changes') {
        return { kind: 'stash', current: yours, incoming: 'your stash' }
      }
      break
    }

    return { kind: 'unknown', current: yours, incoming: 'the other side' }
  }

  private isMergeInProgress(): Promise<boolean> {
    const mergeHeadPath = path.join(this.repository.dotGit.path, 'MERGE_HEAD')
    return exists(mergeHeadPath)
  }

  private async getInputTemplate(): Promise<string | undefined> {
    return (await Promise.all([this.repository.getMergeMessage(), this.repository.getSquashMessage()])).find((msg) => !!msg)
  }

  private async readEnv(): Promise<EnvStore> {
    const dir = await resolveNeverCommitDir(this.root)
    return { dir, data: await readNeverCommitData(dir) }
  }

  private async mergeablePaths(paths: Iterable<string>): Promise<Set<string>> {
    const unique = [...new Set(paths)]
    if (unique.length === 0) {
      return new Set()
    }

    const attributes = await this.repository.checkAttr(unique, ENV_MERGE_ATTRIBUTES).catch(() => new Map<string, Map<string, string>>())
    return new Set(unique.filter((p) => isEnvMergeable(attributes.get(p))))
  }

  private async mergeableSnapshots(snapshots: ReadonlyMap<string, EnvSnapshot>, paths: Iterable<string>): Promise<Map<string, EnvSnapshot>> {
    const candidates = [...new Set(paths)].filter((p) => snapshots.has(p))
    const mergeable = await this.mergeablePaths(candidates)
    return new Map(candidates.filter((p) => mergeable.has(p)).map((p) => [p, snapshots.get(p)!]))
  }

  private async classifyEnv(env: EnvStore, groups: GitResourceGroups): Promise<{ envResidual: ScmEnvResidual[]; envStagedUnsafe: string[] }> {
    const envResidual: ScmEnvResidual[] = []
    const envStagedUnsafe: string[] = []
    const entries = new Set(env.data.entries)

    if (entries.size === 0) {
      return { envResidual, envStagedUnsafe }
    }

    const snapshots = await this.mergeableSnapshots(env.data.snapshots, [
      ...groups.workingTreeGroup.filter((c) => c.status === Status.MODIFIED).map((c) => c.path),
      ...groups.indexGroup.filter((c) => entries.has(c.path)).map((c) => c.path)
    ])

    for (const change of groups.workingTreeGroup) {
      const snapshot = snapshots.get(change.path)
      if (change.status !== Status.MODIFIED || !snapshot) {
        continue
      }

      const residual = await this.envResidualOf(env.dir, change.path, snapshot).catch(() => undefined)
      if (residual) {
        envResidual.push(residual)
      }
    }

    for (const change of groups.indexGroup) {
      if (entries.has(change.path) && !await this.stagedWithoutEnv(env.dir, change.path, snapshots.get(change.path)).catch(() => false)) {
        envStagedUnsafe.push(change.path)
      }
    }

    return { envResidual, envStagedUnsafe }
  }

  private async envResidualOf(dir: string, filePath: string, snapshot: EnvSnapshot): Promise<ScmEnvResidual | undefined> {
    const working = await this.readWorkingTree(filePath, MAX_SHOW_BYTES)
    if (working.kind !== 'bytes' || !isText(working.buffer) || gitBlobSha(working.buffer) === snapshot.env) {
      return undefined
    }

    const stripped = await this.stripEnv(dir, snapshot, path.resolve(this.root, filePath))
    if (!stripped || stripped.content.equals(await this.repository.indexContent(filePath))) {
      return undefined
    }

    return { path: filePath, conflict: stripped.conflicts > 0 }
  }

  private async stagedWithoutEnv(dir: string, filePath: string, snapshot: EnvSnapshot | undefined): Promise<boolean> {
    if (!snapshot) {
      return false
    }

    const index = await this.repository.indexContent(filePath)
    const sha = gitBlobSha(index)
    if (sha === snapshot.base) {
      return true
    }
    if (sha === snapshot.env || index.length > MAX_SHOW_BYTES || !isText(index)) {
      return false
    }

    return this.isFreeOfEnv(dir, snapshot, index)
  }

  private async isFreeOfEnv(dir: string, snapshot: EnvSnapshot, content: Buffer): Promise<boolean> {
    const file = tempEnvPath()
    await fs.writeFile(file, content)
    try {
      const stripped = await this.stripEnv(dir, snapshot, file)
      return !!stripped && stripped.conflicts === 0 && stripped.content.equals(content)
    } finally {
      await fs.rm(file, { force: true }).catch(() => undefined)
    }
  }

  private async stripEnv(dir: string, snapshot: EnvSnapshot, current: string): Promise<{ content: Buffer; conflicts: number } | undefined> {
    const env = envBlobPath(dir, snapshot.env)
    const base = envBlobPath(dir, snapshot.base)
    const present = await Promise.all([env, base].map((p) => fs.access(p).then(() => true, () => false)))
    if (present.includes(false)) {
      return undefined
    }

    return this.repository.mergeFile(current, env, base, ENV_MERGE_LABELS)
  }

  private async readEnvStripped(filePath: string, limit: number): Promise<RawContent> {
    const working = await this.readWorkingTree(filePath, limit)
    const env = await this.readEnv()
    const snapshot = (await this.mergeableSnapshots(env.data.snapshots, [filePath])).get(filePath)
    if (!snapshot || working.kind !== 'bytes' || working.buffer.length > MAX_SHOW_BYTES || !isText(working.buffer)) {
      return working
    }

    const stripped = await this.stripEnv(env.dir, snapshot, path.resolve(this.root, filePath))
    return stripped ? { kind: 'bytes', buffer: stripped.content } : working
  }

  private async snapshotEnv(dir: string, paths: string[]): Promise<Map<string, EnvSnapshot | undefined>> {
    const snapshots = new Map<string, EnvSnapshot | undefined>()
    if (paths.length === 0) {
      return snapshots
    }

    const index = await this.repository.indexEntries(paths)
    const mergeable = await this.mergeablePaths(paths)

    for (const filePath of paths) {
      snapshots.set(filePath, undefined)
      const entry = index.get(filePath)
      if (!entry || entry.unmerged || !REGULAR_FILE_MODE.test(entry.mode) || !mergeable.has(filePath)) {
        continue
      }

      const working = await this.readWorkingTree(filePath, MAX_SHOW_BYTES)
      if (working.kind !== 'bytes' || !isText(working.buffer)) {
        continue
      }

      const base = await this.repository.indexContent(filePath).catch(() => undefined)
      if (!base || base.length > MAX_SHOW_BYTES || !isText(base) || isLfsPointer(base) || base.equals(working.buffer)) {
        continue
      }

      snapshots.set(filePath, { env: await writeEnvBlob(dir, working.buffer), base: await writeEnvBlob(dir, base) })
    }

    return snapshots
  }

  private async assertNotStaged(paths: string[], action: string, allowed?: (filePath: string) => Promise<boolean>): Promise<void> {
    if (paths.length === 0) {
      return
    }

    const staged: string[] = []
    for (const filePath of [...(await this.repository.stagedPaths(paths))].sort()) {
      if (!allowed || !await allowed(filePath).catch(() => false)) {
        staged.push(filePath)
      }
    }
    if (staged.length === 0) {
      return
    }

    throw new GitError({
      message: staged.length === 1
        ? `${staged[0]} has staged changes. Unstage it first, then ${action}.`
        : `${staged.length} files have staged changes (${staged.join(', ')}). Unstage them first, then ${action}.`,
      gitErrorCode: 'EnvStaged'
    })
  }

  async updateNeverCommit(change: NeverCommitChange): Promise<string[]> {
    const dir = await resolveNeverCommitDir(this.root)
    const drop = new Set(normalizeNeverCommitEntries(change.remove ?? []))
    const add = normalizeNeverCommitEntries(change.add ?? []).filter((e) => !drop.has(e))
    const listed = new Set((await readNeverCommitData(dir)).entries)
    await this.assertNotStaged(add.filter((e) => !listed.has(e)), 'add it to Env Changes')
    const next = await updateNeverCommitData(dir, async (data) => {
      const previous = new Set(data.entries)
      const added = add.filter((e) => !previous.has(e))
      const snapshots = new Map(data.snapshots)

      await this.assertNotStaged(added, 'add it to Env Changes')

      for (const [filePath, snapshot] of await this.snapshotEnv(dir, added)) {
        if (snapshot) {
          snapshots.set(filePath, snapshot)
        }
      }

      return { entries: [...data.entries.filter((e) => !drop.has(e)), ...added], snapshots }
    })
    return next.entries
  }

  async keepEnv(paths: string[]): Promise<void> {
    const dir = await resolveNeverCommitDir(this.root)
    await updateNeverCommitData(dir, async (data) => {
      const entries = new Set(data.entries)
      const snapshots = new Map(data.snapshots)
      const targets = [...new Set(paths)].filter((p) => entries.has(p))
      const mergeable = await this.mergeableSnapshots(data.snapshots, targets)

      await this.assertNotStaged(
        targets,
        'use Keep as Env',
        (filePath) => this.stagedWithoutEnv(dir, filePath, mergeable.get(filePath))
      )

      for (const [filePath, snapshot] of await this.snapshotEnv(dir, targets)) {
        if (snapshot) {
          snapshots.set(filePath, snapshot)
        } else {
          snapshots.delete(filePath)
        }
      }

      return { entries: data.entries, snapshots }
    })
  }

  async stage(paths: string[]): Promise<void> {
    const { dir, data } = await this.readEnv()
    const snapshots = await this.mergeableSnapshots(data.snapshots, paths)
    const envPaths = [...new Set(paths)].filter((p) => snapshots.has(p))
    const plain = paths.filter((p) => !snapshots.has(p))
    const blocked: string[] = []

    if (envPaths.length > 0) {
      const index = await this.repository.indexEntries(envPaths)

      for (const filePath of envPaths) {
        const entry = index.get(filePath)
        const working = await this.readWorkingTree(filePath, MAX_SHOW_BYTES)
        const stripped = entry && !entry.unmerged && working.kind === 'bytes' && isText(working.buffer)
          ? await this.stripEnv(dir, snapshots.get(filePath)!, path.resolve(this.root, filePath))
          : undefined

        if (!entry || !stripped) {
          plain.push(filePath)
        } else if (stripped.conflicts > 0) {
          blocked.push(filePath)
        } else {
          const object = await this.repository.hashObject(filePath, stripped.content)
          await this.run(Operation.Add, () => this.repository.updateIndexCacheInfo(entry.mode, object, filePath))
        }
      }
    }

    if (plain.length > 0) {
      await this.add(plain)
    }

    if (blocked.length > 0) {
      throw new GitError({
        message: blocked.length === 1
          ? `Didn't stage ${blocked[0]}: the new edits touch the same lines as your env edits, so git can't split them apart. Move them apart in the file, or use Keep as Env.`
          : `Didn't stage ${blocked.length} env files (${blocked.join(', ')}): the new edits touch the same lines as your env edits, so git can't split them apart. Move them apart in the files, or use Keep as Env.`
      })
    }
  }

  async getStatus(): Promise<{ resourceGroups: GitResourceGroups; isRepositoryHuge: false | { limit: number } }> {
    const untrackedChanges = 'mixed'
    const ignoreSubmodules = false
    const limit = 10000
    const similarityThreshold = 50

    const { status, didHitLimit } = await this.repository.getStatus({ limit, ignoreSubmodules, similarityThreshold, untrackedChanges })

    return {
      resourceGroups: toResourceGroups(status, untrackedChanges),
      isRepositoryHuge: didHitLimit ? { limit } : false
    }
  }

  async getRefs(query: RefQuery = {}): Promise<Ref[]> {
    const defaultSort = 'committerdate'
    query = { ...query, sort: query?.sort ?? defaultSort }
    return await this.run(Operation.GetRefs, () => this.repository.getRefs(query))
  }

  log(options?: LogOptions): Promise<Commit[]> {
    return this.run(Operation.Log, () => this.repository.log(options))
  }

  async searchLog(options: LogOptions & { refNames: string[] }, search: ScmLogSearch): Promise<Commit[]> {
    const text = search.text.trim()
    if (!text) return []
    if (search.by === 'message') {
      return await this.log({ ...options, grep: text, grepFixed: true })
    }
    if (!/^[0-9a-f]{1,40}$/i.test(text)) return []
    const hashes = await this.run(Operation.Log, () =>
      this.repository.findCommitsByHashPrefix(text, options.refNames, options.maxEntries ?? 50)
    )
    if (hashes.length === 0) return []
    return await this.log({ refNames: hashes, maxEntries: hashes.length, noWalk: true })
  }

  async getCommit(ref: string): Promise<Commit> {
    return await this.repository.getCommit(ref)
  }

  getMergeBase(ref1: string, ref2: string, ...refs: string[]): Promise<string | undefined> {
    return this.run(Operation.MergeBase, () => this.repository.getMergeBase(ref1, ref2, ...refs))
  }

  async getEmptyTree(): Promise<string> {
    if (!this._EMPTY_TREE) {
      const result = await this.repository.exec(['hash-object', '-t', 'tree', '/dev/null'], { noOptionalLocks: true })
      this._EMPTY_TREE = result.stdout.trim()
    }

    return this._EMPTY_TREE
  }

  diffBetweenWithStats(ref1: string, ref2: string, path?: string): Promise<DiffChange[]> {
    if (ref1 === this._EMPTY_TREE) {
      return this.diffTrees(ref1, ref2)
    }

    const similarityThreshold = 50

    return this.run(Operation.Diff, () =>
      this.repository.diffBetweenWithStats(`${ref1}...${ref2}`, { path, similarityThreshold }))
  }

  diffTrees(treeish1: string, treeish2?: string): Promise<DiffChange[]> {
    const similarityThreshold = 50

    return this.run(Operation.Diff, () => this.repository.diffTrees(treeish1, treeish2, { similarityThreshold }))
  }

  diffBetween(ref1: string, ref2: string): Promise<Change[]> {
    const similarityThreshold = 50

    if (ref1 === this._EMPTY_TREE) {
      return this.run(Operation.Diff, () => this.repository.diffTreesWithoutStats(ref1, ref2, { similarityThreshold }))
    }

    return this.run(Operation.Diff, () => this.repository.diffBetween(`${ref1}...${ref2}`, { similarityThreshold }))
  }

  compareCommits(ref1: string, ref2: string): Promise<Change[]> {
    const similarityThreshold = 50

    return this.run(Operation.Diff, () => this.repository.diffBetween(`${ref1}..${ref2}`, { similarityThreshold }))
  }

  async compareCommitsStats(ref1: string, ref2: string, paths: string[]): Promise<ScmDiffStat[]> {
    const wanted = new Set(paths)
    if (wanted.size === 0) {
      return []
    }

    const pathGroups = (await this.compareCommits(ref1, ref2))
      .filter((change) => wanted.has(change.path))
      .map((change) => change.status === Status.INDEX_RENAMED ? [change.originalPath, change.path] : [change.path])

    if (pathGroups.length === 0) {
      return []
    }

    const similarityThreshold = 50

    const stats = await this.run(Operation.Diff, () =>
      this.repository.diffBetweenNumstat(`${ref1}..${ref2}`, pathGroups, { similarityThreshold }))

    return stats.filter((stat) => wanted.has(stat.path))
  }

  async diffStats(ref1: string, ref2: string, paths: string[]): Promise<ScmDiffStat[]> {
    const wanted = new Set(paths)
    if (wanted.size === 0) {
      return []
    }

    const pathGroups = (await this.diffBetween(ref1, ref2))
      .filter((change) => wanted.has(change.path))
      .map((change) => change.status === Status.INDEX_RENAMED ? [change.originalPath, change.path] : [change.path])

    if (pathGroups.length === 0) {
      return []
    }

    const similarityThreshold = 50

    const stats = await this.run(Operation.Diff, () => ref1 === this._EMPTY_TREE
      ? this.repository.diffTreesNumstat(ref1, ref2, pathGroups, { similarityThreshold })
      : this.repository.diffBetweenNumstat(`${ref1}...${ref2}`, pathGroups, { similarityThreshold }))

    return stats.filter((stat) => wanted.has(stat.path))
  }

  async explainDiff(filePath: string, originalPath: string, originalRef: string, modifiedRef: string, checkContent: boolean): Promise<ScmDiffExplanation> {
    if (originalRef === ENV_REF || modifiedRef === ENV_REF || /^:[123]$/.test(originalRef) || /^:[123]$/.test(modifiedRef)) {
      return {}
    }

    const paths = Array.from(new Set([originalPath, filePath]))
    let args: string[]
    if (modifiedRef === WORKTREE_REF) {
      args = originalRef === INDEX_REF ? ['diff-files', '--raw', '--', ...paths] : ['diff-index', '--raw', originalRef, '--', ...paths]
    } else if (modifiedRef === INDEX_REF) {
      args = ['diff-index', '--cached', '--raw', originalRef === INDEX_REF ? 'HEAD' : originalRef, '--', ...paths]
    } else {
      args = ['diff-tree', '-r', '--raw', '-M', originalRef, modifiedRef, '--', ...paths]
    }

    const result = await this.run(Operation.Diff, () => this.repository.exec(args, { noOptionalLocks: true }))
    const raw = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) /m.exec(result.stdout)
    if (!raw) {
      return {}
    }

    const [, oldMode, newMode, oldObject, newObject] = raw
    const explanation: { -readonly [K in keyof ScmDiffExplanation]: ScmDiffExplanation[K] } = { oldMode, newMode, oldObject, newObject }

    if (oldMode === '120000') {
      explanation.oldTarget = await this.repository.exec(['cat-file', 'blob', oldObject]).then((r) => r.stdout, () => undefined)
    }
    if (newMode === '120000') {
      explanation.newTarget = modifiedRef === WORKTREE_REF
        ? await fs.readlink(path.resolve(this.root, filePath)).catch(() => undefined)
        : await this.repository.exec(['cat-file', 'blob', newObject]).then((r) => r.stdout, () => undefined)
    }

    if (checkContent && modifiedRef === WORKTREE_REF && oldMode === newMode && oldMode !== '160000' && oldMode !== '120000') {
      const hashed = await this.repository.exec(['hash-object', '--', filePath]).then((r) => r.stdout.trim(), () => undefined)
      if (hashed && hashed === oldObject) {
        explanation.sameContent = true
        if (originalRef === INDEX_REF || originalRef === 'HEAD') {
          await this.repository.exec(['update-index', '-q', '--refresh', '--', filePath]).catch(() => undefined)
          explanation.refreshed = true
        }
      }
    }

    return explanation
  }

  async patch(filePath: string, originalPath: string, originalRef: string, modifiedRef: string): Promise<string> {
    const paths = Array.from(new Set([originalPath, filePath]))
    const base = ['diff', '--no-color', '--no-ext-diff', '-M', '-U3']
    let args: string[]
    if (modifiedRef === WORKTREE_REF) {
      const tracked = await this.repository.exec(['ls-files', '--error-unmatch', '--', ...paths], { noOptionalLocks: true }).then(() => true, () => false)
      if (!tracked) {
        if (!(await insideRealRoot(this.root, path.resolve(this.root, filePath)))) return ''
        const result = await this.repository.exec([...base, '--no-index', '--', '/dev/null', filePath]).catch((e: GitError) => ({ stdout: e.stdout ?? '' }))
        return result.stdout
      }
      args = originalRef === INDEX_REF ? [...base, '--', ...paths] : [...base, originalRef, '--', ...paths]
    } else if (modifiedRef === INDEX_REF) {
      args = [...base, '--cached', originalRef === INDEX_REF ? 'HEAD' : originalRef, '--', ...paths]
    } else {
      args = [...base, originalRef, modifiedRef, '--', ...paths]
    }
    const result = await this.run(Operation.Diff, () => this.repository.exec(args, { noOptionalLocks: true }))
    return result.stdout
  }

  async show(filePath: string, ref: string): Promise<ScmFileContent> {
    if (ref === WORKTREE_REF) {
      return this.showWorkingTree(filePath)
    }

    if (ref === ENV_REF) {
      const content = await this.readEnvStripped(filePath, MAX_SHOW_BYTES)
      return content.kind === 'bytes' ? sniff(content.buffer) : content
    }

    const treeish = ref === INDEX_REF ? '' : ref

    return await this.run(Operation.Show, async () => {
      let size: number
      try {
        size = (await this.repository.getObjectDetails(treeish, filePath)).size
      } catch {
        return { kind: 'missing' }
      }

      if (size > MAX_SHOW_BYTES) {
        return { kind: 'tooLarge', size }
      }

      let buffer: Buffer
      try {
        buffer = await this.repository.buffer(treeish, filePath)
      } catch {
        return { kind: 'missing' }
      }

      return sniff(buffer)
    })
  }

  private async showWorkingTree(filePath: string): Promise<ScmFileContent> {
    const content = await this.readWorkingTree(filePath, MAX_SHOW_BYTES)
    return content.kind === 'bytes' ? sniff(content.buffer) : content
  }

  private async readWorkingTree(filePath: string, limit: number): Promise<RawContent> {
    const absolutePath = path.resolve(this.root, filePath)
    if (!(await scmReadable(this.root, filePath))) {
      return { kind: 'missing' }
    }

    let stat
    try {
      stat = await fs.stat(absolutePath)
    } catch {
      return { kind: 'missing' }
    }

    if (!stat.isFile()) {
      return { kind: 'missing' }
    }

    if (stat.size > limit) {
      return { kind: 'tooLarge', size: stat.size }
    }

    let buffer: Buffer
    try {
      buffer = await fs.readFile(absolutePath)
    } catch {
      return { kind: 'missing' }
    }

    return { kind: 'bytes', buffer }
  }

  async showImage(filePath: string, ref: string): Promise<ScmImageContent> {
    const content = ref === WORKTREE_REF
      ? await this.readWorkingTree(filePath, MAX_IMAGE_BYTES)
      : ref === ENV_REF
        ? await this.readEnvStripped(filePath, MAX_IMAGE_BYTES)
        : await this.run(Operation.Show, () => this.readImageBlob(ref === INDEX_REF ? '' : ref, filePath))

    if (content.kind !== 'bytes') {
      return content
    }

    return {
      kind: 'image',
      mime: imageMimeType(filePath) ?? 'application/octet-stream',
      base64: content.buffer.toString('base64'),
      size: content.buffer.length
    }
  }

  private async readImageBlob(treeish: string, filePath: string): Promise<RawContent> {
    let size: number
    try {
      size = (await this.repository.getObjectDetails(treeish, filePath)).size
    } catch {
      return { kind: 'missing' }
    }

    if (size > MAX_IMAGE_BYTES) {
      return { kind: 'tooLarge', size }
    }

    let buffer: Buffer
    try {
      buffer = await this.repository.blob(treeish, filePath)
    } catch {
      return { kind: 'missing' }
    }

    return isLfsPointer(buffer) ? this.smudgeImage(filePath, buffer) : { kind: 'bytes', buffer }
  }

  private async smudgeImage(filePath: string, pointer: Buffer): Promise<RawContent> {
    const size = lfsPointerSize(pointer)
    if (size !== undefined && size > MAX_IMAGE_BYTES) {
      return { kind: 'tooLarge', size }
    }

    if (!await this.repository.git.isLfsAvailable(this.root)) {
      throw new GitError({ message: 'This image is in Git LFS, but git-lfs isn\'t installed.' })
    }

    const buffer = await this.repository.lfsSmudge(filePath, pointer)

    if (isLfsPointer(buffer)) {
      throw new GitError({ message: 'Git LFS returned a pointer file instead of the image.' })
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
      return { kind: 'tooLarge', size: buffer.length }
    }

    return { kind: 'bytes', buffer }
  }

  async add(resources: string[], opts?: { update?: boolean }): Promise<void> {
    await this.run(Operation.Add, () => this.repository.add(resources, opts))
  }

  async revert(resources: string[]): Promise<void> {
    await this.run(Operation.RevertFiles, () => this.repository.revert('HEAD', resources))
  }

  async stageContent(filePath: string, contents: string, unstage: boolean): Promise<void> {
    const { dir, data } = await this.readEnv()
    if (!unstage && data.entries.includes(filePath.replace(/\\/g, '/'))) {
      const snapshot = (await this.mergeableSnapshots(data.snapshots, [filePath])).get(filePath)
      if (!snapshot) {
        throw new GitError({ message: `Didn't stage these lines: ${filePath} has no saved env edits to leave out, so every line counts as an env edit.` })
      }
      if (!await this.isFreeOfEnv(dir, snapshot, Buffer.from(contents, 'utf8'))) {
        throw new GitError({ message: `Didn't stage these lines: they include env edits in ${filePath}. Select only the new lines.` })
      }
    }

    await this.run(Operation.Stage, () => this.repository.stage(filePath, contents))
  }

  async discardEnvLines(filePath: string, contents: string, expected?: string): Promise<void> {
    const target = await this.writableTarget(filePath)
    if (expected !== undefined) {
      await this.assertUnchanged(filePath, expected, ENV_REF)
    }
    const merged = await this.mergeOutsideEnv(filePath, Buffer.from(contents, 'utf8'), 'these lines')
    await atomicWriteFile(target, merged)
  }

  async discardOutsideEnv(paths: string[]): Promise<void> {
    const results: [string, Buffer][] = []
    for (const filePath of [...new Set(paths)]) {
      const index = await this.repository.indexContent(filePath)
      results.push([filePath, await this.mergeOutsideEnv(filePath, index, 'the changes')])
    }

    for (const [filePath, content] of results) {
      await atomicWriteFile(await this.writableTarget(filePath), content)
    }
  }

  private async mergeOutsideEnv(filePath: string, contents: Buffer, what: string): Promise<Buffer> {
    const { dir, data } = await this.readEnv()
    const snapshot = (await this.mergeableSnapshots(data.snapshots, [filePath])).get(filePath)
    const working = path.resolve(this.root, filePath)
    const stripped = snapshot ? await this.stripEnv(dir, snapshot, working) : undefined
    if (!stripped || stripped.conflicts > 0) {
      throw new GitError({ message: `Couldn't discard ${what} in ${filePath}: the new edits touch your env edits. Discard it from Env Changes instead, which drops the env edits too.` })
    }

    const base = tempEnvPath()
    const other = tempEnvPath()
    try {
      await fs.writeFile(base, stripped.content)
      await fs.writeFile(other, contents)
      const merged = await this.repository.mergeFile(working, base, other, ENV_MERGE_LABELS)
      if (merged.conflicts > 0) {
        throw new GitError({ message: `Couldn't discard ${what} in ${filePath}: they touch your env edits. Discard it from Env Changes instead, which drops the env edits too.` })
      }
      return merged.content
    } finally {
      await Promise.all([base, other].map((f) => fs.rm(f, { force: true }).catch(() => undefined)))
    }
  }

  async rm(resources: string[]): Promise<void> {
    await this.run(Operation.Remove, () => this.repository.rm(resources))
  }

  async commit(message: string | undefined): Promise<void> {
    const opts = { requireUserConfig: true }

    if (await this.getRebaseCommit()) {
      await this.run(Operation.RebaseContinue, () => this.repository.rebaseContinue())
    } else {
      await this.run(Operation.Commit, () => this.repository.commit(message, opts))
    }
  }

  async clean(paths: string[]): Promise<void> {
    await this.run(Operation.Clean, async () => {
      const { resourceGroups } = await this.getStatus()
      const resourceStates = new Map<string, Change>()
      for (const change of resourceGroups.workingTreeGroup) {
        resourceStates.set(change.path, change)
        if (change.renamePath) {
          resourceStates.set(change.renamePath, change)
        }
      }
      const toClean: string[] = []
      const toCheckout: string[] = []

      for (const filePath of paths) {
        const change = resourceStates.get(filePath)
        if (!change) {
          continue
        }

        switch (change.status) {
          case Status.UNTRACKED:
          case Status.IGNORED:
            toClean.push(filePath)
            break
          default:
            toCheckout.push(filePath)
            break
        }
      }

      await this.trashUntracked(toClean)

      if (toCheckout.length !== 0) {
        await this.repository.checkout('', toCheckout)
      }
    })
  }

  private async trashUntracked(paths: string[]): Promise<void> {
    const folders: string[] = []
    for (const filePath of paths) {
      const absolutePath = path.resolve(this.root, filePath)
      if (!scmTrashable(this.root, filePath)) {
        throw new GitError({ message: `Refusing to move ${filePath} to the Trash: it's outside the repository` })
      }
      const stat = await fs.lstat(absolutePath).catch(() => undefined)
      if (!stat) {
        continue
      }
      if (stat.isDirectory()) {
        folders.push(filePath)
        continue
      }
      await trashPath(absolutePath)
      console.log(`[scm] moved ${filePath} to the Trash`)
    }
    if (folders.length > 0) {
      throw new GitError({
        message: folders.length === 1
          ? `Left ${folders[0]} in place: it's a folder with its own git repository. Remove it in Finder if you don't need it.`
          : `Left ${folders.length} folders in place (${folders.join(', ')}): they have their own git repositories. Remove them in Finder if you don't need them.`
      })
    }
  }

  async merge(ref: string): Promise<void> {
    await this.run(Operation.Merge, () => this.repository.merge(ref))
  }

  async mergeAbort(): Promise<void> {
    await this.run(Operation.MergeAbort, async () => await this.repository.mergeAbort())
  }

  async rebaseAbort(): Promise<void> {
    await this.run(Operation.RebaseAbort, async () => await this.repository.rebaseAbort())
  }

  async fetchDefault(): Promise<void> {
    await this._fetch({})
  }

  async fetchAll(): Promise<void> {
    await this._fetch({ all: true })
  }

  private async _fetch(options: { remote?: string; ref?: string; all?: boolean; prune?: boolean; depth?: number } = {}): Promise<void> {
    if (!options.prune) {
      const prune = false
      options.prune = prune
    }

    await this.withRemote('Fetch', (spawnOptions) => this.run(Operation.Fetch, async () => this.repository.fetch(options, spawnOptions)))
  }

  cancelRemote(): boolean {
    return this.remote?.cancel() ?? false
  }

  private async withRemote<T>(operation: ScmRemoteOperation, fn: (spawnOptions: SpawnOptions) => Promise<T>): Promise<T> {
    const current = this.remote
    if (current) {
      current.check()
      const value = await fn(current.spawnOptions)
      current.check()
      return value
    }
    const remote = new RemoteOperation(this.root, operation)
    this.remote = remote
    try {
      const value = await fn(remote.spawnOptions)
      remote.check()
      return value
    } catch (err) {
      remote.check()
      if (err instanceof GitError && err.stderr) err.stderr = tidyProgressOutput(err.stderr)
      throw err
    } finally {
      if (this.remote === remote) this.remote = undefined
      remote.dispose()
    }
  }

  async pullWithRebase(head: Branch | undefined, flags: PullFlags): Promise<void> {
    let remote: string | undefined
    let branch: string | undefined

    if (head && head.name && head.upstream) {
      remote = head.upstream.remote
      branch = `${head.upstream.name}`
    }

    return this.pullFrom(true, remote, branch, undefined, flags, head?.name)
  }

  async pull(head: Branch | undefined, unshallow: boolean | undefined, flags: PullFlags): Promise<void> {
    let remote: string | undefined
    let branch: string | undefined

    if (head && head.name && head.upstream) {
      remote = head.upstream.remote
      branch = `${head.upstream.name}`
    }

    return this.pullFrom(false, remote, branch, unshallow, flags, head?.name)
  }

  async pullFrom(rebase: boolean | undefined, remote: string | undefined, branch: string | undefined, unshallow: boolean | undefined, flags: PullFlags, currentBranch?: string): Promise<void> {
    await this.withRemote('Pull', (spawnOptions) => this.run(Operation.Pull, async () => {
      await this.maybeAutoStash(flags.autoStash, async () => {
        const autoStash = flags.autoStash
        const fetchOnPull = true
        const tags = true

        if (fetchOnPull) {
          await this.fetchAll()
        }

        if (await this.checkIfMaybeRebased(currentBranch, flags.ignoreRebaseWarning)) {
          this.remote?.check()
          await this.repository.pull(rebase, remote, branch, { unshallow, tags, autoStash }, spawnOptions)
        }
      })
    }))
  }

  private async checkIfMaybeRebased(currentBranch: string | undefined, ignoreRebaseWarning: boolean | undefined): Promise<boolean> {
    const shouldIgnore = ignoreRebaseWarning === true

    if (shouldIgnore) {
      return true
    }

    const maybeRebased = await this.run(Operation.Log, async () => {
      try {
        const result = await this.repository.exec(['log', '--oneline', '--cherry', `${currentBranch ?? ''}...${currentBranch ?? ''}@{upstream}`, '--'])
        if (result.exitCode) {
          return false
        }

        return /^=/.test(result.stdout)
      } catch {
        return false
      }
    })

    if (!maybeRebased) {
      return true
    }

    throw new GitError({
      message: currentBranch
        ? `It looks like the current branch "${currentBranch}" might have been rebased. Are you sure you still want to pull into it?`
        : 'It looks like the current branch might have been rebased. Are you sure you still want to pull into it?',
      gitErrorCode: MAYBE_REBASED_ERROR
    })
  }

  async push(head: Branch, forcePushMode?: ForcePushMode): Promise<void> {
    let remote: string | undefined
    let branch: string | undefined

    if (head && head.name && head.upstream) {
      remote = head.upstream.remote
      branch = `${head.name}:${head.upstream.name}`
    }

    await this.withRemote('Push', (spawnOptions) => this.run(Operation.Push, () => this._push(remote, branch, undefined, undefined, forcePushMode, spawnOptions)))
  }

  async pushTo(remote?: string, name?: string, setUpstream = false, forcePushMode?: ForcePushMode): Promise<void> {
    await this.withRemote('Push', (spawnOptions) => this.run(Operation.Push, () => this._push(remote, name, setUpstream, undefined, forcePushMode, spawnOptions)))
  }

  private async _push(remote?: string, refspec?: string, setUpstream = false, followTags = false, forcePushMode?: ForcePushMode, spawnOptions: SpawnOptions = {}): Promise<void> {
    try {
      await this.repository.push(remote, refspec, setUpstream, followTags, forcePushMode, false, spawnOptions)
    } catch (err) {
      if (err instanceof GitError) {
        const message = PUSH_ERROR_MESSAGES.get(err.gitErrorCode ?? '')
        if (message) err.message = message
      }
      throw err
    }
  }

  getObjectFiles(ref: string): Promise<LsTreeElement[]> {
    return this.run(Operation.GetObjectFiles, () => this.repository.lstree(ref, undefined, { recursive: true }))
  }

  async getStashes(): Promise<Stash[]> {
    return this.run(Operation.Stash, () => this.repository.getStashes())
  }

  async createStash(message?: string, includeUntracked?: boolean, staged?: boolean): Promise<void> {
    return await this.run(Operation.Stash, async () => {
      await this.repository.createStash(message, includeUntracked, staged)
    })
  }

  async popStash(index?: number, options?: { reinstateStagedChanges?: boolean }): Promise<void> {
    return await this.run(Operation.Stash, () => this.repository.popStash(index, options))
  }

  async dropStash(index?: number): Promise<void> {
    return await this.run(Operation.Stash, () => this.repository.dropStash(index))
  }

  async applyStash(index?: number, options?: { reinstateStagedChanges?: boolean }): Promise<void> {
    return await this.run(Operation.Stash, () => this.repository.applyStash(index, options))
  }

  async showStash(index: number): Promise<Change[] | undefined> {
    return await this.run(Operation.Stash, () => this.repository.showStash(index))
  }

  async writeFile(filePath: string, content: string, expected?: string): Promise<void> {
    const target = await this.writableTarget(filePath)
    if (expected !== undefined) {
      await this.assertUnchanged(filePath, expected, WORKTREE_REF)
    }
    await atomicWriteFile(target, content)
  }

  private writableTarget(filePath: string): Promise<string> {
    return scmWritableTarget(this.root, filePath)
  }

  private async assertUnchanged(filePath: string, expected: string, ref: string): Promise<void> {
    const current = await this.show(filePath, ref)
    const text = current.kind === 'text' ? current.text : current.kind === 'missing' ? '' : undefined
    if (text !== expected) {
      throw new GitError({
        message: `${filePath} changed on disk after this diff was shown, so nothing was written. Look at the reloaded diff and try again.`,
        gitErrorCode: STALE_CONTENT_ERROR
      })
    }
  }

  private gitignoreTargets(entries: string[]): { rel: string; folder: boolean }[] {
    return scmIgnoreTargets(this.root, entries)
  }

  async trackedPaths(entries: string[]): Promise<string[]> {
    const targets = this.gitignoreTargets(entries)
    if (targets.length === 0) {
      return []
    }
    const result = await this.repository.exec(['ls-files', '-z', '--', ...targets.map((t) => t.rel)], { noOptionalLocks: true })
    return [...new Set(result.stdout.split('\0').filter(Boolean))]
  }

  async addToGitignore(entries: string[], untrack: boolean): Promise<string[]> {
    const targets = this.gitignoreTargets(entries)
    const gitignore = await this.writableTarget('.gitignore')
    const text = await fs.readFile(gitignore, 'utf8').catch(() => '')
    const eol = text.includes('\r\n') ? '\r\n' : '\n'
    const existing = new Set(text.split(/\r?\n/).map((line) => line.trim()))
    const added: string[] = []
    for (const { rel, folder } of targets) {
      const line = `/${rel.replace(/[*?[\]\\]/g, (c) => `\\${c}`).replace(/ $/, '\\ ')}${folder ? '/' : ''}`
      if (existing.has(line)) continue
      existing.add(line)
      added.push(line)
    }
    if (added.length > 0) {
      const separator = text.length > 0 && !text.endsWith('\n') ? eol : ''
      await atomicWriteFile(gitignore, text + separator + added.join(eol) + eol)
    }
    if (untrack && targets.length > 0) {
      await this.run(Operation.Remove, () =>
        this.repository.exec(['rm', '--cached', '-r', '-q', '--ignore-unmatch', '--', ...targets.map((t) => t.rel)]))
    }
    return added
  }

  private async maybeAutoStash<T>(autoStash: boolean, runOperation: () => Promise<T>): Promise<T> {
    const shouldAutoStash = autoStash
      && this.repository.git.compareGitVersionTo('2.27.0') < 0
      && await this.getStatus().then(({ resourceGroups }) => resourceGroups.indexGroup.length > 0
        || resourceGroups.workingTreeGroup.some((r) => r.status !== Status.UNTRACKED && r.status !== Status.IGNORED))

    if (!shouldAutoStash) {
      return await runOperation()
    }

    await this.repository.createStash(undefined, true)
    try {
      const result = await runOperation()
      return result
    } finally {
      await this.repository.popStash(undefined, { reinstateStagedChanges: true })
    }
  }

  private async run<T>(operation: Operation, runOperation: () => Promise<T>): Promise<T> {
    return await this.retryRun(operation, runOperation)
  }

  private async retryRun<T>(operation: Operation, runOperation: () => Promise<T>): Promise<T> {
    let attempt = 0

    while (true) {
      try {
        attempt++
        return await runOperation()
      } catch (err: any) {
        const shouldRetry = attempt <= 10 && (
          (err.gitErrorCode === GitErrorCodes.RepositoryIsLocked)
          || (operation.retry && (err.gitErrorCode === GitErrorCodes.CantLockRef || err.gitErrorCode === GitErrorCodes.CantRebaseMultipleBranches))
        )

        if (shouldRetry) {
          await timeout(Math.pow(attempt, 2) * 50)
        } else {
          throw err
        }
      }
    }
  }
}

export class CommandCenter {

  constructor(private readonly repository: Repository) { }

  async fetch(): Promise<void> {
    const remotes = await this.repository.repository.getRemotes()

    if (remotes.length === 0) {
      throw new Error('This repository has no remotes configured to fetch from.')
    }

    await this.repository.fetchDefault()
  }

  async pull(options: ScmPullOptions): Promise<void> {
    const remotes = await this.repository.repository.getRemotes()

    if (remotes.length === 0) {
      throw new Error('Your repository has no remotes configured to pull from.')
    }

    const HEAD = await this.repository.repository.getHEADRef()
    const flags: PullFlags = { autoStash: options.autoStash, ignoreRebaseWarning: options.ignoreRebaseWarning }

    if (options.rebase) {
      await this.repository.pullWithRebase(HEAD, flags)
    } else {
      await this.repository.pull(HEAD, undefined, flags)
    }
  }

  async push(options: ScmPushOptions = {}): Promise<void> {
    const forcePushMode = options.force ? ForcePushMode.ForceWithLeaseIfIncludes : undefined
    const remotes = await this.repository.repository.getRemotes()

    if (remotes.length === 0) {
      throw new Error('Your repository has no remotes configured to push to.')
    }

    const HEAD = await this.repository.repository.getHEADRef()

    if (!HEAD || !HEAD.name) {
      throw new Error('Please check out a branch to push to a remote.')
    }

    if (!HEAD.upstream) {
      await this.publish(remotes, HEAD.name)
      return
    }

    try {
      await this.repository.push(HEAD, forcePushMode)
    } catch (err) {
      if (!(err instanceof GitError) || err.gitErrorCode !== GitErrorCodes.NoUpstreamBranch) {
        throw err
      }

      await this.publish(remotes, HEAD.name)
    }
  }

  async publish(remotes: Remote[], branchName: string): Promise<void> {
    const remote = remotes.find((r) => r.name === 'origin') ?? (remotes.length === 1 ? remotes[0] : undefined)

    if (!remote) {
      throw new GitError({
        message: `The branch "${branchName}" has no remote branch.`,
        gitErrorCode: GitErrorCodes.NoUpstreamBranch
      })
    }

    await this.repository.pushTo(remote.name, branchName, true)
  }

  async commit(message: string): Promise<void> {
    if (!message) {
      throw new GitError({
        message: 'Commit operation was cancelled due to empty commit message.',
        gitErrorCode: GitErrorCodes.EmptyCommitMessage
      })
    }

    await this.repository.commit(message)
  }

  async stage(paths: string[]): Promise<void> {
    if (paths.length > 0) {
      await this.repository.stage(paths)
    }
  }

  async unstage(paths: string[]): Promise<void> {
    await this.repository.revert(paths)
  }

  async stash(options: ScmStashOptions): Promise<void> {
    const includeUntracked = options.includeUntracked === true
    const staged = options.staged === true
    const { resourceGroups } = await this.repository.getStatus()
    const noUnstagedChanges = resourceGroups.workingTreeGroup.length === 0
    const noStagedChanges = resourceGroups.indexGroup.length === 0

    if (staged) {
      if (noStagedChanges) {
        throw new GitError({ message: 'There are no staged changes to stash.', gitErrorCode: GitErrorCodes.NoLocalChanges })
      }
    } else {
      if (noUnstagedChanges && noStagedChanges) {
        throw new GitError({ message: 'There are no changes to stash.', gitErrorCode: GitErrorCodes.NoLocalChanges })
      }
    }

    try {
      await this.repository.createStash(options.message, includeUntracked, staged)
    } catch (err: any) {
      if (/You do not have the initial commit yet/.test(err.stderr || '')) {
        throw new GitError({ message: 'The repository does not have any commits. Please make an initial commit before creating a stash.' })
      }

      throw err
    }
  }

  async stashPop(index: number | undefined): Promise<void> {
    if (index === undefined) {
      await this.assertHasStashes()
    }

    await this.repository.popStash(index)
  }

  async stashApply(index: number | undefined): Promise<void> {
    if (index === undefined) {
      await this.assertHasStashes()
    }

    await this.repository.applyStash(index)
  }

  async stashDrop(index: number | undefined): Promise<void> {
    if (index === undefined) {
      await this.assertHasStashes()
    }

    await this.repository.dropStash(index)
  }

  async stashShow(index: number): Promise<ScmStashDetails> {
    const stashes = await this.repository.getStashes()
    const stash = stashes.find((s) => s.index === index)
    if (!stash) {
      return { changes: [], untracked: [] }
    }

    const changes = await this.repository.showStash(stash.index)
    if (!changes || changes.length === 0) {
      return { changes: [], untracked: [] }
    }

    const stashUntrackedFilesParentCommit = stash.parents.length === 3 ? stash.parents[2] : undefined
    const untracked = stashUntrackedFilesParentCommit
      ? (await this.repository.getObjectFiles(stashUntrackedFilesParentCommit)).map((f) => f.file)
      : []

    return { changes, untracked }
  }

  private async assertHasStashes(): Promise<void> {
    const stashes = await this.repository.getStashes()

    if (stashes.length === 0) {
      throw new Error('There are no stashes in the repository.')
    }
  }
}

async function getRepositoryRootRealPath(repositoryRoot: string): Promise<string | undefined> {
  try {
    const repositoryRootRealPath = await fs.realpath(repositoryRoot)
    return !pathEquals(repositoryRoot, repositoryRootRealPath) ? repositoryRootRealPath : undefined
  } catch {
    return undefined
  }
}

async function openRepository(root: string): Promise<Repository> {
  const git = await getGit()
  const repositoryRoot = await git.getRepositoryRoot(root)
  const repositoryRootRealPath = await getRepositoryRootRealPath(repositoryRoot)
  const dotGit = await git.getRepositoryDotGit(repositoryRoot)
  return new Repository(git.open(repositoryRoot, repositoryRootRealPath, dotGit))
}

const repositories = new Map<string, Promise<Repository>>()
censusTrack('repository.repositories', repositories)

export function getRepository(root: string): Promise<Repository> {
  let repository = repositories.get(root)
  if (!repository) {
    const pending = openRepository(root)
    repositories.set(root, pending)
    pending.catch(() => {
      if (repositories.get(root) === pending) {
        repositories.delete(root)
      }
    })
    repository = pending
  }
  return repository
}

export function toScmGitError(err: unknown): ScmGitError {
  if (err instanceof GitError) {
    const error: { -readonly [K in keyof ScmGitError]: ScmGitError[K] } = { message: err.message }
    if (err.stdout !== undefined) error.stdout = err.stdout
    if (err.stderr !== undefined) error.stderr = err.stderr
    if (err.exitCode !== undefined) error.exitCode = err.exitCode
    if (err.gitErrorCode !== undefined) error.gitErrorCode = err.gitErrorCode
    if (err.gitCommand !== undefined) error.gitCommand = err.gitCommand
    if (err.gitArgs !== undefined) error.gitArgs = err.gitArgs
    return error
  }
  if (err instanceof Error) {
    return { message: err.message }
  }
  return { message: String(err) }
}

function invalid(message: string): ScmResult<never> {
  return { ok: false, error: { message } }
}

function isRoot(root: unknown): root is string {
  return typeof root === 'string' && root.length > 0 && path.isAbsolute(root)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string')
}

function isStashIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
}

function optionalStashIndex(value: unknown): number | undefined | false {
  if (value === undefined || value === null) return undefined
  return isStashIndex(value) ? value : false
}

function isOptional(value: unknown, type: 'string' | 'boolean'): boolean {
  return value === undefined || value === null || typeof value === type
}

export async function scmWritableTarget(root: string, filePath: string): Promise<string> {
  const absolutePath = path.resolve(root, filePath)
  const realRoot = await fs.realpath(root).catch(() => path.resolve(root))
  const realTarget = await resolveExisting(absolutePath)
  if (
    !isInside(root, realTarget)
    || hasDotGitSegment(path.relative(path.resolve(root), absolutePath))
    || hasDotGitSegment(path.relative(realRoot, realTarget))
  ) {
    throw new GitError({ message: 'Path is outside the repository' })
  }
  return absolutePath
}

export function scmIgnoreTargets(root: string, entries: string[]): { rel: string; folder: boolean }[] {
  return entries.map((entry) => {
    const normalized = entry.replace(/\\/g, '/')
    const rel = normalized.replace(/^\/+|\/+$/g, '')
    const absolutePath = path.resolve(root, rel)
    if (!rel || !isDescendant(root, absolutePath) || hasDotGitSegment(rel)) {
      throw new GitError({ message: `Can't ignore ${entry}: it's outside the repository` })
    }
    return { rel, folder: normalized.endsWith('/') }
  })
}

export function scmTrashable(root: string, filePath: string): boolean {
  const absolutePath = path.resolve(root, filePath)
  return isInside(root, path.dirname(absolutePath), { allowRoot: true }) && !hasDotGitSegment(path.relative(root, absolutePath))
}

export async function scmReadable(root: string, filePath: string): Promise<boolean> {
  const absolutePath = path.resolve(root, filePath)
  if (absolutePath === path.resolve(root) || !isDescendant(root, absolutePath)) return false
  return insideRealRoot(root, absolutePath)
}

export async function insideRealRoot(root: string, filePath: string): Promise<boolean> {
  try {
    const [realRoot, real] = await Promise.all([fs.realpath(root), fs.realpath(filePath)])
    return real !== realRoot && isDescendant(realRoot, real)
  } catch {
    return false
  }
}

function badRef(...refs: unknown[]): boolean {
  return refs.some((r) => typeof r === 'string' && r.startsWith('-'))
}

const BAD_REF = 'A ref cannot start with "-".'

function exists(filePath: string): Promise<boolean> {
  return fs.access(filePath).then(() => true, () => false)
}

async function withRepository<T>(root: unknown, fn: (repository: Repository) => Promise<T>): Promise<ScmResult<T>> {
  if (!isRoot(root)) {
    return invalid('Repository root must be an absolute path.')
  }
  try {
    const repository = await getRepository(root)
    return { ok: true, value: await fn(repository) }
  } catch (err) {
    if (err instanceof GitError && err.gitErrorCode === GitErrorCodes.NotAGitRepository) {
      repositories.delete(root)
    }
    return { ok: false, error: toScmGitError(err) }
  }
}

export type GitScmService = Omit<GitScmApi, 'watch' | 'unwatch' | 'onDidChange' | 'onRemoteProgress' | 'revealInFolder'>

export const gitScmService: GitScmService = {
  getState: (root) => withRepository(root, (r) => r.getState()),

  log: (root, options: ScmLogOptions) => {
    if (!options || !isStringArray(options.refNames) || typeof options.maxEntries !== 'number') {
      return Promise.resolve(invalid('Log options need refNames and maxEntries.'))
    }
    if (badRef(...options.refNames)) return Promise.resolve(invalid(BAD_REF))
    const refNames = Array.from(new Set<string>(options.refNames))
    let logOptions: LogOptions = { refNames, maxEntries: options.maxEntries }
    if (typeof options.skip === 'number') {
      logOptions = { ...logOptions, skip: options.skip }
    }
    if (isStringArray(options.paths) && options.paths.length > 0) {
      logOptions = { ...logOptions, paths: options.paths }
    }
    const search = options.search
    if (search && typeof search.text === 'string' && (search.by === 'hash' || search.by === 'message')) {
      return withRepository(root, (r) => r.searchLog({ ...logOptions, refNames }, search))
    }
    return withRepository(root, (r) => r.log(logOptions))
  },

  getCommit: (root, ref) => {
    if (typeof ref !== 'string' || !ref) return Promise.resolve(invalid('A commit ref is required.'))
    if (badRef(ref)) return Promise.resolve(invalid(BAD_REF))
    return withRepository(root, (r) => r.getCommit(ref))
  },

  getMergeBase: (root, ref1, ref2) => {
    if (typeof ref1 !== 'string' || typeof ref2 !== 'string') return Promise.resolve(invalid('Two refs are required.'))
    if (badRef(ref1, ref2)) return Promise.resolve(invalid(BAD_REF))
    return withRepository(root, (r) => r.getMergeBase(ref1, ref2))
  },

  diffBetweenWithStats: (root, ref1, ref2) => {
    if ((ref1 !== undefined && typeof ref1 !== 'string') || typeof ref2 !== 'string' || !ref2) {
      return Promise.resolve(invalid('A target ref is required.'))
    }
    if (badRef(ref1, ref2)) return Promise.resolve(invalid(BAD_REF))
    return withRepository(root, async (r) => r.diffBetweenWithStats(ref1 ?? await r.getEmptyTree(), ref2))
  },

  diffBetween: (root, ref1, ref2) => {
    if ((ref1 !== undefined && typeof ref1 !== 'string') || typeof ref2 !== 'string' || !ref2) {
      return Promise.resolve(invalid('A target ref is required.'))
    }
    if (badRef(ref1, ref2)) return Promise.resolve(invalid(BAD_REF))
    return withRepository(root, async (r) => r.diffBetween(ref1 ?? await r.getEmptyTree(), ref2))
  },

  compareCommits: (root, ref1, ref2) => {
    if (typeof ref1 !== 'string' || !ref1 || typeof ref2 !== 'string' || !ref2) {
      return Promise.resolve(invalid('Two commits are required.'))
    }
    if (badRef(ref1, ref2)) return Promise.resolve(invalid(BAD_REF))
    return withRepository(root, (r) => r.compareCommits(ref1, ref2))
  },

  compareCommitsStats: (root, ref1, ref2, paths) => {
    if (typeof ref1 !== 'string' || !ref1 || typeof ref2 !== 'string' || !ref2) {
      return Promise.resolve(invalid('Two commits are required.'))
    }
    if (badRef(ref1, ref2)) return Promise.resolve(invalid(BAD_REF))
    if (!isStringArray(paths)) return Promise.resolve(invalid('Paths must be a list of strings.'))
    return withRepository(root, (r) => r.compareCommitsStats(ref1, ref2, paths))
  },

  patch: (root, filePath, originalPath, originalRef, modifiedRef) => {
    if ([filePath, originalPath, originalRef, modifiedRef].some((v) => typeof v !== 'string') || !filePath) {
      return Promise.resolve(invalid('A file path and two refs are required.'))
    }
    if (badRef(originalRef, modifiedRef)) return Promise.resolve(invalid(BAD_REF))
    return withRepository(root, (r) => r.patch(filePath, originalPath || filePath, originalRef, modifiedRef))
  },

  explainDiff: (root, filePath, originalPath, originalRef, modifiedRef, checkContent) => {
    if ([filePath, originalPath, originalRef, modifiedRef].some((v) => typeof v !== 'string') || !filePath) {
      return Promise.resolve(invalid('A file path and two refs are required.'))
    }
    if (badRef(originalRef, modifiedRef)) return Promise.resolve(invalid(BAD_REF))
    return withRepository(root, (r) => r.explainDiff(filePath, originalPath || filePath, originalRef, modifiedRef, checkContent === true))
  },

  diffStats: (root, ref1, ref2, paths) => {
    if ((ref1 !== undefined && typeof ref1 !== 'string') || typeof ref2 !== 'string' || !ref2) {
      return Promise.resolve(invalid('A target ref is required.'))
    }
    if (badRef(ref1, ref2)) return Promise.resolve(invalid(BAD_REF))
    if (!isStringArray(paths)) return Promise.resolve(invalid('Paths must be a list of strings.'))
    return withRepository(root, async (r) => r.diffStats(ref1 ?? await r.getEmptyTree(), ref2, paths))
  },

  show: (root, filePath, ref) => {
    if (typeof filePath !== 'string' || !filePath || typeof ref !== 'string') {
      return Promise.resolve(invalid('A file path and ref are required.'))
    }
    if (badRef(ref)) return Promise.resolve(invalid(BAD_REF))
    return withRepository(root, (r) => r.show(filePath, ref))
  },

  showImage: (root, filePath, ref) => {
    if (typeof filePath !== 'string' || !filePath || typeof ref !== 'string') {
      return Promise.resolve(invalid('A file path and ref are required.'))
    }
    if (badRef(ref)) return Promise.resolve(invalid(BAD_REF))
    return withRepository(root, (r) => r.showImage(filePath, ref))
  },

  add: (root, paths) => {
    if (!isStringArray(paths)) return Promise.resolve(invalid('Paths must be a list of strings.'))
    return withRepository(root, (r) => new CommandCenter(r).stage(paths))
  },

  revert: (root, paths) => {
    if (!isStringArray(paths)) return Promise.resolve(invalid('Paths must be a list of strings.'))
    return withRepository(root, (r) => new CommandCenter(r).unstage(paths))
  },

  stageContent: (root, filePath, content, unstage) => {
    if (typeof filePath !== 'string' || !filePath || typeof content !== 'string') {
      return Promise.resolve(invalid('A file path and content are required.'))
    }
    return withRepository(root, (r) => r.stageContent(filePath, content, unstage === true))
  },

  discardOutsideEnv: (root, paths) => {
    if (!isStringArray(paths)) return Promise.resolve(invalid('Paths must be a list of strings.'))
    return withRepository(root, (r) => r.discardOutsideEnv(paths))
  },

  discardEnvLines: (root, filePath, content, expected) => {
    if (typeof filePath !== 'string' || !filePath || typeof content !== 'string' || !isOptional(expected, 'string')) {
      return Promise.resolve(invalid('A file path and content are required.'))
    }
    return withRepository(root, (r) => r.discardEnvLines(filePath, content, expected ?? undefined))
  },

  rm: (root, paths) => {
    if (!isStringArray(paths)) return Promise.resolve(invalid('Paths must be a list of strings.'))
    return withRepository(root, (r) => r.rm(paths))
  },

  commit: (root, message) => {
    if (typeof message !== 'string') return Promise.resolve(invalid('A commit message is required.'))
    return withRepository(root, (r) => new CommandCenter(r).commit(message))
  },

  fetch: (root) => withRepository(root, (r) => new CommandCenter(r).fetch()),

  cancelRemote: async (root) => {
    if (!isRoot(root)) return invalid('Repository root must be an absolute path.')
    const pending = repositories.get(root)
    if (!pending) return { ok: true, value: false }
    try {
      return { ok: true, value: (await pending).cancelRemote() }
    } catch {
      return { ok: true, value: false }
    }
  },

  pull: (root, options) => {
    if (!options || typeof options.rebase !== 'boolean' || typeof options.autoStash !== 'boolean' || !isOptional(options.ignoreRebaseWarning, 'boolean')) {
      return Promise.resolve(invalid('Pull options need rebase and autoStash.'))
    }
    const pullOptions: ScmPullOptions = { rebase: options.rebase, autoStash: options.autoStash, ignoreRebaseWarning: options.ignoreRebaseWarning === true }
    return withRepository(root, (r) => new CommandCenter(r).pull(pullOptions))
  },

  push: (root, options) => {
    if (options !== undefined && (!options || typeof options !== 'object' || !isOptional(options.force, 'boolean'))) {
      return Promise.resolve(invalid('Push options are invalid.'))
    }
    return withRepository(root, (r) => new CommandCenter(r).push({ force: options?.force === true }))
  },

  rebaseAbort: (root) => withRepository(root, (r) => r.rebaseAbort()),

  clean: (root, paths) => {
    if (!isStringArray(paths)) return Promise.resolve(invalid('Paths must be a list of strings.'))
    return withRepository(root, (r) => r.clean(paths))
  },

  merge: (root, ref) => {
    if (typeof ref !== 'string' || !ref) return Promise.resolve(invalid('A branch or tag to merge is required.'))
    if (badRef(ref)) return Promise.resolve(invalid(BAD_REF))
    return withRepository(root, (r) => r.merge(ref))
  },

  mergeAbort: (root) => withRepository(root, (r) => r.mergeAbort()),

  stash: (root, options) => {
    if (!options || typeof options !== 'object' || !isOptional(options.message, 'string') || !isOptional(options.includeUntracked, 'boolean') || !isOptional(options.staged, 'boolean')) {
      return Promise.resolve(invalid('Stash options are invalid.'))
    }
    const stashOptions: ScmStashOptions = {
      message: options.message ?? undefined,
      includeUntracked: options.includeUntracked === true,
      staged: options.staged === true
    }
    return withRepository(root, (r) => new CommandCenter(r).stash(stashOptions))
  },

  stashApply: (root, index) => {
    const stashIndex = optionalStashIndex(index)
    if (stashIndex === false) return Promise.resolve(invalid('A stash index must be a non-negative integer.'))
    return withRepository(root, (r) => new CommandCenter(r).stashApply(stashIndex))
  },

  stashPop: (root, index) => {
    const stashIndex = optionalStashIndex(index)
    if (stashIndex === false) return Promise.resolve(invalid('A stash index must be a non-negative integer.'))
    return withRepository(root, (r) => new CommandCenter(r).stashPop(stashIndex))
  },

  stashDrop: (root, index) => {
    const stashIndex = optionalStashIndex(index)
    if (stashIndex === false) return Promise.resolve(invalid('A stash index must be a non-negative integer.'))
    return withRepository(root, (r) => new CommandCenter(r).stashDrop(stashIndex))
  },

  stashShow: (root, index) => {
    if (!isStashIndex(index)) return Promise.resolve(invalid('A stash index must be a non-negative integer.'))
    return withRepository(root, (r) => new CommandCenter(r).stashShow(index))
  },

  writeFile: (root, filePath, content, expected) => {
    if (typeof filePath !== 'string' || !filePath || typeof content !== 'string' || !isOptional(expected, 'string')) {
      return Promise.resolve(invalid('A file path and content are required.'))
    }
    return withRepository(root, (r) => r.writeFile(filePath, content, expected ?? undefined))
  },

  trackedPaths: (root, entries) => {
    if (!isStringArray(entries)) return Promise.resolve(invalid('Paths must be a list of strings.'))
    return withRepository(root, (r) => r.trackedPaths(entries))
  },

  addToGitignore: (root, entries, untrack) => {
    if (!isStringArray(entries) || entries.length === 0) return Promise.resolve(invalid('Pick at least one file or folder to ignore.'))
    return withRepository(root, (r) => r.addToGitignore(entries, untrack === true))
  },

  updateNeverCommit: (root, change) => {
    if (!change || typeof change !== 'object' || (change.add !== undefined && !isStringArray(change.add)) || (change.remove !== undefined && !isStringArray(change.remove))) {
      return Promise.resolve(invalid('Env Changes updates need add and remove lists of strings.'))
    }
    return withRepository(root, (r) => r.updateNeverCommit({ add: change.add ?? [], remove: change.remove ?? [] }))
  },

  keepEnv: (root, paths) => {
    if (!isStringArray(paths)) return Promise.resolve(invalid('Paths must be a list of strings.'))
    return withRepository(root, (r) => r.keepEnv(paths))
  },

  getSettings: (root) => withRepository(root, (r) => readScmSettings(r.root)),

  setSettings: (root, settings) => withRepository(root, (r) => writeScmSettings(r.root, settings))
}
