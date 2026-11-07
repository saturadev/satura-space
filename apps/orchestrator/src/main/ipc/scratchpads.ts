import { app, ipcMain } from 'electron'
import type { ScratchpadInfo, ScratchpadResult } from '@shared/scratchpads'
import { unityProvider } from '../unity/unity-instance-provider'
import { scratchpads } from '../unity/scratchpads'
import { onRendererReset } from '../window/renderer-reset'

async function wrap<T>(fn: () => Promise<T>): Promise<ScratchpadResult<T>> {
  try {
    return { ok: true, data: await fn() }
  } catch (e) {
    return { ok: false, error: (e as Error)?.message ?? String(e) }
  }
}

export function registerScratchpadHandlers(): void {
  unityProvider.setScratchpadCommandHandler((args) => scratchpads.handleCommand(args))
  app.on('will-quit', () => scratchpads.detachAll())

  ipcMain.handle('scratchpads:attach', (_e, { projectPath }: { projectPath: string }) =>
    scratchpads.attach(projectPath)
  )
  ipcMain.handle(
    'scratchpads:list',
    (_e, { projectPath }: { projectPath: string }): Promise<ScratchpadResult<ScratchpadInfo[]>> =>
      wrap(() => scratchpads.list(projectPath))
  )
  ipcMain.handle(
    'scratchpads:create',
    (_e, { projectPath, name }: { projectPath: string; name?: string }): Promise<ScratchpadResult<ScratchpadInfo>> =>
      wrap(() => scratchpads.create(projectPath, name))
  )
  ipcMain.handle(
    'scratchpads:rename',
    (_e, { projectPath, id, name }: { projectPath: string; id: string; name: string }): Promise<ScratchpadResult<ScratchpadInfo>> =>
      wrap(() => scratchpads.rename(projectPath, id, name))
  )
  ipcMain.handle(
    'scratchpads:start',
    (_e, { projectPath, id }: { projectPath: string; id: string }): Promise<ScratchpadResult<ScratchpadInfo>> =>
      wrap(() => scratchpads.start(projectPath, id))
  )
  ipcMain.handle(
    'scratchpads:stop',
    (_e, { projectPath, id }: { projectPath: string; id: string }): Promise<ScratchpadResult<ScratchpadInfo>> =>
      wrap(() => scratchpads.stop(projectPath, id))
  )
  ipcMain.handle(
    'scratchpads:restart',
    (_e, { projectPath, id }: { projectPath: string; id: string }): Promise<ScratchpadResult<ScratchpadInfo>> =>
      wrap(() => scratchpads.restart(projectPath, id))
  )
  ipcMain.handle(
    'scratchpads:remove',
    (_e, { projectPath, id }: { projectPath: string; id: string }): Promise<ScratchpadResult<null>> =>
      wrap(async () => {
        await scratchpads.remove(projectPath, id)
        return null
      })
  )
  ipcMain.handle(
    'scratchpads:stopAll',
    (_e, { projectPath }: { projectPath: string }): Promise<ScratchpadResult<number>> =>
      wrap(() => scratchpads.stopAll(projectPath))
  )
  ipcMain.on('scratchpads:panels', (e, { projectPaths }: { projectPaths: unknown }) => {
    const wcId = e.sender.id
    onRendererReset(e.sender, 'scratchpads:panels', () => scratchpads.setPanels(wcId, []))
    const paths = Array.isArray(projectPaths) ? projectPaths.filter((p): p is string => typeof p === 'string') : []
    scratchpads.setPanels(wcId, paths)
  })
}
