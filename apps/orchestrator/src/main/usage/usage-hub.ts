import { BrowserWindow } from 'electron'
import type { UsageProvider, UsageRemaining, UsageSnapshot } from '@shared/api'
import { visibleUsageProviders } from '@shared/types'
import { censusTrack } from '@shared/census'
import { loadState } from '../persistence'

type UsageReader = (force?: boolean) => Promise<UsageRemaining>

const WATCH_MS = 60_000

const readers = new Map<UsageProvider, UsageReader>()
const latest = new Map<UsageProvider, UsageRemaining>()
const busy = new Map<UsageProvider, number>()
const listeners = new Set<(snapshot: UsageSnapshot) => void>()
let sentKey = ''
let watch: NodeJS.Timeout | null = null
censusTrack('usage-hub.latest', latest)
censusTrack('usage-hub.listeners', listeners)

function visible(): UsageProvider[] {
  return visibleUsageProviders(loadState().settings.hiddenUsageProviders)
}

export function usageSnapshot(): UsageSnapshot {
  const providers = visible()
  const usage: UsageSnapshot['usage'] = {}
  for (const p of providers) {
    const u = latest.get(p)
    if (u) usage[p] = u
  }
  return { providers, usage, checking: providers.filter((p) => (busy.get(p) ?? 0) > 0) }
}

function keyOf(s: UsageSnapshot): string {
  return JSON.stringify(s, (k, v) => (k === 'updatedAt' && typeof v === 'number' ? Math.floor(v / 60_000) : v))
}

function changed(): void {
  const snapshot = usageSnapshot()
  const key = keyOf(snapshot)
  if (key === sentKey) return
  sentKey = key
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('usage:changed', snapshot)
  for (const l of listeners) {
    try {
      l(snapshot)
    } catch (e) {
      console.warn(`[usage] listener failed: ${(e as Error).message}`)
    }
  }
}

export function registerUsageReader(provider: UsageProvider, read: UsageReader): void {
  readers.set(provider, read)
}

export async function readUsage(provider: UsageProvider, force = false): Promise<UsageRemaining> {
  const read = readers.get(provider)
  if (!read) throw new Error(`No usage reader for ${provider}`)
  const shown = force || !latest.has(provider)
  if (shown) {
    busy.set(provider, (busy.get(provider) ?? 0) + 1)
    changed()
  }
  try {
    const usage = await read(force)
    latest.set(provider, usage)
    return usage
  } finally {
    if (shown) {
      const n = (busy.get(provider) ?? 1) - 1
      if (n > 0) busy.set(provider, n)
      else busy.delete(provider)
    }
    changed()
  }
}

export function requestUsage(force = false, only?: UsageProvider): UsageSnapshot {
  for (const p of visible()) {
    if (only && p !== only) continue
    if (force || !latest.has(p)) void readUsage(p, force).catch(() => {})
  }
  return usageSnapshot()
}

export function usageSettingsChanged(): void {
  requestUsage()
  changed()
}

export function onUsageChanged(cb: (snapshot: UsageSnapshot) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function watchUsage(on: boolean): void {
  if (!on) {
    if (watch) clearInterval(watch)
    watch = null
    return
  }
  if (watch) return
  watch = setInterval(() => {
    for (const p of visible()) void readUsage(p).catch(() => {})
  }, WATCH_MS)
  watch.unref()
}
