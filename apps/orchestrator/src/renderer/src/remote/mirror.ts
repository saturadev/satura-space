import type { WindowSession } from '@shared/api'
import type { RemoteStoreAction } from '@shared/remote-protocol'
import { useAppStore } from '../store'
import { hydrating, invokeRemote, withQuietCalls, wsTransport } from './ws-transport'
import { installFileSync, withPendingEdits } from './file-sync'

type Applied = (action: RemoteStoreAction, args: unknown[]) => void

const appliedListeners = new Set<Applied>()

export function applyMirrorSession(session: WindowSession | null | undefined): void {
  if (!session?.workspace) return
  const merged = withPendingEdits(session)
  withQuietCalls(() => useAppStore.getState().hydrateWindowSession(merged))
}

export function onMirrorApplied(cb: Applied): () => void {
  appliedListeners.add(cb)
  return () => appliedListeners.delete(cb)
}

export async function runMirrored(action: RemoteStoreAction, args: unknown[]): Promise<void> {
  const res = await invokeRemote<{ session: WindowSession | null }>('remote:storeAction', { action, args })
  applyMirrorSession(res?.session)
  for (const l of appliedListeners) l(action, args)
}

function mirrored(action: RemoteStoreAction) {
  return (...args: unknown[]): void => {
    if (hydrating()) return
    runMirrored(action, args).catch((e: Error) => console.warn(`[remote] ${action} failed: ${e.message}`))
  }
}

export function installMirror(): void {
  useAppStore.setState({
    setActiveWorkspace: mirrored('setActiveWorkspace'),
    activateTab: mirrored('activateTab'),
    setActiveGroup: mirrored('setActiveGroup'),
    setTabScratchpad: mirrored('setTabScratchpad'),
    openTabBeside: mirrored('openTabBeside') as never,
    exitFullscreen: mirrored('exitFullscreen'),
    setViewerLive: mirrored('setViewerLive'),
    toggleBlame: mirrored('toggleBlame')
  })
  wsTransport.on('remote:session', (session: WindowSession) => applyMirrorSession(session))
  installFileSync()
}
