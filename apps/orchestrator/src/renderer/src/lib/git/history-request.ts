import { useEffect, useRef } from 'react'
import { censusTrack } from '@shared/census'

const pending = new Map<string, string[]>()
censusTrack('history-request.pending', pending)
const listeners = new Set<(projectPath: string) => void>()
censusTrack('history-request.listeners', listeners)

function norm(p: string): string {
  return p.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function repoRelativePaths(root: string, absPaths: string[]): string[] {
  const base = norm(root)
  const out: string[] = []
  for (const abs of absPaths) {
    const p = norm(abs)
    if (p === base) out.push('.')
    else if (p.startsWith(`${base}/`)) out.push(p.slice(base.length + 1))
  }
  return [...new Set(out)]
}

export function postGitHistoryRequest(projectPath: string, absPaths: string[]): void {
  const key = norm(projectPath)
  pending.set(key, absPaths)
  for (const fn of listeners) fn(key)
}

const pendingCommits = new Map<string, string>()
censusTrack('history-request.pendingCommits', pendingCommits)
const commitListeners = new Set<(projectPath: string) => void>()
censusTrack('history-request.commitListeners', commitListeners)

export function postGitCommitRequest(projectPath: string, hash: string): void {
  const key = norm(projectPath)
  pendingCommits.set(key, hash)
  for (const fn of commitListeners) fn(key)
}

export function useGitCommitRequests(projectPath: string | undefined, onCommit: (hash: string) => void): void {
  const onCommitRef = useRef(onCommit)
  onCommitRef.current = onCommit
  useEffect(() => {
    if (!projectPath) return
    const key = norm(projectPath)
    const take = (target: string): void => {
      if (target !== key) return
      const hash = pendingCommits.get(key)
      if (!hash) return
      pendingCommits.delete(key)
      onCommitRef.current(hash)
    }
    take(key)
    commitListeners.add(take)
    return () => {
      commitListeners.delete(take)
    }
  }, [projectPath])
}

export function useGitHistoryRequests(
  projectPath: string | undefined,
  root: string,
  onPaths: (paths: string[]) => void
): void {
  const onPathsRef = useRef(onPaths)
  onPathsRef.current = onPaths
  useEffect(() => {
    if (!projectPath) return
    const key = norm(projectPath)
    const take = (target: string): void => {
      if (target !== key) return
      const abs = pending.get(key)
      if (!abs) return
      pending.delete(key)
      const rel = repoRelativePaths(root, abs)
      if (rel.length > 0) onPathsRef.current(rel)
    }
    take(key)
    listeners.add(take)
    return () => {
      listeners.delete(take)
    }
  }, [projectPath, root])
}
