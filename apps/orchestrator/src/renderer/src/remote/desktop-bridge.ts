import { useEffect } from 'react'
import { REMOTE_DESKTOP_CALLS, REMOTE_HOST_CALLS, REMOTE_STORE_ACTIONS } from '@shared/remote-protocol'
import { useAppStore } from '../store'
import { runDesktopCall } from '../lib/actions/desktop-actions'
import { openProjectOnMac } from './desktop-open-project'
import { syncRestorePromptsToPhones } from '../lib/claude-sessions/launch-restore'

export function useRemoteDesktopBridge(): void {
  useEffect(() => syncRestorePromptsToPhones(), [])
  useEffect(
    () =>
      window.api.remote.onStoreAction(({ reqId, action, args, at, ttl }) => {
        const late = at && ttl ? Date.now() - at - ttl : 0
        if (late > 0) {
          console.warn(`[remote] skipped the phone's ${action}: it arrived ${Math.round((late + (ttl ?? 0)) / 1000)} s late and the phone already gave up on it`)
          window.api.remote.storeActionDone(reqId, 'The Satura window was busy, so this did not run')
          return
        }
        if (REMOTE_HOST_CALLS.includes(action)) {
          const run = action === 'openProject' ? openProjectOnMac(String(args[0] ?? ''), typeof args[1] === 'string' ? args[1] : undefined) : Promise.reject(new Error(`Unknown action ${action}`))
          void run.then(
            (value) => window.api.remote.storeActionDone(reqId, undefined, value),
            (e) => window.api.remote.storeActionDone(reqId, (e as Error)?.message ?? String(e))
          )
          return
        }
        if (REMOTE_DESKTOP_CALLS.includes(action)) {
          void runDesktopCall(action, args).then(
            (value) => window.api.remote.storeActionDone(reqId, undefined, value),
            (e) => window.api.remote.storeActionDone(reqId, (e as Error)?.message ?? String(e))
          )
          return
        }
        try {
          const fn = REMOTE_STORE_ACTIONS.includes(action)
            ? (useAppStore.getState()[action as 'activateTab'] as (...a: unknown[]) => void)
            : null
          if (typeof fn !== 'function') throw new Error(`Unknown action ${action}`)
          fn(...args)
          const s = useAppStore.getState()
          if (s.hydrationSucceeded) window.api.session.updateWindow(s.buildWindowSession({ terminalSnapshots: false }))
          window.api.remote.storeActionDone(reqId)
        } catch (e) {
          window.api.remote.storeActionDone(reqId, (e as Error)?.message ?? String(e))
        }
      }),
    []
  )
}
