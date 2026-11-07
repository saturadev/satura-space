import { existsSync, promises as fsp } from 'node:fs'
import { join } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ReportCompileResult, ReportDiagnostic } from '@shared/report-compile'
import { displayPath, formatDiagnostics, hashOf } from './compile-util'

const IDLE_MS = 60_000

const results = new Map<string, { key: string; result: ReportCompileResult }>()
const running = new Map<string, Promise<ReportCompileResult>>()

type Reply = { id: number; result?: ReportCompileResult; error?: string }

let worker: Worker | null = null
let idleTimer: ReturnType<typeof setTimeout> | null = null
let nextId = 0
const pending = new Map<number, { resolve: (r: ReportCompileResult) => void; reject: (e: Error) => void }>()

function workerFile(): string | null {
  const file = join(__dirname, 'report-compile-worker.js')
  return existsSync(file) ? file : null
}

function stopWorker(): Promise<void> {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const w = worker
  worker = null
  return w ? w.terminate().then(() => {}, () => {}) : Promise.resolve()
}

export function stopReportCompilerForQuit(): Promise<void> {
  failAll(new Error('Satura Space is quitting'))
  return stopWorker()
}

function armIdle(): void {
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  if (pending.size > 0) return
  idleTimer = setTimeout(stopWorker, IDLE_MS)
  idleTimer.unref?.()
}

function failAll(error: Error): void {
  const waiting = [...pending.values()]
  pending.clear()
  for (const p of waiting) p.reject(error)
}

function getWorker(file: string): Worker {
  if (worker) return worker
  const w = new Worker(file)
  w.on('message', (m: Reply) => {
    const p = pending.get(m.id)
    if (!p) return
    pending.delete(m.id)
    if (m.result) p.resolve(m.result)
    else p.reject(new Error(m.error ?? 'The report compiler failed.'))
    if (worker === w) armIdle()
  })
  w.on('error', (e) => {
    if (worker !== w) return
    worker = null
    failAll(e)
  })
  w.on('exit', (code) => {
    if (worker !== w) return
    worker = null
    failAll(new Error(`The report compiler stopped (code ${code}).`))
  })
  worker = w
  return w
}

async function compileSource(file: string, source: string, root: string | undefined): Promise<ReportCompileResult> {
  const entry = workerFile()
  if (!entry) return (await import('./compile-core')).compileSource(file, source, root)
  const w = getWorker(entry)
  if (idleTimer) clearTimeout(idleTimer)
  idleTimer = null
  const id = ++nextId
  return new Promise<ReportCompileResult>((resolve, reject) => {
    pending.set(id, { resolve, reject })
    w.postMessage({ id, file, source, root })
  })
}

export async function compileReport(file: string, root?: string): Promise<ReportCompileResult> {
  const [result, info] = await Promise.all([compileCached(file, root), fsp.stat(file).catch(() => null)])
  if (!info) return result
  const prev = timed.get(result)
  if (prev?.mtimeMs === info.mtimeMs) return prev
  const out = { ...result, mtimeMs: info.mtimeMs }
  timed.set(result, out)
  return out
}

const timed = new WeakMap<ReportCompileResult, ReportCompileResult>()

async function compileCached(file: string, root?: string): Promise<ReportCompileResult> {
  const pendingJob = running.get(file)
  if (pendingJob) return pendingJob
  const job = (async (): Promise<ReportCompileResult> => {
    let source: string
    try {
      source = await fsp.readFile(file, 'utf8')
    } catch {
      const d: ReportDiagnostic = { file: displayPath(file, root), line: 0, column: 0, code: '', message: `No report at ${file}` }
      return { ok: false, file, stamp: '', diagnostics: [d], text: formatDiagnostics([d]), ms: 0 }
    }
    const key = `${hashOf(source)}:${root ?? ''}`
    const hit = results.get(file)
    if (hit && hit.key === key) return hit.result
    const result = await compileSource(file, source, root)
    results.delete(file)
    results.set(file, { key, result })
    while (results.size > 24) results.delete(results.keys().next().value as string)
    return result
  })()
  running.set(file, job)
  try {
    return await job
  } finally {
    running.delete(file)
  }
}
