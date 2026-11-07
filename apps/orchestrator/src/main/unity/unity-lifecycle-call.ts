import { BlockedError, type HandleCtx } from '../handles/registry'
import { guardDialogs } from '../handles/dialogs'
import { unityLifecycle } from './lifecycle'
import { lifecycleCall, relaunchAndWait, type RelaunchDeps, type RelaunchOutcome } from './relaunch-wait'
import { unityProvider } from './unity-instance-provider'

export function relaunchDeps(log?: (line: string) => void): RelaunchDeps {
  return {
    relaunch: (p) => unityProvider.relaunchProject(p),
    lifecycle: (p) => unityProvider.lifecycle(p),
    next: (p, seq, ms, signal) => unityLifecycle.next(p, seq, ms, signal),
    dialogs: async (p, signal) => {
      const ctx = { signal, answered: [] as string[], log: (line: string) => log?.(line) } as unknown as HandleCtx
      try {
        await guardDialogs(ctx, p)
        return null
      } catch (e) {
        if (e instanceof BlockedError) return e.message
        throw e
      }
    },
    settle: (p) => unityProvider.dropPendingRelaunch(p),
    log
  }
}

export function relaunchProjectAndWait(projectPath: string, timeoutMs: number, signal?: AbortSignal, log?: (line: string) => void): Promise<RelaunchOutcome> {
  return relaunchAndWait(relaunchDeps(log ?? ((line) => console.log(`[unity-lifecycle] relaunch ${projectPath}: ${line}`))), projectPath, timeoutMs, signal)
}

export function unityLifecycleCall(params: Record<string, unknown>, projectRoot: string, signal?: AbortSignal): Promise<unknown> {
  const log = (line: string): void => console.log(`[unity-lifecycle] relaunch ${String(params.path || projectRoot)}: ${line}`)
  return lifecycleCall({ ...relaunchDeps(log), manages: (p) => unityProvider.managesProject(p) })(params, projectRoot, signal)
}
