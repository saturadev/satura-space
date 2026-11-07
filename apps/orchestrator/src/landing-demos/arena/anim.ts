import { frameOf, mergeTunerAnimator, type TunerAnimator, type TunerAnimatorRequest, type TunerAnimatorUpdate, type TunerAnimClip, type TunerAnimKey, type TunerAnimKeyArg, type TunerAnimProp, type TunerAnimPropChoice } from '@shared/tuner-animator'
import { applyEaseLocal, EASE_PRESETS, evalKeys, isAutoMode, sideMode, TM_CLAMPED, TM_CONSTANT, TM_FREE, TM_LINEAR, updateTangents } from '@renderer/lib/tuner/curves'
import type { TunerBezier } from '@shared/tuner-animator'
import { PASS, handle } from '../mock/api'
type Listener = (a: TunerAnimator, clipChanged: boolean) => void

export interface AnimBinding {
  rest: (chId: string) => number
  templates: () => TunerAnimPropChoice[]
  template: (path: string, group: string) => TunerAnimProp | null
}

function initial(updates: (TunerAnimatorUpdate | null)[]): { anim: TunerAnimator; clips: Map<string, TunerAnimClip> } {
  let anim: TunerAnimator | null = null
  const clips = new Map<string, TunerAnimClip>()
  let base: TunerAnimator | null = null
  for (const u of updates) {
    if (!u) continue
    anim = mergeTunerAnimator(anim, u).anim
    if (anim.clip && !clips.has(anim.clip.path)) clips.set(anim.clip.path, structuredClone(anim.clip))
    if (anim.clip && !base) base = anim
  }
  anim = base ?? anim
  const first = updates.find((u) => u?.clip)!.clip!.path
  anim = { ...anim!, clip: structuredClone(clips.get(first)!), time: 0, playing: false, preview: true, record: false, status: '', error: '' }
  return { anim, clips }
}

function flatKey(t: number, v: number): TunerAnimKey {
  return { t, v, in: 0, out: 0, inW: 1 / 3, outW: 1 / 3, wm: 0, lm: TM_CLAMPED, rm: TM_CLAMPED, broken: false }
}


export class AnimSim {
  readonly root: string
  readonly session: string
  anim: TunerAnimator
  private clips: Map<string, TunerAnimClip>
  private readonly start: { anim: TunerAnimator; clips: Map<string, TunerAnimClip> }
  private listeners = new Set<Listener>()
  private undoStack: TunerAnimClip[] = []
  private redoStack: TunerAnimClip[] = []
  private liveBase: TunerAnimClip | null = null
  private raf = 0
  private last = 0
  private offs: (() => void)[] = []

  private bind: AnimBinding

  constructor(root: string, session: string, updates: (TunerAnimatorUpdate | null)[], bind: AnimBinding) {
    this.root = root
    this.session = session
    this.bind = bind
    this.start = initial(updates)
    this.anim = structuredClone(this.start.anim)
    this.clips = new Map([...this.start.clips].map(([k, v]) => [k, structuredClone(v)]))
    this.anim.values = this.values(this.anim.clip, 0)
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  get dirty(): boolean {
    return this.undoStack.length > 0 || this.anim.clip?.path !== this.start.anim.clip?.path
  }

  reset(): void {
    this.pause()
    this.anim = structuredClone(this.start.anim)
    this.clips = new Map([...this.start.clips].map(([k, v]) => [k, structuredClone(v)]))
    this.undoStack = []
    this.redoStack = []
    this.liveBase = null
    this.anim.rev += 100
    this.anim.clipSeq += 100
    this.publish({ time: 0 })
  }

  private values(clip: TunerAnimClip | null, t: number): Record<string, number> {
    const out: Record<string, number> = {}
    for (const p of clip?.props ?? []) for (const c of p.channels) out[c.id] = c.keys.length ? evalKeys(c.keys, t) : this.bind.rest(c.id)
    return out
  }

  private publish(patch: Partial<TunerAnimator> = {}, clipChanged = false): void {
    const next = { ...this.anim, ...patch }
    if (clipChanged) next.clipSeq = this.anim.clipSeq + 1
    next.values = this.values(next.clip, next.time)
    this.anim = next
    for (const l of this.listeners) l(next, clipChanged)
  }

  private get fps(): number {
    return this.anim.clip?.frameRate ?? 30
  }

  private snap(t: number): number {
    const len = this.anim.clip?.length ?? 0
    return Math.max(0, Math.min(len, Math.round(t * this.fps) / this.fps))
  }

  play(): void {
    if (this.anim.playing || !this.anim.clip) return
    this.publish({ playing: true })
    this.last = performance.now()
    const tick = (now: number): void => {
      if (!this.anim.playing) return
      const clip = this.anim.clip
      if (!clip) return
      const dt = Math.min(0.1, (now - this.last) / 1000)
      this.last = now
      let t = this.anim.time + dt
      if (t > clip.length) {
        if (clip.loop && clip.length > 0) t = t % clip.length
        else {
          this.publish({ time: clip.length, playing: false })
          return
        }
      }
      this.publish({ time: t })
      this.raf = requestAnimationFrame(tick)
    }
    this.raf = requestAnimationFrame(tick)
  }

  pause(): void {
    cancelAnimationFrame(this.raf)
    if (this.anim.playing) this.publish({ playing: false, time: this.snap(this.anim.time) })
  }

  private keyTimes(): number[] {
    const set = new Set<number>()
    for (const p of this.anim.clip?.props ?? []) for (const c of p.channels) for (const k of c.keys) set.add(frameOf(k.t, this.fps))
    return [...set].sort((a, b) => a - b)
  }

  private channel(clip: TunerAnimClip, id: string): TunerAnimKey[] | null {
    for (const p of clip.props) for (const c of p.channels) if (c.id === id) return c.keys
    return null
  }

  private findKey(keys: TunerAnimKey[], t: number): number {
    const f = frameOf(t, this.fps)
    return keys.findIndex((k) => frameOf(k.t, this.fps) === f)
  }

  private touch(clip: TunerAnimClip, ids: Iterable<string>): void {
    for (const id of ids) {
      const keys = this.channel(clip, id)
      if (!keys) continue
      keys.sort((a, b) => a.t - b.t)
      updateTangents(keys)
    }
  }

  private put(keys: TunerAnimKey[], k: TunerAnimKey): void {
    const i = this.findKey(keys, k.t)
    if (i >= 0) keys.splice(i, 1)
    keys.push(k)
  }

  private edit(req: TunerAnimatorRequest, fn: (clip: TunerAnimClip) => void): void {
    const cur = this.anim.clip
    if (!cur) return
    let clip: TunerAnimClip
    if (req.live) {
      this.liveBase ??= structuredClone(cur)
      clip = structuredClone(this.liveBase)
    } else if (this.liveBase) {
      this.undoStack.push(this.liveBase)
      clip = structuredClone(this.liveBase)
      this.liveBase = null
      this.redoStack = []
    } else {
      this.undoStack.push(structuredClone(cur))
      this.redoStack = []
      clip = structuredClone(cur)
    }
    fn(clip)
    this.clips.set(clip.path, clip)
    this.publish({ clip, rev: this.anim.rev + 1 }, true)
  }

  private moveKeys(clip: TunerAnimClip, req: TunerAnimatorRequest): void {
    const df = req.df ?? 0
    const dv = req.dv ?? 0
    const moved: [string, TunerAnimKey][] = []
    for (const a of req.keys ?? []) {
      if (!a.id) continue
      const keys = this.channel(clip, a.id)
      if (!keys) continue
      const i = this.findKey(keys, a.t)
      if (i < 0) continue
      const k = keys[i]
      if (!req.copy) keys.splice(i, 1)
      moved.push([a.id, { ...k, t: Math.max(0, (frameOf(k.t, this.fps) + df) / this.fps), v: k.v + dv }])
    }
    for (const [id, k] of moved) this.put(this.channel(clip, id)!, k)
    const last = Math.max(clip.length, ...moved.map(([, k]) => k.t))
    clip.length = last
    this.touch(clip, moved.map(([id]) => id))
  }

  private tangent(clip: TunerAnimClip, req: TunerAnimatorRequest): void {
    const mode = req.mode ?? ''
    const bez = /^bezier /.test(mode) ? (mode.split(' ').slice(1).map(Number) as TunerBezier) : EASE_PRESETS[mode]
    const ids = new Set<string>()
    for (const a of req.keys ?? []) {
      if (!a.id) continue
      const keys = this.channel(clip, a.id)
      if (!keys) continue
      keys.sort((x, y) => x.t - y.t)
      const i = this.findKey(keys, a.t)
      if (i < 0) continue
      const k = keys[i]
      ids.add(a.id)
      if (bez && i < keys.length - 1) {
        applyEaseLocal(keys, i, bez)
        continue
      }
      if (mode === 'clampedAuto' || mode === 'auto') {
        k.lm = k.rm = mode === 'auto' ? 1 : TM_CLAMPED
        k.broken = false
      } else if (mode === 'freeSmooth') {
        k.lm = k.rm = TM_FREE
        k.broken = false
      } else if (mode === 'flat') {
        k.lm = k.rm = TM_FREE
        k.in = k.out = 0
        k.broken = false
      } else if (mode === 'broken') k.broken = !k.broken
      else if (mode === 'step' || mode === 'rightConstant') sideMode(k, false, TM_CONSTANT)
      else if (mode === 'linear' || mode === 'bothLinear') {
        sideMode(k, true, TM_LINEAR)
        sideMode(k, false, TM_LINEAR)
      } else {
        const m = /^(left|right|both)(Free|Linear|Constant)$/.exec(mode)
        if (m) {
          const v = m[2] === 'Free' ? TM_FREE : m[2] === 'Linear' ? TM_LINEAR : TM_CONSTANT
          if (m[1] !== 'right') sideMode(k, true, v)
          if (m[1] !== 'left') sideMode(k, false, v)
        }
      }
    }
    this.touch(clip, ids)
  }

  private setTangents(clip: TunerAnimClip, keys: TunerAnimKeyArg[]): void {
    for (const a of keys) {
      if (!a.id || !a.hasTan) continue
      const ch = this.channel(clip, a.id)
      const i = ch ? this.findKey(ch, a.t) : -1
      if (!ch || i < 0) continue
      const k = ch[i]
      const tan = (v: number | undefined): number | null => (v == null || Math.abs(v) >= 1e29 ? null : v)
      Object.assign(k, { in: tan(a.inT), out: tan(a.outT), inW: a.inW ?? k.inW, outW: a.outW ?? k.outW, wm: a.wm ?? k.wm, lm: a.lm ?? k.lm, rm: a.rm ?? k.rm, broken: a.broken ?? k.broken })
      if (isAutoMode(k.lm) && !isAutoMode(k.rm)) k.lm = TM_FREE
    }
  }

  recordKeys(path: string, group: string, values: number[], live: boolean): boolean {
    if (!this.anim.record || !this.anim.clip || this.anim.playing) return false
    const t = this.snap(this.anim.time)
    this.edit({ op: 'setKey', live } as TunerAnimatorRequest, (c) => {
      const id = `${path}|UnityEngine.Transform|${group}`
      let prop = c.props.find((p) => p.id === id)
      if (!prop) {
        const made = this.bind.template(path, group)
        if (!made) return
        for (const ch of made.channels) ch.keys = t > 0 ? [flatKey(0, this.bind.rest(ch.id))] : []
        c.props.push(made)
        prop = made
      }
      const ids: string[] = []
      prop.channels.forEach((ch, i) => {
        const v = values[i]
        if (v == null || !Number.isFinite(v)) return
        const k = this.findKey(ch.keys, t)
        if (k >= 0) ch.keys[k] = { ...ch.keys[k], v }
        else ch.keys.push(flatKey(t, v))
        ids.push(ch.id)
      })
      this.touch(c, ids)
    })
    return true
  }

  private choices(): TunerAnimPropChoice[] {
    const have = new Set(this.anim.clip?.props.map((p) => p.id) ?? [])
    return this.bind.templates().map((c) => ({ ...c, animated: have.has(c.id) }))
  }

  request(req: TunerAnimatorRequest): { ok: true; data: { time: number; rev: number; data?: unknown } } | { ok: false; error: string } {
    const clip = this.anim.clip
    const fps = this.fps
    const at = (t: number | undefined): number => this.snap(t ?? this.anim.time)
    switch (req.op) {
      case 'time':
        this.publish({ time: at(req.time), playing: false })
        break
      case 'step':
        this.pause()
        this.publish({ time: at(this.anim.time + (req.dir ?? 1) / fps) })
        break
      case 'first':
        this.pause()
        this.publish({ time: 0 })
        break
      case 'last':
        this.pause()
        this.publish({ time: clip?.length ?? 0 })
        break
      case 'prevKey':
      case 'nextKey': {
        this.pause()
        const f = frameOf(this.anim.time, fps)
        const ks = this.keyTimes()
        const to = req.op === 'prevKey' ? [...ks].reverse().find((k) => k < f) : ks.find((k) => k > f)
        if (to != null) this.publish({ time: to / fps })
        break
      }
      case 'play':
        this.play()
        break
      case 'pause':
        this.pause()
        break
      case 'resume':
      case 'model':
      case 'close':
        this.publish()
        break
      case 'preview':
        this.publish({ preview: req.value === '1' })
        break
      case 'record':
        this.publish({ record: req.value === '1' })
        break
      case 'lock':
        this.publish({ locked: req.locked === 1 })
        break
      case 'clip': {
        const path = (req.clip ?? '').split('::')[0]
        const next = this.clips.get(path)
        if (!next) return { ok: false, error: `No clip at ${path}` }
        this.pause()
        this.undoStack = []
        this.redoStack = []
        this.publish({ clip: next, time: 0 }, true)
        break
      }
      case 'moveKeys':
        this.edit(req, (c) => this.moveKeys(c, req))
        break
      case 'setKey':
        this.edit(req, (c) => {
          const ids: string[] = []
          for (const a of req.keys ?? []) {
            const keys = a.id ? this.channel(c, a.id) : null
            if (!keys || !a.id) continue
            const i = this.findKey(keys, a.t)
            if (i >= 0) keys[i] = { ...keys[i], v: a.hasV ? a.v! : keys[i].v }
            else keys.push(flatKey(this.snap(a.t), a.hasV ? a.v! : evalKeys(keys, a.t)))
            ids.push(a.id)
          }
          this.touch(c, ids)
        })
        break
      case 'addKey':
        this.edit(req, (c) => {
          const t = at(req.time)
          const ids = req.ids?.length ? req.ids : c.props.flatMap((p) => p.channels.map((ch) => ch.id))
          for (const id of ids) {
            const keys = this.channel(c, id)
            if (keys && this.findKey(keys, t) < 0) keys.push(flatKey(t, keys.length ? evalKeys(keys, t) : this.bind.rest(id)))
          }
          this.touch(c, ids)
        })
        break
      case 'deleteKeys':
        this.edit(req, (c) => {
          const ids: string[] = []
          for (const a of req.keys ?? []) {
            const keys = a.id ? this.channel(c, a.id) : null
            if (!keys || !a.id) continue
            const i = this.findKey(keys, a.t)
            if (i >= 0) keys.splice(i, 1)
            ids.push(a.id)
          }
          this.touch(c, ids)
        })
        break
      case 'pasteKeys':
        this.edit(req, (c) => {
          const src = req.keys ?? []
          if (!src.length) return
          const t0 = Math.min(...src.map((k) => k.t))
          const base = at(req.time)
          const ids: string[] = []
          for (const a of src) {
            const keys = a.id ? this.channel(c, a.id) : null
            if (!keys || !a.id) continue
            const k = flatKey(this.snap(base + a.t - t0), a.v ?? 0)
            this.put(keys, k)
            ids.push(a.id)
          }
          this.setTangents(c, src.map((a) => ({ ...a, t: this.snap(base + a.t - t0) })))
          c.length = Math.max(c.length, ...src.map((a) => base + a.t - t0))
          this.touch(c, ids)
        })
        break
      case 'tangent':
        this.edit(req, (c) => this.tangent(c, req))
        break
      case 'setTangents':
        this.edit(req, (c) => {
          this.setTangents(c, req.keys ?? [])
          this.touch(c, (req.keys ?? []).map((k) => k.id!).filter(Boolean))
        })
        break
      case 'addEvent':
        this.edit(req, (c) => {
          c.events = [...c.events, { t: at(req.time), fn: '', f: 0, i: 0, s: '', o: '', oName: '' }].sort((a, b) => a.t - b.t)
        })
        break
      case 'moveEvent':
        this.edit(req, (c) => {
          const e = c.events[req.index ?? -1]
          if (e) c.events[req.index!] = { ...e, t: at(req.time) }
        })
        break
      case 'editEvent':
        this.edit(req, (c) => {
          const e = c.events[req.index ?? -1]
          if (e && req.ev) c.events[req.index!] = { ...e, fn: req.ev.fn ?? e.fn, f: req.ev.f ?? e.f, i: req.ev.i ?? e.i, s: req.ev.s ?? e.s, o: req.ev.o ?? e.o }
        })
        break
      case 'deleteEvent':
        this.edit(req, (c) => {
          const drop = new Set(req.indices ?? [req.index ?? -1])
          c.events = c.events.filter((_e, i) => !drop.has(i))
        })
        break
      case 'settings':
        this.edit(req, (c) => {
          if (req.loop != null) c.loop = req.loop > 0
          if (req.length != null && req.length > 0) c.length = req.length
          if (req.frameRate != null && req.frameRate > 0) c.frameRate = req.frameRate
        })
        break
      case 'props':
        return { ok: true, data: { time: this.anim.time, rev: this.anim.rev, data: this.choices() } }
      case 'addProp':
        this.edit(req, (c) => {
          for (const id of req.ids ?? []) {
            const [path, , rest] = id.split('|')
            const group = rest.split('.')[0]
            if (c.props.some((p) => p.id === `${path}|${id.split('|')[1]}|${group}`)) continue
            const t = this.bind.template(path, group)
            if (!t) continue
            for (const ch of t.channels) ch.keys = [flatKey(0, this.bind.rest(ch.id))]
            c.props.push(t)
          }
        })
        break
      case 'removeProp':
        this.edit(req, (c) => {
          const drop = new Set(req.ids ?? [])
          c.props = c.props.map((p) => ({ ...p, channels: p.channels.filter((ch) => !drop.has(ch.id)) })).filter((p) => p.channels.length > 0)
        })
        break
      case 'undo':
      case 'redo': {
        const from = req.op === 'undo' ? this.undoStack : this.redoStack
        const to = req.op === 'undo' ? this.redoStack : this.undoStack
        const prev = from.pop()
        if (prev && clip) {
          to.push(structuredClone(clip))
          this.clips.set(prev.path, prev)
          this.publish({ clip: prev, rev: this.anim.rev + 1 }, true)
        }
        break
      }
      default:
        return { ok: false, error: 'Not part of this demo' }
    }
    return { ok: true, data: { time: this.anim.time, rev: this.anim.rev } }
  }

  install(): () => void {
    this.offs.push(handle('tuner', 'animator', (p, s, req) => (p === this.root && s === this.session ? Promise.resolve(this.request(req)) : PASS)))
    return () => {
      this.pause()
      for (const off of this.offs) off()
      this.offs = []
    }
  }
}
