import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { copyFile, lstat, mkdir, readdir, realpath, rm, stat } from 'node:fs/promises'
import { constants as fsConstants, existsSync, type Dirent } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { CreateWorktreeResult, ProjectWorktree, RemoveWorktreeResult } from '@shared/api'
import { execGit } from './exec-git'
import { SSPACE_DIR, ensureSspaceDir } from '../sspace'
import { RC_DIR, RC_OVERRIDES_FILE } from '@shared/remote-controls'

const exec = promisify(execFile)

const WORKTREES_REL = join(SSPACE_DIR, 'worktrees')

export const OUTSIDE_WORKTREES_MESSAGE =
  'Refusing to remove a path outside this project’s worktrees folder.'

export function isProjectWorktreePath(root: string, worktreePath: string): boolean {
  if (!root || !worktreePath) return false
  const base = resolve(root, WORKTREES_REL)
  const rel = relative(base, resolve(worktreePath))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

export function isWorktreeShapedPath(p: string): boolean {
  if (!p) return false
  return /[\\/]\.sspace[\\/]worktrees[\\/][^\\/]/.test(resolve(p))
}

export type CopyProgress = {
  phase: 'preparing' | 'copying' | 'done'
  copiedBytes: number
  totalBytes: number
  indeterminate: boolean
}
export type ProgressFn = (p: CopyProgress) => void

export type RemoveProgress = {
  phase: 'preparing' | 'removing' | 'done'
  removedBytes: number
  totalBytes: number
  indeterminate: boolean
}
export type RemoveProgressFn = (p: RemoveProgress) => void

function git(root: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execGit(['-C', root, ...args], { maxBuffer: 16 * 1024 * 1024 })
}

function sanitizeName(raw: string): string {
  return raw
    .trim()
    .replace(/[\\/]+/g, '')
    .replace(/\s+/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '')
    .replace(/^[-.]+/, '')
    .slice(0, 64)
}

export async function isGitRepo(root: string): Promise<boolean> {
  if (!root) return false
  try {
    const { stdout } = await git(root, ['rev-parse', '--is-inside-work-tree'])
    return stdout.trim() === 'true'
  } catch {
    return false
  }
}

async function branchExists(root: string, name: string): Promise<boolean> {
  try {
    await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`])
    return true
  } catch {
    return false
  }
}

type WorktreeRecord = { path: string; branch: string; prunable: boolean }

async function worktreeRecords(root: string): Promise<WorktreeRecord[]> {
  let stdout: string
  try {
    ;({ stdout } = await git(root, ['worktree', 'list', '--porcelain']))
  } catch {
    return []
  }
  const out: WorktreeRecord[] = []
  let current: WorktreeRecord | null = null
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('worktree ')) {
      if (current) out.push(current)
      current = { path: line.slice('worktree '.length).trim(), branch: '', prunable: false }
    } else if (!current) {
      continue
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace(/^refs\/heads\//, '')
    } else if (line.startsWith('prunable')) {
      current.prunable = true
    }
  }
  if (current) out.push(current)
  return out
}

async function branchCheckedOutAt(root: string, name: string): Promise<string | null> {
  const live = (await worktreeRecords(root)).find((w) => w.branch === name && !w.prunable)
  return live ? live.path : null
}

async function sameCommit(root: string, a: string, b: string): Promise<boolean> {
  try {
    const [ra, rb] = await Promise.all([
      git(root, ['rev-parse', a]),
      git(root, ['rev-parse', b])
    ])
    return ra.stdout.trim() === rb.stdout.trim()
  } catch {
    return true
  }
}

async function currentBranch(root: string): Promise<string> {
  try {
    const { stdout } = await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])
    return stdout.trim()
  } catch {
    return ''
  }
}

export async function listProjectWorktrees(root: string): Promise<ProjectWorktree[]> {
  if (!root) return []
  const realRoot = await realpath(root).catch(() => root)
  const prefixes = [...new Set([root, realRoot])].map((r) =>
    join(r, WORKTREES_REL).replace(/\\/g, '/')
  )
  const out: ProjectWorktree[] = []
  for (const rec of await worktreeRecords(root)) {
    const p = rec.path.replace(/\\/g, '/')
    const prefix = prefixes.find((pre) => p.startsWith(pre + '/'))
    if (!prefix) continue
    const rel = p.slice(prefix.length + 1)
    const path = join(root, WORKTREES_REL, rel).replace(/\\/g, '/')
    out.push({ name: basename(p), path, branch: rec.branch })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

async function fileSize(path: string): Promise<number> {
  try {
    return (await stat(path)).size
  } catch {
    return 0
  }
}

async function measureTree(dir: string): Promise<number> {
  let total = 0
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      total += await measureTree(full)
    } else if (entry.isFile()) {
      total += await fileSize(full)
    }
  }
  return total
}

async function copyTree(src: string, dst: string, onBytes: (n: number) => void): Promise<void> {
  await mkdir(dst, { recursive: true })
  const entries = await readdir(src, { withFileTypes: true })
  for (const entry of entries) {
    const from = join(src, entry.name)
    const to = join(dst, entry.name)
    if (entry.isDirectory()) {
      await copyTree(from, to, onBytes)
    } else if (entry.isFile()) {
      await copyFile(from, to)
      onBytes(await fileSize(to))
    }
  }
}

const SYNC_EXCLUDED_TOP_DIRS = new Set(['.sspace', 'Library', 'Temp', 'Logs'])

async function changedPaths(root: string): Promise<string[]> {
  const { stdout } = await git(root, [
    'status',
    '--porcelain',
    '-z',
    '--no-renames',
    '--untracked-files=all'
  ])
  const out: string[] = []
  for (const entry of stdout.split('\0')) {
    if (entry.length < 4) continue
    const p = entry.slice(3)
    const top = p.split('/')[0]
    if (SYNC_EXCLUDED_TOP_DIRS.has(top)) continue
    out.push(p)
  }
  return out
}

async function syncWorkingState(root: string, dir: string, onProgress?: ProgressFn): Promise<void> {
  let paths: string[]
  try {
    paths = await changedPaths(root)
  } catch (e) {
    console.log(`[worktree] working-state scan failed: ${(e as Error).message}`)
    return
  }
  if (!paths.length) return
  onProgress?.({ phase: 'preparing', copiedBytes: 0, totalBytes: 0, indeterminate: true })
  const copies: Array<{ from: string; to: string; size: number }> = []
  const deletions: string[] = []
  for (const p of paths) {
    const from = join(root, p)
    let st
    try {
      st = await lstat(from)
    } catch {
      deletions.push(join(dir, p))
      continue
    }
    if (st.isDirectory()) continue
    copies.push({ from, to: join(dir, p), size: st.isFile() ? st.size : 0 })
  }
  const totalBytes = copies.reduce((sum, c) => sum + c.size, 0)
  let copiedBytes = 0
  let lastEmit = 0
  onProgress?.({ phase: 'copying', copiedBytes, totalBytes, indeterminate: totalBytes === 0 })
  for (const target of deletions) {
    await rm(target, { recursive: true, force: true }).catch(() => {})
  }
  for (const c of copies) {
    try {
      await mkdir(dirname(c.to), { recursive: true })
      await rm(c.to, { force: true })
      await copyFile(c.from, c.to, fsConstants.COPYFILE_FICLONE)
    } catch (e) {
      console.log(`[worktree] copy failed for ${c.from}: ${(e as Error).message}`)
    }
    copiedBytes += c.size
    if (copiedBytes - lastEmit >= 4 * 1024 * 1024 || copiedBytes >= totalBytes) {
      lastEmit = copiedBytes
      onProgress?.({ phase: 'copying', copiedBytes, totalBytes, indeterminate: totalBytes === 0 })
    }
  }
}

async function copyHiddenSideFiles(root: string, dir: string): Promise<void> {
  const rel = join(...RC_DIR.split('/'), RC_OVERRIDES_FILE)
  if (!existsSync(join(root, rel)) || existsSync(join(dir, rel))) return
  try {
    await mkdir(dirname(join(dir, rel)), { recursive: true })
    await copyFile(join(root, rel), join(dir, rel))
  } catch (e) {
    console.log(`[worktree] copy failed for ${rel}: ${(e as Error).message}`)
  }
}

async function copyLibrary(root: string, dir: string, onProgress?: ProgressFn): Promise<void> {
  const src = join(root, 'Library')
  const dst = join(dir, 'Library')
  if (!existsSync(src) || existsSync(dst)) return
  try {
    if (process.platform === 'darwin') {
      onProgress?.({ phase: 'copying', copiedBytes: 0, totalBytes: 0, indeterminate: true })
      await exec('cp', ['-cR', src, dst], { timeout: 10 * 60 * 1000 })
    } else {
      onProgress?.({ phase: 'preparing', copiedBytes: 0, totalBytes: 0, indeterminate: true })
      const totalBytes = await measureTree(src)
      let copiedBytes = 0
      let lastEmit = 0
      onProgress?.({ phase: 'copying', copiedBytes, totalBytes, indeterminate: totalBytes === 0 })
      await copyTree(src, dst, (n) => {
        copiedBytes += n
        if (copiedBytes - lastEmit >= 4 * 1024 * 1024 || copiedBytes >= totalBytes) {
          lastEmit = copiedBytes
          onProgress?.({ phase: 'copying', copiedBytes, totalBytes, indeterminate: totalBytes === 0 })
        }
      })
    }
    await rm(join(dst, 'UnityLockfile'), { force: true }).catch(() => {})
  } catch (e) {
    console.log(`[worktree] Library copy failed: ${(e as Error).message}`)
  }
}

export async function createWorktree(
  root: string,
  rawName: string,
  onProgress?: ProgressFn
): Promise<CreateWorktreeResult> {
  if (!(await isGitRepo(root))) return { ok: false, code: 'not-a-repo' }
  const name = sanitizeName(rawName)
  if (!name) return { ok: false, code: 'invalid-name' }
  const dir = join(root, WORKTREES_REL, name)
  if (existsSync(dir)) {
    const norm = dir.replace(/\\/g, '/')
    const registered = (await listProjectWorktrees(root)).find((w) => w.path === norm)
    if (registered) return { ok: true, path: norm, adopted: true }
    return { ok: false, code: 'exists' }
  }

  try {
    await ensureSspaceDir(join(root, SSPACE_DIR))
    await mkdir(join(root, WORKTREES_REL), { recursive: true })
  } catch (e) {
    return { ok: false, code: 'error', message: (e as Error).message }
  }

  await git(root, ['worktree', 'prune']).catch(() => {})

  let reusedBranch = false
  let behindHead = false
  if (await branchExists(root, name)) {
    const liveAt = await branchCheckedOutAt(root, name)
    if (liveAt) return { ok: false, code: 'branch-exists' }
    reusedBranch = true
    behindHead = !(await sameCommit(root, name, 'HEAD'))
  }

  try {
    const add = reusedBranch ? ['worktree', 'add', dir, name] : ['worktree', 'add', '-b', name, dir]
    await git(root, add)
  } catch (e) {
    const msg = (e as Error).message ?? ''
    if (/already exists/i.test(msg) && /branch/i.test(msg)) return { ok: false, code: 'branch-exists' }
    return { ok: false, code: 'error', message: msg }
  }

  await syncWorkingState(root, dir, onProgress)
  await copyHiddenSideFiles(root, dir)
  await copyLibrary(root, dir, onProgress)
  onProgress?.({ phase: 'done', copiedBytes: 0, totalBytes: 0, indeterminate: false })
  return { ok: true, path: dir.replace(/\\/g, '/'), reusedBranch, behindHead }
}

async function trashDir(dir: string, onProgress?: RemoveProgressFn): Promise<string | null> {
  if (!existsSync(dir)) return null
  onProgress?.({ phase: 'removing', removedBytes: 0, totalBytes: 0, indeterminate: true })
  try {
    const { shell } = await import('electron')
    await shell.trashItem(resolve(dir))
  } catch (e) {
    return (e as Error).message || 'Could not move the folder to the trash.'
  }
  return existsSync(dir) ? 'The folder is in use and could not be moved to the trash.' : null
}

export async function removeWorktree(
  root: string,
  worktreePath: string,
  onProgress?: RemoveProgressFn
): Promise<RemoveWorktreeResult> {
  if (!root || !worktreePath) return { ok: false, message: 'Missing path' }
  if (!isProjectWorktreePath(root, worktreePath)) {
    return { ok: false, message: OUTSIDE_WORKTREES_MESSAGE }
  }
  const worktrees = await listProjectWorktrees(root)
  const norm = resolve(worktreePath).replace(/\\/g, '/')
  const entry = worktrees.find((w) => resolve(w.path).replace(/\\/g, '/') === norm)
  const branch = entry?.branch ?? ''

  const rmError = await trashDir(worktreePath, onProgress)
  if (rmError) {
    return {
      ok: false,
      message: `Could not move the worktree to the trash. ${rmError} Close any Unity editor or app using it and try again.`
    }
  }
  onProgress?.({ phase: 'done', removedBytes: 0, totalBytes: 0, indeterminate: false })

  await git(root, ['worktree', 'remove', '--force', worktreePath]).catch((e) =>
    console.log(`[worktree] git remove failed: ${(e as Error).message}`)
  )
  await git(root, ['worktree', 'prune']).catch(() => {})

  if (!branch) return { ok: true }
  const current = await currentBranch(root)
  if (branch === current) return { ok: true }
  if ((await deleteBranch(root, branch, false)) !== 'unmerged') return { ok: true }
  pendingForceDeletes.add(forceKey(root, branch))
  return {
    ok: true,
    unmergedBranch: { branch, commits: await unmergedCommits(root, branch), into: current && current !== 'HEAD' ? current : 'HEAD' }
  }
}

const pendingForceDeletes = new Set<string>()

function forceKey(root: string, branch: string): string {
  return `${resolve(root)}\0${branch}`
}

async function unmergedCommits(root: string, branch: string): Promise<number> {
  try {
    const { stdout } = await git(root, ['rev-list', '--count', `HEAD..refs/heads/${branch}`])
    return Number.parseInt(stdout.trim(), 10) || 0
  } catch {
    return 0
  }
}

export async function forceDeleteWorktreeBranch(root: string, branch: string): Promise<RemoveWorktreeResult> {
  if (!root || !branch || !pendingForceDeletes.delete(forceKey(root, branch))) {
    return { ok: false, message: `Refusing to delete “${branch}”: it isn't a branch of a worktree that was just removed.` }
  }
  const result = await deleteBranch(root, branch, true)
  if (result === 'deleted' || result === 'gone') return { ok: true }
  return {
    ok: false,
    message: result === 'checked-out'
      ? `Kept the branch “${branch}”: another worktree has it checked out.`
      : `Could not delete the branch “${branch}”.`
  }
}

type BranchDelete = 'deleted' | 'gone' | 'checked-out' | 'unmerged' | 'failed'

async function deleteBranch(root: string, branch: string, force: boolean): Promise<BranchDelete> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await branchExists(root, branch))) return 'gone'
    if (await branchCheckedOutAt(root, branch)) return 'checked-out'
    try {
      await git(root, ['branch', force ? '-D' : '-d', branch])
      return 'deleted'
    } catch (e) {
      const message = (e as Error).message ?? ''
      if (!force && /not fully merged/i.test(message)) return 'unmerged'
      console.log(`[worktree] branch delete failed: ${message}`)
      await git(root, ['worktree', 'prune']).catch(() => {})
    }
  }
  return 'failed'
}
