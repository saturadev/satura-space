import { createContext, useContext, useEffect, useState, type ReactElement, type RefObject } from 'react'
import { mediaUrlForPath } from '@shared/media-url'
import type { FsPathInfo } from '@shared/api'
import type { ReportHoverInfo } from '@shared/hover-info'
import type { GitScmApi } from '@shared/git-scm'
import type { CodeFileResult, CodeRefResolution } from '@shared/report-code'
import type { SaturaExecReply } from '@shared/satura-exec'
import { reportDir, resolveReportPath, type ReportLocation } from '@shared/report-link'
import type { FramePlayerHandle } from './FramePlayer'
import { cssZoom } from './zoom-pan'
import type { ImageGallery, ImageHint } from './ReportOverlay'
import { mediaLoader, type MediaInfo, type MediaProgress, type MediaSaveAsk, type MediaSaved } from '../../lib/media-loader'
import type { BlockPlace } from './report-view-state'

type FrameListener = (frame: number) => void

export type BlockTest = (el: ReactElement) => boolean

export interface ReportBlocksControl {
  reveal: (test: BlockTest | null, find: () => HTMLElement | null) => Promise<HTMLElement | null>
  first: (test: BlockTest) => ReactElement | null
  jump: (el: HTMLElement, align: 'start' | 'center') => boolean
}

const VIDEO_FILE = /\.(mp4|m4v|mov|webm|mkv|avi)$/i

export class ReportStore {
  private warnings = new Map<number, string>()
  private nextWarning = 0
  private pending = 0
  private listeners = new Set<() => void>()
  private snapshot = { warnings: [] as string[], pending: 0 }

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  get = (): { warnings: string[]; pending: number } => this.snapshot

  private emit(): void {
    this.snapshot = { warnings: [...new Set(this.warnings.values())], pending: this.pending }
    for (const cb of this.listeners) cb()
  }

  warn(message: string): () => void {
    const id = this.nextWarning++
    this.warnings.set(id, message)
    this.emit()
    return () => {
      if (this.warnings.delete(id)) this.emit()
    }
  }

  begin(): () => void {
    this.pending++
    this.emit()
    let done = false
    return () => {
      if (done) return
      done = true
      this.pending--
      this.emit()
    }
  }
}

export type ReportGit = Pick<GitScmApi, 'getState' | 'getCommit' | 'diffBetweenWithStats' | 'show' | 'patch'>

export type MediaStat = Pick<FsPathInfo, 'exists'> & { outside?: boolean }

export interface ReportBridge {
  statPath: (path: string) => Promise<MediaStat>
  codeRefs: (file: string, root: string | undefined, refs: string[]) => Promise<Record<string, CodeRefResolution>>
  readCode: (file: string, root: string | undefined, rel: string) => Promise<CodeFileResult>
  git: ReportGit
  action?: (file: string, code: string, root: string) => Promise<SaturaExecReply>
  fileInfo?: (file: string, root: string) => Promise<ReportHoverInfo | null>
  diag?: (line: string) => void
  mediaInfo?: (file: string, root: string, path: string) => Promise<MediaInfo | null>
  mediaRead?: (file: string, root: string, path: string, offset: number, length: number) => Promise<{ data: Uint8Array; size: number }>
  saveMedia?: (file: string, root: string, ask: MediaSaveAsk, onProgress?: (p: MediaProgress) => void) => Promise<MediaSaved>
  recording?: boolean
}

let appBridgeValue: ReportBridge | null = null

export function appBridge(): ReportBridge {
  appBridgeValue ??= {
    statPath: (p) => window.api.fs.statPath(p),
    codeRefs: (file, root, refs) => window.api.app.reportCodeRefs(file, root, refs),
    readCode: (file, root, rel) => window.api.app.reportReadCode(file, root, rel),
    git: window.api.gitScm,
    action: (file, code, root) => window.api.app.reportAction(file, code, root),
    fileInfo: (file, root) => window.api.app.reportInfo(file, root),
    diag: (line) => window.api.app.reportDiag?.(line),
    mediaInfo: (file, root, path) => window.api.app.reportMediaInfo(file, root, path),
    mediaRead: (file, root, path, offset, length) => window.api.app.reportMediaRead(file, root, path, offset, length)
  }
  return appBridgeValue
}

export interface ReportHost {
  bridge?: ReportBridge
  mediaUrl?: (path: string) => string
  file: string
  root: string
  version: string
  store: ReportStore
  initial: ReportLocation | null
  frames: Map<string, number>
  setTitle: (title: string) => void
  openReport: (file: string, loc: ReportLocation) => void
  openFile: (path: string, line?: number, column?: number) => void
  showImage: (src: string, alt?: string, gallery?: ImageGallery, hint?: ImageHint) => void
  showCode: (target: { ref: string; line?: number; endLine?: number }) => void
  copyLink: (url: string) => void
  states: Map<string, unknown>
  scroller?: RefObject<HTMLElement | null>
  view?: { blocks: BlockPlace | null }
}

export function revealInHost(el: HTMLElement | null, smooth = true): void {
  const host = el?.closest('.rk-host') as HTMLElement | null
  if (!el || !host) return
  const hb = host.getBoundingClientRect()
  const eb = el.getBoundingClientRect()
  const z = cssZoom(host)
  const margin = 16 * z
  let top = host.scrollTop
  if (eb.height + margin * 2 >= hb.height || eb.top < hb.top + margin) top += (eb.top - hb.top - margin) / z
  else if (eb.bottom > hb.bottom - margin) top += (eb.bottom - hb.bottom + margin) / z
  else return
  host.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' })
}

const reducedMotion = (): boolean => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

export function centerInHost(el: HTMLElement | null, smooth: boolean): Promise<string> {
  const host = el?.closest('.rk-host') as HTMLElement | null
  if (!el || !host) return Promise.resolve('not in the report')
  const hb = host.getBoundingClientRect()
  const eb = el.getBoundingClientRect()
  if (eb.top >= hb.top && eb.bottom <= hb.bottom) return Promise.resolve('already in view')
  const z = cssZoom(host)
  const offset = eb.height + 32 * z >= hb.height ? eb.top - hb.top - 16 * z : eb.top + eb.height / 2 - (hb.top + hb.height / 2)
  const top = Math.max(0, Math.min(host.scrollHeight - host.clientHeight, host.scrollTop + offset / z))
  if (!smooth) {
    host.scrollTop = top
    return Promise.resolve(`scrolled to ${Math.round(top)}`)
  }
  return new Promise((resolve) => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      host.removeEventListener('scrollend', finish)
      window.clearTimeout(t)
      resolve(`scrolled to ${Math.round(host.scrollTop)}`)
    }
    const t = window.setTimeout(finish, 900)
    host.addEventListener('scrollend', finish)
    host.scrollTo({ top, behavior: 'smooth' })
  })
}

export function highlight(el: HTMLElement | null, onEnd?: () => void): void {
  if (!el) return
  el.classList.remove('rk-jump')
  void el.offsetWidth
  el.classList.add('rk-jump')
  const end = (): void => {
    el.removeEventListener('animationend', onAnim)
    el.classList.remove('rk-jump')
    onEnd?.()
  }
  const onAnim = (e: AnimationEvent): void => {
    if (e.target === el && e.animationName === 'rk-jump') end()
  }
  el.addEventListener('animationend', onAnim)
}

export class ReportApi {
  readonly dir: string
  private videos = new Map<string, FramePlayerHandle>()
  private order: string[] = []
  private listeners = new Map<string, Set<FrameListener>>()
  private firstListeners = new Set<FrameListener>()
  private pending: { loc: ReportLocation; at: number; what?: string } | null = null
  private jumps = 0
  private blocks: ReportBlocksControl | null = null
  private stats = new Map<string, Promise<MediaStat>>()

  constructor(readonly host: ReportHost) {
    this.dir = reportDir(host.file)
  }

  path(src: string): string {
    return resolveReportPath(this.host.file, src)
  }

  get bridge(): ReportBridge {
    return this.host.bridge ?? appBridge()
  }

  url(src: string): string {
    if (this.host.mediaUrl) return this.host.mediaUrl(this.path(src))
    const loader = mediaLoader()
    if (loader) return loader.cached(this.path(src)) ?? ''
    const base = mediaUrlForPath(this.path(src))
    return `${base}${base.includes('?') ? '&' : '?'}r=${encodeURIComponent(this.host.version)}`
  }

  streamUrl(src: string): string | null {
    if (this.host.mediaUrl) return null
    const url = mediaLoader()?.stream?.(this.path(src))
    return url ? `${url}&v=${encodeURIComponent(this.host.version)}` : null
  }

  info(src: string): Promise<MediaInfo | null> {
    const loader = this.host.mediaUrl ? null : mediaLoader()
    return loader?.info ? loader.info(this.path(src)) : Promise.resolve(null)
  }

  resolve(src: string): Promise<string> {
    const loader = this.host.mediaUrl ? null : mediaLoader()
    return loader ? loader.load(this.path(src)) : Promise.resolve(this.url(src))
  }

  attachBlocks(control: ReportBlocksControl): () => void {
    this.blocks = control
    return () => {
      if (this.blocks === control) this.blocks = null
    }
  }

  reveal(test: BlockTest | null, find: () => HTMLElement | null): Promise<HTMLElement | null> {
    return this.blocks ? this.blocks.reveal(test, find) : Promise.resolve(find())
  }

  jumpTo(el: HTMLElement, align: 'start' | 'center'): boolean {
    return !!this.blocks?.jump(el, align)
  }

  private far(el: HTMLElement): boolean {
    const host = el.closest('.rk-host') as HTMLElement | null
    if (!host) return false
    const hb = host.getBoundingClientRect()
    const eb = el.getBoundingClientRect()
    return eb.bottom < hb.top - hb.height || eb.top > hb.bottom + hb.height
  }

  private scrollToBlock(el: HTMLElement | null, smooth: boolean): Promise<string> {
    if (!el || !this.far(el) || !this.jumpTo(el, 'center')) return centerInHost(el, smooth)
    return new Promise((resolve) => window.setTimeout(() => resolve(`jumped to a far block, at ${Math.round((el.closest('.rk-host') as HTMLElement | null)?.scrollTop ?? 0)}`), 250))
  }

  statPath(path: string): Promise<MediaStat> {
    let hit = this.stats.get(path)
    if (!hit) {
      hit = this.bridge.statPath(path)
      this.stats.set(path, hit)
      hit.then(
        (i) => {
          if (!i.exists) this.stats.delete(path)
        },
        () => this.stats.delete(path)
      )
    }
    return hit
  }

  videoTest(id?: string): BlockTest {
    return (el) => {
      const p = el.props as { src?: unknown; id?: unknown }
      if (typeof p.src !== 'string' || !VIDEO_FILE.test(p.src)) return false
      return !id || this.sameVideo(typeof p.id === 'string' ? p.id : p.src, id)
    }
  }

  private firstVideo(): string | undefined {
    const el = this.blocks?.first(this.videoTest())
    if (!el) return undefined
    const p = el.props as { src: string; id?: unknown }
    return typeof p.id === 'string' ? p.id : p.src
  }

  showInitial(): void {
    const init = this.host.initial
    if (!init || (init.frame == null && init.t == null) || this.resolveVideo(init.video)) return
    void this.reveal(this.videoTest(init.video ?? this.firstVideo()), () => this.videoElement(init.video))
  }

  videoElement(id?: string): HTMLElement | null {
    const key = this.resolveVideo(id)
    return (key ? this.videos.get(key)?.element() : null) ?? null
  }

  registerVideo(id: string, handle: FramePlayerHandle): () => void {
    this.videos.set(id, handle)
    if (!this.order.includes(id)) this.order.push(id)
    const init = this.host.initial
    if (init && this.resolveVideo(init.video) === id && (init.frame != null || init.t != null)) {
      handle.goto({ frame: init.frame, t: init.t })
      this.host.initial = null
      requestAnimationFrame(() => revealInHost(handle.element(), false))
    }
    const want = this.pending
    if (want && Date.now() - want.at < 15000 && this.resolveVideo(want.loc.video) === id) {
      this.pending = null
      requestAnimationFrame(() => {
        const outcome = this.jump(handle, want.loc)
        if (want.what) this.diag(want.what, want.loc, `${outcome}, after video ${id} appeared`)
      })
    }
    return () => {
      if (this.videos.get(id) === handle) this.videos.delete(id)
      this.order = this.order.filter((v) => this.videos.has(v))
    }
  }

  private sameVideo(k: string, id: string): boolean {
    const base = k.split('/').pop() ?? k
    return k === id || base === id || base.replace(/\.[^.]+$/, '') === id || this.path(k) === this.path(id)
  }

  private resolveVideo(id?: string): string | undefined {
    const want = id ?? this.firstVideo()
    if (want && this.videos.has(want)) return want
    if (want) return [...this.videos.keys()].find((k) => this.sameVideo(k, want))
    return this.order[0]
  }

  hasVideo(id?: string): boolean {
    return !!this.resolveVideo(id)
  }

  fps(id?: string): number | undefined {
    const key = this.resolveVideo(id)
    return key ? this.videos.get(key)?.fps() : undefined
  }

  private jump(handle: FramePlayerHandle, loc: ReportLocation): string {
    let outcome: string
    try {
      outcome = handle.goto({ frame: loc.frame, t: loc.t })
    } catch (e) {
      outcome = `seek failed: ${e instanceof Error ? e.message : String(e)}`
    }
    const el = handle.element()
    const block = (el?.closest('.rk-card') as HTMLElement | null) ?? el
    const full = !!el?.closest('[data-report-overlay]')
    const calm = reducedMotion()
    const seq = ++this.jumps
    const diag = (m: string): void => this.bridge.diag?.(`jump #${seq}: ${m}`)
    void (full ? Promise.resolve('full screen, no scroll') : this.scrollToBlock(block, !calm)).then((scroll) => {
      diag(`${scroll}, frame ${handle.frame()}`)
      if (calm) return
      handle.pulse?.()
      if (full) return
      const spot = handle.target?.() ?? block
      diag(`highlight start${spot !== block ? ` on angle ${spot?.dataset.angle}` : ''}`)
      highlight(spot, () => diag('highlight end'))
    })
    return outcome
  }

  diag(what: string, loc: ReportLocation, outcome: string): void {
    const at = loc.frame != null ? `frame ${loc.frame}` : loc.t != null ? `t ${loc.t}` : 'start'
    const name = this.host.file.split('/').slice(-2).join('/')
    this.bridge.diag?.(`${what} in ${name} → video "${loc.video ?? '(first)'}" ${at}: ${outcome}`)
  }

  videoIds(): string {
    return [...this.videos.keys()].join(', ') || 'none'
  }

  goto(loc: ReportLocation, what?: string): boolean {
    const key = this.resolveVideo(loc.video)
    const handle = key ? this.videos.get(key) : undefined
    if (!handle) {
      this.pending = { loc, at: Date.now(), what }
      if (what) this.diag(what, loc, `waiting for video ${loc.video ?? ''} (registered: ${this.videoIds()})`)
      void this.reveal(this.videoTest(loc.video ?? this.firstVideo()), () => this.videoElement(loc.video))
      return false
    }
    this.pending = null
    const outcome = this.jump(handle, loc)
    if (what) this.diag(what, loc, outcome)
    return true
  }

  usePersisted<T>(key: string, init: () => T): [T, (v: T | ((p: T) => T)) => void] {
    const states = this.host.states
    const [value, setValue] = useState<T>(() => (states.has(key) ? (states.get(key) as T) : init()))
    const set = (v: T | ((p: T) => T)): void =>
      setValue((prev) => {
        const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
        states.set(key, next)
        return next
      })
    return [value, set]
  }

  initialFrame(id: string): number | undefined {
    return this.host.frames.get(id)
  }

  noteFrame(id: string, frame: number): void {
    this.host.frames.set(id, frame)
    for (const cb of this.listeners.get(id) ?? []) cb(frame)
    if (this.firstListeners.size && this.resolveVideo() === id) for (const cb of this.firstListeners) cb(frame)
  }

  subscribe(id: string | undefined, cb: FrameListener): () => void {
    if (!id) {
      this.firstListeners.add(cb)
      return () => this.firstListeners.delete(cb)
    }
    let set = this.listeners.get(id)
    if (!set) this.listeners.set(id, (set = new Set()))
    set.add(cb)
    return () => set.delete(cb)
  }

  videoKey(id?: string): string | undefined {
    return this.resolveVideo(id)
  }
}

export const ReportContext = createContext<ReportApi | null>(null)

export const ReportSavedContext = createContext<number | undefined>(undefined)

export function useReport(): ReportApi {
  const api = useContext(ReportContext)
  if (!api) throw new Error('Kit components work only inside a report.')
  return api
}

export function useMediaCheck(api: ReportApi, srcs: string[]): string | null {
  const [missing, setMissing] = useState<string | null>(null)
  const key = srcs.join('\n')
  useEffect(() => {
    let alive = true
    let unwarn: (() => void) | null = null
    const done = api.host.store.begin()
    const list = key.split('\n').filter(Boolean)
    void Promise.all(list.map((s) => api.statPath(api.path(s)).then((i) => (i.exists ? null : { s, outside: !!i.outside }), () => ({ s, outside: false }))))
      .then((res) => {
        if (!alive) return
        const gone = res.filter((g): g is { s: string; outside: boolean } => !!g)
        if (gone.length) {
          const text = gone.map((g) => (g.outside ? `This file is outside the report's project: ${api.path(g.s)}` : `Can't find ${g.s} (looked at ${api.path(g.s)})`)).join('\n')
          unwarn = api.host.store.warn(text)
          setMissing(text)
        } else setMissing(null)
      })
      .finally(done)
    return () => {
      alive = false
      done()
      unwarn?.()
    }
  }, [api, key])
  return missing
}
