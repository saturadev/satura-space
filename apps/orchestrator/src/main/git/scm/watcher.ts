import { watch, type FSWatcher } from 'node:fs'
import * as path from 'node:path'
import { NEVER_COMMIT_DIR, NEVER_COMMIT_FILE } from '@shared/git-scm'
import { getGit } from './git'
import { resolveNeverCommitDir } from './never-commit-store'

export const WATCH_DEBOUNCE_MS = 500

const WORKING_TREE_NOISE = new Set(['Library', 'Temp', 'Logs', 'obj', 'UserSettings', '.sspace'])
const WORKING_TREE_CONTENT = new Set(['Assets', 'Packages', 'ProjectSettings'])

export interface RepositoryWatcher {
  readonly root: string
  dispose(): void
}

export function isWorkingTreeNoise(relativePath: string): boolean {
  if (relativePath.replace(/\\/g, '/') === `${NEVER_COMMIT_DIR}/${NEVER_COMMIT_FILE}`) {
    return false
  }
  if (/\.git($|\\|\/)/.test(relativePath)) {
    return true
  }
  for (const segment of relativePath.split(/[\\/]/)) {
    if (WORKING_TREE_CONTENT.has(segment)) return false
    if (WORKING_TREE_NOISE.has(segment)) return true
  }
  return false
}

export function isDotGitNoise(relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, '/')
  return (
    /^(objects|lfs|worktrees|fsmonitor--daemon)(\/|$)/.test(p) ||
    /\.lock$/.test(p) ||
    /(^|\/)\.watchman-cookie-/.test(p)
  )
}

export function isCommonDirNoise(relativePath: string): boolean {
  const p = relativePath.replace(/\\/g, '/')
  return !/^(refs|reftable)(\/|$)|^(packed-refs|config)$/.test(p) || isDotGitNoise(p)
}

function isOutside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child)
  return rel.startsWith('..') || path.isAbsolute(rel)
}

export async function resolveWatchPaths(
  root: string
): Promise<{ workingTree: string; gitDir: string; commonDir: string }> {
  const git = await getGit()
  const workingTree = await git.getRepositoryRoot(root)
  const result = await git.exec(
    root,
    ['rev-parse', '--absolute-git-dir', '--path-format=absolute', '--git-common-dir'],
    { noOptionalLocks: true }
  )
  const [gitDir, commonDir] = result.stdout.split('\n').map((l) => l.trim())
  return {
    workingTree,
    gitDir: path.normalize(gitDir),
    commonDir: path.normalize(commonDir || gitDir)
  }
}

export async function watchRepository(
  root: string,
  onChange: (root: string) => void,
  delay: number = WATCH_DEBOUNCE_MS
): Promise<RepositoryWatcher> {
  const { workingTree, gitDir, commonDir } = await resolveWatchPaths(root)
  const watchers: FSWatcher[] = []
  let timer: NodeJS.Timeout | undefined
  let disposed = false

  const fire = (): void => {
    if (disposed) return
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = undefined
      if (!disposed) onChange(root)
    }, delay)
  }

  const add = (dir: string, isNoise: (relativePath: string) => boolean, recursive = true): void => {
    try {
      const watcher = watch(dir, { recursive }, (_event, filename) => {
        if (!filename || !isNoise(filename.toString())) fire()
      })
      watcher.on('error', () => undefined)
      watchers.push(watcher)
    } catch {
    }
  }

  add(workingTree, isWorkingTreeNoise)
  add(gitDir, isDotGitNoise)
  if (commonDir !== gitDir) add(commonDir, isCommonDirNoise)
  const envDir = await resolveNeverCommitDir(root).catch(() => undefined)
  if (envDir && isOutside(workingTree, envDir)) add(envDir, (name) => name !== NEVER_COMMIT_FILE, false)

  return {
    root,
    dispose: () => {
      if (disposed) return
      disposed = true
      if (timer) clearTimeout(timer)
      for (const watcher of watchers) {
        try {
          watcher.close()
        } catch {
        }
      }
    }
  }
}
