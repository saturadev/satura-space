import type { ReportLocation } from './report-link'

export const REPORT_FRAME_SCHEME = 'satura-report-frame'
export const REPORT_FRAME_URL = `${REPORT_FRAME_SCHEME}://app/frame.html`
export const REPORT_FRAME_TAG = 'satura-report-frame/1'
export const REPORT_FRAME_SANDBOX = 'allow-scripts'

const CSP_TAIL = "frame-src 'none'; child-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; manifest-src 'none'"

export const REPORT_FRAME_CSP = [
  "default-src 'none'",
  `script-src ${REPORT_FRAME_SCHEME}: 'unsafe-eval'`,
  `style-src ${REPORT_FRAME_SCHEME}: 'unsafe-inline'`,
  `img-src ${REPORT_FRAME_SCHEME}: data: blob:`,
  `media-src ${REPORT_FRAME_SCHEME}: data: blob:`,
  `font-src ${REPORT_FRAME_SCHEME}: data:`,
  'connect-src data: blob:',
  'worker-src blob:',
  CSP_TAIL
].join('; ')

export const REPORT_FRAME_INLINE_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'media-src data: blob:',
  'font-src data:',
  'connect-src data: blob:',
  'worker-src blob:',
  CSP_TAIL
].join('; ')

export type FrameMode = 'report' | 'tile' | 'collect'

export interface FrameBlockPlace {
  count: number
  index: number
  within: number
  cache: [number[], number?] | null
}

export interface FrameView {
  scrollTop: number
  frames: [string, number][]
  states: [string, unknown][]
  blocks: FrameBlockPlace | null
}

export interface FrameMediaInfo {
  width: number
  height: number
  fps?: number
  duration?: number
  audio?: boolean
  codec?: string
}

export interface FrameTileSetup {
  widget: string
  state: Record<string, unknown>
  series: [string, number[]][]
}

export interface FrameLoad {
  mode: FrameMode
  file: string
  root: string
  version: string
  stamp: string
  code: string
  map?: string
  shown: string
  savedAt?: number
  initial: ReportLocation | null
  view: FrameView
  aspects: [string, number][]
  infos: [string, FrameMediaInfo][]
  zoom: number
  layout: 'desktop' | 'mobile'
  chrome: 'mac' | 'win' | null
  theme: string
  media: { kind: 'token'; base: string } | { kind: 'proxy' }
  chunks: string | null
  online: boolean
  canAct: boolean
  tile?: FrameTileSetup
}

export interface FrameInsets {
  t: number
  r: number
  b: number
  l: number
}

export interface FrameSettings {
  zoom?: number
  online?: boolean
  theme?: string
  insets?: FrameInsets
  screen?: FrameInsets
  held?: number
}

export type FrameStatus = {
  version: string
  phase: 'loading' | 'rendering' | 'ok' | 'error'
  pending: number
  warnings: string[]
  error: string
  empty: boolean
}

export interface FrameHook {
  hook: string
  target: string
  status: 'loading' | 'ok' | 'error'
  error?: string
  http?: number
  at?: number
  ms?: number
  every?: number
}

export type FrameTileStatus = {
  version: string
  status: 'loading' | 'ok' | 'error'
  error: string
  title: string
  rendered: boolean
  empty: boolean
  hooks: FrameHook[]
  pending: number
}

export type FrameEvent =
  | { e: 'status'; status: FrameStatus }
  | { e: 'tile'; tile: FrameTileStatus }
  | { e: 'title'; text: string }
  | { e: 'openReport'; file: string; loc: ReportLocation }
  | { e: 'openFile'; path: string; line?: number; column?: number }
  | { e: 'showCode'; ref: string; line?: number; endLine?: number }
  | { e: 'copy'; text: string; toast: boolean }
  | { e: 'view'; view: Partial<FrameView>; aspects?: [string, number][]; infos?: [string, FrameMediaInfo][] }
  | { e: 'series'; series: [string, number[]][] }
  | { e: 'fullscreen'; on: boolean }
  | { e: 'back'; depth: number; title: string }
  | { e: 'key'; type: 'keydown' | 'keyup'; key: string; code: string; meta: boolean; ctrl: boolean; alt: boolean; shift: boolean; repeat: boolean }
  | { e: 'pointer' }
  | { e: 'reload' }
  | { e: 'findChanged' }
  | { e: 'zoom'; scale: number; done: boolean }

export type FrameQuery =
  | { q: 'view'; scrollTop?: number; anchor?: string; click?: string }
  | { q: 'findOpen'; open: boolean }
  | { q: 'find'; text: string }
  | { q: 'findShow'; index: number; scroll: boolean }
  | { q: 'hooks' }
  | { q: 'collect' }
  | { q: 'probe'; count?: string[]; rect?: string; text?: string }
  | { q: 'video'; index?: number; name?: string; steps?: VideoStep[] }
  | { q: 'select'; selector: string }

export type VideoStep =
  | { do: 'state' }
  | { do: 'goto'; frame?: number; t?: number }
  | { do: 'step'; by: number }
  | { do: 'scrub'; from: number; to: number; steps?: number; ms?: number }
  | { do: 'play'; ms?: number }
  | { do: 'pause' }
  | { do: 'wait'; ms: number }
  | { do: 'unmute' }

export type HostMessage =
  | { $sf: typeof REPORT_FRAME_TAG; t: 'load'; load: FrameLoad }
  | { $sf: typeof REPORT_FRAME_TAG; t: 'set'; set: FrameSettings }
  | { $sf: typeof REPORT_FRAME_TAG; t: 'reply'; id: number; ok: boolean; value?: unknown; error?: string }
  | { $sf: typeof REPORT_FRAME_TAG; t: 'progress'; id: number; got: number; total: number }
  | { $sf: typeof REPORT_FRAME_TAG; t: 'query'; id: number; query: FrameQuery }
  | { $sf: typeof REPORT_FRAME_TAG; t: 'back' }
  | { $sf: typeof REPORT_FRAME_TAG; t: 'watch'; path: string }

export type FrameMessage =
  | { t: 'ready' }
  | { t: 'call'; id: number; m: FrameMethod; a: unknown[] }
  | { t: 'ev'; ev: FrameEvent }
  | { t: 'answer'; id: number; ok: boolean; value?: unknown; error?: string }

export const REPORT_METHODS = [
  'statPath',
  'codeRefs',
  'readCode',
  'git.getState',
  'git.getCommit',
  'git.diffBetweenWithStats',
  'git.show',
  'git.patch',
  'action',
  'fileInfo',
  'diag',
  'chunk'
] as const

export const MEDIA_METHODS = ['media.load', 'media.info', 'media.plan', 'media.still', 'media.read', 'media.download', 'media.saved', 'media.stop', 'media.held', 'media.save'] as const

export const TILE_METHODS = ['dash.fetch', 'dash.abort', 'dash.handle', 'dash.git', 'dash.logs', 'dash.file', 'dash.saveState', 'dash.watch', 'dash.unwatch'] as const

export type FrameMethod = (typeof REPORT_METHODS)[number] | (typeof MEDIA_METHODS)[number] | (typeof TILE_METHODS)[number]

const ALL_METHODS = new Set<string>([...REPORT_METHODS, ...MEDIA_METHODS, ...TILE_METHODS])

const MAX_TEXT = 64 * 1024
const MAX_PATH = 4096
const MAX_CODE = 256 * 1024
const MAX_LIST = 500
const MAX_ARGS = 8

function rec(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function str(v: unknown, max = MAX_TEXT): v is string {
  return typeof v === 'string' && v.length <= max
}

function num(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function optNum(v: unknown): boolean {
  return v === undefined || num(v)
}

function bool(v: unknown): v is boolean {
  return typeof v === 'boolean'
}

function strList(v: unknown, max = MAX_LIST, each = MAX_TEXT): v is string[] {
  return Array.isArray(v) && v.length <= max && v.every((s) => str(s, each))
}

function loc(v: unknown): boolean {
  return rec(v) && (v.video === undefined || str(v.video, MAX_PATH)) && optNum(v.frame) && optNum(v.t)
}

function pairList(v: unknown, check: (a: unknown, b: unknown) => boolean, max = 2000): boolean {
  return Array.isArray(v) && v.length <= max && v.every((p) => Array.isArray(p) && p.length === 2 && check(p[0], p[1]))
}

function mediaInfo(v: unknown): boolean {
  return rec(v) && num(v.width) && num(v.height) && optNum(v.fps) && optNum(v.duration)
}

function blockPlace(v: unknown): boolean {
  if (v === null) return true
  if (!rec(v) || !num(v.count) || !num(v.index) || !num(v.within)) return false
  if (v.cache === null) return true
  return Array.isArray(v.cache) && v.cache.length <= 2 && Array.isArray(v.cache[0]) && v.cache[0].length <= 200_000 && v.cache[0].every(num) && optNum(v.cache[1])
}

function view(v: unknown): boolean {
  if (!rec(v)) return false
  if (v.scrollTop !== undefined && !num(v.scrollTop)) return false
  if (v.frames !== undefined && !pairList(v.frames, (a, b) => str(a, MAX_PATH) && num(b))) return false
  if (v.states !== undefined && !pairList(v.states, (a) => str(a, 512), 500)) return false
  if (v.blocks !== undefined && !blockPlace(v.blocks)) return false
  return true
}

function status(v: unknown): boolean {
  return (
    rec(v) &&
    str(v.version, 512) &&
    ['loading', 'rendering', 'ok', 'error'].includes(v.phase as string) &&
    num(v.pending) &&
    strList(v.warnings, 200) &&
    str(v.error) &&
    bool(v.empty)
  )
}

function hook(v: unknown): boolean {
  return (
    rec(v) &&
    str(v.hook, 64) &&
    str(v.target, MAX_PATH) &&
    ['loading', 'ok', 'error'].includes(v.status as string) &&
    (v.error === undefined || str(v.error)) &&
    optNum(v.http) &&
    optNum(v.at) &&
    optNum(v.ms) &&
    optNum(v.every)
  )
}

function tile(v: unknown): boolean {
  return (
    rec(v) &&
    str(v.version, 512) &&
    ['loading', 'ok', 'error'].includes(v.status as string) &&
    str(v.error) &&
    str(v.title, 512) &&
    bool(v.rendered) &&
    bool(v.empty) &&
    Array.isArray(v.hooks) &&
    v.hooks.length <= 200 &&
    v.hooks.every(hook) &&
    num(v.pending)
  )
}

function event(v: unknown): v is FrameEvent {
  if (!rec(v) || typeof v.e !== 'string') return false
  switch (v.e) {
    case 'status':
      return status(v.status)
    case 'tile':
      return tile(v.tile)
    case 'title':
      return str(v.text, 1024)
    case 'openReport':
      return str(v.file, MAX_PATH) && loc(v.loc)
    case 'openFile':
      return str(v.path, MAX_PATH) && optNum(v.line) && optNum(v.column)
    case 'showCode':
      return str(v.ref, MAX_PATH) && optNum(v.line) && optNum(v.endLine)
    case 'copy':
      return str(v.text) && bool(v.toast)
    case 'view':
      return view(v.view) && (v.aspects === undefined || pairList(v.aspects, (a, b) => str(a, MAX_PATH) && num(b))) && (v.infos === undefined || pairList(v.infos, (a, b) => str(a, MAX_PATH) && mediaInfo(b)))
    case 'series':
      return pairList(v.series, (a, b) => str(a, 1024) && Array.isArray(b) && b.length <= 10000 && b.every(num), 500)
    case 'fullscreen':
      return bool(v.on)
    case 'back':
      return num(v.depth) && str(v.title, 256)
    case 'key':
      return (v.type === 'keydown' || v.type === 'keyup') && str(v.key, 64) && str(v.code, 64) && bool(v.meta) && bool(v.ctrl) && bool(v.alt) && bool(v.shift) && bool(v.repeat)
    case 'pointer':
    case 'reload':
    case 'findChanged':
      return true
    case 'zoom':
      return num(v.scale) && bool(v.done)
  }
  return false
}

export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (!rec(data) || data.$sf !== REPORT_FRAME_TAG || typeof data.t !== 'string') return null
  switch (data.t) {
    case 'ready':
      return { t: 'ready' }
    case 'call':
      if (!Number.isSafeInteger(data.id) || typeof data.m !== 'string' || !ALL_METHODS.has(data.m)) return null
      if (!Array.isArray(data.a) || data.a.length > MAX_ARGS) return null
      return { t: 'call', id: data.id as number, m: data.m as FrameMethod, a: data.a }
    case 'ev':
      return event(data.ev) ? { t: 'ev', ev: data.ev } : null
    case 'answer':
      if (!Number.isSafeInteger(data.id) || !bool(data.ok)) return null
      if (data.error !== undefined && !str(data.error)) return null
      return { t: 'answer', id: data.id as number, ok: data.ok, value: data.value, error: data.error as string | undefined }
  }
  return null
}

interface FrameCallScope {
  mode: FrameMode
  root: string
  media: 'token' | 'proxy'
  canAct: boolean
  caseInsensitive: boolean
}

export type VettedCall = { ok: true; args: unknown[] } | { ok: false; error: string }

function posix(p: string): string {
  return p.replace(/\\/g, '/')
}

function normalizeAbs(p: string): string | null {
  const s = posix(p)
  const drive = /^[A-Za-z]:(?=\/)/.exec(s)?.[0] ?? ''
  if (!drive && !s.startsWith('/')) return null
  const out: string[] = []
  for (const part of s.slice(drive.length).split('/')) {
    if (!part || part === '.') continue
    if (part === '..') {
      if (!out.length) return null
      out.pop()
    } else out.push(part)
  }
  return `${drive}/${out.join('/')}`
}

export function reportProjectRoot(file: string, fallback: string): string {
  const p = posix(file)
  const i = p.indexOf('/.sspace/')
  if (i > 0) return p.slice(0, i)
  const f = posix(fallback)
  return f && (f.startsWith('/') || /^[A-Za-z]:\//.test(f)) ? f : p.slice(0, p.lastIndexOf('/')) || '/'
}

export function insideRootLexically(root: string, path: string, caseInsensitive: boolean): boolean {
  if (!str(path, MAX_PATH) || !path || path.includes('\0') || !root) return false
  const r = normalizeAbs(root)
  const p = normalizeAbs(path)
  if (!r || !p || r === '/') return false
  const fold = (s: string): string => (caseInsensitive ? s.toLowerCase() : s)
  const base = fold(r.endsWith('/') ? r : `${r}/`)
  return fold(p) === fold(r) || fold(p).startsWith(base)
}

const MAX_MEDIA_READ = 4 * 1024 * 1024
const MEDIA_TAGS = ['best', '1080', '720', '480', 'phone']

const REF = /^[A-Za-z0-9][\w./@{}^~+:-]{0,255}$/

function reportGitRef(v: unknown, allowMissing = false): boolean {
  if (v === undefined || v === null) return allowMissing
  return v === '' || v === ':' || (typeof v === 'string' && REF.test(v) && !v.includes('..'))
}

function repoRelative(v: unknown): v is string {
  if (!str(v, MAX_PATH) || !v || v.includes('\0')) return false
  const s = posix(v)
  if (s.startsWith('/') || /^[A-Za-z]:/.test(s)) return false
  return !s.split('/').some((part) => part === '..')
}

function plainJson(v: unknown, depth = 0): boolean {
  if (depth > 20) return false
  if (v === null || typeof v === 'string' || typeof v === 'boolean') return true
  if (typeof v === 'number') return Number.isFinite(v)
  if (Array.isArray(v)) return v.length <= 10000 && v.every((x) => plainJson(x, depth + 1))
  if (rec(v)) return Object.keys(v).length <= 10000 && Object.values(v).every((x) => plainJson(x, depth + 1))
  return false
}

function headers(v: unknown): boolean {
  return v === undefined || (rec(v) && Object.keys(v).length <= 64 && Object.entries(v).every(([k, x]) => str(k, 256) && str(x, 8192)))
}

export function vetFrameCall(scope: FrameCallScope, m: FrameMethod, a: unknown[]): VettedCall {
  const no = (error: string): VettedCall => ({ ok: false, error })
  const yes = (...args: unknown[]): VettedCall => ({ ok: true, args })
  const mediaPath = (p: unknown): p is string => str(p, MAX_PATH) && !!normalizeAbs(p) && !p.includes('\0')
  const mediaTag = (t: unknown): boolean => t === undefined || (rec(t) && mediaPath(t.of) && typeof t.q === 'string' && MEDIA_TAGS.includes(t.q))
  if (m.startsWith('dash.') && scope.mode !== 'tile') return no(`${m} works only in a dashboard widget`)
  if (m.startsWith('media.') && scope.media !== 'proxy' && m !== 'media.info' && m !== 'media.read' && m !== 'media.save') return no(`${m} is not available here`)
  switch (m) {
    case 'statPath':
      return mediaPath(a[0]) ? yes(a[0]) : no('statPath takes an absolute path')
    case 'codeRefs':
      return strList(a[0], MAX_LIST, MAX_PATH) ? yes(a[0]) : no('codeRefs takes a list of refs')
    case 'readCode':
      return str(a[0], MAX_PATH) && !(a[0] as string).includes('\0') ? yes(a[0]) : no('readCode takes a path')
    case 'git.getState':
    case 'fileInfo':
      return yes()
    case 'git.getCommit':
      return reportGitRef(a[0]) ? yes(a[0]) : no('Not a git ref')
    case 'git.diffBetweenWithStats':
      return reportGitRef(a[0], true) && reportGitRef(a[1]) ? yes(a[0] ?? undefined, a[1]) : no('Not a git ref')
    case 'git.show':
      return repoRelative(a[0]) && reportGitRef(a[1]) ? yes(a[0], a[1]) : no('git.show takes a repo path and a ref')
    case 'git.patch':
      return repoRelative(a[0]) && repoRelative(a[1]) && reportGitRef(a[2]) && reportGitRef(a[3]) ? yes(a[0], a[1], a[2], a[3]) : no('git.patch takes repo paths and refs')
    case 'action':
      if (!scope.canAct) return no('Actions are off here')
      return str(a[0], MAX_CODE) ? yes(a[0]) : no('action takes the script text')
    case 'diag':
      return typeof a[0] === 'string' ? yes(a[0].replace(/\s+/g, ' ').slice(0, 400)) : no('diag takes a line')
    case 'chunk':
      return a[0] === 'monaco' ? yes(a[0]) : no('Unknown chunk')
    case 'media.load':
    case 'media.info':
    case 'media.still':
    case 'media.saved':
    case 'media.held':
      return mediaPath(a[0]) ? yes(a[0]) : no(`${m} takes an absolute media path`)
    case 'media.download':
      return mediaPath(a[0]) && mediaTag(a[1]) ? yes(a[0], a[1]) : no('media.download takes an absolute media path')
    case 'media.save': {
      const r = a[0]
      if (!rec(r) || !mediaPath(r.path) || !str(r.name, 255) || (r.kind !== 'video' && r.kind !== 'image') || !mediaTag(r.tag)) return no('media.save takes a media path, a file name and its kind')
      const t = r.tag as { of: string; q: string } | undefined
      return yes({ path: r.path, name: r.name.replace(/[\\/:\0]/g, '_').trim() || 'media', kind: r.kind, ...(t ? { tag: { of: t.of, q: t.q } } : {}) })
    }
    case 'media.stop':
      return mediaPath(a[0]) && str(a[1], 200) ? yes(a[0], a[1]) : no('media.stop takes a media path and why it stopped')
    case 'media.read': {
      const [offset, length] = [a[1], a[2]]
      const ok = Number.isSafeInteger(offset) && (offset as number) >= 0 && Number.isSafeInteger(length) && (length as number) > 0 && (length as number) <= MAX_MEDIA_READ
      return mediaPath(a[0]) && ok ? yes(a[0], offset, length) : no('media.read takes a path, an offset and a length up to 4 MB')
    }
    case 'media.plan': {
      const want = a[2]
      const wantOk = want === undefined || (rec(want) && (want.rendition === undefined || str(want.rendition, 16)) && (want.urgent === undefined || bool(want.urgent)) && (want.drop === undefined || bool(want.drop)))
      return mediaPath(a[0]) && bool(a[1]) && wantOk ? yes(a[0], a[1], want) : no('media.plan takes an absolute video path')
    }
    case 'dash.fetch': {
      const r = a[0]
      if (!rec(r) || !str(r.id, 128) || !str(r.url, 8192) || (r.method !== undefined && !str(r.method, 16)) || !headers(r.headers) || (r.body !== undefined && !str(r.body, 1024 * 1024)) || (r.as !== undefined && r.as !== 'json' && r.as !== 'text'))
        return no('useFetch got a bad request')
      return yes({ id: r.id, url: r.url, method: r.method, headers: r.headers, body: r.body, as: r.as })
    }
    case 'dash.abort':
      return str(a[0], 128) ? yes(a[0]) : no('abort takes an id')
    case 'dash.handle': {
      const r = a[0]
      if (!rec(r) || !str(r.name, 256) || (r.args !== undefined && !(Array.isArray(r.args) && r.args.length <= 64 && plainJson(r.args))) || (r.player !== undefined && !str(r.player, 256)))
        return no('useHandle got a bad request')
      return yes({ name: r.name, args: r.args ?? [], player: r.player })
    }
    case 'dash.git': {
      const r = a[0]
      if (!rec(r) || !optNum(r.log) || (r.status !== undefined && !bool(r.status))) return no('useGit got a bad request')
      return yes({ log: r.log, status: r.status })
    }
    case 'dash.logs': {
      const r = a[0]
      if (!rec(r) || (r.source !== undefined && r.source !== 'unity' && r.source !== 'app') || (r.grep !== undefined && !str(r.grep, 1024)) || !optNum(r.tail)) return no('useLogs got a bad request')
      return yes({ source: r.source, grep: r.grep, tail: r.tail })
    }
    case 'dash.file':
      return str(a[0], MAX_PATH) && (a[1] === undefined || a[1] === 'json' || a[1] === 'text') ? yes(a[0], a[1]) : no('useFile takes a path')
    case 'dash.saveState':
      return str(a[0], 512) && plainJson(a[1]) ? yes(a[0], a[1]) : no('useStore keeps plain JSON values')
    case 'dash.watch':
    case 'dash.unwatch':
      return typeof a[0] === 'string' && insideRootLexically(scope.root, a[0], scope.caseInsensitive) ? yes(a[0]) : no('That file is outside the project')
  }
  return no(`${String(m)} is not a report call`)
}

type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never

export type HostBody = DistOmit<HostMessage, '$sf'>

export function hostMessage(msg: HostBody): HostMessage {
  return { $sf: REPORT_FRAME_TAG, ...msg } as HostMessage
}

export function frameMessage(msg: FrameMessage): FrameMessage & { $sf: typeof REPORT_FRAME_TAG } {
  return { $sf: REPORT_FRAME_TAG, ...msg }
}

export function frameInlineHtml(js: string, css: string): string {
  const safeJs = js.replace(/<\/(script)/gi, '<\\/$1')
  const safeCss = css.replace(/<\/(style)/gi, '<\\/$1')
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${REPORT_FRAME_INLINE_CSP}"><style>${safeCss}</style></head><body><div id="root"></div><script>${safeJs}</script></body></html>`
}

export const REPORT_FRAME_BOOT_FILE = 'boot.html'
const REPORT_FRAME_BOOT_TAG = 'satura-report-frame-boot/1'

export function frameBootHtml(): string {
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"></head><body><script>addEventListener('message',function boot(e){var d=e.data;if(e.source!==parent||!d||d.$boot!=='${REPORT_FRAME_BOOT_TAG}'||typeof d.html!=='string')return;removeEventListener('message',boot);document.open();document.write(d.html);document.close()});parent.postMessage({$boot:'${REPORT_FRAME_BOOT_TAG}'},'*')</script></body></html>`
}

export function isFrameBoot(data: unknown): boolean {
  return rec(data) && data.$boot === REPORT_FRAME_BOOT_TAG
}

export function frameBootReply(html: string): { $boot: string; html: string } {
  return { $boot: REPORT_FRAME_BOOT_TAG, html }
}

export function frameDocumentHtml(version = ''): string {
  const v = version ? `?v=${encodeURIComponent(version)}` : ''
  return `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><link rel="stylesheet" href="runtime.css${v}"></head><body><div id="root"></div><script src="runtime.js${v}"></script></body></html>`
}
