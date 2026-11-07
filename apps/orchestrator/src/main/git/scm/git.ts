import { exec as cpExec, type ChildProcess, type SpawnOptions as CpSpawnOptions } from 'node:child_process'
import { promises as fs, realpath } from 'node:fs'
import * as path from 'node:path'
import {
  RefType,
  Status,
  type Branch,
  type Change,
  type Commit,
  type CommitShortStat,
  type DiffChange,
  type Ref,
  type Remote,
  type ScmDiffStat,
  type Stash
} from '@shared/git-scm'
import { GitProcessTimeoutError, killGitProcess, runGitProcess } from '../git-queue'
import { isMacintosh, isWindows, isDescendant, pathEquals, relativePathWithNoFallback, splitGroupsInChunks, splitInChunks, Versions } from './util'

export const MAX_CLI_LENGTH = 30000
export const MAX_DIFF_STAT_PATHSPECS = 200
export const MAX_DIFF_STAT_LENGTH = 20000

export enum GitErrorCodes {
  BadConfigFile = 'BadConfigFile',
  BadRevision = 'BadRevision',
  AuthenticationFailed = 'AuthenticationFailed',
  NoUserNameConfigured = 'NoUserNameConfigured',
  NoUserEmailConfigured = 'NoUserEmailConfigured',
  NoRemoteRepositorySpecified = 'NoRemoteRepositorySpecified',
  NotAGitRepository = 'NotAGitRepository',
  NotASafeGitRepository = 'NotASafeGitRepository',
  NotAtRepositoryRoot = 'NotAtRepositoryRoot',
  Conflict = 'Conflict',
  StashConflict = 'StashConflict',
  UnmergedChanges = 'UnmergedChanges',
  PushRejected = 'PushRejected',
  ForcePushWithLeaseRejected = 'ForcePushWithLeaseRejected',
  ForcePushWithLeaseIfIncludesRejected = 'ForcePushWithLeaseIfIncludesRejected',
  RemoteConnectionError = 'RemoteConnectionError',
  DirtyWorkTree = 'DirtyWorkTree',
  CantOpenResource = 'CantOpenResource',
  GitNotFound = 'GitNotFound',
  CantCreatePipe = 'CantCreatePipe',
  PermissionDenied = 'PermissionDenied',
  CantAccessRemote = 'CantAccessRemote',
  RepositoryNotFound = 'RepositoryNotFound',
  RepositoryIsLocked = 'RepositoryIsLocked',
  BranchNotFullyMerged = 'BranchNotFullyMerged',
  NoRemoteReference = 'NoRemoteReference',
  InvalidBranchName = 'InvalidBranchName',
  BranchAlreadyExists = 'BranchAlreadyExists',
  NoLocalChanges = 'NoLocalChanges',
  NoStashFound = 'NoStashFound',
  LocalChangesOverwritten = 'LocalChangesOverwritten',
  NoUpstreamBranch = 'NoUpstreamBranch',
  IsInSubmodule = 'IsInSubmodule',
  WrongCase = 'WrongCase',
  CantLockRef = 'CantLockRef',
  CantRebaseMultipleBranches = 'CantRebaseMultipleBranches',
  PatchDoesNotApply = 'PatchDoesNotApply',
  NoPathFound = 'NoPathFound',
  UnknownPath = 'UnknownPath',
  EmptyCommitMessage = 'EmptyCommitMessage',
  BranchFastForwardRejected = 'BranchFastForwardRejected',
  BranchNotYetBorn = 'BranchNotYetBorn',
  TagConflict = 'TagConflict',
  CherryPickEmpty = 'CherryPickEmpty',
  CherryPickConflict = 'CherryPickConflict',
  WorktreeContainsChanges = 'WorktreeContainsChanges',
  WorktreeAlreadyExists = 'WorktreeAlreadyExists',
  WorktreeBranchAlreadyUsed = 'WorktreeBranchAlreadyUsed',
  TimedOut = 'TimedOut',
  Cancelled = 'Cancelled'
}

export enum ForcePushMode {
  Force,
  ForceWithLease,
  ForceWithLeaseIfIncludes
}

export interface IGit {
  path: string
  version: string
}

export interface IDotGit {
  readonly path: string
  readonly commonPath?: string
  readonly superProjectPath?: string
  readonly isBare: boolean
}

export interface IFileStatus {
  x: string
  y: string
  path: string
  rename?: string
}

interface MutableRemote extends Remote {
  fetchUrl?: string
  pushUrl?: string
  isReadOnly: boolean
}

export interface LogOptions {
  readonly maxEntries?: number
  readonly path?: string
  readonly range?: string
  readonly reverse?: boolean
  readonly sortByAuthorDate?: boolean
  readonly shortStats?: boolean
  readonly author?: string
  readonly grep?: string
  readonly refNames?: string[]
  readonly paths?: string[]
  readonly maxParents?: number
  readonly skip?: number
  readonly noWalk?: boolean
  readonly grepFixed?: boolean
}

export interface CommitOptions {
  all?: boolean | 'tracked'
  amend?: boolean
  signoff?: boolean
  signCommit?: boolean
  empty?: boolean
  noVerify?: boolean
  requireUserConfig?: boolean
  useEditor?: boolean
  verbose?: boolean
}

export interface RefQuery {
  readonly contains?: string
  readonly count?: number
  readonly pattern?: string | string[]
  readonly sort?: 'alphabetically' | 'committerdate' | 'creatordate'
}

export interface PullOptions {
  readonly unshallow?: boolean
  readonly tags?: boolean
  readonly autoStash?: boolean
}

function parseVersion(raw: string): string {
  return raw.replace(/^git version /, '')
}

function findSpecificGit(path: string, onValidate: (path: string) => boolean): Promise<IGit> {
  if (!onValidate(path)) {
    return Promise.reject<IGit>(new Error(`Path "${path}" is invalid.`))
  }

  return runGitProcess(path, ['--version'], { windowsHide: true }, (child) => new Promise<IGit>((c, e) => {
    const buffers: Buffer[] = []
    child.stdout!.on('data', (b: Buffer) => buffers.push(b))
    child.on('error', cpErrorHandler(e))
    child.on('close', (code) => code ? e(new Error(`Not found. Code: ${code}`)) : c({ path, version: parseVersion(Buffer.concat(buffers).toString('utf8').trim()) }))
  }))
}

function findGitDarwin(onValidate: (path: string) => boolean): Promise<IGit> {
  return new Promise<IGit>((c, e) => {
    cpExec('which git', (err, gitPathBuffer) => {
      if (err) {
        return e(new Error(`Executing "which git" failed: ${err.message}`))
      }

      const path = gitPathBuffer.toString().trim()

      function getVersion(path: string) {
        findSpecificGit(path, onValidate).then(c, e)
      }

      if (path !== '/usr/bin/git') {
        return getVersion(path)
      }

      cpExec('xcode-select -p', (err) => {
        if (err && err.code === 2) {
          return e(new Error('Executing "xcode-select -p" failed with error code 2.'))
        }

        getVersion(path)
      })
    })
  })
}

function findSystemGitWin32(base: string, onValidate: (path: string) => boolean): Promise<IGit> {
  if (!base) {
    return Promise.reject<IGit>('Not found')
  }

  return findSpecificGit(path.join(base, 'Git', 'cmd', 'git.exe'), onValidate)
}

function findGitWin32(onValidate: (path: string) => boolean): Promise<IGit> {
  return findSystemGitWin32(process.env['ProgramW6432'] as string, onValidate)
    .then(undefined, () => findSystemGitWin32(process.env['ProgramFiles(x86)'] as string, onValidate))
    .then(undefined, () => findSystemGitWin32(process.env['ProgramFiles'] as string, onValidate))
    .then(undefined, () => findSystemGitWin32(path.join(process.env['LocalAppData'] as string, 'Programs'), onValidate))
    .then(undefined, () => findSpecificGit('git.exe', onValidate))
}

export async function findGit(hints: string[], onValidate: (path: string) => boolean): Promise<IGit> {
  for (const hint of hints) {
    try {
      return await findSpecificGit(hint, onValidate)
    } catch {
    }
  }

  try {
    switch (process.platform) {
      case 'darwin': return await findGitDarwin(onValidate)
      case 'win32': return await findGitWin32(onValidate)
      default: return await findSpecificGit('git', onValidate)
    }
  } catch {
  }

  throw new Error('Git installation not found.')
}

export interface IExecutionResult<T extends string | Buffer> {
  exitCode: number
  stdout: T
  stderr: string
}

function cpErrorHandler(cb: (reason?: any) => void): (reason?: any) => void {
  return (err) => {
    if (err instanceof GitProcessTimeoutError) {
      err = new GitError({
        error: err,
        message: err.message,
        gitErrorCode: GitErrorCodes.TimedOut,
        gitCommand: err.command,
        gitArgs: [...err.args]
      })
    } else if (/ENOENT/.test(err.message)) {
      err = new GitError({
        error: err,
        message: 'Failed to execute git (ENOENT)',
        gitErrorCode: GitErrorCodes.NotAGitRepository
      })
    }

    cb(err)
  }
}

export interface SpawnOptions extends CpSpawnOptions {
  input?: string
  noOptionalLocks?: boolean
  progress?: boolean
  onSpawn?: (childProcess: ChildProcess) => void
}

async function exec(child: ChildProcess): Promise<IExecutionResult<Buffer>> {
  if (!child.stdout || !child.stderr) {
    throw new GitError({ message: 'Failed to get stdout or stderr from git process.' })
  }

  const disposables: (() => void)[] = []

  const once = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
    ee.once(name, fn)
    disposables.push(() => ee.removeListener(name, fn))
  }

  const on = (ee: NodeJS.EventEmitter, name: string, fn: (...args: any[]) => void) => {
    ee.on(name, fn)
    disposables.push(() => ee.removeListener(name, fn))
  }

  const result: Promise<[number, Buffer, string]> = Promise.all([
    new Promise<number>((c, e) => {
      once(child, 'error', cpErrorHandler(e))
      once(child, 'exit', c)
    }),
    new Promise<Buffer>((c) => {
      const buffers: Buffer[] = []
      on(child.stdout!, 'data', (b: Buffer) => buffers.push(b))
      once(child.stdout!, 'close', () => c(Buffer.concat(buffers)))
    }),
    new Promise<string>((c) => {
      const buffers: Buffer[] = []
      on(child.stderr!, 'data', (b: Buffer) => buffers.push(b))
      once(child.stderr!, 'close', () => c(Buffer.concat(buffers).toString('utf8')))
    })
  ])

  try {
    const [exitCode, stdout, stderr] = await result
    return { exitCode, stdout, stderr }
  } finally {
    for (const dispose of disposables) {
      dispose()
    }
  }
}

export interface IGitErrorData {
  error?: Error
  message?: string
  stdout?: string
  stderr?: string
  exitCode?: number
  gitErrorCode?: string
  gitCommand?: string
  gitArgs?: string[]
}

export class GitError extends Error {

  error?: Error
  stdout?: string
  stderr?: string
  exitCode?: number
  gitErrorCode?: string
  gitCommand?: string
  gitArgs?: string[]

  constructor(data: IGitErrorData) {
    super(data.error?.message || data.message || 'Git error')

    this.error = data.error
    this.stdout = data.stdout
    this.stderr = data.stderr
    this.exitCode = data.exitCode
    this.gitErrorCode = data.gitErrorCode
    this.gitCommand = data.gitCommand
    this.gitArgs = data.gitArgs
  }

  override toString(): string {
    let result = this.message + ' ' + JSON.stringify({
      exitCode: this.exitCode,
      gitErrorCode: this.gitErrorCode,
      gitCommand: this.gitCommand,
      stdout: this.stdout,
      stderr: this.stderr
    }, null, 2)

    if (this.error?.stack) {
      result += this.error.stack
    }

    return result
  }
}

export interface IGitOptions {
  gitPath: string
  version: string
  env?: { [key: string]: string }
}

export function getGitErrorCode(stderr: string): string | undefined {
  if (/Another git process seems to be running in this repository|If no other git process is currently running/.test(stderr)) {
    return GitErrorCodes.RepositoryIsLocked
  } else if (/Authentication failed/i.test(stderr)) {
    return GitErrorCodes.AuthenticationFailed
  } else if (/Not a git repository/i.test(stderr)) {
    return GitErrorCodes.NotAGitRepository
  } else if (/bad config file/.test(stderr)) {
    return GitErrorCodes.BadConfigFile
  } else if (/cannot make pipe for command substitution|cannot create standard input pipe/.test(stderr)) {
    return GitErrorCodes.CantCreatePipe
  } else if (/Repository not found/.test(stderr)) {
    return GitErrorCodes.RepositoryNotFound
  } else if (/unable to access/.test(stderr)) {
    return GitErrorCodes.CantAccessRemote
  } else if (/branch '.+' is not fully merged/.test(stderr)) {
    return GitErrorCodes.BranchNotFullyMerged
  } else if (/Couldn\'t find remote ref/.test(stderr)) {
    return GitErrorCodes.NoRemoteReference
  } else if (/A branch named '.+' already exists/.test(stderr)) {
    return GitErrorCodes.BranchAlreadyExists
  } else if (/'.+' is not a valid branch name/.test(stderr)) {
    return GitErrorCodes.InvalidBranchName
  } else if (/Please,? commit your changes or stash them/.test(stderr)) {
    return GitErrorCodes.DirtyWorkTree
  } else if (/detected dubious ownership in repository at/.test(stderr)) {
    return GitErrorCodes.NotASafeGitRepository
  } else if (/contains modified or untracked files|use --force to delete it/.test(stderr)) {
    return GitErrorCodes.WorktreeContainsChanges
  } else if (/fatal: '[^']+' already exists/.test(stderr)) {
    return GitErrorCodes.WorktreeAlreadyExists
  } else if (/is already used by worktree at/.test(stderr)) {
    return GitErrorCodes.WorktreeBranchAlreadyUsed
  }
  return undefined
}

function sanitizePath(path: string): string {
  return path.replace(/^([a-z]):\\/i, (_, letter) => `${letter.toUpperCase()}:\\`)
}

function sanitizeRelativePath(path: string): string {
  return path.replace(/\\/g, '/')
}

function findRenamesArgs(similarityThreshold: number | undefined): string[] {
  return similarityThreshold ? [`--find-renames=${similarityThreshold}%`] : []
}

export const COMMIT_FORMAT = '%H%n%aN%n%aE%n%at%n%ct%n%P%n%D%n%B'
const STASH_FORMAT = '%H%n%P%n%gd%n%gs%n%at%n%ct'

function uncAuthority(fsPath: string): string {
  const match = /^[\\/]{2}([^\\/]+)/.exec(fsPath)
  return match ? match[1] : ''
}

export class Git {

  readonly path: string
  readonly version: string
  readonly env: { [key: string]: string }
  private _lfsAvailable = false

  constructor(options: IGitOptions) {
    this.path = options.gitPath
    this.version = options.version
    this.env = options.env || {}
  }

  compareGitVersionTo(version: string): -1 | 0 | 1 {
    return Versions.compare(Versions.fromString(this.version), Versions.fromString(version))
  }

  async isLfsAvailable(cwd: string): Promise<boolean> {
    if (!this._lfsAvailable) {
      this._lfsAvailable = await this.exec(cwd, ['lfs', 'version'], { noOptionalLocks: true }).then(() => true, () => false)
    }

    return this._lfsAvailable
  }

  open(repositoryRoot: string, repositoryRootRealPath: string | undefined, dotGit: IDotGit): Repository {
    return new Repository(this, repositoryRoot, repositoryRootRealPath, dotGit)
  }

  async getRepositoryRoot(pathInsidePossibleRepository: string): Promise<string> {
    const result = await this.exec(pathInsidePossibleRepository, ['rev-parse', '--show-toplevel'], { noOptionalLocks: true })

    const repositoryRootPath = path.normalize(result.stdout.trimStart().replace(/[\r\n]+$/, ''))

    if (!pathEquals(pathInsidePossibleRepository, repositoryRootPath) &&
      !isDescendant(repositoryRootPath, pathInsidePossibleRepository) &&
      !isDescendant(pathInsidePossibleRepository, repositoryRootPath) &&
      this.compareGitVersionTo('2.31.0') !== -1) {
      const relativePathResult = await this.exec(pathInsidePossibleRepository, ['rev-parse', '--path-format=relative', '--show-toplevel'], { noOptionalLocks: true })
      return path.resolve(pathInsidePossibleRepository, relativePathResult.stdout.trimStart().replace(/[\r\n]+$/, ''))
    }

    if (isWindows) {
      if (uncAuthority(repositoryRootPath).length !== 0 && uncAuthority(pathInsidePossibleRepository).length === 0) {
        const match = /^[\/]?([a-zA-Z])[:\/\\]/.exec(pathInsidePossibleRepository)
        if (match !== null) {
          const [, letter] = match

          try {
            const networkPath = await new Promise<string | undefined>((resolve) =>
              realpath.native(`${letter}:\\`, { encoding: 'utf8' }, (err, resolvedPath) =>
                resolve(err !== null ? undefined : resolvedPath)
              )
            )
            if (networkPath !== undefined) {
              const isDriveRoot = pathEquals(repositoryRootPath, networkPath)

              return path.normalize(
                repositoryRootPath.replace(
                  networkPath,
                  `${letter.toLowerCase()}:${isDriveRoot || networkPath.endsWith('\\') ? '\\' : ''}`
                )
              )
            }
          } catch { }
        }

        return path.normalize(pathInsidePossibleRepository)
      }
    }

    return repositoryRootPath
  }

  async getRepositoryDotGit(repositoryPath: string): Promise<IDotGit> {
    let dotGitPath: string | undefined, commonDotGitPath: string | undefined, superProjectPath: string | undefined

    const args = ['rev-parse', '--git-dir', '--git-common-dir']
    if (this.compareGitVersionTo('2.13.0') >= 0) {
      args.push('--show-superproject-working-tree')
    }

    const result = await this.exec(repositoryPath, args, { noOptionalLocks: true })
    ;[dotGitPath, commonDotGitPath, superProjectPath] = result.stdout.split('\n').map((r) => r.trim())

    if (!path.isAbsolute(dotGitPath)) {
      dotGitPath = path.join(repositoryPath, dotGitPath)
    }
    dotGitPath = path.normalize(dotGitPath)

    if (commonDotGitPath) {
      if (!path.isAbsolute(commonDotGitPath)) {
        commonDotGitPath = path.join(repositoryPath, commonDotGitPath)
      }
      commonDotGitPath = path.normalize(commonDotGitPath)
    }

    const raw = await fs.readFile(path.join(commonDotGitPath ?? dotGitPath, 'config'), 'utf8')
    const coreSections = GitConfigParser.parse(raw).find((s) => s.name === 'core')
    const isBare = coreSections?.properties['bare'] === 'true'

    return {
      isBare,
      path: dotGitPath,
      commonPath: commonDotGitPath !== dotGitPath ? commonDotGitPath : undefined,
      superProjectPath: superProjectPath ? path.normalize(superProjectPath) : undefined
    }
  }

  async exec(cwd: string, args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
    options = Object.assign({ cwd }, options || {})
    return await this._exec(args, options)
  }

  stream<T>(cwd: string, args: string[], options: SpawnOptions, consume: (child: ChildProcess) => Promise<T>): Promise<T> {
    options = Object.assign({ cwd }, options || {})
    return this.spawn(args, options, consume)
  }

  private async _exec(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
    const bufferResult = await this.spawn(args, options, (child) => {
      options.onSpawn?.(child)

      if (options.input) {
        child.stdin!.on('error', () => undefined)
        child.stdin!.end(options.input, 'utf8')
      }

      return exec(child)
    })

    const result: IExecutionResult<string> = {
      exitCode: bufferResult.exitCode,
      stdout: bufferResult.stdout.toString('utf8'),
      stderr: bufferResult.stderr
    }

    if (bufferResult.exitCode) {
      return Promise.reject<IExecutionResult<string>>(new GitError({
        message: 'Failed to execute git',
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        gitErrorCode: getGitErrorCode(result.stderr),
        gitCommand: args[0],
        gitArgs: options.noOptionalLocks ? ['--no-optional-locks', ...args] : args
      }))
    }

    return result
  }

  spawn<T>(args: string[], options: SpawnOptions, consume: (child: ChildProcess) => Promise<T>): Promise<T> {
    if (!this.path) {
      return Promise.reject<T>(new Error('git could not be found in the system.'))
    }

    if (!options) {
      options = {}
    }

    if (!options.stdio && !options.input) {
      options.stdio = ['ignore', null, null]
    }

    options.env = Object.assign({}, process.env, this.env, options.env || {}, {
      LANGUAGE: 'en',
      LC_ALL: 'en_US.UTF-8',
      LANG: 'en_US.UTF-8',
      GIT_PAGER: 'cat',
      GIT_LITERAL_PATHSPECS: '1'
    })

    const cwd = options.cwd
    if (typeof cwd === 'string') {
      options.cwd = sanitizePath(cwd)
    }

    options.windowsHide = true

    return runGitProcess(this.path, options.noOptionalLocks ? ['--no-optional-locks', ...args] : args, options, consume)
  }
}

let gitPromise: Promise<Git> | undefined

export function getGit(): Promise<Git> {
  if (!gitPromise) {
    const pending = findGit([], () => true).then((info) => new Git({
      gitPath: info.path,
      version: info.version,
      env: { GIT_TERMINAL_PROMPT: '0' }
    }))
    gitPromise = pending
    pending.catch(() => {
      if (gitPromise === pending) {
        gitPromise = undefined
      }
    })
  }
  return gitPromise
}

interface GitConfigSection {
  name: string
  subSectionName?: string
  properties: { [key: string]: string }
}

class GitConfigParser {
  private static readonly _lineSeparator = /\r?\n/

  private static readonly _propertyRegex = /^\s*(\w+)\s*=\s*"?([^"]+)"?$/
  private static readonly _sectionRegex = /^\s*\[\s*([^\]]+?)\s*(\"[^"]+\")*\]\s*$/

  static parse(raw: string): GitConfigSection[] {
    const config: { sections: GitConfigSection[] } = { sections: [] }
    let section: GitConfigSection = { name: 'DEFAULT', properties: {} }

    const addSection = (section?: GitConfigSection) => {
      if (!section) { return }
      config.sections.push(section)
    }

    for (const line of raw.split(GitConfigParser._lineSeparator)) {
      const sectionMatch = line.match(GitConfigParser._sectionRegex)
      if (sectionMatch?.length === 3) {
        addSection(section)
        section = { name: sectionMatch[1], subSectionName: sectionMatch[2]?.replaceAll('"', ''), properties: {} }

        continue
      }

      const propertyMatch = line.match(GitConfigParser._propertyRegex)
      if (propertyMatch?.length === 3 && !Object.keys(section.properties).includes(propertyMatch[1])) {
        section.properties[propertyMatch[1]] = propertyMatch[2]
      }
    }

    addSection(section)

    return config.sections
  }
}

export class GitStatusParser {

  private lastRaw = ''
  private result: IFileStatus[] = []

  get status(): IFileStatus[] {
    return this.result
  }

  update(raw: string): void {
    let i = 0
    let nextI: number | undefined

    raw = this.lastRaw + raw

    while ((nextI = this.parseEntry(raw, i)) !== undefined) {
      i = nextI
    }

    this.lastRaw = raw.substring(i)
  }

  private parseEntry(raw: string, i: number): number | undefined {
    if (i + 4 >= raw.length) {
      return
    }

    let lastIndex: number
    const entry: IFileStatus = {
      x: raw.charAt(i++),
      y: raw.charAt(i++),
      rename: undefined,
      path: ''
    }

    i++

    if (entry.x === 'R' || entry.y === 'R' || entry.x === 'C') {
      lastIndex = raw.indexOf('\0', i)

      if (lastIndex === -1) {
        return
      }

      entry.rename = raw.substring(i, lastIndex)
      i = lastIndex + 1
    }

    lastIndex = raw.indexOf('\0', i)

    if (lastIndex === -1) {
      return
    }

    entry.path = raw.substring(i, lastIndex)

    if (entry.path[entry.path.length - 1] !== '/') {
      this.result.push(entry)
    }

    return lastIndex + 1
  }
}

export function parseGitRemotes(raw: string): MutableRemote[] {
  const remotes: MutableRemote[] = []

  for (const remoteSection of GitConfigParser.parse(raw).filter((s) => s.name === 'remote')) {
    if (remoteSection.subSectionName) {
      remotes.push({
        name: remoteSection.subSectionName,
        fetchUrl: remoteSection.properties['url'],
        pushUrl: remoteSection.properties['pushurl'] ?? remoteSection.properties['url'],
        isReadOnly: false
      })
    }
  }

  return remotes
}

const commitRegex = /([0-9a-f]{40})\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)\n(.*)(?:\n([^]*?))?(?:\x00)(?:\n((?:.*)files? changed(?:.*))$)?/gm

export function parseGitCommits(data: string): Commit[] {
  const commits: Commit[] = []

  let ref
  let authorName
  let authorEmail
  let authorDate
  let commitDate
  let parents
  let refNames
  let message
  let shortStat
  let match

  do {
    match = commitRegex.exec(data)
    if (match === null) {
      break
    }

    ;[, ref, authorName, authorEmail, authorDate, commitDate, parents, refNames, message, shortStat] = match

    if (message[message.length - 1] === '\n') {
      message = message.substring(0, message.length - 1)
    }

    commits.push({
      hash: ` ${ref}`.substring(1),
      message: ` ${message}`.substring(1),
      parents: parents ? parents.split(' ') : [],
      authorDate: Number(authorDate) * 1000,
      authorName: ` ${authorName}`.substring(1),
      authorEmail: ` ${authorEmail}`.substring(1),
      commitDate: Number(commitDate) * 1000,
      refNames: refNames.split(',').map((s) => s.trim()),
      shortStat: shortStat ? parseGitDiffShortStat(shortStat) : undefined
    })
  } while (true)

  return commits
}

const diffShortStatRegex = /(\d+) files? changed(?:, (\d+) insertions?\(\+\))?(?:, (\d+) deletions?\(-\))?/

export function parseGitDiffShortStat(data: string): CommitShortStat {
  const matches = data.trim().match(diffShortStatRegex)

  if (!matches) {
    return { files: 0, insertions: 0, deletions: 0 }
  }

  const [, files, insertions = undefined, deletions = undefined] = matches
  return { files: parseInt(files), insertions: parseInt(insertions ?? '0'), deletions: parseInt(deletions ?? '0') }
}

export interface LsTreeElement {
  mode: string
  type: string
  object: string
  size: string
  file: string
}

export function parseLsTree(raw: string): LsTreeElement[] {
  return raw.split('\n')
    .filter((l) => !!l)
    .map((line) => /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)!)
    .filter((m) => !!m)
    .map(([, mode, type, object, size, file]) => ({ mode, type, object, size, file }))
}

interface LsFilesElement {
  mode: string
  object: string
  stage: string
  file: string
}

const stashRegex = /([0-9a-f]{40})\n(.*)\nstash@{(\d+)}\n(?:(WIP\s)?on\s([^:\n]+):\s)?(.*)\n(\d+)\n(\d+)(?:\x00)/gmi

export function parseGitStashes(raw: string): Stash[] {
  const result: Stash[] = []

  let match: RegExpExecArray | null
  let hash: string
  let parents: string
  let index: string
  let wip: string | undefined
  let branchName: string | undefined
  let description: string
  let authorDate: string
  let commitDate: string

  do {
    match = stashRegex.exec(raw)
    if (match === null) {
      break
    }

    ;[, hash, parents, index, wip, branchName, description, authorDate, commitDate] = match
    result.push({
      hash,
      parents: parents.split(' '),
      index: parseInt(index),
      branchName: (branchName ?? '').trim(),
      description: wip ? `WIP (${description.trim()})` : description.trim(),
      authorDate: authorDate ? Number(authorDate) * 1000 : undefined,
      commitDate: commitDate ? Number(commitDate) * 1000 : undefined
    })
  } while (true)

  return result
}

export function parseLsFiles(raw: string): LsFilesElement[] {
  return raw.split('\n')
    .filter((l) => !!l)
    .map((line) => /^(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)!)
    .filter((m) => !!m)
    .map(([, mode, object, stage, file]) => ({ mode, object, stage, file }))
}

export function parseGitChanges(raw: string): Change[] {
  return parseGitDiffRaw(raw).changes
}

export function parseGitNameStatus(raw: string): Change[] {
  let index = 0
  const result: Change[] = []
  const segments = raw.trim().split('\x00').filter((s) => s)

  segmentsLoop:
  while (index < segments.length - 1) {
    const change = segments[index++]
    const resourcePath = segments[index++]

    if (!change || !resourcePath) {
      break
    }

    const originalPath = sanitizeRelativePath(resourcePath)

    let filePath = originalPath
    let renamePath = originalPath
    let status: Status = Status.UNTRACKED

    switch (change[0]) {
      case 'A':
        status = Status.INDEX_ADDED
        break

      case 'M':
        status = Status.MODIFIED
        break

      case 'D':
        status = Status.DELETED
        break

      case 'R': {
        if (index >= segments.length) {
          break
        }

        const newPath = segments[index++]
        if (!newPath) {
          break
        }

        status = Status.INDEX_RENAMED
        filePath = renamePath = sanitizeRelativePath(newPath)
        break
      }
      default:
        break segmentsLoop
    }

    result.push({ status, path: filePath, originalPath, renamePath })
  }

  return result
}

export function parseGitChangesRaw(raw: string): DiffChange[] {
  const { changes, numStats } = parseGitDiffRaw(raw)

  return changes.map((change) => ({
    ...change,
    insertions: numStats.get(change.path)?.insertions ?? 0,
    deletions: numStats.get(change.path)?.deletions ?? 0
  }))
}

export function parseGitNumstat(raw: string): ScmDiffStat[] {
  const stats: ScmDiffStat[] = []
  const segments = raw.split('\x00')
  let index = 0

  while (index < segments.length) {
    const segment = segments[index++]
    const first = segment.indexOf('\t')
    const second = first < 0 ? -1 : segment.indexOf('\t', first + 1)
    if (second < 0) {
      continue
    }

    const insertions = segment.substring(0, first)
    const deletions = segment.substring(first + 1, second)
    let filePath = segment.substring(second + 1)

    if (filePath === '') {
      index++
      filePath = segments[index++] ?? ''
    }

    if (!filePath) {
      continue
    }

    const binary = insertions === '-' && deletions === '-'
    stats.push({
      path: sanitizeRelativePath(filePath),
      insertions: binary ? 0 : parseInt(insertions, 10) || 0,
      deletions: binary ? 0 : parseInt(deletions, 10) || 0,
      binary
    })
  }

  return stats
}

function parseGitDiffRaw(raw: string): { changes: Change[]; numStats: Map<string, { insertions: number; deletions: number }> } {
  const changes: Change[] = []
  const numStats = new Map<string, { insertions: number; deletions: number }>()

  let index = 0
  const segments = raw.trim().split('\x00').filter((s) => s)

  segmentsLoop:
  while (index < segments.length) {
    const segment = segments[index++]
    if (!segment) {
      break
    }

    if (segment.startsWith(':')) {
      const [, , , , change] = segment.split(' ')
      const filePath = segments[index++]
      const originalPath = sanitizeRelativePath(filePath)

      let resourcePath = originalPath
      let renamePath = originalPath
      let status: Status = Status.UNTRACKED

      switch (change[0]) {
        case 'A':
          status = Status.INDEX_ADDED
          break
        case 'M':
          status = Status.MODIFIED
          break
        case 'D':
          status = Status.DELETED
          break
        case 'R': {
          if (index >= segments.length) {
            break
          }
          const newPath = segments[index++]
          if (!newPath) {
            break
          }

          status = Status.INDEX_RENAMED
          resourcePath = renamePath = sanitizeRelativePath(newPath)
          break
        }
        default:
          break segmentsLoop
      }

      changes.push({ status, path: resourcePath, originalPath, renamePath })
    } else {
      const [insertions, deletions, filePath] = segment.split('\t')

      let numstatPath: string
      if (filePath === '') {
        index++

        const renamePath = segments[index++]
        numstatPath = sanitizeRelativePath(renamePath)
      } else {
        numstatPath = sanitizeRelativePath(filePath)
      }

      numStats.set(numstatPath, {
        insertions: insertions === '-' ? 0 : parseInt(insertions),
        deletions: deletions === '-' ? 0 : parseInt(deletions)
      })
    }
  }

  return { changes, numStats }
}

const REFS_FORMAT = '%(refname)%00%(objectname)%00%(*objectname)'

export function parseRefs(data: string): (Ref | Branch)[] {
  const refRegex = /^(refs\/[^\0]+)\0([0-9a-f]{40})\0([0-9a-f]{40})?(?:\0(.*))?$/gm

  const headRegex = /^refs\/heads\/([^ ]+)$/
  const remoteHeadRegex = /^refs\/remotes\/([^/]+)\/([^ ]+)$/
  const tagRegex = /^refs\/tags\/([^ ]+)$/
  const statusRegex = /\[(?:ahead ([0-9]+))?[,\s]*(?:behind ([0-9]+))?]|\[gone]/

  let ref: string | undefined
  let commitHash: string | undefined
  let tagCommitHash: string | undefined
  let details: string | undefined
  let status: string | undefined

  const refs: (Ref | Branch)[] = []

  let match: RegExpExecArray | null
  let refMatch: RegExpExecArray | null

  do {
    match = refRegex.exec(data)
    if (match === null) {
      break
    }

    ;[, ref, commitHash, tagCommitHash, details] = match
    status = details?.split('\0')[8]

    if (refMatch = headRegex.exec(ref)) {
      const [, aheadCount, behindCount] = statusRegex.exec(status ?? '') ?? []
      const ahead = status ? aheadCount ? Number(aheadCount) : 0 : undefined
      const behind = status ? behindCount ? Number(behindCount) : 0 : undefined
      refs.push({ name: refMatch[1], commit: commitHash, ahead, behind, type: RefType.Head })
    } else if (refMatch = remoteHeadRegex.exec(ref)) {
      const name = `${refMatch[1]}/${refMatch[2]}`
      refs.push({ name, remote: refMatch[1], commit: commitHash, type: RefType.RemoteHead })
    } else if (refMatch = tagRegex.exec(ref)) {
      refs.push({ name: refMatch[1], commit: tagCommitHash ?? commitHash, type: RefType.Tag })
    }
  } while (true)

  return refs
}

export class Repository {
  private _isUsingRefTable = false

  constructor(
    private _git: Git,
    private repositoryRoot: string,
    private repositoryRootRealPath: string | undefined,
    readonly dotGit: IDotGit
  ) { }

  get git(): Git {
    return this._git
  }

  get root(): string {
    return this.repositoryRoot
  }

  get rootRealPath(): string | undefined {
    return this.repositoryRootRealPath
  }

  async exec(args: string[], options: SpawnOptions = {}): Promise<IExecutionResult<string>> {
    return await this.git.exec(this.repositoryRoot, args, options)
  }

  stream<T>(args: string[], options: SpawnOptions, consume: (child: ChildProcess) => Promise<T>): Promise<T> {
    return this.git.stream(this.repositoryRoot, args, options, consume)
  }

  spawn<T>(args: string[], options: SpawnOptions, consume: (child: ChildProcess) => Promise<T>): Promise<T> {
    return this.git.spawn(args, options, consume)
  }

  async log(options?: LogOptions): Promise<Commit[]> {
    const spawnOptions: SpawnOptions = { noOptionalLocks: true }
    const args = ['-c', 'i18n.logOutputEncoding=UTF-8', 'log', `--format=${COMMIT_FORMAT}`, '-z']

    if (options?.shortStats) {
      args.push('--shortstat')

      if (this._git.compareGitVersionTo('2.31') !== -1) {
        args.push('--diff-merges=first-parent')
      }
    }

    if (options?.reverse) {
      args.push('--reverse', '--ancestry-path')
    }

    if (options?.sortByAuthorDate) {
      args.push('--author-date-order')
    }

    if (options?.range) {
      args.push(options.range)
    } else {
      args.push(`-n${options?.maxEntries ?? 32}`)
    }

    if (options?.author) {
      args.push(`--author=${options.author}`)
    }

    if (options?.grep) {
      args.push(`--grep=${options.grep}`)
      args.push(options.grepFixed ? '--fixed-strings' : '--extended-regexp')
      args.push('--regexp-ignore-case')
    }

    if (typeof options?.maxParents === 'number') {
      args.push(`--max-parents=${options.maxParents}`)
    }

    if (typeof options?.skip === 'number') {
      args.push(`--skip=${options.skip}`)
    }

    if (options?.noWalk) {
      args.push('--no-walk')
    }

    const pathspecs = (options?.paths ?? []).map((p) => this.sanitizeRelativePath(p))
    if (pathspecs.length > 0) {
      args.push('--parents')
    }

    if (options?.refNames) {
      args.push('--topo-order')
      args.push('--decorate=full')

      spawnOptions.input = pathspecs.length > 0
        ? [...options.refNames, '--', ...pathspecs].join('\n')
        : options.refNames.join('\n')
      args.push('--stdin')
    } else if (pathspecs.length > 0) {
      args.push('--', ...pathspecs)
    }

    if (options?.path) {
      args.push('--', options.path)
    }

    const result = await this.exec(args, spawnOptions)
    if (result.exitCode) {
      return []
    }

    return parseGitCommits(result.stdout)
  }

  async findCommitsByHashPrefix(prefix: string, refNames: string[], limit: number): Promise<string[]> {
    const needle = prefix.toLowerCase()
    const result = await this.exec(['log', '--format=%H', '--stdin'], { noOptionalLocks: true, input: refNames.join('\n') })
    if (result.exitCode) {
      return []
    }
    const out: string[] = []
    for (const line of result.stdout.split('\n')) {
      if (line.startsWith(needle)) {
        out.push(line)
        if (out.length >= limit) break
      }
    }
    return out
  }

  async buffer(ref: string, filePath: string): Promise<Buffer> {
    const relativePath = this.sanitizeRelativePath(filePath)
    const { exitCode, stdout, stderr } = await this.stream(['show', '--textconv', `${ref}:${relativePath}`], { noOptionalLocks: true }, (child) => {
      if (!child.stdout) {
        return Promise.reject<IExecutionResult<Buffer>>('Can\'t open file from git')
      }

      return exec(child)
    })

    if (exitCode) {
      const err = new GitError({
        message: 'Could not show object.',
        exitCode
      })

      if (/exists on disk, but not in/.test(stderr)) {
        err.gitErrorCode = GitErrorCodes.WrongCase
      }

      return Promise.reject<Buffer>(err)
    }

    return stdout
  }

  async blob(ref: string, filePath: string): Promise<Buffer> {
    const args = ['cat-file', 'blob', `${ref}:${this.sanitizeRelativePath(filePath)}`]
    const { exitCode, stdout, stderr } = await this.stream(args, { noOptionalLocks: true }, exec)

    if (exitCode) {
      throw new GitError({
        message: 'Could not read object.',
        stderr,
        exitCode,
        gitErrorCode: getGitErrorCode(stderr),
        gitCommand: 'cat-file',
        gitArgs: ['--no-optional-locks', ...args]
      })
    }

    return stdout
  }

  async lfsSmudge(filePath: string, pointer: Buffer): Promise<Buffer> {
    const args = ['lfs', 'smudge', '--', this.sanitizeRelativePath(filePath)]
    const { exitCode, stdout, stderr } = await this.stream(args, {
      noOptionalLocks: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { GIT_LFS_SKIP_SMUDGE: '0' }
    }, (child) => {
      child.stdin!.on('error', () => undefined)
      child.stdin!.end(pointer)

      return exec(child)
    })

    if (exitCode) {
      throw new GitError({
        message: 'Git LFS couldn\'t download this image.',
        stderr,
        exitCode,
        gitErrorCode: getGitErrorCode(stderr),
        gitCommand: 'lfs',
        gitArgs: ['--no-optional-locks', ...args]
      })
    }

    return stdout
  }

  async indexContent(filePath: string): Promise<Buffer> {
    const args = ['cat-file', '--filters', `:0:${this.sanitizeRelativePath(filePath)}`]
    const { exitCode, stdout, stderr } = await this.stream(args, { noOptionalLocks: true }, exec)

    if (exitCode) {
      throw new GitError({
        message: 'Could not read the file from the index.',
        stderr,
        exitCode,
        gitErrorCode: getGitErrorCode(stderr),
        gitCommand: 'cat-file',
        gitArgs: ['--no-optional-locks', ...args]
      })
    }

    return stdout
  }

  async indexEntries(paths: string[]): Promise<Map<string, { mode: string; object: string; unmerged: boolean }>> {
    const entries = new Map<string, { mode: string; object: string; unmerged: boolean }>()
    const pathspecs = paths.map((p) => this.sanitizeRelativePath(p))

    for (const chunk of splitInChunks(pathspecs, MAX_CLI_LENGTH)) {
      const { stdout } = await this.exec(['ls-files', '--stage', '-z', '--', ...chunk], { noOptionalLocks: true })

      for (const record of stdout.split('\0')) {
        const match = /^(\d+) ([0-9a-f]+) (\d)\t(.*)$/s.exec(record)
        if (!match) {
          continue
        }

        const [, mode, object, stage, file] = match
        const previous = entries.get(file)
        entries.set(file, { mode, object, unmerged: stage !== '0' || !!previous?.unmerged })
      }
    }

    return entries
  }

  async stagedPaths(paths: string[]): Promise<Set<string>> {
    const staged = new Set<string>()
    const pathspecs = paths.map((p) => this.sanitizeRelativePath(p))

    for (const chunk of splitInChunks(pathspecs, MAX_CLI_LENGTH)) {
      const { stdout } = await this.exec(['diff', '--cached', '--name-only', '--no-renames', '-z', '--', ...chunk], { noOptionalLocks: true })

      for (const file of stdout.split('\0')) {
        if (file) {
          staged.add(file)
        }
      }
    }

    return staged
  }

  async checkAttr(paths: string[], attributes: string[]): Promise<Map<string, Map<string, string>>> {
    const result = new Map<string, Map<string, string>>()
    if (paths.length === 0 || attributes.length === 0) {
      return result
    }

    const input = paths.map((p) => `${this.sanitizeRelativePath(p)}\0`).join('')
    const { stdout } = await this.exec(['check-attr', '-z', '--stdin', ...attributes], { noOptionalLocks: true, input })
    const fields = stdout.split('\0')

    for (let i = 0; i + 2 < fields.length; i += 3) {
      const file = fields[i]
      let values = result.get(file)
      if (!values) {
        values = new Map()
        result.set(file, values)
      }
      values.set(fields[i + 1], fields[i + 2])
    }

    return result
  }

  async mergeFile(current: string, base: string, other: string, labels: [string, string, string]): Promise<{ content: Buffer; conflicts: number }> {
    const args = ['merge-file', '-p', '-L', labels[0], '-L', labels[1], '-L', labels[2], '--', current, base, other]
    const { exitCode, stdout, stderr } = await this.stream(args, { noOptionalLocks: true }, exec)

    if (!Number.isInteger(exitCode) || exitCode < 0 || exitCode > 127) {
      throw new GitError({
        message: 'Could not merge the file.',
        stderr,
        exitCode,
        gitErrorCode: getGitErrorCode(stderr),
        gitCommand: 'merge-file',
        gitArgs: ['--no-optional-locks', ...args]
      })
    }

    return { content: stdout, conflicts: exitCode }
  }

  async hashObject(filePath: string, content: Buffer): Promise<string> {
    const args = ['hash-object', '-w', '--stdin', `--path=${this.sanitizeRelativePath(filePath)}`]
    const { exitCode, stdout, stderr } = await this.stream(args, { stdio: ['pipe', 'pipe', 'pipe'] }, (child) => {
      child.stdin!.on('error', () => undefined)
      child.stdin!.end(content)

      return exec(child)
    })

    if (exitCode) {
      throw new GitError({
        message: 'Could not write the file to the object database.',
        stderr,
        exitCode,
        gitErrorCode: getGitErrorCode(stderr),
        gitCommand: 'hash-object',
        gitArgs: args
      })
    }

    return stdout.toString('utf8').trim()
  }

  async updateIndexCacheInfo(mode: string, object: string, filePath: string): Promise<void> {
    await this.exec(['update-index', '--cacheinfo', `${mode},${object},${this.sanitizeRelativePath(filePath)}`])
  }

  async getObjectDetails(treeish: string, path: string): Promise<{ mode: string; object: string; size: number }> {
    if (!treeish || treeish === ':1' || treeish === ':2' || treeish === ':3') {
      const elements = await this.lsfiles(path)

      if (elements.length === 0) {
        throw new GitError({ message: 'Path not known by git', gitErrorCode: GitErrorCodes.UnknownPath })
      }

      const { mode, object } = treeish !== ''
        ? elements.find((e) => e.stage === treeish.substring(1)) ?? elements[0]
        : elements[0]

      const catFile = await this.exec(['cat-file', '-s', object], { noOptionalLocks: true })
      const size = parseInt(catFile.stdout)

      return { mode, object, size }
    }

    const elements = await this.lstree(treeish, path)

    if (elements.length === 0) {
      throw new GitError({ message: 'Path not known by git', gitErrorCode: GitErrorCodes.UnknownPath })
    }

    const { mode, object, size } = elements[0]
    return { mode, object, size: parseInt(size) || 0 }
  }

  async lstree(treeish: string, path?: string, options?: { recursive?: boolean }): Promise<LsTreeElement[]> {
    const args = ['ls-tree', '-l']

    if (options?.recursive) {
      args.push('-r')
    }

    args.push(treeish)

    if (path) {
      args.push('--', this.sanitizeRelativePath(path))
    }

    const { stdout } = await this.exec(args, { noOptionalLocks: true })
    return parseLsTree(stdout)
  }

  async lsfiles(path: string): Promise<LsFilesElement[]> {
    const args = ['ls-files', '--stage']
    const relativePath = this.sanitizeRelativePath(path)

    if (relativePath) {
      args.push('--', relativePath)
    }

    const { stdout } = await this.exec(args, { noOptionalLocks: true })
    return parseLsFiles(stdout)
  }

  async diffBetweenWithStats(ref: string, options: { path?: string; similarityThreshold?: number }): Promise<DiffChange[]> {
    const args = ['diff', '--raw', '--numstat', '--diff-filter=ADMR', '-z']

    if (options.similarityThreshold) {
      args.push(`--find-renames=${options.similarityThreshold}%`)
    }

    args.push(...[ref, '--'])
    if (options.path) {
      args.push(this.sanitizeRelativePath(options.path))
    }

    const gitResult = await this.exec(args, { noOptionalLocks: true })
    if (gitResult.exitCode) {
      return []
    }

    return parseGitChangesRaw(gitResult.stdout)
  }

  async diffTrees(treeish1: string, treeish2?: string, options?: { similarityThreshold?: number }): Promise<DiffChange[]> {
    const args = ['diff-tree', '-r', '--raw', '--numstat', '--diff-filter=ADMR', '-z']

    if (options?.similarityThreshold) {
      args.push(`--find-renames=${options.similarityThreshold}%`)
    }

    args.push(treeish1)

    if (treeish2) {
      args.push(treeish2)
    }

    args.push('--')

    const gitResult = await this.exec(args, { noOptionalLocks: true })
    if (gitResult.exitCode) {
      return []
    }

    return parseGitChangesRaw(gitResult.stdout)
  }

  async diffBetween(ref: string, options: { similarityThreshold?: number } = {}): Promise<Change[]> {
    const args = ['diff', '--raw', '--diff-filter=ADMR', '-z', ...findRenamesArgs(options.similarityThreshold), ref, '--']
    const gitResult = await this.exec(args, { noOptionalLocks: true })
    return parseGitChanges(gitResult.stdout)
  }

  async diffTreesWithoutStats(treeish1: string, treeish2: string, options: { similarityThreshold?: number } = {}): Promise<Change[]> {
    const args = ['diff-tree', '-r', '--raw', '--diff-filter=ADMR', '-z', ...findRenamesArgs(options.similarityThreshold), treeish1, treeish2, '--']
    const gitResult = await this.exec(args, { noOptionalLocks: true })
    return parseGitChanges(gitResult.stdout)
  }

  diffBetweenNumstat(ref: string, pathGroups: string[][], options: { similarityThreshold?: number } = {}): Promise<ScmDiffStat[]> {
    return this.numstat(['diff', '--numstat', '--diff-filter=ADMR', '-z', ...findRenamesArgs(options.similarityThreshold), ref], pathGroups)
  }

  diffTreesNumstat(treeish1: string, treeish2: string, pathGroups: string[][], options: { similarityThreshold?: number } = {}): Promise<ScmDiffStat[]> {
    return this.numstat(['diff-tree', '-r', '--numstat', '--diff-filter=ADMR', '-z', ...findRenamesArgs(options.similarityThreshold), treeish1, treeish2], pathGroups)
  }

  private async numstat(args: string[], pathGroups: string[][]): Promise<ScmDiffStat[]> {
    const pathspecs = pathGroups.map((group) => group.map((p) => this.sanitizeRelativePath(p)))
    const stats: ScmDiffStat[] = []

    for (const chunk of splitGroupsInChunks(pathspecs, MAX_DIFF_STAT_PATHSPECS, MAX_DIFF_STAT_LENGTH)) {
      const gitResult = await this.exec([...args, '--', ...chunk], { noOptionalLocks: true })
      stats.push(...parseGitNumstat(gitResult.stdout))
    }

    return stats
  }

  async getMergeBase(ref1: string, ref2: string, ...refs: string[]): Promise<string | undefined> {
    try {
      const args = ['merge-base']
      if (refs.length !== 0) {
        args.push('--octopus')
        args.push(...refs)
      }

      args.push(ref1, ref2)

      const result = await this.exec(args, { noOptionalLocks: true })

      return result.stdout.trim()
    }
    catch (err) {
      return undefined
    }
  }

  async add(paths: string[], opts?: { update?: boolean }): Promise<void> {
    const args = ['add']

    if (opts && opts.update) {
      args.push('-u')
    } else {
      args.push('-A')
    }

    if (paths && paths.length) {
      for (const chunk of splitInChunks(paths.map((p) => this.sanitizeRelativePath(p)), MAX_CLI_LENGTH)) {
        await this.exec([...args, '--', ...chunk])
      }
    } else {
      await this.exec([...args, '--', '.'])
    }
  }

  async commit(message: string | undefined, opts: CommitOptions = Object.create(null)): Promise<void> {
    const args = ['commit', '--quiet']
    const options: SpawnOptions = {}

    if (message) {
      options.input = message
      args.push('--allow-empty-message', '--file', '-')
    }

    if (opts.verbose) {
      args.push('--verbose')
    }

    if (opts.all) {
      args.push('--all')
    }

    if (opts.amend) {
      args.push('--amend')
    }

    if (!opts.useEditor) {
      if (!message) {
        if (opts.amend) {
          args.push('--no-edit')
        } else {
          options.input = ''
          args.push('--file', '-')
        }
      }

      args.push('--allow-empty-message')
    }

    if (opts.signoff) {
      args.push('--signoff')
    }

    if (opts.signCommit !== undefined) {
      if (opts.signCommit) {
        args.push('-S')
      } else {
        args.push('--no-gpg-sign')
      }
    }

    if (opts.empty) {
      args.push('--allow-empty')
    }

    if (opts.noVerify) {
      args.push('--no-verify')
    }

    if (opts.requireUserConfig ?? true) {
      args.splice(0, 0, '-c', 'user.useConfigOnly=true')
    }

    try {
      await this.exec(args, options)
    } catch (commitErr) {
      await this.handleCommitError(commitErr)
    }
  }

  private async handleCommitError(commitErr: unknown): Promise<void> {
    if (commitErr instanceof GitError && /not possible because you have unmerged files/.test(commitErr.stderr || '')) {
      commitErr.gitErrorCode = GitErrorCodes.UnmergedChanges
      throw commitErr
    } else if (commitErr instanceof GitError && /Aborting commit due to empty commit message/.test(commitErr.stderr || '')) {
      commitErr.gitErrorCode = GitErrorCodes.EmptyCommitMessage
      throw commitErr
    }

    try {
      await this.exec(['config', '--get-all', 'user.name'], { noOptionalLocks: true })
    } catch (err: any) {
      err.gitErrorCode = GitErrorCodes.NoUserNameConfigured
      throw err
    }

    try {
      await this.exec(['config', '--get-all', 'user.email'], { noOptionalLocks: true })
    } catch (err: any) {
      err.gitErrorCode = GitErrorCodes.NoUserEmailConfigured
      throw err
    }

    throw commitErr
  }

  async revert(treeish: string, paths: string[]): Promise<void> {
    const result = await this.exec(['branch'], { noOptionalLocks: true })
    let args: string[]

    if (!result.stdout) {
      args = ['rm', '--cached', '-r']
    } else {
      args = ['reset', '-q', treeish]
    }

    try {
      if (paths && paths.length > 0) {
        for (const chunk of splitInChunks(paths.map((p) => this.sanitizeRelativePath(p)), MAX_CLI_LENGTH)) {
          await this.exec([...args, '--', ...chunk])
        }
      } else {
        await this.exec([...args, '--', '.'])
      }
    } catch (err: any) {
      if (/([^:]+: needs merge\n)+/m.test(err.stdout || '')) {
        return
      }

      throw err
    }
  }

  async stage(path: string, data: string): Promise<void> {
    const relativePath = this.sanitizeRelativePath(path)
    const { exitCode, stdout } = await this.exec(['hash-object', '--stdin', '-w', '--path', relativePath], { input: data })
    const hash = stdout.trim()

    if (exitCode) {
      throw new GitError({ message: 'Could not hash object.', exitCode })
    }

    const treeish = await this.getCommit('HEAD').then(() => 'HEAD', () => '')
    let mode: string
    let add = ''

    try {
      const details = await this.getObjectDetails(treeish, path)
      mode = details.mode
    } catch (err: any) {
      if (err.gitErrorCode !== GitErrorCodes.UnknownPath) {
        throw err
      }

      mode = '100644'
      add = '--add'
    }

    await this.exec(['update-index', ...(add ? [add] : []), '--cacheinfo', mode, hash, relativePath])
  }

  async rm(paths: string[]): Promise<void> {
    const args = ['rm', '--']

    if (!paths || !paths.length) {
      return
    }

    args.push(...paths.map((p) => this.sanitizeRelativePath(p)))

    await this.exec(args)
  }

  async rebaseAbort(): Promise<void> {
    await this.exec(['rebase', '--abort'])
  }

  async rebaseContinue(): Promise<void> {
    const args = ['rebase', '--continue']

    try {
      await this.exec(args, { env: { GIT_EDITOR: 'true' } })
    } catch (commitErr) {
      await this.handleCommitError(commitErr)
    }
  }

  async mergeAbort(): Promise<void> {
    await this.exec(['merge', '--abort'])
  }

  async clean(paths: string[]): Promise<void> {
    const pathsByGroup = new Map<string, string[]>()
    for (const p of paths.map(sanitizePath)) {
      const dir = path.dirname(p)
      const group = pathsByGroup.get(dir)
      if (group) {
        group.push(p)
      } else {
        pathsByGroup.set(dir, [p])
      }
    }

    const args = ['clean', '-f', '-q']
    const promises: Promise<unknown>[] = []

    for (const group of pathsByGroup.values()) {
      for (const chunk of splitInChunks(group.map((p) => this.sanitizeRelativePath(p)), MAX_CLI_LENGTH)) {
        promises.push(this.exec([...args, '--', ...chunk]))
      }
    }

    await Promise.all(promises)
  }

  async checkout(treeish: string, paths: string[], opts: { track?: boolean; detached?: boolean } = Object.create(null)): Promise<void> {
    const args = ['checkout', '-q']

    if (opts.track) {
      args.push('--track')
    }

    if (opts.detached) {
      args.push('--detach')
    }

    if (treeish) {
      args.push(treeish)
    }

    try {
      if (paths && paths.length > 0) {
        for (const chunk of splitInChunks(paths.map((p) => this.sanitizeRelativePath(p)), MAX_CLI_LENGTH)) {
          await this.exec([...args, '--', ...chunk])
        }
      } else {
        await this.exec(args)
      }
    } catch (err: any) {
      if (/Please,? commit your changes or stash them/.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.DirtyWorkTree
      } else if (/You are on a branch yet to be born/.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.BranchNotYetBorn
      }

      throw err
    }
  }

  async merge(ref: string): Promise<void> {
    const args = ['merge', ref]

    try {
      await this.exec(args)
    } catch (err: any) {
      if (/^CONFLICT /m.test(err.stdout || '')) {
        err.gitErrorCode = GitErrorCodes.Conflict
      }

      throw err
    }
  }

  async fetch(options: { remote?: string; ref?: string; all?: boolean; prune?: boolean; depth?: number } = {}, spawnOptions: SpawnOptions = {}): Promise<void> {
    const args = ['fetch']

    if (spawnOptions.progress) {
      args.push('--progress')
    }

    if (options.remote) {
      args.push(options.remote)

      if (options.ref) {
        args.push(options.ref)
      }
    } else if (options.all) {
      args.push('--all')
    }

    if (options.prune) {
      args.push('--prune')
    }

    if (typeof options.depth === 'number') {
      args.push(`--depth=${options.depth}`)
    }

    try {
      await this.exec(args, spawnOptions)
    } catch (err: any) {
      if (/No remote repository specified\./.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.NoRemoteRepositorySpecified
      } else if (/Could not read from remote repository/.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.RemoteConnectionError
      } else if (/! \[rejected\].*\(non-fast-forward\)/m.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.BranchFastForwardRejected
      }

      throw err
    }
  }

  async pull(rebase?: boolean, remote?: string, branch?: string, options: PullOptions = {}, spawnOptions: SpawnOptions = {}): Promise<boolean> {
    const args = ['pull']

    if (spawnOptions.progress) {
      args.push('--progress')
    }

    if (options.tags) {
      args.push('--tags')
    }

    if (options.unshallow) {
      args.push('--unshallow')
    }

    if (options.autoStash && this._git.compareGitVersionTo('2.27.0') !== -1) {
      args.push('--autostash')
    }

    if (rebase) {
      args.push('-r')
    } else if (rebase === false) {
      args.push('--no-rebase')
    }

    if (remote && branch) {
      args.push(remote)
      args.push(branch)
    }

    try {
      const result = await this.exec(args, spawnOptions)
      return !/Already up to date/i.test(result.stdout)
    } catch (err: any) {
      if (/^CONFLICT \([^)]+\): \b/m.test(err.stdout || '')) {
        err.gitErrorCode = GitErrorCodes.Conflict
      } else if (/Please tell me who you are\./.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.NoUserNameConfigured
      } else if (/Could not read from remote repository/.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.RemoteConnectionError
      } else if (/Pull(?:ing)? is not possible because you have unmerged files|Cannot pull with rebase: You have unstaged changes|Your local changes to the following files would be overwritten|Please, commit your changes before you can merge/i.test(err.stderr)) {
        err.stderr = err.stderr.replace(/Cannot pull with rebase: You have unstaged changes/i, 'Cannot pull with rebase, you have unstaged changes')
        err.gitErrorCode = GitErrorCodes.DirtyWorkTree
      } else if (/cannot lock ref|unable to update local ref/i.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.CantLockRef
      } else if (/cannot rebase onto multiple branches/i.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.CantRebaseMultipleBranches
      } else if (/! \[rejected\].*\(would clobber existing tag\)/m.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.TagConflict
      }

      throw err
    }
  }

  async push(remote?: string, name?: string, setUpstream: boolean = false, followTags = false, forcePushMode?: ForcePushMode, tags = false, spawnOptions: SpawnOptions = {}): Promise<void> {
    const args = ['push']

    if (spawnOptions.progress) {
      args.push('--progress')
    }

    if (forcePushMode === ForcePushMode.ForceWithLease || forcePushMode === ForcePushMode.ForceWithLeaseIfIncludes) {
      args.push('--force-with-lease')
      if (forcePushMode === ForcePushMode.ForceWithLeaseIfIncludes && this._git.compareGitVersionTo('2.30') !== -1) {
        args.push('--force-if-includes')
      }
    } else if (forcePushMode === ForcePushMode.Force) {
      args.push('--force')
    }

    if (setUpstream) {
      args.push('-u')
    }

    if (followTags) {
      args.push('--follow-tags')
    }

    if (tags) {
      args.push('--tags')
    }

    if (remote) {
      args.push(remote)
    }

    if (name) {
      args.push(name)
    }

    try {
      await this.exec(args, spawnOptions)
    } catch (err: any) {
      if (/^error: failed to push some refs to\b/m.test(err.stderr || '')) {
        if ((forcePushMode === ForcePushMode.ForceWithLease || forcePushMode === ForcePushMode.ForceWithLeaseIfIncludes) && /! \[rejected\].*\(stale info\)/m.test(err.stderr || '')) {
          err.gitErrorCode = GitErrorCodes.ForcePushWithLeaseRejected
        } else if (forcePushMode === ForcePushMode.ForceWithLeaseIfIncludes && /! \[rejected\].*\(remote ref updated since checkout\)/m.test(err.stderr || '')) {
          err.gitErrorCode = GitErrorCodes.ForcePushWithLeaseIfIncludesRejected
        } else {
          err.gitErrorCode = GitErrorCodes.PushRejected
        }
      } else if (/Permission.*denied/.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.PermissionDenied
      } else if (/Could not read from remote repository/.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.RemoteConnectionError
      } else if (/^fatal: The current branch .* has no upstream branch/.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.NoUpstreamBranch
      }

      throw err
    }
  }

  async createStash(message?: string, includeUntracked?: boolean, staged?: boolean): Promise<void> {
    try {
      const args = ['stash', 'push']

      if (includeUntracked) {
        args.push('-u')
      }

      if (staged) {
        args.push('-S')
      }

      if (message) {
        args.push('-m', message)
      }

      await this.exec(args)
    } catch (err: any) {
      if (/No local changes to save/.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.NoLocalChanges
      }

      throw err
    }
  }

  async popStash(index?: number, options?: { reinstateStagedChanges?: boolean }): Promise<void> {
    const args = ['stash', 'pop']
    if (options?.reinstateStagedChanges) {
      args.push('--index')
    }
    await this.popOrApplyStash(args, index)
  }

  async applyStash(index?: number, options?: { reinstateStagedChanges?: boolean }): Promise<void> {
    const args = ['stash', 'apply']
    if (options?.reinstateStagedChanges) {
      args.push('--index')
    }
    await this.popOrApplyStash(args, index)
  }

  private async popOrApplyStash(args: string[], index?: number): Promise<void> {
    try {
      if (typeof index === 'number') {
        args.push(`stash@{${index}}`)
      }

      await this.exec(args)
    } catch (err: any) {
      if (/No stash found/.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.NoStashFound
      } else if (/error: Your local changes to the following files would be overwritten/.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.LocalChangesOverwritten
      } else if (/^CONFLICT/m.test(err.stdout || '')) {
        err.gitErrorCode = GitErrorCodes.StashConflict
      }

      throw err
    }
  }

  async dropStash(index?: number): Promise<void> {
    const args = ['stash']

    if (typeof index === 'number') {
      args.push('drop')
      args.push(`stash@{${index}}`)
    } else {
      args.push('clear')
    }

    try {
      await this.exec(args)
    } catch (err: any) {
      if (/No stash found/.test(err.stderr || '')) {
        err.gitErrorCode = GitErrorCodes.NoStashFound
      }

      throw err
    }
  }

  async showStash(index: number): Promise<Change[] | undefined> {
    const args = ['stash', 'show', `stash@{${index}}`, '--name-status', '-z', '-u']

    try {
      const result = await this.exec(args, { noOptionalLocks: true })
      if (result.exitCode) {
        return []
      }

      return parseGitNameStatus(result.stdout.trim())
    } catch (err: any) {
      if (/No stash found/.test(err.stderr || '')) {
        return undefined
      }

      throw err
    }
  }

  async getStatus(opts?: { limit?: number; ignoreSubmodules?: boolean; similarityThreshold?: number; untrackedChanges?: 'mixed' | 'separate' | 'hidden' }): Promise<{ status: IFileStatus[]; statusLength: number; didHitLimit: boolean }> {
    const env = { GIT_OPTIONAL_LOCKS: '0' }
    const args = ['status', '-z']

    if (opts?.untrackedChanges === 'hidden') {
      args.push('-uno')
    } else {
      args.push('-uall')
    }

    if (opts?.ignoreSubmodules) {
      args.push('--ignore-submodules')
    }

    if (opts?.similarityThreshold && opts.similarityThreshold !== 50 && this._git.compareGitVersionTo('2.18.0') !== -1) {
      args.push(`--find-renames=${opts.similarityThreshold}%`)
    }

    return await this.stream(args, { env, noOptionalLocks: true }, (child) => new Promise<{ status: IFileStatus[]; statusLength: number; didHitLimit: boolean }>((c, e) => {
      const parser = new GitStatusParser()

      const onClose = (exitCode: number) => {
        if (exitCode !== 0) {
          const stderr = stderrData.join('')
          return e(new GitError({
            message: 'Failed to execute git',
            stderr,
            exitCode,
            gitErrorCode: getGitErrorCode(stderr),
            gitCommand: 'status',
            gitArgs: ['--no-optional-locks', ...args]
          }))
        }

        c({ status: parser.status, statusLength: parser.status.length, didHitLimit: false })
      }

      const limit = opts?.limit ?? 10000
      const onStdoutData = (raw: string) => {
        parser.update(raw)

        if (limit !== 0 && parser.status.length > limit) {
          child.removeListener('close', onClose)
          child.stdout?.removeListener('data', onStdoutData)
          killGitProcess(child)

          c({ status: parser.status.slice(0, limit), statusLength: parser.status.length, didHitLimit: true })
        }
      }

      if (child.stdout) {
        child.stdout.setEncoding('utf8')
        child.stdout.on('data', onStdoutData)
      }

      const stderrData: string[] = []
      if (child.stderr) {
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', (raw) => stderrData.push(raw as string))
      }

      child.on('error', cpErrorHandler(e))
      child.on('close', onClose)
    }))
  }

  async getHEADRef(): Promise<Branch | undefined> {
    let HEAD: Branch | undefined

    try {
      HEAD = await this.getHEAD()

      if (HEAD.name) {
        HEAD = await this.getBranch(HEAD.name)

        if (HEAD && HEAD.upstream) {
          const ref = HEAD.upstream.remote !== '.'
            ? `refs/remotes/${HEAD.upstream.remote}/${HEAD.upstream.name}`
            : `refs/heads/${HEAD.upstream.name}`
          const commit = await this.revParse(ref)
          HEAD = { ...HEAD, upstream: { ...HEAD.upstream, commit } }
        }
      } else if (HEAD.commit) {
        const tags = await this.getRefs({ pattern: 'refs/tags' })
        const tag = tags.find((tag) => tag.commit === HEAD!.commit)

        if (tag) {
          HEAD = { ...HEAD, name: tag.name, type: RefType.Tag }
        }
      }
    } catch (err) {
    }

    return HEAD
  }

  async getHEAD(): Promise<Ref> {
    if (!this._isUsingRefTable) {
      try {
        const result = await this.getHEADFS()

        if (result.name === '.invalid') {
          this._isUsingRefTable = true
        } else {
          return result
        }
      }
      catch (err) {
      }
    }

    try {
      const result = await this.exec(['symbolic-ref', '--short', 'HEAD'], { noOptionalLocks: true })

      if (!result.stdout) {
        throw new Error('Not in a branch')
      }

      return { name: result.stdout.trim(), commit: undefined, type: RefType.Head }
    }
    catch (err) { }

    const result = await this.exec(['rev-parse', 'HEAD'], { noOptionalLocks: true })

    if (!result.stdout) {
      throw new Error('Error parsing HEAD')
    }

    return { name: undefined, commit: result.stdout.trim(), type: RefType.Head }
  }

  async getHEADFS(): Promise<Ref> {
    const raw = await fs.readFile(path.join(this.dotGit.path, 'HEAD'), 'utf8')

    const branchMatch = raw.match(/^ref: refs\/heads\/(?<name>.*)$/m)
    if (branchMatch?.groups?.name) {
      return { name: branchMatch.groups.name, commit: undefined, type: RefType.Head }
    }

    const commitMatch = raw.match(/^(?<commit>[0-9a-f]{40})$/m)
    if (commitMatch?.groups?.commit) {
      return { name: undefined, commit: commitMatch.groups.commit, type: RefType.Head }
    }

    throw new Error(`Unable to parse HEAD file. HEAD file contents: ${raw}.`)
  }

  async getRefs(query: RefQuery): Promise<(Ref | Branch)[]> {
    const args = ['for-each-ref']

    if (query.count) {
      args.push(`--count=${query.count}`)
    }

    if (query.sort && query.sort !== 'alphabetically') {
      args.push('--sort', `-${query.sort}`)
    }

    args.push('--format', REFS_FORMAT)

    if (query.pattern) {
      const patterns = Array.isArray(query.pattern) ? query.pattern : [query.pattern]
      for (const pattern of patterns) {
        args.push(pattern.startsWith('refs/') ? pattern : `refs/${pattern}`)
      }
    }

    if (query.contains) {
      args.push('--contains', query.contains)
    }

    const result = await this.exec(args, { noOptionalLocks: true })
    return parseRefs(result.stdout)
  }

  async getStashes(): Promise<Stash[]> {
    const result = await this.exec(['stash', 'list', `--format=${STASH_FORMAT}`, '-z'], { noOptionalLocks: true })
    return parseGitStashes(result.stdout.trim())
  }

  async getRemotes(): Promise<Remote[]> {
    const remotes: MutableRemote[] = []

    try {
      remotes.push(...await this.getRemotesFS())
    }
    catch (err) {
      remotes.push(...await this.getRemotesGit())
    }

    for (const remote of remotes) {
      remote.isReadOnly = remote.pushUrl === undefined || remote.pushUrl === 'no_push'
    }

    return remotes
  }

  private async getRemotesFS(): Promise<MutableRemote[]> {
    const raw = await fs.readFile(path.join(this.dotGit.commonPath ?? this.dotGit.path, 'config'), 'utf8')
    return parseGitRemotes(raw)
  }

  private async getRemotesGit(): Promise<MutableRemote[]> {
    const remotes: MutableRemote[] = []

    const result = await this.exec(['remote', '--verbose'], { noOptionalLocks: true })
    const lines = result.stdout.trim().split('\n').filter((l) => !!l)

    for (const line of lines) {
      const parts = line.split(/\s/)
      const [name, url, type] = parts

      let remote = remotes.find((r) => r.name === name)

      if (!remote) {
        remote = { name, isReadOnly: false }
        remotes.push(remote)
      }

      if (/fetch/i.test(type)) {
        remote.fetchUrl = url
      } else if (/push/i.test(type)) {
        remote.pushUrl = url
      } else {
        remote.fetchUrl = url
        remote.pushUrl = url
      }
    }

    return remotes
  }

  async getBranch(name: string): Promise<Branch> {
    if (name === 'HEAD') {
      return this.getHEAD()
    }

    const args = ['for-each-ref']

    let supportsAheadBehind = true
    if (this._git.compareGitVersionTo('1.9.0') === -1) {
      args.push('--format=%(refname)%00%(upstream:short)%00%(objectname)')
      supportsAheadBehind = false
    } else if (this._git.compareGitVersionTo('2.16.0') === -1) {
      args.push('--format=%(refname)%00%(upstream:short)%00%(objectname)%00%(upstream:track)')
    } else {
      args.push('--format=%(refname)%00%(upstream:short)%00%(objectname)%00%(upstream:track)%00%(upstream:remotename)%00%(upstream:remoteref)')
    }

    if (this.git.compareGitVersionTo('2.12') !== -1 && (isWindows || isMacintosh)) {
      args.push('--ignore-case')
    }

    if (/^refs\/(heads|remotes)\//i.test(name)) {
      args.push(name)
    } else {
      args.push(`refs/heads/${name}`, `refs/remotes/${name}`)
    }

    const result = await this.exec(args, { noOptionalLocks: true })
    const branches: Branch[] = result.stdout.trim().split('\n').map<Branch | undefined>((line) => {
      let [branchName, upstream, ref, status, remoteName, upstreamRef] = line.trim().split('\0')

      if (branchName.startsWith('refs/heads/')) {
        branchName = branchName.substring(11)
        const index = upstream.indexOf('/')

        let ahead
        let behind
        const match = /\[(?:ahead ([0-9]+))?[,\s]*(?:behind ([0-9]+))?]|\[gone]/.exec(status)
        if (match) {
          [, ahead, behind] = match
        }

        return {
          type: RefType.Head,
          name: branchName,
          upstream: upstream !== '' && status !== '[gone]' ? {
            name: upstreamRef ? upstreamRef.substring(11) : upstream.substring(index + 1),
            remote: remoteName ? remoteName : upstream.substring(0, index)
          } : undefined,
          commit: ref || undefined,
          ahead: Number(ahead) || 0,
          behind: Number(behind) || 0
        }
      } else if (branchName.startsWith('refs/remotes/')) {
        branchName = branchName.substring(13)
        const index = branchName.indexOf('/')

        return {
          type: RefType.RemoteHead,
          name: branchName.substring(index + 1),
          remote: branchName.substring(0, index),
          commit: ref
        }
      } else {
        return undefined
      }
    }).filter((b?: Branch): b is Branch => !!b)

    if (branches.length) {
      const [branch] = branches

      if (!supportsAheadBehind && branch.upstream) {
        try {
          const result = await this.exec(['rev-list', '--left-right', '--count', `${branch.name}...${branch.upstream.remote}/${branch.upstream.name}`], { noOptionalLocks: true })
          const [ahead, behind] = result.stdout.trim().split('\t')

          return { ...branch, ahead: Number(ahead) || 0, behind: Number(behind) || 0 }
        } catch { }
      }

      return branch
    }

    return Promise.reject<Branch>(new Error(`No such branch: ${name}.`))
  }

  stripCommitMessageComments(message: string): string {
    return message.replace(/^\s*#.*$\n?/gm, '').trim()
  }

  async getSquashMessage(): Promise<string | undefined> {
    const squashMsgPath = path.join(this.dotGit.path, 'SQUASH_MSG')

    try {
      const raw = await fs.readFile(squashMsgPath, 'utf8')
      return this.stripCommitMessageComments(raw)
    } catch {
      return undefined
    }
  }

  async getMergeMessage(): Promise<string | undefined> {
    const mergeMsgPath = path.join(this.dotGit.path, 'MERGE_MSG')

    try {
      const raw = await fs.readFile(mergeMsgPath, 'utf8')
      return this.stripCommitMessageComments(raw)
    } catch {
      return undefined
    }
  }

  async getCommit(ref: string): Promise<Commit> {
    const result = await this.exec(['-c', 'i18n.logOutputEncoding=UTF-8', 'show', '-s', '--decorate=full', '--shortstat', `--format=${COMMIT_FORMAT}`, '-z', ref, '--'], { noOptionalLocks: true })
    const commits = parseGitCommits(result.stdout)
    if (commits.length === 0) {
      return Promise.reject<Commit>('bad commit format')
    }
    return commits[0]
  }

  async revParse(ref: string): Promise<string | undefined> {
    try {
      const result = await fs.readFile(path.join(this.dotGit.path, ref), 'utf8')
      return result.trim()
    } catch (err) {
    }

    try {
      const result = await this.exec(['rev-parse', ref], { noOptionalLocks: true })
      if (result.stderr) {
        return undefined
      }
      return result.stdout.trim()
    } catch (err) {
      return undefined
    }
  }

  private sanitizeRelativePath(filePath: string): string {
    if (!path.isAbsolute(filePath)) {
      filePath = sanitizeRelativePath(filePath)
      return filePath
    }

    let relativePath: string | undefined

    if (this.repositoryRootRealPath) {
      relativePath = relativePathWithNoFallback(this.repositoryRootRealPath, filePath)
      if (relativePath) {
        relativePath = sanitizeRelativePath(relativePath)
        return relativePath
      }
    }

    relativePath = relativePathWithNoFallback(this.repositoryRoot, filePath)
    if (relativePath) {
      relativePath = sanitizeRelativePath(relativePath)
      return relativePath
    }

    filePath = sanitizeRelativePath(path.relative(this.repositoryRoot, filePath))
    return filePath
  }
}
