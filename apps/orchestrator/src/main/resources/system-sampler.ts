import { execFile } from 'node:child_process'
import { readFile, statfs } from 'node:fs/promises'
import { cpus, freemem, homedir, totalmem } from 'node:os'
import type { SystemDisk, SystemLoad, SystemSample } from '@shared/api'
import { listSessionWindows } from '../session-registry'

const WINDOW_MS = 10 * 60_000
const FAST_MS = 2000
const IDLE_MS = 10_000
const WATCH_GRACE_MS = 6000

const history: SystemSample[] = []
let lastCpu: { idle: number; total: number } | null = null
let disk: SystemDisk | null = null
let watchedUntil = 0
let timer: ReturnType<typeof setTimeout> | null = null
let running = false

function cpuTimes(): { idle: number; total: number } {
  let idle = 0
  let total = 0
  for (const c of cpus()) {
    const t = c.times
    idle += t.idle
    total += t.user + t.nice + t.sys + t.idle + t.irq
  }
  return { idle, total }
}

function vmStat(): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('/usr/bin/vm_stat', { timeout: 3000 }, (err, out) => (err ? reject(err) : resolve(out)))
  })
}

function macUsedMemory(text: string): number | null {
  const page = Number(text.match(/page size of (\d+) bytes/)?.[1] ?? 0)
  if (!page) return null
  const pages = (label: string): number => Number(text.match(new RegExp(`^${label}:\\s+(\\d+)`, 'm'))?.[1] ?? 0)
  const used =
    pages('Pages active') +
    pages('Pages inactive') +
    pages('Pages speculative') +
    pages('Pages wired down') +
    pages('Pages occupied by compressor') -
    pages('Pages purgeable') -
    pages('File-backed pages')
  return Math.max(0, used * page)
}

async function usedMemory(): Promise<number> {
  try {
    if (process.platform === 'darwin') {
      const used = macUsedMemory(await vmStat())
      if (used !== null) return used
    }
    if (process.platform === 'linux') {
      const info = await readFile('/proc/meminfo', 'utf8')
      const kb = (k: string): number => Number(info.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'))?.[1] ?? 0)
      if (kb('MemAvailable')) return (kb('MemTotal') - kb('MemAvailable')) * 1024
    }
  } catch {
  }
  return totalmem() - freemem()
}

function projectsPath(): string {
  for (const w of listSessionWindows()) {
    const ws = w.snapshot.session?.workspace
    const active = ws?.workspaces.find((x) => x.id === ws.activeWorkspaceId) ?? ws?.workspaces[0]
    const path = active?.worktreePath || active?.folderPath
    if (path) return path
  }
  return homedir()
}

async function readDisk(): Promise<SystemDisk | null> {
  for (const path of [projectsPath(), homedir()]) {
    try {
      const s = await statfs(path)
      const total = s.blocks * s.bsize
      if (total > 0) return { path, total, free: s.bavail * s.bsize }
    } catch {
    }
  }
  return null
}

async function sample(): Promise<void> {
  const now = cpuTimes()
  const prev = lastCpu
  lastCpu = now
  const [mem, d] = await Promise.all([usedMemory(), readDisk()])
  if (d) disk = d
  if (!prev || now.total <= prev.total) return
  const cpu = Math.min(100, Math.max(0, 100 * (1 - (now.idle - prev.idle) / (now.total - prev.total))))
  const t = Date.now()
  history.push({ t, cpu: Math.round(cpu * 10) / 10, mem })
  while (history.length && history[0].t < t - WINDOW_MS) history.shift()
}

function schedule(ms: number): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => void tick(), ms)
  timer.unref?.()
}

async function tick(): Promise<void> {
  timer = null
  if (running) return
  running = true
  try {
    await sample()
  } catch (e) {
    console.log(`[system-load] sample failed: ${(e as Error)?.message ?? e}`)
  } finally {
    running = false
  }
  schedule(Date.now() < watchedUntil ? FAST_MS : IDLE_MS)
}

export function startSystemSampler(): void {
  if (timer || running) return
  lastCpu = cpuTimes()
  schedule(1000)
}

export function systemLoad(since = 0): SystemLoad {
  const idle = Date.now() >= watchedUntil
  watchedUntil = Date.now() + WATCH_GRACE_MS
  if (idle && !running) {
    console.log('[system-load] watched, sampling every 2 s')
    schedule(0)
  }
  return {
    samples: since ? history.filter((s) => s.t > since) : history.slice(),
    memTotal: totalmem(),
    disk,
    intervalMs: FAST_MS,
    windowMs: WINDOW_MS,
    cores: cpus().length
  }
}

export function systemLoadInfo(): { latest: SystemSample | null; history: number; spanSec: number; watched: boolean; memTotal: number; disk: SystemDisk | null } {
  const latest = history[history.length - 1] ?? null
  return {
    latest,
    history: history.length,
    spanSec: latest ? Math.round((latest.t - history[0].t) / 1000) : 0,
    watched: Date.now() < watchedUntil,
    memTotal: totalmem(),
    disk
  }
}
