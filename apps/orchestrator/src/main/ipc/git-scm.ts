import { existsSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { ipcMain, shell, type WebContents } from 'electron'
import type { NeverCommitChange, ScmLogOptions, ScmPullOptions, ScmPushOptions, ScmRemoteProgress, ScmResult, ScmStashOptions, ScmViewSettings } from '@shared/git-scm'
import { toNativePath } from './native-path'
import { gitScmService } from '../git/scm/repository'
import { watchRepository, type RepositoryWatcher } from '../git/scm/watcher'
import { onRemoteProgress } from '../git/scm/remote-operation'
import { censusTrack } from '@shared/census'

interface Subscriber {
  contents: WebContents
  count: number
}

interface WatchEntry {
  subscribers: Map<number, Subscriber>
  watcher?: RepositoryWatcher
  starting?: Promise<void>
}

export function revealTarget(root: unknown, rel: unknown): { ok: true; target: string } | { ok: false; message: string } {
  if (typeof root !== 'string' || !root || typeof rel !== 'string') return { ok: false, message: 'Invalid path' }
  const base = resolve(root)
  let target = resolve(base, rel)
  if (target !== base && !target.startsWith(base + sep)) return { ok: false, message: 'Path is outside the repository' }
  while (target !== base && !existsSync(target)) target = dirname(target)
  return { ok: true, target }
}

function revealInFolder(root: string, rel: string): ScmResult {
  const found = revealTarget(root, rel)
  if (!found.ok) return { ok: false, error: { message: found.message } }
  shell.showItemInFolder(toNativePath(found.target))
  return { ok: true, value: undefined }
}

const watches = new Map<string, WatchEntry>()
censusTrack('git-scm.watches', watches)
const trackedContents = new Set<number>()
censusTrack('git-scm.trackedContents', trackedContents)
let registered = false

function notify(root: string): void {
  const entry = watches.get(root)
  if (!entry) return
  for (const { contents } of entry.subscribers.values()) {
    if (!contents.isDestroyed()) contents.send('gitScm:didChange', root)
  }
}

function notifyProgress(root: string, progress: ScmRemoteProgress | null): void {
  const entry = watches.get(root)
  if (!entry) return
  for (const { contents } of entry.subscribers.values()) {
    if (!contents.isDestroyed()) contents.send('gitScm:remoteProgress', root, progress)
  }
}

function release(root: string, entry: WatchEntry): void {
  if (entry.subscribers.size > 0 || watches.get(root) !== entry) return
  watches.delete(root)
  entry.watcher?.dispose()
  entry.watcher = undefined
}

function dropContents(id: number): void {
  trackedContents.delete(id)
  for (const [root, entry] of [...watches]) {
    if (entry.subscribers.delete(id)) release(root, entry)
  }
}

async function subscribe(contents: WebContents, root: string): Promise<void> {
  let entry = watches.get(root)
  if (!entry) {
    entry = { subscribers: new Map() }
    watches.set(root, entry)
  }
  const existing = entry.subscribers.get(contents.id)
  if (existing) existing.count++
  else entry.subscribers.set(contents.id, { contents, count: 1 })

  if (!trackedContents.has(contents.id)) {
    trackedContents.add(contents.id)
    const id = contents.id
    contents.once('destroyed', () => dropContents(id))
  }

  if (!entry.watcher && !entry.starting) {
    const target = entry
    target.starting = watchRepository(root, notify).then(
      (watcher) => {
        target.starting = undefined
        if (watches.get(root) === target && target.subscribers.size > 0) target.watcher = watcher
        else watcher.dispose()
      },
      () => {
        target.starting = undefined
      }
    )
  }
  await entry.starting
}

function unsubscribe(contents: WebContents, root: string): void {
  const entry = watches.get(root)
  if (!entry) return
  const existing = entry.subscribers.get(contents.id)
  if (!existing) return
  existing.count--
  if (existing.count <= 0) entry.subscribers.delete(contents.id)
  release(root, entry)
}

export function registerGitScmHandlers(): void {
  if (registered) return
  registered = true

  ipcMain.handle('gitScm:getState', (_event, root: string) => gitScmService.getState(root))

  ipcMain.handle('gitScm:log', (_event, root: string, options: ScmLogOptions) =>
    gitScmService.log(root, options)
  )

  ipcMain.handle('gitScm:getCommit', (_event, root: string, ref: string) =>
    gitScmService.getCommit(root, ref)
  )

  ipcMain.handle('gitScm:getMergeBase', (_event, root: string, ref1: string, ref2: string) =>
    gitScmService.getMergeBase(root, ref1, ref2)
  )

  ipcMain.handle(
    'gitScm:diffBetweenWithStats',
    (_event, root: string, ref1: string | undefined, ref2: string) =>
      gitScmService.diffBetweenWithStats(root, ref1 ?? undefined, ref2)
  )

  ipcMain.handle('gitScm:diffBetween', (_event, root: string, ref1: string | undefined, ref2: string) =>
    gitScmService.diffBetween(root, ref1 ?? undefined, ref2)
  )

  ipcMain.handle(
    'gitScm:diffStats',
    (_event, root: string, ref1: string | undefined, ref2: string, paths: string[]) =>
      gitScmService.diffStats(root, ref1 ?? undefined, ref2, paths)
  )

  ipcMain.handle('gitScm:compareCommits', (_event, root: string, ref1: string, ref2: string) =>
    gitScmService.compareCommits(root, ref1, ref2)
  )

  ipcMain.handle(
    'gitScm:compareCommitsStats',
    (_event, root: string, ref1: string, ref2: string, paths: string[]) =>
      gitScmService.compareCommitsStats(root, ref1, ref2, paths)
  )

  ipcMain.handle(
    'gitScm:explainDiff',
    (_event, root: string, path: string, originalPath: string, originalRef: string, modifiedRef: string, checkContent: boolean) =>
      gitScmService.explainDiff(root, path, originalPath, originalRef, modifiedRef, checkContent === true)
  )

  ipcMain.handle(
    'gitScm:patch',
    (_event, root: string, path: string, originalPath: string, originalRef: string, modifiedRef: string) =>
      gitScmService.patch(root, path, originalPath, originalRef, modifiedRef)
  )

  ipcMain.handle('gitScm:show', (_event, root: string, path: string, ref: string) =>
    gitScmService.show(root, path, ref)
  )

  ipcMain.handle('gitScm:showImage', (_event, root: string, path: string, ref: string) =>
    gitScmService.showImage(root, path, ref)
  )

  ipcMain.handle('gitScm:revealInFolder', (_event, root: string, path: string) => revealInFolder(root, path))

  ipcMain.handle('gitScm:add', (_event, root: string, paths: string[]) => gitScmService.add(root, paths))

  ipcMain.handle('gitScm:revert', (_event, root: string, paths: string[]) =>
    gitScmService.revert(root, paths)
  )

  ipcMain.handle('gitScm:stageContent', (_event, root: string, path: string, content: string, unstage?: boolean) =>
    gitScmService.stageContent(root, path, content, unstage === true)
  )

  ipcMain.handle('gitScm:discardOutsideEnv', (_event, root: string, paths: string[]) =>
    gitScmService.discardOutsideEnv(root, paths)
  )

  ipcMain.handle('gitScm:discardEnvLines', (_event, root: string, path: string, content: string, expected?: string) =>
    gitScmService.discardEnvLines(root, path, content, expected)
  )

  ipcMain.handle('gitScm:rm', (_event, root: string, paths: string[]) => gitScmService.rm(root, paths))

  ipcMain.handle('gitScm:commit', (_event, root: string, message: string) =>
    gitScmService.commit(root, message)
  )

  ipcMain.handle('gitScm:fetch', (_event, root: string) => gitScmService.fetch(root))

  ipcMain.handle('gitScm:pull', (_event, root: string, options: ScmPullOptions) => gitScmService.pull(root, options))

  ipcMain.handle('gitScm:push', (_event, root: string, options?: ScmPushOptions) => gitScmService.push(root, options))

  ipcMain.handle('gitScm:cancelRemote', (_event, root: string) => gitScmService.cancelRemote(root))

  onRemoteProgress(notifyProgress)

  ipcMain.handle('gitScm:rebaseAbort', (_event, root: string) => gitScmService.rebaseAbort(root))

  ipcMain.handle('gitScm:clean', (_event, root: string, paths: string[]) => gitScmService.clean(root, paths))

  ipcMain.handle('gitScm:merge', (_event, root: string, ref: string) => gitScmService.merge(root, ref))

  ipcMain.handle('gitScm:mergeAbort', (_event, root: string) => gitScmService.mergeAbort(root))

  ipcMain.handle('gitScm:stash', (_event, root: string, options: ScmStashOptions) => gitScmService.stash(root, options))

  ipcMain.handle('gitScm:stashApply', (_event, root: string, index: number | undefined) =>
    gitScmService.stashApply(root, index ?? undefined)
  )

  ipcMain.handle('gitScm:stashPop', (_event, root: string, index: number | undefined) =>
    gitScmService.stashPop(root, index ?? undefined)
  )

  ipcMain.handle('gitScm:stashDrop', (_event, root: string, index: number | undefined) =>
    gitScmService.stashDrop(root, index ?? undefined)
  )

  ipcMain.handle('gitScm:stashShow', (_event, root: string, index: number) => gitScmService.stashShow(root, index))

  ipcMain.handle('gitScm:writeFile', (_event, root: string, path: string, content: string, expected?: string) =>
    gitScmService.writeFile(root, path, content, expected)
  )

  ipcMain.handle('gitScm:trackedPaths', (_event, root: string, entries: string[]) => gitScmService.trackedPaths(root, entries))

  ipcMain.handle('gitScm:addToGitignore', (_event, root: string, entries: string[], untrack: boolean) =>
    gitScmService.addToGitignore(root, entries, untrack)
  )

  ipcMain.handle('gitScm:getSettings', (_event, root: string) => gitScmService.getSettings(root))

  ipcMain.handle('gitScm:setSettings', (_event, root: string, settings: ScmViewSettings) =>
    gitScmService.setSettings(root, settings)
  )

  ipcMain.handle('gitScm:updateNeverCommit', (_event, root: string, change: NeverCommitChange) =>
    gitScmService.updateNeverCommit(root, change)
  )

  ipcMain.handle('gitScm:keepEnv', (_event, root: string, paths: string[]) => gitScmService.keepEnv(root, paths))

  ipcMain.handle('gitScm:watch', async (event, root: string): Promise<void> => {
    if (typeof root !== 'string' || !root) return
    await subscribe(event.sender, root)
  })

  ipcMain.handle('gitScm:unwatch', (event, root: string): void => {
    if (typeof root !== 'string' || !root) return
    unsubscribe(event.sender, root)
  })
}
