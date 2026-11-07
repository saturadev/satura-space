import { ipcMain } from 'electron'
import type {
  BlameRange,
  CreateWorktreeResult,
  ProjectWorktree,
  RemoveWorktreeResult
} from '@shared/api'
import { listIgnoredPaths } from '../git/ignored'
import { isTracked, runBlame } from '../git/blame'
import {
  createWorktree,
  forceDeleteWorktreeBranch,
  isGitRepo,
  isProjectWorktreePath,
  isWorktreeShapedPath,
  listProjectWorktrees,
  removeWorktree,
  OUTSIDE_WORKTREES_MESSAGE,
  type RemoveProgressFn
} from '../git/worktrees'
import { unityProvider } from '../unity/unity-instance-provider'
import { killProcessesUnderPath } from '../git/kill-cwd-processes'

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function registerGitHandlers(): void {
  ipcMain.handle('git:listIgnored', (_event, path: string): Promise<string[]> =>
    listIgnoredPaths(typeof path === 'string' ? path : '')
  )

  ipcMain.handle(
    'git:blame',
    (_event, args: { rootPath: string; filePath: string; ref?: string }): Promise<BlameRange[]> =>
      runBlame(args?.rootPath ?? '', args?.filePath ?? '', args?.ref)
  )

  ipcMain.handle(
    'git:isTracked',
    (_event, args: { rootPath: string; filePath: string }): Promise<boolean> =>
      isTracked(args?.rootPath ?? '', args?.filePath ?? '')
  )

  ipcMain.handle('git:isRepo', (_event, path: string): Promise<boolean> =>
    isGitRepo(typeof path === 'string' ? path : '')
  )

  ipcMain.handle('git:listWorktrees', (_event, path: string): Promise<ProjectWorktree[]> =>
    listProjectWorktrees(typeof path === 'string' ? path : '')
  )

  ipcMain.handle(
    'git:createWorktree',
    (event, args: { rootPath: string; name: string }): Promise<CreateWorktreeResult> => {
      const rootPath = args?.rootPath ?? ''
      const name = args?.name ?? ''
      return createWorktree(rootPath, name, (p) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('git:worktreeProgress', { rootPath, name, ...p })
        }
      })
    }
  )

  ipcMain.handle(
    'git:removeWorktree',
    async (event, args: { rootPath: string; worktreePath: string }): Promise<RemoveWorktreeResult> => {
      const rootPath = args?.rootPath ?? ''
      const worktreePath = args?.worktreePath ?? ''
      if (!isProjectWorktreePath(rootPath, worktreePath)) {
        return { ok: false, message: OUTSIDE_WORKTREES_MESSAGE }
      }
      await unityProvider.releaseForProjectPath(worktreePath)
      const preKilled = await killProcessesUnderPath(worktreePath).catch(() => 0)
      if (preKilled > 0) await delay(700)
      const onProgress: RemoveProgressFn = (p) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send('git:worktreeRemoveProgress', { worktreePath, ...p })
        }
      }
      let result = await removeWorktree(rootPath, worktreePath, onProgress)
      if (!result.ok) {
        const killed = await killProcessesUnderPath(worktreePath).catch(() => 0)
        if (killed > 0) {
          await delay(700)
          result = await removeWorktree(rootPath, worktreePath, onProgress)
        }
      }
      return result
    }
  )

  ipcMain.handle(
    'git:forceDeleteWorktreeBranch',
    (_event, args: { rootPath: string; branch: string }): Promise<RemoveWorktreeResult> =>
      forceDeleteWorktreeBranch(
        typeof args?.rootPath === 'string' ? args.rootPath : '',
        typeof args?.branch === 'string' ? args.branch : ''
      )
  )

  ipcMain.handle('git:releaseWorktreeProcesses', async (_event, worktreePath: string): Promise<void> => {
    const path = typeof worktreePath === 'string' ? worktreePath : ''
    if (!isWorktreeShapedPath(path)) return
    await unityProvider.releaseForProjectPath(path)
    await killProcessesUnderPath(path).catch(() => 0)
  })
}
