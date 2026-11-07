
export type TunerBezier = [number, number, number, number]

export interface TunerAnimatorSpec {
  path: string
  clip?: string
}

export type TunerAnimOwnerKind = 'animator' | 'legacy'

export interface TunerAnimOwner {
  path: string
  name: string
  kind: TunerAnimOwnerKind
  controller: string
  note: string
  human: boolean
}

export interface TunerAnimClipRef {
  name: string
  path: string
  readOnly: boolean
  state: string
}

export interface TunerAnimKey {
  t: number
  v: number
  in: number | null
  out: number | null
  inW: number
  outW: number
  wm: number
  lm: number
  rm: number
  broken: boolean
  label?: string
}

export interface TunerAnimChannel {
  id: string
  prop: string
  label: string
  discrete: boolean
  keys: TunerAnimKey[]
}

export interface TunerAnimProp {
  id: string
  path: string
  object: string
  type: string
  component: string
  group: string
  label: string
  section: string
  pptr: boolean
  missing: boolean
  channels: TunerAnimChannel[]
}

export interface TunerAnimEvent {
  t: number
  fn: string
  f: number
  i: number
  s: string
  o: string
  oName: string
}

export interface TunerAnimClip {
  name: string
  path: string
  readOnly: boolean
  length: number
  frameRate: number
  loop: boolean
  legacy: boolean
  human: boolean
  events: TunerAnimEvent[]
  props: TunerAnimProp[]
}

export interface TunerAnimClipPatch {
  base: number
  seq: number
  head?: Omit<TunerAnimClip, 'props'>
  chans: Record<string, TunerAnimKey[]>
}

export interface TunerAnimRootMotion {
  on: boolean
  mode: 'auto' | 'on' | 'off'
  animator: boolean
}

export type TunerAnimParam = 'none' | 'float' | 'int' | 'string' | 'object' | 'event'

export interface TunerAnimMethod {
  name: string
  param: TunerAnimParam
  component: string
  otype?: string
}

export interface TunerAnimator {
  mode: 'edit' | 'play'
  owner: TunerAnimOwner | null
  target: { path: string; name: string } | null
  clips: TunerAnimClipRef[]
  clip: TunerAnimClip | null
  clipSeq: number
  rootMotion: TunerAnimRootMotion | null
  values: Record<string, number>
  pending: Record<string, number>
  methods: TunerAnimMethod[]
  time: number
  preview: boolean
  playing: boolean
  record: boolean
  locked: boolean
  live: boolean
  takenOver: boolean
  status: string
  error: string
  rev: number
}

export interface TunerAnimatorUpdate extends Omit<TunerAnimator, 'clip'> {
  clip?: TunerAnimClip | null
  clipPatch?: TunerAnimClipPatch
  valuesFull: boolean
}

export interface TunerAnimPropChoice {
  id: string
  path: string
  object: string
  component: string
  label: string
  animated: boolean
  ids: string[]
}

export const TUNER_ANIM_OPS = [
  'close',
  'preview',
  'time',
  'step',
  'first',
  'last',
  'prevKey',
  'nextKey',
  'play',
  'pause',
  'resume',
  'record',
  'clip',
  'createClip',
  'duplicateClip',
  'addKey',
  'setKey',
  'deleteKeys',
  'moveKeys',
  'pasteKeys',
  'tangent',
  'setTangents',
  'addProp',
  'removeProp',
  'props',
  'addEvent',
  'moveEvent',
  'editEvent',
  'deleteEvent',
  'settings',
  'undo',
  'redo',
  'rootMotion',
  'model',
  'lock'
] as const

export type TunerAnimatorOp = (typeof TUNER_ANIM_OPS)[number]

export const TUNER_ANIM_TANGENTS = [
  'clampedAuto',
  'auto',
  'freeSmooth',
  'flat',
  'broken',
  'leftFree',
  'leftLinear',
  'leftConstant',
  'leftWeighted',
  'rightFree',
  'rightLinear',
  'rightConstant',
  'rightWeighted',
  'bothFree',
  'bothLinear',
  'bothConstant',
  'weighted',
  'linear',
  'step',
  'ease',
  'easeIn',
  'easeOut',
  'easeInOut'
] as const

export interface TunerAnimKeyArg {
  id?: string
  path?: string
  type?: string
  prop?: string
  t: number
  frame?: number
  hasV?: boolean
  v?: number
  hasTan?: boolean
  inT?: number
  outT?: number
  inW?: number
  outW?: number
  wm?: number
  lm?: number
  rm?: number
  broken?: boolean
  tangent?: string
  dv?: number
  add?: boolean
}

export interface TunerAnimEventArg {
  t?: number
  frame?: number
  fn?: string
  f?: number
  i?: number
  s?: string
  o?: string
}

export interface TunerAnimatorRequest {
  op: TunerAnimatorOp
  obj?: string
  clip?: string
  name?: string
  time?: number
  frame?: number
  dir?: number
  value?: string
  id?: string
  ids?: string[]
  keys?: TunerAnimKeyArg[]
  ev?: TunerAnimEventArg
  df?: number
  dv?: number
  copy?: boolean
  live?: boolean
  mode?: string
  index?: number
  indices?: number[]
  length?: number
  frameRate?: number
  loop?: number
  locked?: number
}

export interface TunerAnimatorResult {
  time: number
  rev?: number
  data?: unknown
}

const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const str = (v: unknown, max = 256): string | null => (typeof v === 'string' && v.length <= max && !/[\r\n]/.test(v) ? v : null)
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))
const MAX_KEYS = 20000
const MAX_IDS = 4096
const BEZIER_RE = /^bezier( -?\d+(\.\d+)?(e-?\d+)?){4}$/

function cleanKey(raw: unknown): TunerAnimKeyArg | null {
  if (!raw || typeof raw !== 'object') return null
  const k = raw as Record<string, unknown>
  const out: TunerAnimKeyArg = { t: isNum(k.t) ? clamp(k.t, 0, 36000) : 0 }
  const id = str(k.id, 1024)
  if (id) out.id = id
  for (const f of ['path', 'type', 'prop'] as const) {
    const v = str(k[f], 512)
    if (v != null) out[f] = v
  }
  if (!out.id && !out.prop) return null
  if (isNum(k.frame) && k.frame >= 0) out.frame = Math.round(Math.min(k.frame, 1e6))
  if (k.hasV === true && isNum(k.v)) {
    out.hasV = true
    out.v = clamp(k.v, -1e9, 1e9)
  }
  if (k.hasTan === true) {
    out.hasTan = true
    out.inT = isNum(k.inT) ? clamp(k.inT, -1e9, 1e9) : k.inT === null ? Infinity : 0
    out.outT = isNum(k.outT) ? clamp(k.outT, -1e9, 1e9) : k.outT === null ? Infinity : 0
    out.inW = isNum(k.inW) ? clamp(k.inW, 0, 1) : 1 / 3
    out.outW = isNum(k.outW) ? clamp(k.outW, 0, 1) : 1 / 3
    out.wm = isNum(k.wm) ? clamp(Math.round(k.wm), 0, 3) : 0
    out.lm = isNum(k.lm) ? clamp(Math.round(k.lm), 0, 4) : 0
    out.rm = isNum(k.rm) ? clamp(Math.round(k.rm), 0, 4) : 0
    out.broken = k.broken === true
    if (!Number.isFinite(out.inT!)) out.inT = 1e30
    if (!Number.isFinite(out.outT!)) out.outT = 1e30
  }
  if (isNum(k.dv) && k.dv !== 0) out.dv = clamp(k.dv, -1e9, 1e9)
  if (k.add === true) out.add = true
  const tan = str(k.tangent, 96)
  if (tan && ((TUNER_ANIM_TANGENTS as readonly string[]).includes(tan) || BEZIER_RE.test(tan))) out.tangent = tan
  return out
}

function cleanEvent(raw: unknown): TunerAnimEventArg | null {
  if (!raw || typeof raw !== 'object') return null
  const e = raw as Record<string, unknown>
  const out: TunerAnimEventArg = {}
  if (isNum(e.t)) out.t = clamp(e.t, 0, 36000)
  if (isNum(e.frame) && e.frame >= 0) out.frame = Math.round(e.frame)
  const fn = typeof e.fn === 'string' && e.fn.length <= 256 && /^[A-Za-z_]?\w*$/.test(e.fn) ? e.fn : null
  if (fn != null) out.fn = fn
  if (isNum(e.f)) out.f = e.f
  if (isNum(e.i)) out.i = Math.round(clamp(e.i, -2147483648, 2147483647))
  const s = typeof e.s === 'string' && e.s.length <= 2048 ? e.s : null
  if (s != null) out.s = s
  const o = str(e.o, 1024)
  if (o != null && (o === '' || o.startsWith('Assets/') || o.startsWith('Packages/'))) out.o = o
  return out
}

export function cleanTunerAnimatorRequest(raw: unknown): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const op = r.op as TunerAnimatorOp
  if (!(TUNER_ANIM_OPS as readonly string[]).includes(op)) return null
  const out: Record<string, unknown> = { op }
  for (const k of ['obj', 'clip', 'name', 'value', 'id', 'mode'] as const) {
    const v = str(r[k], k === 'id' ? 1024 : 512)
    if (v != null) out[k] = v
  }
  if (typeof out.mode === 'string' && !(TUNER_ANIM_TANGENTS as readonly string[]).includes(out.mode) && !BEZIER_RE.test(out.mode)) return null
  if (typeof out.name === 'string' && /[\\/:*?"<>|]/.test(out.name)) return null
  if (isNum(r.time)) out.time = clamp(r.time, 0, 36000)
  if (isNum(r.frame) && r.frame >= 0) out.frame = Math.round(Math.min(r.frame, 1e6))
  if (isNum(r.dir)) out.dir = r.dir < 0 ? -1 : 1
  if (isNum(r.df)) out.df = Math.round(clamp(r.df, -1e6, 1e6))
  if (isNum(r.dv)) out.dv = clamp(r.dv, -1e9, 1e9)
  if (r.copy === true) out.copy = true
  if (r.live === true) out.live = true
  if (isNum(r.index) && r.index >= 0) out.index = Math.round(Math.min(r.index, 100000))
  if (Array.isArray(r.indices)) out.indices = r.indices.filter((i) => isNum(i) && i >= 0).slice(0, MAX_IDS).map((i) => Math.round(i as number))
  if (isNum(r.length) && r.length >= 0) out.length = Math.min(r.length, 36000)
  if (isNum(r.frameRate) && r.frameRate > 0) out.frameRate = Math.min(r.frameRate, 1000)
  if (r.loop === 0 || r.loop === 1) out.loop = r.loop
  if (r.locked === 0 || r.locked === 1) out.locked = r.locked
  if (Array.isArray(r.ids)) {
    const ids = r.ids.map((x) => str(x, 1024)).filter((x): x is string => !!x)
    if (ids.length > MAX_IDS) return null
    out.ids = ids
  }
  if (Array.isArray(r.keys)) {
    if (r.keys.length > MAX_KEYS) return null
    const keys = r.keys.map(cleanKey)
    if (keys.some((k) => k == null)) return null
    out.keys = keys
  }
  if (r.ev !== undefined) {
    const ev = cleanEvent(r.ev)
    if (!ev) return null
    out.ev = ev
  }
  if (op === 'lock' && out.locked === undefined) return null
  const needKeys = ['deleteKeys', 'moveKeys', 'pasteKeys', 'tangent', 'setTangents', 'setKey']
  if (needKeys.includes(op) && !(Array.isArray(out.keys) && (out.keys as unknown[]).length > 0)) return null
  if (op === 'tangent' && !out.mode) return null
  if (op === 'clip' && !out.clip) return null
  if ((op === 'addProp' || op === 'removeProp') && !(out.id || (Array.isArray(out.ids) && (out.ids as unknown[]).length > 0))) return null
  if ((op === 'moveEvent' || op === 'editEvent') && out.index === undefined) return null
  if (op === 'editEvent' && !out.ev) return null
  if (op === 'deleteEvent' && out.index === undefined && !(Array.isArray(out.indices) && (out.indices as unknown[]).length > 0)) return null
  return out
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function rec(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

const s = (v: unknown): string => (typeof v === 'string' ? v : '')
const n = (v: unknown, d = 0): number => (isNum(v) ? v : d)
const nn = (v: unknown): number | null => (isNum(v) ? v : null)

function parseKey(v: unknown): TunerAnimKey | null {
  const a = arr(v)
  if (a.length < 10 || !isNum(a[0])) return null
  const k: TunerAnimKey = {
    t: a[0],
    v: n(a[1]),
    in: nn(a[2]),
    out: nn(a[3]),
    inW: n(a[4], 1 / 3),
    outW: n(a[5], 1 / 3),
    wm: n(a[6]),
    lm: n(a[7]),
    rm: n(a[8]),
    broken: a[9] === 1 || a[9] === '1' || a[9] === true
  }
  if (typeof a[10] === 'string') k.label = a[10]
  return k
}

function parseKeys(v: unknown): TunerAnimKey[] {
  return arr(v)
    .map(parseKey)
    .filter((k): k is TunerAnimKey => k != null)
}

function parseHead(c: Record<string, unknown>): Omit<TunerAnimClip, 'props'> {
  return {
    name: s(c.name),
    path: s(c.path),
    readOnly: c.readOnly === true,
    length: Math.max(0, n(c.length)),
    frameRate: n(c.frameRate, 60) > 0 ? n(c.frameRate, 60) : 60,
    loop: c.loop === true,
    legacy: c.legacy === true,
    human: c.human === true,
    events: arr(c.events).map((e) => {
      const r = rec(e)
      return { t: n(r.t), fn: s(r.fn), f: n(r.f), i: n(r.i), s: s(r.s), o: s(r.o), oName: s(r.oName) }
    })
  }
}

function parseClipPatch(v: unknown): TunerAnimClipPatch | undefined {
  const c = rec(v)
  if (!isNum(c.base) || !isNum(c.seq)) return undefined
  const chans: Record<string, TunerAnimKey[]> = {}
  for (const [id, keys] of Object.entries(rec(c.chans))) chans[id] = parseKeys(keys)
  const head = rec(c.head)
  return { base: c.base, seq: c.seq, chans, ...(typeof head.name === 'string' ? { head: parseHead(head) } : {}) }
}

function parseClip(v: unknown): TunerAnimClip | null {
  const c = rec(v)
  if (typeof c.name !== 'string') return null
  return {
    ...parseHead(c),
    props: arr(c.props).map((p) => {
      const r = rec(p)
      return {
        id: s(r.id),
        path: s(r.path),
        object: s(r.object),
        type: s(r.type),
        component: s(r.component),
        group: s(r.group),
        label: s(r.label),
        section: s(r.section),
        pptr: r.pptr === true,
        missing: r.missing === true,
        channels: arr(r.channels).map((ch) => {
          const x = rec(ch)
          return {
            id: s(x.id),
            prop: s(x.prop),
            label: s(x.label),
            discrete: x.discrete === true,
            keys: parseKeys(x.keys)
          }
        })
      }
    })
  }
}

function numMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, x] of Object.entries(rec(v))) if (isNum(x)) out[k] = x
  return out
}

export function parseTunerAnimator(v: unknown): TunerAnimatorUpdate | null {
  if (!v || typeof v !== 'object') return null
  const r = v as Record<string, unknown>
  const o = rec(r.owner)
  const owner: TunerAnimOwner | null =
    typeof o.path === 'string'
      ? { path: o.path, name: s(o.name), kind: o.kind === 'legacy' ? 'legacy' : 'animator', controller: s(o.controller), note: s(o.note), human: o.human === true }
      : null
  const rm = rec(r.rootMotion)
  const clipSeq = isNum(r.clipSeq) ? r.clipSeq : -1
  const clip = 'clip' in r ? parseClip(r.clip) : isNum(r.clipSeq) ? undefined : null
  const clipPatch = r.clipPatch !== undefined ? parseClipPatch(r.clipPatch) : undefined
  const t = rec(r.target)
  const kinds: TunerAnimParam[] = ['none', 'float', 'int', 'string', 'object', 'event']
  return {
    mode: r.mode === 'play' ? 'play' : 'edit',
    owner,
    target: typeof t.path === 'string' ? { path: t.path, name: s(t.name) } : null,
    clips: arr(r.clips).map((c) => {
      const x = rec(c)
      return { name: s(x.name), path: s(x.path), readOnly: x.readOnly === true, state: s(x.state) }
    }),
    ...(clip !== undefined ? { clip } : {}),
    ...(clipPatch ? { clipPatch } : {}),
    clipSeq,
    rootMotion: typeof rm.on === 'boolean' ? { on: rm.on, mode: rm.mode === 'on' || rm.mode === 'off' ? rm.mode : 'auto', animator: rm.animator === true } : null,
    values: numMap(r.values),
    valuesFull: r.valuesFull !== false,
    pending: numMap(r.pending),
    methods: arr(r.methods).map((m) => {
      const x = rec(m)
      return { name: s(x.name), param: kinds.includes(x.param as TunerAnimParam) ? (x.param as TunerAnimParam) : 'none', component: s(x.component), ...(typeof x.otype === 'string' && x.otype ? { otype: x.otype } : {}) }
    }),
    time: Math.max(0, n(r.time)),
    preview: r.preview === true,
    playing: r.playing === true,
    record: r.record === true,
    locked: r.locked === true,
    live: r.live !== false,
    takenOver: r.takenOver === true,
    status: s(r.status),
    error: s(r.error),
    rev: n(r.rev)
  }
}

export function applyClipPatch(clip: TunerAnimClip, patch: TunerAnimClipPatch): TunerAnimClip {
  const props = clip.props.map((p) => {
    if (!p.channels.some((c) => patch.chans[c.id] !== undefined)) return p
    return { ...p, channels: p.channels.map((c) => (patch.chans[c.id] !== undefined ? { ...c, keys: patch.chans[c.id] } : c)) }
  })
  return { ...clip, ...(patch.head ?? {}), props }
}

export function mergeTunerAnimator(prev: TunerAnimator | null, next: TunerAnimatorUpdate): { anim: TunerAnimator; resync: boolean } {
  const { clipPatch, valuesFull, clip: wireClip, ...rest } = next
  let clip: TunerAnimClip | null
  let clipSeq = next.clipSeq
  let resync = false
  if (wireClip !== undefined) clip = wireClip
  else if (clipPatch) {
    if (prev?.clip && prev.clipSeq === clipPatch.base) clip = applyClipPatch(prev.clip, clipPatch)
    else {
      clip = prev?.clip ?? null
      clipSeq = prev?.clipSeq ?? -1
      resync = true
    }
  } else {
    clip = prev?.clip ?? null
    if (next.clipSeq >= 0 && (!prev || prev.clipSeq !== next.clipSeq)) {
      clipSeq = prev?.clipSeq ?? -1
      resync = true
    }
  }
  const delta = Object.keys(next.values).length
  const values = valuesFull || !prev ? next.values : delta === 0 ? prev.values : { ...prev.values, ...next.values }
  return { anim: { ...rest, clip, clipSeq, values }, resync }
}

export function parseTunerAnimPropChoices(v: unknown): TunerAnimPropChoice[] {
  return arr(v)
    .map((p) => {
      const r = rec(p)
      return {
        id: s(r.id),
        path: s(r.path),
        object: s(r.object),
        component: s(r.component),
        label: s(r.label),
        animated: r.animated === true,
        ids: arr(r.ids).filter((x): x is string => typeof x === 'string')
      }
    })
    .filter((p) => p.id && p.ids.length > 0)
}

export function parseTunerAnimatorSpec(raw: unknown): TunerAnimatorSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  let path = typeof r.path === 'string' ? r.path : ''
  path = path.trim().replace(/^\/+/, '')
  if (!path || path.length > 2048 || /[\r\n]/.test(path)) return null
  const spec: TunerAnimatorSpec = { path }
  const clip = str(r.clip, 512)
  if (clip) spec.clip = clip
  return spec
}

export function formatTimelineTime(seconds: number): string {
  const x = Math.max(0, seconds)
  return x < 10 ? x.toFixed(2) : x.toFixed(1)
}

export function frameOf(t: number, fps: number): number {
  return Math.round(t * fps + 1e-6)
}
