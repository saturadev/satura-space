import { ipcMain, webContents } from 'electron'
import { watch, type FSWatcher } from 'node:fs'
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { toNativePath } from './native-path'
import { onRendererReset } from '../window/renderer-reset'
import { censusTrack } from '@shared/census'

const COALESCE_MS = 120
const RETRY_MS = 2000
const PROBE_MS = 5000

interface DirWatchSet {
  desired: string[]
  watchers: Map<string, FSWatcher>
  pending: Set<string>
  flush: ReturnType<typeof setTimeout> | null
  retry: ReturnType<typeof setTimeout> | null
  probe: ReturnType<typeof setInterval> | null
}

const setsByWc = new Map<number, Map<string, DirWatchSet>>()
censusTrack('fs-watch-dirs.setsByWc', setsByWc)

function isLive(wcId: number, watchId: string, set: DirWatchSet): boolean {
  return setsByWc.get(wcId)?.get(watchId) === set
}

function markChanged(set: DirWatchSet, wcId: number, watchId: string, dir: string): void {
  set.pending.add(dir)
  if (set.flush) return
  set.flush = setTimeout(() => {
    set.flush = null
    const dirs = [...set.pending]
    set.pending.clear()
    if (dirs.length === 0 || !isLive(wcId, watchId, set)) return
    const wc = webContents.fromId(wcId)
    if (wc && !wc.isDestroyed()) wc.send('fs:watchDirs:changed', { watchId, dirs })
  }, COALESCE_MS)
}

function scheduleRetry(set: DirWatchSet, wcId: number, watchId: string): void {
  if (set.retry) return
  set.retry = setTimeout(() => {
    set.retry = null
    if (isLive(wcId, watchId, set)) applyDirs(set, wcId, watchId, set.desired)
  }, RETRY_MS)
}

function openWatch(set: DirWatchSet, wcId: number, watchId: string, dir: string): void {
  let w: FSWatcher
  try {
    w = watch(toNativePath(dir), () => markChanged(set, wcId, watchId, dir))
  } catch {
    scheduleRetry(set, wcId, watchId)
    return
  }
  w.on('error', () => {
    try {
      w.close()
    } catch {
    }
    if (set.watchers.get(dir) === w) set.watchers.delete(dir)
    if (!isLive(wcId, watchId, set)) return
    markChanged(set, wcId, watchId, dir)
    scheduleRetry(set, wcId, watchId)
  })
  set.watchers.set(dir, w)
}

function probeWatchers(set: DirWatchSet, wcId: number, watchId: string): void {
  for (const [dir, w] of [...set.watchers]) {
    stat(toNativePath(dir)).catch(() => {
      if (set.watchers.get(dir) !== w) return
      try {
        w.close()
      } catch {
      }
      set.watchers.delete(dir)
      if (!isLive(wcId, watchId, set)) return
      markChanged(set, wcId, watchId, dir)
      scheduleRetry(set, wcId, watchId)
    })
  }
}

function applyDirs(set: DirWatchSet, wcId: number, watchId: string, dirs: string[]): void {
  set.desired = dirs
  const want = new Set(dirs)
  for (const [dir, w] of [...set.watchers]) {
    if (want.has(dir)) continue
    try {
      w.close()
    } catch {
    }
    set.watchers.delete(dir)
  }
  for (const dir of want) if (!set.watchers.has(dir)) openWatch(set, wcId, watchId, dir)
  if (set.watchers.size > 0 && !set.probe) {
    set.probe = setInterval(() => probeWatchers(set, wcId, watchId), PROBE_MS)
  } else if (set.watchers.size === 0 && set.probe) {
    clearInterval(set.probe)
    set.probe = null
  }
}

function stopSet(wcId: number, watchId: string): void {
  const own = setsByWc.get(wcId)
  const set = own?.get(watchId)
  if (!own || !set) return
  if (set.flush) clearTimeout(set.flush)
  if (set.retry) clearTimeout(set.retry)
  if (set.probe) clearInterval(set.probe)
  for (const w of set.watchers.values()) {
    try {
      w.close()
    } catch {
    }
  }
  set.watchers.clear()
  set.pending.clear()
  own.delete(watchId)
  if (own.size === 0) setsByWc.delete(wcId)
}

export function registerFsWatchDirs(): void {
  ipcMain.on('fs:watchDirs:set', (e, args: { watchId?: string; dirs?: string[] }) => {
    const wcId = e.sender.id
    const watchId = args?.watchId
    if (!watchId || !Array.isArray(args?.dirs)) return
    const dirs = args.dirs.filter((d) => typeof d === 'string' && isAbsolute(d))
    let own = setsByWc.get(wcId)
    if (!own) {
      own = new Map()
      setsByWc.set(wcId, own)
      onRendererReset(e.sender, 'fs:watchDirs', () => {
        const m = setsByWc.get(wcId)
        if (m) for (const id of [...m.keys()]) stopSet(wcId, id)
      })
    }
    let set = own.get(watchId)
    if (!set) {
      set = {
        desired: [],
        watchers: new Map(),
        pending: new Set(),
        flush: null,
        retry: null,
        probe: null
      }
      own.set(watchId, set)
    }
    applyDirs(set, wcId, watchId, dirs)
  })

  ipcMain.on('fs:watchDirs:stop', (e, args: { watchId?: string }) => {
    if (args?.watchId) stopSet(e.sender.id, args.watchId)
  })
}
