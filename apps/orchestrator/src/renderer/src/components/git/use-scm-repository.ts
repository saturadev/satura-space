import { useCallback, useEffect, useRef, useState } from 'react'
import type { GitScmApi, ScmGitError, ScmRemoteProgress, ScmRepositoryState, ScmResult } from '@shared/git-scm'
import { debugLog } from '@shared/debug-log'

export type ScmOperation =
  | 'Stage'
  | 'Unstage'
  | 'Commit'
  | 'Fetch'
  | 'Pull'
  | 'Push'
  | 'NeverCommit'
  | 'Stash'
  | 'Abort'
  | 'Merge'
  | 'Discard'
  | 'Ignore'

const VERBS: Record<ScmOperation, string> = {
  Stage: 'Staging',
  Unstage: 'Unstaging',
  Commit: 'Committing',
  Fetch: 'Fetching',
  Pull: 'Pulling',
  Push: 'Pushing',
  NeverCommit: 'Updating Env Changes',
  Stash: 'Stashing',
  Abort: 'Aborting',
  Merge: 'Merging',
  Discard: 'Discarding',
  Ignore: 'Ignoring'
}

export function progressLabel(operation: ScmOperation, paths: readonly string[]): string {
  const verb = VERBS[operation]
  if (paths.length === 0 || operation === 'Commit' || operation === 'Stash' || operation === 'Merge') return `${verb}…`
  if (paths.length === 1) return `${verb} ${paths[0].substring(paths[0].lastIndexOf('/') + 1)}…`
  return `${verb} ${paths.length} files…`
}

export interface ScmProgress {
  readonly id: number
  readonly operation: ScmOperation
  readonly label: string
  readonly paths: readonly string[]
  readonly started: number
}

export interface ScmOperationError {
  readonly operation: ScmOperation
  readonly error: ScmGitError
}

export interface ScmRepository {
  readonly api: GitScmApi
  readonly root: string
  readonly state: ScmRepositoryState | null
  readonly loadError: ScmGitError | null
  readonly busy: ScmOperation | null
  readonly progress: readonly ScmProgress[]
  readonly remote: ScmRemoteProgress | null
  readonly cancelRemote: () => void
  readonly operationError: ScmOperationError | null
  readonly dismissError: () => void
  readonly refresh: () => Promise<void>
  readonly run: <T>(operation: ScmOperation, fn: () => Promise<ScmResult<T>>, paths?: readonly string[]) => Promise<boolean>
}

export function gitScmApi(): GitScmApi {
  return window.api.gitScm
}

export function useScmRepository(root: string, visible = true): ScmRepository {
  const api = gitScmApi()
  const [state, setState] = useState<ScmRepositoryState | null>(null)
  const [loadError, setLoadError] = useState<ScmGitError | null>(null)
  const [busy, setBusy] = useState<ScmOperation | null>(null)
  const [progress, setProgress] = useState<readonly ScmProgress[]>([])
  const [remote, setRemote] = useState<ScmRemoteProgress | null>(null)
  const progressSeq = useRef(0)
  const [operationError, setOperationError] = useState<ScmOperationError | null>(null)
  const inFlight = useRef<Promise<void> | null>(null)
  const pending = useRef(false)
  const rootRef = useRef(root)
  rootRef.current = root
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const missedFocus = useRef(false)

  const refresh = useCallback(async (): Promise<void> => {
    if (inFlight.current) {
      pending.current = true
      return inFlight.current
    }
    const run = async (): Promise<void> => {
      do {
        pending.current = false
        const target = rootRef.current
        const result = await api.getState(target)
        if (target !== rootRef.current) continue
        if (result.ok) {
          setState(result.value)
          setLoadError(null)
        } else {
          setLoadError(result.error)
        }
      } while (pending.current)
    }
    inFlight.current = run().finally(() => {
      inFlight.current = null
    })
    return inFlight.current
  }, [api])

  useEffect(() => {
    setState(null)
    setLoadError(null)
    setRemote(null)
    if (!root) return
    void refresh()
    void api.watch(root)
    const off = api.onDidChange((changed) => {
      if (changed === root) void refresh()
    })
    const offProgress = api.onRemoteProgress((changed, next) => {
      if (changed === root) setRemote(next)
    })
    const onFocus = (): void => {
      if (visibleRef.current) void refresh()
      else missedFocus.current = true
    }
    window.addEventListener('focus', onFocus)
    return () => {
      off()
      offProgress()
      window.removeEventListener('focus', onFocus)
      void api.unwatch(root)
    }
  }, [root, api, refresh])

  const run = useCallback(
    async <T,>(operation: ScmOperation, fn: () => Promise<ScmResult<T>>, paths: readonly string[] = []): Promise<boolean> => {
      setBusy(operation)
      const id = ++progressSeq.current
      const label = progressLabel(operation, paths)
      const started = Date.now()
      let ran = 0
      setProgress((prev) => [...prev, { id, operation, label, paths, started }])
      try {
        const result = await fn()
        ran = Date.now() - started
        if (!result.ok) {
          setOperationError(result.error.gitErrorCode === 'Cancelled' ? null : { operation, error: result.error })
          return false
        }
        setOperationError(null)
        return true
      } finally {
        setBusy(null)
        try {
          await refresh()
        } finally {
          setProgress((prev) => prev.filter((p) => p.id !== id))
          const total = Date.now() - started
          if (total >= 750) debugLog(`[scm] ${label} took ${total}ms: git ${ran}ms, refresh ${total - ran}ms`)
        }
      }
    },
    [refresh]
  )

  useEffect(() => {
    if (!visible || !missedFocus.current) return
    missedFocus.current = false
    void refresh()
  }, [visible, refresh])

  const dismissError = useCallback(() => setOperationError(null), [])

  const cancelRemote = useCallback(() => {
    void api.cancelRemote(rootRef.current)
  }, [api])

  const current: ScmRepository = { api, root, state, loadError, busy, progress, remote, cancelRemote, operationError, dismissError, refresh, run }
  const shown = useRef(current)
  if (visible) shown.current = current
  return shown.current
}
