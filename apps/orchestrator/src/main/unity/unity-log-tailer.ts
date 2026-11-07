import { Worker } from 'node:worker_threads'
import { join, resolve } from 'node:path'
import type { UnityLogLine } from '@shared/api'
import { censusTrack } from '@shared/census'

type Listener = (lines: UnityLogLine[]) => void

interface FromWorker {
  t: 'res' | 'lines'
  reqId?: number
  projectPath?: string
  lines: UnityLogLine[]
}

let worker: Worker | null = null
let seq = 0
let respawnTimer: ReturnType<typeof setTimeout> | null = null
let respawnDelay = 0
let maxSeq = 0
const RESPAWN_MIN_MS = 1000
const RESPAWN_MAX_MS = 30_000
const HEALTHY_RUN_MS = 60_000
const pending = new Map<number, (lines: UnityLogLine[]) => void>()
censusTrack('unity-log-tailer.pending', pending)
const listeners = new Map<string, Set<Listener>>()
censusTrack('unity-log-tailer.listeners', listeners)

function onMessage(m: FromWorker): void {
  for (const line of m.lines) if (line.seq > maxSeq) maxSeq = line.seq
  if (m.t === 'res' && m.reqId !== undefined) {
    const resolveFn = pending.get(m.reqId)
    if (resolveFn) {
      pending.delete(m.reqId)
      resolveFn(m.lines)
    }
  } else if (m.t === 'lines' && m.projectPath) {
    const set = listeners.get(m.projectPath)
    if (set) for (const l of set) l(m.lines)
  }
}

function settlePending(): void {
  const waiting = [...pending.values()]
  pending.clear()
  for (const resolveFn of waiting) resolveFn([])
}

function getWorker(): Worker {
  if (worker) return worker
  if (respawnTimer) {
    clearTimeout(respawnTimer)
    respawnTimer = null
  }
  const w = new Worker(join(__dirname, 'unity-log-worker.js'), { workerData: { seqBase: maxSeq } })
  const spawnedAt = Date.now()
  w.on('message', onMessage)
  w.on('error', (e) => console.error('[unity-console] log worker error:', e))
  w.on('exit', (code) => {
    if (code !== 0) console.error('[unity-console] log worker exited with code', code)
    if (worker !== w) return
    worker = null
    settlePending()
    respawnDelay =
      Date.now() - spawnedAt >= HEALTHY_RUN_MS
        ? RESPAWN_MIN_MS
        : Math.min(RESPAWN_MAX_MS, Math.max(RESPAWN_MIN_MS, respawnDelay * 2))
    if (listeners.size > 0 && !respawnTimer) {
      respawnTimer = setTimeout(() => {
        respawnTimer = null
        if (!worker && listeners.size > 0) getWorker()
      }, respawnDelay)
      respawnTimer.unref?.()
    }
  })
  worker = w
  for (const [key, set] of listeners) {
    for (let i = 0; i < set.size; i++) w.postMessage({ t: 'sub', projectPath: key })
  }
  return w
}

function request(t: 'sub' | 'snap', projectPath: string): Promise<UnityLogLine[]> {
  const reqId = ++seq
  const p = new Promise<UnityLogLine[]>((res) => pending.set(reqId, res))
  getWorker().postMessage({ t, projectPath, reqId })
  return p
}

export const unityLogTailers = {
  async addListener(
    projectPath: string,
    listener: Listener
  ): Promise<{ snapshot: UnityLogLine[]; remove: () => void }> {
    const key = resolve(projectPath)
    getWorker()
    let set = listeners.get(key)
    if (!set) {
      set = new Set()
      listeners.set(key, set)
    }
    set.add(listener)
    const snapshot = await request('sub', projectPath)
    let removed = false
    const remove = (): void => {
      if (removed) return
      removed = true
      const s = listeners.get(key)
      if (s) {
        s.delete(listener)
        if (s.size === 0) listeners.delete(key)
      }
      worker?.postMessage({ t: 'unsub', projectPath })
    }
    return { snapshot, remove }
  },

  getSnapshot(projectPath: string): Promise<UnityLogLine[]> {
    return request('snap', projectPath)
  },

  reset(projectPath: string): void {
    worker?.postMessage({ t: 'reset', projectPath })
  },

  async stopForQuit(): Promise<void> {
    listeners.clear()
    if (respawnTimer) {
      clearTimeout(respawnTimer)
      respawnTimer = null
    }
    const w = worker
    worker = null
    settlePending()
    if (w) await w.terminate().catch(() => {})
  }
}
