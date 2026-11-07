import {
  REPORT_FRAME_BOOT_FILE,
  frameBootReply,
  frameInlineHtml,
  hostMessage,
  isFrameBoot,
  parseFrameMessage,
  vetFrameCall,
  type FrameEvent,
  type FrameLoad,
  type FrameMethod,
  type FrameMode,
  type FrameQuery,
  type FrameSettings,
  type HostBody
} from '@shared/report-frame'
import type { CodeFileResult, CodeRefResolution } from '@shared/report-code'
import { mediaLoader, type MediaSaveAsk, type MediaScope, type MediaTag } from '../../lib/media-loader'
import { saveOnDesktop } from './save-desktop'
import { isMobileLayout } from '../../lib/mobile/mobile-back'

export interface FrameRecorder {
  git: (method: string, args: unknown[], value: unknown) => void
  refs: (map: Record<string, CodeRefResolution>) => void
  code: (rel: string, res: CodeFileResult) => void
  stat: (path: string, exists: boolean) => void
}

export interface FrameScope {
  mode: FrameMode
  file: string
  root: string
  canAct: boolean
  tile?: { widget: string; state: Record<string, unknown> }
}

export function frameChrome(): 'mac' | 'win' | null {
  if (isMobileLayout()) return null
  return /Mac/i.test(navigator.platform || navigator.userAgent) ? 'mac' : 'win'
}

export function frameMediaSetup(file: string, root: string): Promise<FrameLoad['media']> {
  if (mediaLoader()) return Promise.resolve({ kind: 'proxy' })
  return window.api.app.reportFrameMedia(file, root).then((base) => ({ kind: 'token' as const, base }))
}

let inlineBase: string | null = null
let htmlJob: Promise<string> | null = null
const chunkJobs = new Map<string, Promise<string>>()

export function setInlineReportFrames(base: string): void {
  inlineBase = base.endsWith('/') ? base : `${base}/`
}

export function inlineReportFrames(): boolean {
  return !!inlineBase
}

export function inlineFrameUrl(): string {
  return `${inlineBase ?? './report-frame/'}${REPORT_FRAME_BOOT_FILE}`
}

async function text(url: string): Promise<string> {
  const res = await fetch(url, { credentials: 'same-origin' })
  if (!res.ok) throw new Error(`${url.split('/').pop()} answered ${res.status}`)
  return res.text()
}

export function inlineFrameHtml(): Promise<string> {
  if (!inlineBase) return Promise.reject(new Error('Report frames load from the app here'))
  const base = inlineBase
  htmlJob ??= Promise.all([text(`${base}runtime.js`), text(`${base}runtime.css`)]).then(
    ([js, css]) => frameInlineHtml(js, css),
    (e: unknown) => {
      htmlJob = null
      throw e
    }
  )
  return htmlJob
}

function inlineChunk(name: string): Promise<string> {
  if (!inlineBase) return Promise.reject(new Error('No chunk source'))
  const base = inlineBase
  let job = chunkJobs.get(name)
  if (!job) {
    job = text(`${base}${name}.js`).catch((e: unknown) => {
      chunkJobs.delete(name)
      throw e
    })
    chunkJobs.set(name, job)
  }
  return job
}

const caseInsensitive = typeof navigator !== 'undefined' && /Mac|Win|iPhone|iPad/i.test(navigator.platform || navigator.userAgent)

const registry = new WeakMap<HTMLIFrameElement, FrameChannel>()

export function frameChannelOf(el: Element | null): FrameChannel | null {
  return el instanceof HTMLIFrameElement ? (registry.get(el) ?? null) : null
}

export function frameChannelsIn(root: ParentNode | null): FrameChannel[] {
  if (!root) return []
  return [...root.querySelectorAll<HTMLIFrameElement>('iframe[data-report-frame]')].map((el) => registry.get(el)).filter((c): c is FrameChannel => !!c && c.isReady())
}

function diag(line: string): void {
  try {
    window.api.app.reportDiag?.(line)
  } catch {
    console.warn(line)
  }
}

const ACTIVATION_GRACE_MS = 5000

export class FrameChannel {
  iframe: HTMLIFrameElement | null = null
  scope: FrameScope
  onEvent: (ev: FrameEvent) => void
  recorder: FrameRecorder | null = null
  private ready = false
  private loadMsg: FrameLoad | null = null
  private settings: FrameSettings = {}
  private queries = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: number }>()
  private nextQuery = 1
  private watches = new Map<string, { count: number; off: () => void }>()
  private dropped = 0
  private lastPointer = 0
  private readyWaiters: (() => void)[] = []
  private findListeners = new Set<() => void>()
  private reads = new Map<string, AbortController>()

  constructor(scope: FrameScope, onEvent: (ev: FrameEvent) => void) {
    this.scope = scope
    this.onEvent = onEvent
  }

  isReady(): boolean {
    return this.ready && !!this.iframe
  }

  whenReady(): Promise<void> {
    if (this.ready) return Promise.resolve()
    return new Promise((r) => this.readyWaiters.push(r))
  }

  attach(el: HTMLIFrameElement): void {
    if (this.iframe === el) return
    this.detach()
    this.iframe = el
    registry.set(el, this)
    window.addEventListener('message', this.onMessage)
  }

  detach(): void {
    window.removeEventListener('message', this.onMessage)
    if (this.iframe) registry.delete(this.iframe)
    this.iframe = null
    this.ready = false
    for (const [, q] of this.queries) {
      window.clearTimeout(q.timer)
      q.reject(new Error('The report closed'))
    }
    this.queries.clear()
    for (const [, w] of this.watches) w.off()
    this.watches.clear()
    for (const [path, c] of this.reads) {
      c.abort()
      mediaLoader()?.stop?.(path, 'the report closed')
    }
    this.reads.clear()
  }

  load(load: FrameLoad): void {
    this.loadMsg = load
    if (this.ready) this.post({ t: 'load', load })
  }

  set(settings: FrameSettings): void {
    this.settings = { ...this.settings, ...settings }
    if (this.ready) this.post({ t: 'set', set: settings })
  }

  back(): void {
    this.post({ t: 'back' })
  }

  onFindChange(cb: () => void): () => void {
    this.findListeners.add(cb)
    return () => this.findListeners.delete(cb)
  }

  notePointer(): void {
    this.lastPointer = Date.now()
  }

  query<T>(query: FrameQuery, timeoutMs = 30_000): Promise<T> {
    if (!this.iframe) return Promise.reject(new Error('The report is not on screen'))
    const id = this.nextQuery++
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.queries.delete(id)
        reject(new Error(`The report did not answer ${query.q} in time`))
      }, timeoutMs)
      this.queries.set(id, { resolve: resolve as (v: unknown) => void, reject, timer })
      this.post({ t: 'query', id, query })
    })
  }

  private post(msg: HostBody, transfer?: Transferable[]): void {
    this.iframe?.contentWindow?.postMessage(hostMessage(msg), '*', transfer ?? [])
  }

  private onMessage = (e: MessageEvent): void => {
    if (!this.iframe || e.source !== this.iframe.contentWindow) return
    if (isFrameBoot(e.data)) {
      if (!inlineBase) return
      const target = e.source as Window
      void inlineFrameHtml().then(
        (html) => {
          if (this.iframe?.contentWindow === target) target.postMessage(frameBootReply(html), '*')
        },
        (err: unknown) => diag(`report frame boot failed: ${err instanceof Error ? err.message : String(err)}`)
      )
      return
    }
    const msg = parseFrameMessage(e.data)
    if (!msg) {
      if (this.dropped++ < 5) diag(`report frame sent a message the app does not accept (${this.scope.file.split('/').slice(-2).join('/')})`)
      return
    }
    switch (msg.t) {
      case 'ready':
        this.ready = true
        if (this.loadMsg) this.post({ t: 'load', load: this.loadMsg })
        if (Object.keys(this.settings).length) this.post({ t: 'set', set: this.settings })
        for (const w of this.readyWaiters.splice(0)) w()
        return
      case 'call':
        void this.handleCall(msg.id, msg.m, msg.a)
        return
      case 'ev':
        if (msg.ev.e === 'pointer') this.notePointer()
        if (msg.ev.e === 'findChanged') for (const cb of this.findListeners) cb()
        this.onEvent(msg.ev)
        return
      case 'answer': {
        const q = this.queries.get(msg.id)
        if (!q) return
        this.queries.delete(msg.id)
        window.clearTimeout(q.timer)
        if (msg.ok) q.resolve(msg.value)
        else q.reject(new Error(msg.error ?? 'The report could not answer'))
        return
      }
    }
  }

  private async handleCall(id: number, m: FrameMethod, a: unknown[]): Promise<void> {
    const s = this.scope
    const vet = vetFrameCall(
      { mode: s.mode, root: s.root, media: mediaLoader() ? 'proxy' : 'token', canAct: s.canAct, caseInsensitive },
      m,
      a
    )
    if (!vet.ok) {
      if (m !== 'diag') diag(`report frame call ${m} refused in ${s.file.split('/').slice(-2).join('/')}: ${vet.error}`)
      this.post({ t: 'reply', id, ok: false, error: vet.error })
      return
    }
    try {
      const out = await this.run(m, vet.args, (got, total) => this.post({ t: 'progress', id, got, total }))
      this.post({ t: 'reply', id, ok: true, value: out.value }, out.transfer)
    } catch (e) {
      this.post({ t: 'reply', id, ok: false, error: e instanceof Error ? e.message : String(e) })
    }
  }

  private activated(): boolean {
    const ua = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
    if (ua) return ua.isActive
    return Date.now() - this.lastPointer < ACTIVATION_GRACE_MS
  }

  private mediaScope(path?: string): MediaScope {
    let signal: AbortSignal | undefined
    if (path) {
      let c = this.reads.get(path)
      if (!c) {
        c = new AbortController()
        this.reads.set(path, c)
      }
      signal = c.signal
    }
    return { report: { file: this.scope.file, root: this.scope.root }, signal }
  }

  private watch(path: string): void {
    const w = this.watches.get(path)
    if (w) {
      w.count++
      return
    }
    const off = window.api.fs.watchFile(path, () => this.post({ t: 'watch', path }))
    this.watches.set(path, { count: 1, off })
  }

  private unwatch(path: string): void {
    const w = this.watches.get(path)
    if (!w) return
    if (--w.count > 0) return
    w.off()
    this.watches.delete(path)
  }

  private async run(m: FrameMethod, args: unknown[], progress: (got: number, total: number) => void): Promise<{ value: unknown; transfer?: Transferable[] }> {
    const { file, root } = this.scope
    const rec = this.recorder
    const api = window.api
    const v = (value: unknown): { value: unknown } => ({ value })
    const git = async (method: string, call: Promise<unknown>, keyArgs: unknown[]): Promise<{ value: unknown }> => {
      const value = await call
      rec?.git(method, [root, ...keyArgs], value)
      return v(value)
    }
    switch (m) {
      case 'statPath': {
        const info = await api.app.reportStat(file, root, args[0] as string)
        rec?.stat(args[0] as string, info.exists)
        return v(info.outside ? { exists: false, outside: true } : { exists: info.exists })
      }
      case 'codeRefs': {
        const map = await api.app.reportCodeRefs(file, root || undefined, args[0] as string[])
        rec?.refs(map)
        return v(map)
      }
      case 'readCode': {
        const res = await api.app.reportReadCode(file, root || undefined, args[0] as string)
        rec?.code(args[0] as string, res)
        return v(res)
      }
      case 'git.getState':
        return git('getState', api.gitScm.getState(root), [])
      case 'git.getCommit':
        return git('getCommit', api.gitScm.getCommit(root, args[0] as string), [args[0]])
      case 'git.diffBetweenWithStats':
        return git('diffBetweenWithStats', api.gitScm.diffBetweenWithStats(root, args[0] as string | undefined, args[1] as string), [args[0], args[1]])
      case 'git.show':
        return v(await api.gitScm.show(root, args[0] as string, args[1] as string))
      case 'git.patch':
        return git('patch', api.gitScm.patch(root, args[0] as string, args[1] as string, args[2] as string, args[3] as string), args)
      case 'action':
        if (!this.activated()) {
          diag(`report action in ${file.split('/').slice(-2).join('/')} refused: no click in the report`)
          throw new Error('An action runs only from a click on its button')
        }
        return v(await api.app.reportAction(file, args[0] as string, root))
      case 'fileInfo':
        return v(await api.app.reportInfo(file, root))
      case 'diag':
        diag(args[0] as string)
        return v(true)
      case 'chunk':
        return v(await inlineChunk(args[0] as string))
      case 'media.load': {
        const loader = mediaLoader()
        if (!loader?.read) throw new Error('No media loader')
        const r = await loader.read(args[0] as string, 0, Number.MAX_SAFE_INTEGER, { ...this.mediaScope(), progress })
        const data = r.data.slice().buffer
        return { value: { data, type: r.type }, transfer: [data] }
      }
      case 'media.read': {
        const loader = mediaLoader()
        const path = args[0] as string
        if (!loader) {
          const r = await api.app.reportMediaRead(file, root, path, args[1] as number, args[2] as number)
          const data = r.data.byteOffset === 0 && r.data.byteLength === r.data.buffer.byteLength ? (r.data.buffer as ArrayBuffer) : (r.data.slice().buffer as ArrayBuffer)
          return { value: { data, size: r.size, type: '' }, transfer: [data] }
        }
        if (!loader.read) throw new Error('No media reads here')
        const r = await loader.read(path, args[1] as number, args[2] as number, this.mediaScope(path))
        const data = r.data.slice().buffer
        return { value: { data, size: r.size, type: r.type }, transfer: [data] }
      }
      case 'media.saved':
        return v((await mediaLoader()?.saved?.(args[0] as string, this.mediaScope())) ?? null)
      case 'media.download': {
        const loader = mediaLoader()
        if (!loader?.download) throw new Error('No video downloads here')
        const path = args[0] as string
        const tag = args[1] as MediaTag | undefined
        return v(await loader.download(path, (p) => progress(p.got, p.total), { ...this.mediaScope(path), ...(tag ? { tag } : {}) }))
      }
      case 'media.held':
        return v((await mediaLoader()?.held?.(args[0] as string, this.mediaScope())) ?? [])
      case 'media.save': {
        const ask = args[0] as MediaSaveAsk
        const loader = mediaLoader()
        if (!loader) return v(await saveOnDesktop(file, root, ask))
        if (!loader.save) throw new Error("This page can't save files")
        return v(await loader.save(ask, (p) => progress(p.got, p.total), this.mediaScope()))
      }
      case 'media.stop': {
        const path = args[0] as string
        this.reads.get(path)?.abort()
        this.reads.delete(path)
        mediaLoader()?.stop?.(path, args[1] as string)
        return v(true)
      }
      case 'media.info': {
        const loader = mediaLoader()
        if (!loader) return v(await api.app.reportMediaInfo(file, root, args[0] as string))
        return v((await loader.info?.(args[0] as string, this.mediaScope())) ?? null)
      }
      case 'media.plan': {
        const loader = mediaLoader()
        if (!loader?.plan) throw new Error('No video plans here')
        return v(await loader.plan(args[0] as string, args[1] as boolean, args[2] as { rendition?: never; urgent?: boolean; drop?: boolean } | undefined, this.mediaScope()))
      }
      case 'media.still': {
        const loader = mediaLoader()
        if (!loader?.still) throw new Error('No video stills here')
        return v(await loader.still(args[0] as string, this.mediaScope()))
      }
      case 'dash.fetch':
        return v(await api.dashboard.fetch(root, args[0] as never))
      case 'dash.abort':
        api.dashboard.abort(args[0] as string)
        return v(true)
      case 'dash.handle':
        return v(await api.dashboard.handle(root, args[0] as never))
      case 'dash.git':
        return v(await api.dashboard.git(root, args[0] as never))
      case 'dash.logs':
        return v(await api.dashboard.logs(root, args[0] as never))
      case 'dash.file':
        return v(await api.dashboard.file(root, args[0] as string, args[1] as 'json' | 'text' | undefined))
      case 'dash.saveState': {
        const tile = this.scope.tile
        if (!tile) throw new Error('Not a widget')
        tile.state[args[0] as string] = args[1]
        api.dashboard.saveState(root, tile.widget, args[0] as string, args[1])
        return v(true)
      }
      case 'dash.watch':
        this.watch(args[0] as string)
        return v(true)
      case 'dash.unwatch':
        this.unwatch(args[0] as string)
        return v(true)
    }
    throw new Error(`${String(m)} is not a report call`)
  }
}
