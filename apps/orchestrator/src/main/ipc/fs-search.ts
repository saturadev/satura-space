import { ipcMain } from 'electron'
import type { ReplaceRequest, ReplaceResult, SearchOptions } from '@shared/api'
import { runRipgrepSearch, type SearchHandle } from '../search/ripgrep-search'
import { runReplace } from '../search/replace'
import { censusTrack } from '@shared/census'

const active = new Map<string, SearchHandle>()
censusTrack('fs-search.active', active)

function key(senderId: number, requestId: number): string {
  return `${senderId}:${requestId}`
}

export function registerFsSearch(): void {
  ipcMain.on('fs:search:start', (e, requestId: number, opts: SearchOptions) => {
    const k = key(e.sender.id, requestId)
    active.get(k)?.cancel()
    const handle = runRipgrepSearch(
      opts,
      (files) => {
        if (!e.sender.isDestroyed()) e.sender.send('fs:search:result', { requestId, files })
      },
      (summary) => {
        active.delete(k)
        if (!e.sender.isDestroyed()) e.sender.send('fs:search:done', { requestId, ...summary })
      }
    )
    active.set(k, handle)
  })

  ipcMain.on('fs:search:cancel', (e, requestId: number) => {
    const k = key(e.sender.id, requestId)
    active.get(k)?.cancel()
    active.delete(k)
  })

  ipcMain.handle('fs:replace', (_e, req: ReplaceRequest): Promise<ReplaceResult> => runReplace(req))
}
