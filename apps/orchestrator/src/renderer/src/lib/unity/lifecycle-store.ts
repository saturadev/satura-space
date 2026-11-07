import { useEffect, useSyncExternalStore } from 'react'
import { stateLabel, type UnityLifecycle } from '@shared/unity/lifecycle'
import { censusTrack } from '@shared/census'
import { remoteLink } from '../remote-link'

const records = new Map<string, UnityLifecycle>()
censusTrack('unity-lifecycle.records', records)
const watched = new Map<string, { path: string; count: number }>()
censusTrack('unity-lifecycle.watched', watched)
const listeners = new Set<() => void>()
let wired = false

function keyOf(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function nameOf(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').split('/').pop() || path
}

function emit(): void {
  for (const l of listeners) l()
}

function put(life: UnityLifecycle | null | undefined, why: string, force = false): void {
  if (!life || typeof life.project !== 'string') return
  const key = keyOf(life.project)
  const prev = records.get(key)
  const restarted = !!prev && prev.boot !== life.boot
  if (prev && !force && !restarted && prev.seq >= life.seq) return
  records.set(key, life)
  const from = prev ? stateLabel(prev) : 'unknown'
  const to = stateLabel(life)
  if (from !== to && remoteLink() !== null)
    console.info(`[unity] phone has Unity of ${nameOf(life.project)} as ${to} (was ${from}): ${restarted ? 'the desktop started over' : why}, desktop record ${life.seq}`)
  emit()
}

function wire(): void {
  if (wired) return
  wired = true
  window.api.unity.onLifecycle((life) => put(life, 'the desktop sent a change'))
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function onUnityLifecycle(cb: () => void): () => void {
  wire()
  return subscribe(cb)
}

export function getUnityLifecycle(path: string): UnityLifecycle | null {
  return path ? (records.get(keyOf(path)) ?? null) : null
}

export function watchUnityLifecycle(path: string): () => void {
  wire()
  const key = keyOf(path)
  const entry = watched.get(key)
  if (entry) entry.count++
  else watched.set(key, { path, count: 1 })
  let alive = true
  void window.api.unity
    .watchLifecycle(path)
    .then((life) => {
      if (alive) put(life, 'the panel asked the desktop')
    })
    .catch(() => {})
  return () => {
    if (!alive) return
    alive = false
    const cur = watched.get(key)
    if (cur && --cur.count <= 0) watched.delete(key)
    window.api.unity.unwatchLifecycle(path)
  }
}

export async function reloadUnityLifecycles(why: string): Promise<string[]> {
  const paths = [...watched.values()].map((w) => w.path)
  const out = await Promise.all(
    paths.map((path) =>
      window.api.unity.lifecycle(path).then(
        (life) => {
          const before = getUnityLifecycle(path)
          put(life, why, true)
          const was = before ? stateLabel(before) : 'unknown'
          const now = stateLabel(life)
          return `${nameOf(path)} ${now}${was !== now ? ` (was ${was})` : ''}`
        },
        (e: Error) => `${nameOf(path)} not read: ${e?.message ?? e}`
      )
    )
  )
  return out
}

export function useUnityLifecycle(path: string | null | undefined): UnityLifecycle | null {
  useEffect(() => (path ? watchUnityLifecycle(path) : undefined), [path])
  return useSyncExternalStore(subscribe, () => (path ? (records.get(keyOf(path)) ?? null) : null))
}
