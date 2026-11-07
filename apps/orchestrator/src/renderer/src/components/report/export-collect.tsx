import { reportFallbackTitle } from '@shared/report-compile'
import {
  emptySnapshot,
  gitCallKey,
  type ReportExportPage,
  type ReportExportPayload,
  type ReportExportResult,
  type ReportExportSnapshot
} from '@shared/report-export'
import { DEFAULT_THEME } from '@shared/types'
import { REPORT_FRAME_SANDBOX, REPORT_FRAME_URL, insideRootLexically, reportProjectRoot, type FrameLoad } from '@shared/report-frame'
import { FrameChannel, frameMediaSetup, inlineFrameHtml, inlineFrameUrl, inlineReportFrames } from './frame-host'

const MAX_PAGES = 200
const PAGE_TIMEOUT_MS = 60_000
const READY_TIMEOUT_MS = 60_000

interface CollectAnswer {
  title: string
  error?: string
  refs: string[]
  media: string[]
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = window.setTimeout(() => reject(new Error(`${what} timed out`)), ms)
    p.then(
      (v) => {
        window.clearTimeout(t)
        resolve(v)
      },
      (e: unknown) => {
        window.clearTimeout(t)
        reject(e)
      }
    )
  })
}

async function hiddenFrame(): Promise<HTMLIFrameElement> {
  const el = document.createElement('iframe')
  el.setAttribute('sandbox', REPORT_FRAME_SANDBOX)
  el.setAttribute('aria-hidden', 'true')
  el.dataset.reportExportProbe = ''
  el.style.cssText = 'position:fixed;left:-30000px;top:0;width:1100px;height:900px;border:0;visibility:hidden;pointer-events:none'
  if (inlineReportFrames()) {
    await inlineFrameHtml()
    el.src = inlineFrameUrl()
  } else el.src = REPORT_FRAME_URL
  return el
}

async function recordPage(file: string, root: string, code: string, media: Set<string>): Promise<{ title: string; snapshot: ReportExportSnapshot; error?: string }> {
  const snapshot = emptySnapshot()
  const mediaRoot = reportProjectRoot(file, root)
  const insensitive = /Mac|Win/i.test(navigator.platform || navigator.userAgent)
  const keep = (p: string): void => {
    if (insideRootLexically(mediaRoot, p, insensitive)) media.add(p)
  }
  const channel = new FrameChannel({ mode: 'collect', file, root, canAct: false }, () => {})
  channel.recorder = {
    git: (method, args, value) => {
      snapshot.git[gitCallKey(method, args)] = value
    },
    refs: (map) => Object.assign(snapshot.refs, map),
    code: (rel, res) => {
      snapshot.code[rel] = res
    },
    stat: (p, exists) => {
      if (exists) keep(p)
    }
  }
  const frame = await hiddenFrame()
  channel.attach(frame)
  document.body.appendChild(frame)
  try {
    const setup = await frameMediaSetup(file, root)
    const shown = root && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file
    const load: FrameLoad = {
      mode: 'collect',
      file,
      root,
      version: 'export',
      stamp: '',
      code,
      shown,
      initial: null,
      view: { scrollTop: 0, frames: [], states: [], blocks: null },
      aspects: [],
      infos: [],
      zoom: 1,
      layout: 'desktop',
      chrome: null,
      theme: DEFAULT_THEME,
      media: setup,
      chunks: setup.kind === 'token' ? 'satura-report-frame://app/' : null,
      online: true,
      canAct: false
    }
    channel.load(load)
    await withTimeout(channel.whenReady(), READY_TIMEOUT_MS, 'Starting the report viewer')
    const res = await channel.query<CollectAnswer>({ q: 'collect' }, PAGE_TIMEOUT_MS)
    for (const m of Array.isArray(res?.media) ? res.media : []) if (typeof m === 'string') keep(m)
    const refs = (Array.isArray(res?.refs) ? res.refs : []).filter((r): r is string => typeof r === 'string').slice(0, 400)
    const read = async (rel: string): Promise<void> => {
      const r = await window.api.app.reportReadCode(file, root || undefined, rel).catch(() => null)
      if (!r) return
      snapshot.code[rel] = r
      if (!r.ok && r.error === 'ambiguous') {
        for (const c of (r.candidates ?? []).slice(0, 12)) {
          const one = await window.api.app.reportReadCode(file, root || undefined, c).catch(() => null)
          if (one) snapshot.code[c] = one
        }
      }
    }
    await Promise.all(refs.map(read))
    const title = typeof res?.title === 'string' ? res.title.slice(0, 1024) : ''
    const error = typeof res?.error === 'string' ? res.error.slice(0, 60000) : ''
    return { title, snapshot, ...(error ? { error } : {}) }
  } finally {
    channel.detach()
    frame.remove()
  }
}

export async function collectReportExport(file: string, root: string, onPage?: (n: number, title: string) => void): Promise<ReportExportPayload> {
  const pages: ReportExportPage[] = []
  const media = new Set<string>()
  const seen = new Set<string>([file])
  const queue = [file]
  while (queue.length && pages.length < MAX_PAGES) {
    const f = queue.shift() as string
    const [compiled, scan] = await Promise.all([
      window.api.app.compileReport(f, root || undefined),
      window.api.app.reportExportScan(f).catch(() => ({ links: [], media: [] }))
    ])
    for (const m of scan.media) media.add(m)
    for (const l of scan.links) {
      if (seen.has(l)) continue
      seen.add(l)
      queue.push(l)
    }
    const fallback = reportFallbackTitle(f)
    if (!compiled.ok || !compiled.code) {
      if (f === file) throw new Error(`The report has errors, so it can't be exported:\n${compiled.text}`)
      pages.push({ file: f, title: fallback, error: compiled.text || 'The report did not compile', savedAt: compiled.mtimeMs, links: scan.links, snapshot: emptySnapshot() })
      continue
    }
    const rec = await recordPage(f, root, compiled.code, media)
    const title = rec.title.trim() || fallback
    pages.push({ file: f, title, code: compiled.code, savedAt: compiled.mtimeMs, links: scan.links, snapshot: rec.snapshot, ...(rec.error ? { error: rec.error } : {}) })
    onPage?.(pages.length, title)
  }
  return { file, root, pages, media: [...media] }
}

export async function exportReportHtml(file: string, root: string, out: string, onPage?: (n: number, title: string) => void): Promise<ReportExportResult> {
  let payload: ReportExportPayload
  try {
    payload = await collectReportExport(file, root, onPage)
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
  return window.api.app.reportExportWrite(out, payload)
}
