import { useEffect, useState, useSyncExternalStore } from 'react'
import type { ScratchpadInfo, ScratchpadResult, ScratchpadStatus } from '@shared/scratchpads'
import { censusTrack } from '@shared/census'
import { forgetWorld } from './world-store'
import { debugLog } from '@shared/debug-log'

const POLL_MS = 1500
const EMPTY: ScratchpadInfo[] = []

interface Entry {
  list: ScratchpadInfo[]
  sig: string
  error: string | null
  loaded: boolean
  watchers: number
  timer: number | null
  inflight: Promise<void> | null
  again: Promise<void> | null
}

const entries = new Map<string, Entry>()
censusTrack('scratchpads.entries', entries)
const listeners = new Set<() => void>()
censusTrack('scratchpads.listeners', listeners)
let offChanged: (() => void) | null = null

function emit(): void {
  listeners.forEach((fn) => fn())
}

function entryFor(projectPath: string): Entry {
  let e = entries.get(projectPath)
  if (!e) {
    e = { list: EMPTY, sig: '', error: null, loaded: false, watchers: 0, timer: null, inflight: null, again: null }
    entries.set(projectPath, e)
  }
  return e
}

async function fetchList(projectPath: string, e: Entry): Promise<void> {
  const r = await window.api.scratchpads.list(projectPath)
  const list = r.ok ? r.data : e.list
  const error = r.ok ? null : r.error
  const sig = JSON.stringify(list)
  if (sig === e.sig && error === e.error && e.loaded) return
  const gone = e.list.filter((old) => !list.some((s) => s.path === old.path))
  e.list = list
  e.sig = sig
  e.error = error
  e.loaded = true
  for (const s of gone) forgetWorld(s.path)
  emit()
}

export function refreshScratchpads(projectPath: string): Promise<void> {
  if (!projectPath) return Promise.resolve()
  const e = entryFor(projectPath)
  if (e.inflight) {
    e.again ??= e.inflight.then(() => {
      e.again = null
      return refreshScratchpads(projectPath)
    })
    return e.again
  }
  const run = fetchList(projectPath, e).finally(() => {
    e.inflight = null
  })
  e.inflight = run
  return run
}

function ensureChangedListener(): void {
  if (offChanged) return
  offChanged = window.api.scratchpads.onChanged(() => {
    for (const [path, e] of entries) if (e.watchers > 0) void refreshScratchpads(path)
  })
}

export function watchScratchpads(projectPath: string): () => void {
  if (!projectPath) return () => {}
  ensureChangedListener()
  const e = entryFor(projectPath)
  e.watchers++
  if (e.watchers === 1) {
    void window.api.scratchpads.attach(projectPath)
    void refreshScratchpads(projectPath)
    e.timer = window.setInterval(() => void refreshScratchpads(projectPath), POLL_MS)
  }
  return () => {
    e.watchers--
    if (e.watchers > 0) return
    if (e.timer != null) window.clearInterval(e.timer)
    e.timer = null
    if (entries.get(projectPath) === e) entries.delete(projectPath)
    if (e.loaded) emit()
  }
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function useScratchpads(projectPath: string): {
  list: ScratchpadInfo[]
  error: string | null
  loaded: boolean
} {
  useEffect(() => watchScratchpads(projectPath), [projectPath])
  const list = useSyncExternalStore(subscribe, () => entries.get(projectPath)?.list ?? EMPTY)
  const error = useSyncExternalStore(subscribe, () => entries.get(projectPath)?.error ?? null)
  const loaded = useSyncExternalStore(subscribe, () => entries.get(projectPath)?.loaded ?? false)
  return { list, error, loaded }
}

export function useScratchpadPick(
  projectPath: string,
  scratchpadId: string | null | undefined
): {
  list: ScratchpadInfo[]
  error: string | null
  loaded: boolean
  selected: ScratchpadInfo | null
  missing: boolean
} {
  const { list, error, loaded } = useScratchpads(projectPath)
  const found = scratchpadId ? (list.find((s) => s.id === scratchpadId) ?? null) : null
  const unknown = loaded && !!scratchpadId && !found
  const key = `${projectPath}\n${scratchpadId ?? ''}`
  const [goneKey, setGoneKey] = useState<string | null>(null)
  useEffect(() => {
    if (!unknown) return
    let alive = true
    void refreshScratchpads(projectPath).then(() => {
      const now = entries.get(projectPath)?.list ?? EMPTY
      if (alive && !now.some((s) => s.id === scratchpadId)) setGoneKey(key)
    })
    return () => {
      alive = false
    }
  }, [unknown, key, projectPath, scratchpadId])
  const missing = unknown && goneKey === key
  return {
    list,
    error,
    loaded: loaded && (!unknown || missing),
    selected: scratchpadId ? found : (list[0] ?? null),
    missing
  }
}

export type ScratchpadAction = 'start' | 'stop' | 'restart' | 'rename' | 'remove'

export interface ScratchpadActionState {
  action: ScratchpadAction | null
  error: string | null
}

const IDLE: ScratchpadActionState = { action: null, error: null }
const actions = new Map<string, ScratchpadActionState & { seq: number }>()
censusTrack('scratchpads.actions', actions)
let actionSeq = 0

function actionKey(projectPath: string, id: string): string {
  return `${projectPath}\n${id}`
}

export async function runScratchpadAction<T>(
  projectPath: string,
  id: string,
  action: ScratchpadAction,
  fn: () => Promise<ScratchpadResult<T>>
): Promise<T | null> {
  const key = actionKey(projectPath, id)
  const seq = ++actionSeq
  actions.set(key, { action, error: null, seq })
  emit()
  let error: string | null = null
  try {
    const r = await fn()
    if (r.ok) return r.data
    error = r.error
    return null
  } catch (e) {
    error = (e as Error)?.message ?? String(e)
    return null
  } finally {
    await refreshScratchpads(projectPath)
    if (actions.get(key)?.seq === seq) {
      const gone = !(entries.get(projectPath)?.list ?? EMPTY).some((s) => s.id === id)
      if (error && !gone) actions.set(key, { action: null, error, seq })
      else actions.delete(key)
      emit()
    }
  }
}

export function clearScratchpadError(projectPath: string, id: string): void {
  const key = actionKey(projectPath, id)
  const cur = actions.get(key)
  if (!cur?.error) return
  if (cur.action) actions.set(key, { ...cur, error: null })
  else actions.delete(key)
  emit()
}

export function useScratchpadAction(projectPath: string, id: string | null | undefined): ScratchpadActionState {
  return useSyncExternalStore(subscribe, () => (id ? actions.get(actionKey(projectPath, id)) : undefined) ?? IDLE)
}

export function shownScratchpadStatus(info: ScratchpadInfo, action: ScratchpadAction | null): ScratchpadStatus {
  if (action === 'stop' || action === 'remove') return info.status === 'stopped' ? info.status : 'stopping'
  if (action === 'restart' || (action === 'start' && info.status !== 'running')) return 'starting'
  return info.status
}

const gridOn = new Set<string>()
censusTrack('scratchpads.gridOn', gridOn)
const gridListeners = new Set<() => void>()

function subscribeGrid(fn: () => void): () => void {
  gridListeners.add(fn)
  return () => gridListeners.delete(fn)
}

export function setScratchpadGrid(ptyId: string, on: boolean): void {
  if (gridOn.has(ptyId) === on) return
  if (on) gridOn.add(ptyId)
  else gridOn.delete(ptyId)
  debugLog(`[scratchpad] grid ${on ? 'on' : 'off'} for ${ptyId}`)
  gridListeners.forEach((fn) => fn())
}

export function useScratchpadGrid(ptyId: string): boolean {
  return useSyncExternalStore(subscribeGrid, () => gridOn.has(ptyId))
}

export function scratchpadGridSnapshot(): string[] {
  return [...gridOn]
}

export function isScratchpadLive(info: ScratchpadInfo | null): boolean {
  return !!info && (info.status === 'running' || info.status === 'starting')
}

export function scratchpadCacheSnapshot(): {
  path: string
  list: ScratchpadInfo[]
  watchers: number
  loaded: boolean
  polling: boolean
  actions: Record<string, ScratchpadActionState>
}[] {
  return [...entries].map(([path, e]) => {
    const mine: Record<string, ScratchpadActionState> = {}
    for (const [key, a] of actions) {
      if (key.startsWith(`${path}\n`)) mine[key.slice(path.length + 1)] = { action: a.action, error: a.error }
    }
    return { path, list: e.list, watchers: e.watchers, loaded: e.loaded, polling: e.timer != null, actions: mine }
  })
}
