import { readFileSync } from 'node:fs'
import { open } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { MEDIA_TYPES } from '@shared/media-url'
import type { RemoteMediaChunk, RemoteMediaRead, RemoteMediaReport } from '@shared/remote-protocol'
import { insideRoot } from '../open-roots'
import { projectRootOf } from '../report/code-refs'
import { mediaInfo } from './media-info'
import { cacheDir } from './phone-video'

const MAX_CHUNK = 4 * 1024 * 1024
const IDLE_MS = 8000
const PROBE_BYTES = 4096
const JUMPS_LOGGED = 3
const read = new Map<string, { n: number; bytes: number; resent: number; jumps: number }>()
const transfers = new Map<string, { bytes: number; size: number; at: number; last: number; timer: NodeJS.Timeout | null; resent: number }>()
const order = new Map<string, { next: number; jumps: number }>()
const sent = new Map<string, { size: number; mtime: number; spans: [number, number][] }>()
let guard: (path: string) => boolean = () => false

const log = (msg: string): void => console.log(`[remote] phone media ${msg}`)
const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`
const at = (n: number): string => `${(n / 1e6).toFixed(2)} MB`

export function setMediaReadGuard(fn: (path: string) => boolean): void {
  guard = fn
}

export function mediaReadReport(reset: boolean): { file: string; n: number; kb: number; resentKB: number; jumps: number }[] {
  const out = [...read].map(([file, r]) => ({ file, n: r.n, kb: Math.round(r.bytes / 102.4) / 10, resentKB: Math.round(r.resent / 102.4) / 10, jumps: r.jumps })).sort((a, b) => b.kb - a.kb)
  if (reset) {
    read.clear()
    sent.clear()
  }
  return out
}

function stats(path: string): { n: number; bytes: number; resent: number; jumps: number } {
  let r = read.get(path)
  if (!r) {
    r = { n: 0, bytes: 0, resent: 0, jumps: 0 }
    read.set(path, r)
  }
  return r
}

function noteAsk(path: string, offset: number, length: number): void {
  if (length <= PROBE_BYTES) return
  const o = order.get(path)
  if (o && offset !== o.next) {
    o.jumps++
    stats(path).jumps++
    if (o.jumps <= JUMPS_LOGGED) log(`${basename(path)}: the phone asked for ${at(offset)} after ${at(o.next)}, out of order`)
  }
  order.set(path, { next: offset + length, jumps: o?.jumps ?? 0 })
}

function sentBefore(path: string, size: number, mtime: number, from: number, to: number): number {
  let s = sent.get(path)
  if (!s || s.size !== size || s.mtime !== mtime) {
    s = { size, mtime, spans: [] }
    sent.set(path, s)
  }
  let twice = 0
  for (const [a, b] of s.spans) twice += Math.max(0, Math.min(b, to) - Math.max(a, from))
  const spans: [number, number][] = []
  let cur: [number, number] = [from, to]
  for (const span of s.spans) {
    if (span[1] < cur[0] || span[0] > cur[1]) spans.push(span)
    else cur = [Math.min(cur[0], span[0]), Math.max(cur[1], span[1])]
  }
  spans.push(cur)
  s.spans = spans.sort((x, y) => x[0] - y[0])
  return twice
}

function madeFrom(path: string): string | null {
  const root = cacheDir()
  if (!insideRoot(root, path)) return null
  try {
    const src = (JSON.parse(readFileSync(join(dirname(path), `${basename(path).replace(/\.[^.]+$/, '')}.json`), 'utf8')) as { src?: unknown }).src
    return typeof src === 'string' && isAbsolute(src) && !insideRoot(root, src) ? src : null
  } catch {
    return null
  }
}

export function reportMediaRefusal(report: RemoteMediaReport | undefined, path: string, inside: (path: string) => boolean = guard): string {
  if (!path || !isAbsolute(path)) return 'Pass an absolute media path'
  if (!inside(path)) return `That file is outside the folders open on the desktop: ${path}`
  if (!report) return ''
  if (typeof report.file !== 'string' || !isAbsolute(report.file)) return 'The report path must be absolute'
  const project = projectRootOf(report.file, typeof report.root === 'string' && report.root ? report.root : undefined)
  const own = madeFrom(path) ?? path
  return insideRoot(project, own) ? '' : `This file is outside the report's project (${project}): ${own}`
}

export function vetReportMedia(report: RemoteMediaReport | undefined, path: string): void {
  const why = reportMediaRefusal(report, path)
  if (!why) return
  log(`refused before reading, 0 bytes sent${report ? ` (report ${basename(dirname(report.file))})` : ''}: ${why}`)
  throw new Error(why)
}

function tally(path: string, offset: number, got: number, size: number, mtime: number): void {
  const r = stats(path)
  r.n++
  r.bytes += got
  let t = transfers.get(path)
  if (!t && got <= PROBE_BYTES) return
  if (!t) {
    t = { bytes: 0, size, at: Date.now(), last: Date.now(), timer: null, resent: 0 }
    transfers.set(path, t)
    log(`${basename(path)}: transfer started at ${mb(offset)} of ${mb(size)}`)
  }
  if (got > PROBE_BYTES) {
    const twice = sentBefore(path, size, mtime, offset, offset + got)
    t.resent += twice
    r.resent += twice
  }
  t.bytes += got
  t.last = Date.now()
  const cur = t
  if (cur.timer) clearTimeout(cur.timer)
  cur.timer = setTimeout(() => endTransfer(path, cur.bytes >= size ? 'reached the end' : 'idle, the phone stopped asking'), IDLE_MS)
}

function endTransfer(path: string, why: string): void {
  const t = transfers.get(path)
  if (!t) return
  if (t.timer) clearTimeout(t.timer)
  transfers.delete(path)
  const jumps = order.get(path)?.jumps ?? 0
  order.delete(path)
  const how = [jumps ? `${jumps} out of order` : 'in order', t.resent ? `${mb(t.resent)} of it sent before` : 'nothing sent twice'].join(', ')
  log(`${basename(path)}: transfer stopped (${why}), ${mb(t.bytes)} sent of ${mb(t.size)} in ${((t.last - t.at) / 1000).toFixed(1)} s, ${how}`)
}

export function stopMediaTransfer(req: { path?: unknown; why?: unknown }): boolean {
  const path = String(req?.path ?? '')
  if (!transfers.has(path)) {
    log(`${basename(path)}: the phone stopped it before any bytes moved (${String(req?.why ?? 'cancel')})`)
    return false
  }
  endTransfer(path, `the phone stopped it: ${String(req?.why ?? 'cancel')}`)
  return true
}

export async function readMediaChunk(req: RemoteMediaRead): Promise<RemoteMediaChunk> {
  const path = String(req?.path ?? '')
  const type = MEDIA_TYPES[extname(path).toLowerCase()]
  if (!type) throw new Error(`${extname(path) || 'That file'} is not a media type the phone can show`)
  vetReportMedia(req?.report, path)
  noteAsk(path, Math.max(0, Math.floor(Number(req.offset) || 0)), Math.max(0, Math.min(MAX_CHUNK, Math.floor(Number(req.length) || MAX_CHUNK))))
  const handle = await open(path, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('Not a file')
    const offset = Math.max(0, Math.min(stat.size, Math.floor(Number(req.offset) || 0)))
    const length = Math.max(0, Math.min(MAX_CHUNK, stat.size - offset, Math.floor(Number(req.length) || MAX_CHUNK)))
    const data = new Uint8Array(length)
    let got = 0
    while (got < length) {
      const { bytesRead } = await handle.read(data, got, length - got, offset + got)
      if (!bytesRead) break
      got += bytesRead
    }
    const info = req.info ? await mediaInfo(handle, stat.size, type) : undefined
    tally(path, offset, got, stat.size, stat.mtimeMs)
    return { size: stat.size, mtime: stat.mtimeMs, type, offset, data: got === length ? data : data.subarray(0, got), ...(info !== undefined ? { info } : {}) }
  } finally {
    await handle.close()
  }
}

export const CHANNEL_CHUNK = 240 * 1024

function frame(head: Record<string, unknown>, data: Uint8Array): Buffer {
  const h = Buffer.from(JSON.stringify(head))
  const out = Buffer.alloc(4 + h.length + data.length)
  out.writeUInt32LE(h.length, 0)
  h.copy(out, 4)
  out.set(data, 4 + h.length)
  return out
}

export async function answerMediaRequest(text: string): Promise<Buffer> {
  let id = 0
  try {
    const req = JSON.parse(text) as RemoteMediaRead & { id: number }
    id = Number(req.id) || 0
    const c = await readMediaChunk({ path: req.path, offset: req.offset, length: Math.min(CHANNEL_CHUNK, Number(req.length) || CHANNEL_CHUNK), info: !!req.info, report: req.report })
    return frame({ id, size: c.size, mtime: c.mtime, type: c.type, offset: c.offset, ...(c.info !== undefined ? { info: c.info } : {}) }, c.data)
  } catch (e) {
    return frame({ id, error: e instanceof Error ? e.message : String(e) }, new Uint8Array(0))
  }
}
