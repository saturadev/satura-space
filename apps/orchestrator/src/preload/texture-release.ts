import { ipcRenderer } from 'electron'
import { debugLog } from '@shared/debug-log'

export const RELEASE_TO_MAIN = 'IMPORT_SHARED_TEXTURE_RELEASE_RENDERER_TO_MAIN'

export interface ReleasableTex {
  textureId?: string
  subtle?: { release(): void }
  release(): void
}

export function releaseTexture(t: ReleasableTex): void {
  if (!t.subtle || !t.textureId) {
    t.release()
    return
  }
  t.subtle.release()
  const id = t.textureId
  ipcRenderer
    .invoke(RELEASE_TO_MAIN, id)
    .catch((e: Error) => debugLog(`[shared-texture] texture ${id} release not taken by main: ${e.message.slice(e.message.lastIndexOf('Error:') + 7)}`))
}
