import { watch, type FSWatcher } from 'node:fs'
import { dashboardDir } from '@shared/dashboard'
import { projectPluginsDir } from '@shared/project-plugins'
import { censusTrack } from '@shared/census'

type Listener = (files: string[]) => void

interface Entry {
  dir: string
  listeners: Set<Listener>
  watcher: FSWatcher | null
  retry: ReturnType<typeof setTimeout> | null
  flush: ReturnType<typeof setTimeout> | null
  changed: Set<string>
  missing: boolean
}

const RETRY_MS = 3000
const DEBOUNCE_MS = 120
const entries = new Map<string, Entry>()
censusTrack('dashboard.watch', entries)

function start(e: Entry): void {
  if (e.watcher || !e.listeners.size) return
  try {
    const w = watch(e.dir, { recursive: true }, (_ev, name) => {
      const file = typeof name === 'string' ? name.replace(/\\/g, '/') : ''
      if (/\.tmp-/.test(file)) return
      e.changed.add(file)
      if (e.flush) return
      e.flush = setTimeout(() => {
        e.flush = null
        const files = [...e.changed]
        e.changed.clear()
        for (const l of [...e.listeners]) l(files)
      }, DEBOUNCE_MS)
    })
    w.on('error', () => {
      w.close()
      if (e.watcher === w) e.watcher = null
      e.missing = true
      schedule(e)
    })
    e.watcher = w
    if (e.missing) {
      e.missing = false
      for (const l of [...e.listeners]) l([''])
    }
  } catch {
    e.missing = true
    schedule(e)
  }
}

function schedule(e: Entry): void {
  if (e.retry || !e.listeners.size) return
  e.retry = setTimeout(() => {
    e.retry = null
    start(e)
    if (!e.watcher) schedule(e)
  }, RETRY_MS)
}

export function watchDashboard(project: string, listener: Listener, folder: 'dashboard' | 'plugins' = 'dashboard'): () => void {
  const dir = folder === 'plugins' ? projectPluginsDir(project) : dashboardDir(project)
  let e = entries.get(dir)
  if (!e) {
    e = { dir, listeners: new Set(), watcher: null, retry: null, flush: null, changed: new Set(), missing: false }
    entries.set(dir, e)
  }
  e.listeners.add(listener)
  start(e)
  const entry = e
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size) return
    entry.watcher?.close()
    entry.watcher = null
    if (entry.retry) clearTimeout(entry.retry)
    if (entry.flush) clearTimeout(entry.flush)
    entry.retry = null
    entry.flush = null
    entries.delete(dir)
  }
}
