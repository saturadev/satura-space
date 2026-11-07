import { useEffect, useRef } from 'react'
import { useAppStore } from '../../../store'

export function useFileSearchRunner(params: {
  worktreeId: string
  rootPath: string
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  includeGlobs: string
  excludeGlobs: string
  useGitignore: boolean
  contextLines: number
  runNonce: number
}): () => void {
  const {
    worktreeId,
    rootPath,
    query,
    caseSensitive,
    wholeWord,
    regex,
    includeGlobs,
    excludeGlobs,
    useGitignore,
    contextLines,
    runNonce
  } = params

  const beginSearchRun = useAppStore((s) => s.beginSearchRun)
  const appendSearchFiles = useAppStore((s) => s.appendSearchFiles)
  const finishSearchRun = useAppStore((s) => s.finishSearchRun)
  const updateSearchState = useAppStore((s) => s.updateSearchState)

  const requestIdRef = useRef(0)
  const worktreeIdRef = useRef(worktreeId)
  worktreeIdRef.current = worktreeId

  useEffect(() => {
    const offResult = window.api.fs.onSearchResult((e) => {
      if (e.requestId === requestIdRef.current) appendSearchFiles(worktreeIdRef.current, e.files)
    })
    const offDone = window.api.fs.onSearchDone((e) => {
      if (e.requestId === requestIdRef.current) finishSearchRun(worktreeIdRef.current, e.limitHit)
    })
    return () => {
      offResult()
      offDone()
    }
  }, [appendSearchFiles, finishSearchRun])

  useEffect(() => () => window.api.fs.searchCancel(requestIdRef.current), [])

  useEffect(() => {
    window.api.fs.searchCancel(requestIdRef.current)

    if (!query.trim()) {
      updateSearchState(worktreeId, { result: null, status: 'idle' })
      return
    }

    const reqId = ++requestIdRef.current
    const t = setTimeout(() => {
      beginSearchRun(worktreeId)
      window.api.fs.searchStart(reqId, {
        rootPath,
        query,
        caseSensitive,
        wholeWord,
        regex,
        includeGlobs,
        excludeGlobs,
        useGitignore,
        contextLines
      })
    }, 250)
    return () => clearTimeout(t)
  }, [
    worktreeId,
    rootPath,
    query,
    caseSensitive,
    wholeWord,
    regex,
    includeGlobs,
    excludeGlobs,
    useGitignore,
    contextLines,
    runNonce,
    beginSearchRun,
    updateSearchState
  ])

  return () => {
    window.api.fs.searchCancel(requestIdRef.current)
    finishSearchRun(worktreeIdRef.current, false)
  }
}
