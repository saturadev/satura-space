import { Color, Vector3 } from 'three'
import type { Quat, TunerCamera, TunerHierarchyRequest, TunerMember, TunerObject, TunerOverride, TunerParticles, TunerState, TunerTransform, TunerView, Vec3 } from '@shared/tuner'
import type { TiSection, TiStyle, TiTexture, TunerInspectTarget, TunerInspectorInput } from '@shared/tuner-inspector'
import type { TunerColor, TunerCurve, TunerGradient, TunerObjectCandidate, TunerObjectQuery } from '@shared/tuner-inspector-popups'
import type { TunerHandleEvent, TunerHandlesRequest, TunerHandlesState } from '@shared/tuner-handles'
import type { TunerPickHit, TunerSceneSelection, TunerTheme } from '@shared/tuner-sceneview'
import type { TunerAnimator, TunerAnimatorUpdate, TunerAnimProp, TunerAnimPropChoice } from '@shared/tuner-animator'
import type { TunerAnnotations, TunerAnnotationsRequest } from '@shared/tuner-annotations'
import { defaultInstanceDesired, type WorldDesired, type WorldObserved } from '@shared/unity/world'
import { tunerSurfaceKey } from '@shared/tuner-frame'
import { eulerToQuat, quatToEuler } from '@renderer/lib/tuner/rotation-math'
import { handlePrefs } from '@renderer/lib/tuner/session-memory'
import { PASS, emit, handle } from '../mock/api'
import { ArenaScene, type SceneData, type SceneObjectData, type SimNode } from './scene'
import { InspectorDoc, type Change, type DocCtx, type ExportField, type ObjectChoice, type StoredCapture } from './inspector'
import { applyDrag, rayAxisParam, type ColliderState, type DragStart, type Handle } from './colliders'
import type { PsParams } from './particles'
import { AnimSim } from './anim'
import { isPhoneView } from '@renderer/lib/tuner/view-mirror'

export interface ArenaFixture {
  root: string
  session: string
  inspectorWidth: number
  listViews: TunerView[]
  start: { ok: true; data: TunerState }
  world: unknown
  objects: Record<string, TunerObject>
  animator: (TunerAnimatorUpdate | null)[]
  particles: TunerParticles | null
  captures: Record<string, StoredCapture>
  styles: Omit<TiStyle, 'id'>[]
  textures: Omit<TiTexture, 'id'>[]
  scene: SceneData
  focus: { view: TunerView; start: { ok: true; data: TunerState }; captures: Record<string, StoredCapture> } | null
  templates?: Record<string, StoredCapture>
}

const AXES = ['x', 'y', 'z'] as const
const TRANSFORM: Record<string, 'lp' | 'lr' | 'ls'> = { m_LocalPosition: 'lp', m_LocalRotation: 'lr', m_LocalScale: 'ls' }
const VIEW = 'landing-arena'
const SCENE = 'LandingArena'
const SCENE_PATH = 'Assets/Scenes/LandingArena.unity'
const ANIM_ROOT = 'Monolith'

function wrap180(d: number): number {
  d %= 360
  if (d > 180) d -= 360
  if (d <= -180) d += 360
  return d
}

interface UndoEntry {
  label: string
  undo: () => void
  redo: () => void
}

interface Clip {
  type: string
  values: Record<string, string>
}

export interface FrameLog {
  t: number
  seq: number
  pointer: { x: number; y: number } | null
  handle: { x: number; y: number } | null
  axisErr: number | null
}

export class ArenaSim {
  readonly root: string
  readonly fx: ArenaFixture
  scene: ArenaScene
  anim: AnimSim
  members: TunerMember[]
  private camera: TunerCamera | null = null
  selected: string[] = []
  private watched: string | null = null
  private inspector: { session: string; doc: InspectorDoc; id: string; seq: number; focus: boolean } | null = null
  docs = new Map<string, InspectorDoc>()
  private focusDocs = new Map<string, InspectorDoc>()
  viewName = VIEW
  overrides: TunerOverride[] = []
  onView: ((name: string) => void) | null = null
  private euler = new Map<string, Vec3>()
  private dirty = true
  private camAt = 0
  private camBusy = false
  private seq = 0
  private offs: (() => void)[] = []
  private raf = 0
  private last = performance.now()
  private visible = true
  private dragStart = new Map<string, { lp: Vec3; lr: Quat; ls: Vec3 }>()
  private undoStack: UndoEntry[] = []
  private redoStack: UndoEntry[] = []
  private unsaved = false
  private saved: string | null = null
  private clipboard: Clip | null = null
  private hover: { handle: number; x: number; y: number } | null = null
  private drag: (DragStart & { id: string; last: { x: number; y: number } }) | null = null
  private particleSpeed = 1
  private lastParticles = 0
  private nextId = 1
  frameLog: FrameLog[] | null = null
  private sentClip = -999
  onChange: ((what: string) => void) | null = null
  debug: ((msg: string) => void) | null = null

  readonly inspectorWidth: number

  constructor(fx: ArenaFixture, inspectorWidth = 0) {
    this.inspectorWidth = inspectorWidth
    this.root = fx.root
    this.fx = fx
    this.members = structuredClone(fx.start.data.members ?? [])
    this.scene = new ArenaScene(structuredClone(fx.scene), this.members)
    for (const n of this.scene.nodes.values()) {
      this.euler.set(n.id, n.data.euler.map(wrap180) as Vec3)
      if (n.data.components.includes('ParticleSystem')) this.scene.addEmitter(n, this.psParams(n))
    }
    this.scene.prewarm()
    this.anim = this.makeAnim()
  }

  get session(): string {
    return this.fx.session
  }

  private makeAnim(): AnimSim {
    const a = new AnimSim(this.root, this.session, this.fx.animator, {
      rest: (ch) => this.restValue(ch),
      templates: () => this.animChoices(),
      template: (path, group) => this.animTemplate(path, group)
    })
    a.subscribe((next, clipChanged) => this.onAnim(next, clipChanged))
    return a
  }

  private animNode(path: string): SimNode | undefined {
    return this.scene.byPath.get(path ? `${ANIM_ROOT}/${path}` : ANIM_ROOT)
  }

  private restValue(ch: string): number {
    const [path, type, prop] = ch.split('|')
    const n = this.animNode(path)
    if (!n || type !== 'UnityEngine.Transform') return 0
    const [group, axis] = prop.split('.')
    const k = AXES.indexOf(axis as 'x')
    if (group === 'localEulerAnglesRaw') return n.data.euler.map(wrap180)[k] ?? 0
    if (group === 'm_LocalPosition') return n.data.lp[k] ?? 0
    if (group === 'm_LocalScale') return n.data.ls[k] ?? 1
    return 0
  }

  private animTemplate(path: string, group: string): TunerAnimProp | null {
    const n = this.animNode(path)
    const label = group === 'm_LocalPosition' ? 'Position' : group === 'localEulerAnglesRaw' ? 'Rotation' : group === 'm_LocalScale' ? 'Scale' : null
    if (!n || !label) return null
    const id = `${path}|UnityEngine.Transform|${group}`
    return { id, path, object: n.data.name, type: 'UnityEngine.Transform', component: 'Transform', group, label, section: '', pptr: false, missing: false, channels: AXES.map((a) => ({ id: `${id}.${a}`, prop: `${group}.${a}`, label: a, discrete: false, keys: [] })) }
  }

  private animChoices(): TunerAnimPropChoice[] {
    const out: TunerAnimPropChoice[] = []
    const root = this.scene.byPath.get(ANIM_ROOT)
    if (!root) return out
    const walk = (n: SimNode, rel: string): void => {
      for (const g of ['m_LocalPosition', 'localEulerAnglesRaw', 'm_LocalScale']) {
        const t = this.animTemplate(rel, g)
        if (t) out.push({ id: t.id, path: rel, object: t.object, component: 'Transform', label: t.label, animated: false, ids: t.channels.map((c) => c.id) })
      }
      for (const c of n.children) walk(c, rel ? `${rel}/${c.data.name}` : c.data.name)
    }
    walk(root, '')
    return out
  }

  private onAnim(a: TunerAnimator, clipChanged: boolean): void {
    if (a.preview || a.playing) this.applyAnim(a)
    const { clip, ...rest } = a
    const send = clipChanged || this.sentClip !== a.clipSeq
    this.sentClip = a.clipSeq
    const update = { ...rest, valuesFull: true, ...(send ? { clip } : {}) } as TunerAnimatorUpdate
    emit('tuner', 'onLive', { projectPath: this.root, session: this.session, animator: update })
    this.onChange?.('anim')
  }

  private applyAnim(a: TunerAnimator): void {
    const touched = new Set<SimNode>()
    for (const [ch, v] of Object.entries(a.values)) {
      const [path, type, prop] = ch.split('|')
      if (type !== 'UnityEngine.Transform') continue
      const n = this.animNode(path)
      if (!n) continue
      const [group, axis] = prop.split('.')
      const k = AXES.indexOf(axis as 'x')
      const l = this.scene.local(n)
      if (group === 'localEulerAnglesRaw') {
        const e = [...(this.euler.get(n.id) ?? quatToEuler(l.lr))] as Vec3
        e[k] = v
        this.euler.set(n.id, e)
        this.scene.setLocal(n.id, { lr: eulerToQuat(e) })
      } else if (group === 'm_LocalPosition') {
        const p = [...l.lp] as Vec3
        p[k] = v
        this.scene.setLocal(n.id, { lp: p })
      } else if (group === 'm_LocalScale') {
        const p = [...l.ls] as Vec3
        p[k] = v
        this.scene.setLocal(n.id, { ls: p })
      }
      touched.add(n)
    }
    this.dirty = true
    const i = this.inspector
    if (i) {
      const n = this.scene.nodes.get(i.id)
      if (n && touched.has(n) && !i.doc.dragging() && this.syncTransform(n, i.doc)) this.pushInspector()
    }
  }

  private mirrored = false

  private mine(p: unknown): boolean {
    return p === this.root
  }

  private fieldsOf(n: SimNode): ExportField[] {
    return n.data.fields
  }

  private ctxFor(n: SimNode): DocCtx {
    return {
      fields: this.fieldsOf(n),
      componentOf: (s) => s,
      objects: (t) => this.objectChoices(t),
      addable: () => this.addable(n),
      canPaste: (s) => this.clipboard?.type === s
    }
  }

  private doc(n: SimNode): InspectorDoc | null {
    const key = n.id
    let d = this.docs.get(key)
    if (d) return d
    const cap = this.fx.captures[n.data.path] ?? this.templateCapture(n)
    if (!cap) return null
    d = new InspectorDoc(n.data.path, cap, this.fx.styles, this.ctxFor(n), this.inspectorWidth)
    this.docs.set(key, d)
    this.syncTransform(n, d)
    const light = d.section('Light') as (TiSection & { layout?: string }) | undefined
    if (light) light.layout = this.lightLayout(d)
    return d
  }

  private focusDoc(n: SimNode): InspectorDoc | null {
    const cap = this.fx.focus?.captures[n.data.path]
    if (!cap) return null
    let d = this.focusDocs.get(n.id)
    if (d) return d
    d = new InspectorDoc(n.data.path, cap, this.fx.styles, this.ctxFor(n), this.inspectorWidth)
    this.focusDocs.set(n.id, d)
    this.syncTransform(n, d)
    for (const f of this.focusValues(n)) d.write(f.section, f.prop, f.value)
    return d
  }

  private focusValues(n: SimNode): { section: string; prop: string; value: number }[] {
    const full = this.docs.get(n.id)
    if (!full) return []
    const out: { section: string; prop: string; value: number }[] = []
    for (const o of this.fx.focus?.start.data.objects ?? []) {
      if (o.path !== n.data.path || o.inspect?.kind !== 'object') continue
      for (const c of o.inspect.components ?? []) for (const f of c.fields ?? []) {
        for (const prop of [f, `${f}.scalar`]) {
          const v = full.read(c.type, prop)
          if (typeof v === 'number') out.push({ section: c.type, prop, value: v })
        }
      }
    }
    return out
  }

  get focused(): boolean {
    return this.viewName !== VIEW && !!this.fx.focus && this.viewName === this.fx.focus.view.name
  }

  private trackOverride(n: SimNode, c: Change): void {
    if ((c.kind !== 'number' && c.kind !== 'color') || !c.final || c.before == null) return
    const fmt = (v: number): string => String(Number(v.toFixed(3)))
    const hex = (v: TunerColor): string => `#${[v.r, v.g, v.b].map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()}`
    const key = `${n.data.path}|${c.section}|${c.prop}`
    const i = this.overrides.findIndex((o) => `${o.path}|${o.component}|${o.field}` === key)
    const before = i >= 0 ? this.overrides[i].beforeRaw : c.kind === 'color' ? hex(c.before) : fmt(c.before)
    const after = c.kind === 'color' ? hex(c.value) : fmt(c.value)
    if (i >= 0) this.overrides.splice(i, 1)
    if (before === after) return
    const state = this.fx.focus?.start.data.activeState ?? 'default'
    const id = this.fx.focus?.start.data.objects?.find((o) => o.path === n.data.path)?.id ?? n.id
    this.overrides.push({ state, id, path: n.data.path, component: c.section, field: c.prop, before, after, beforeRaw: before, afterRaw: after })
    this.emitState()
  }

  private templateCapture(n: SimNode): StoredCapture | null {
    const t = (n.data as SceneObjectData & { template?: string }).template
    return t ? (this.fx.captures[t] ?? null) : null
  }

  syncTransform(n: SimNode, d: InspectorDoc): boolean {
    const l = this.scene.local(n)
    let changed = false
    for (let i = 0; i < 3; i++) {
      changed = d.write('Transform', `m_LocalPosition.${AXES[i]}`, l.lp[i]) || changed
      changed = d.write('Transform', `m_LocalScale.${AXES[i]}`, l.ls[i]) || changed
    }
    const e = quatToEuler(l.lr, this.euler.get(n.id))
    this.euler.set(n.id, e)
    for (let i = 0; i < 3; i++) changed = d.write('Transform', `m_LocalRotation.${AXES[i]}`, Math.round(e[i] * 1000) / 1000) || changed
    return changed
  }

  private syncCollider(n: SimNode, d: InspectorDoc): void {
    const c = n.colliders[0]
    if (!c) return
    const sec = c.type
    for (let i = 0; i < 3; i++) d.write(sec, `m_Center.${AXES[i]}`, c.center[i])
    if (sec === 'BoxCollider') for (let i = 0; i < 3; i++) d.write(sec, `m_Size.${AXES[i]}`, c.size[i])
    if (sec !== 'BoxCollider') d.write(sec, 'm_Radius', c.radius)
    if (sec === 'CapsuleCollider') d.write(sec, 'm_Height', c.height)
  }

  private num(n: SimNode, sec: string, prop: string, fallback: number): number {
    const d = this.docs.get(n.id)
    const v = d?.read(sec, prop)
    if (v != null) return v
    const f = n.data.fields.find((x) => x.path === prop && (x.component === sec || x.component === `${sec}Renderer`))
    return typeof f?.value === 'number' ? f.value : fallback
  }

  private bool(n: SimNode, sec: string, prop: string, fallback: boolean): boolean {
    const d = this.docs.get(n.id)
    const v = d?.readToggle(sec, prop)
    if (v != null) return v
    const f = n.data.fields.find((x) => x.path === prop && (x.component === sec || x.component === `${sec}Renderer`))
    return typeof f?.value === 'boolean' ? f.value : fallback
  }

  private exportValue<T>(n: SimNode, prop: string): T | undefined {
    return n.data.fields.find((x) => x.path === prop)?.value as T | undefined
  }

  psParams(n: SimNode): PsParams {
    const S = 'ParticleSystem'
    const d = this.docs.get(n.id)
    const color = (d?.colors.get(`${S}|InitialModule.startColor.maxColor`) ?? (() => {
      const v = this.exportValue<number[]>(n, 'InitialModule.startColor.maxColor')
      return v ? { r: v[0], g: v[1], b: v[2], a: v[3] } : { r: 1, g: 1, b: 1, a: 1 }
    })()) as TunerColor
    const gradient = (d?.gradients.get(`${S}|ColorModule.gradient.maxGradient`) ?? this.exportValue<TunerGradient>(n, 'ColorModule.gradient.maxGradient') ?? null) as TunerGradient | null
    const sizeCurve = (d?.curves.get(`${S}|SizeModule.curve.maxCurve`) ?? this.exportValue<TunerCurve>(n, 'SizeModule.curve.maxCurve') ?? null) as TunerCurve | null
    const sp = d?.readText(S, 'moveWithTransform') ?? (this.exportValue<number>(n, 'moveWithTransform') === 1 ? 'World' : 'Local')
    const life = this.num(n, S, 'InitialModule.startLifetime.scalar', 1)
    const speed = this.num(n, S, 'InitialModule.startSpeed.scalar', 1)
    const size = this.num(n, S, 'InitialModule.startSize.scalar', 0.1)
    const rot = this.num(n, S, 'InitialModule.startRotation.scalar', 0)
    const renderMode = this.exportValue<number>(n, 'm_RenderMode')
    return {
      duration: this.num(n, S, 'lengthInSec', 1),
      looping: this.bool(n, S, 'looping', true),
      prewarm: this.bool(n, S, 'prewarm', false),
      lifetime: [life * 0.8, life * 1.1],
      speed: [speed * 0.8, speed * 1.15],
      size: [size * 0.7, size * 1.2],
      rotation: [rot, rot],
      color,
      gravity: this.num(n, S, 'InitialModule.gravityModifier.scalar', 0),
      simSpeed: this.num(n, S, 'simulationSpeed', 1),
      maxParticles: this.num(n, S, 'InitialModule.maxNumParticles', 500),
      world: sp !== 'Local',
      emission: this.bool(n, S, 'EmissionModule.enabled', true),
      rate: this.num(n, S, 'EmissionModule.rateOverTime.scalar', 10),
      shape: this.bool(n, S, 'ShapeModule.enabled', true),
      shapeType: 'Cone',
      angle: this.num(n, S, 'ShapeModule.angle', 25),
      radius: this.num(n, S, 'ShapeModule.radius.value', 1),
      arc: this.num(n, S, 'ShapeModule.arc.value', 360),
      boxSize: [1, 1, 1],
      randomDirection: this.num(n, S, 'ShapeModule.randomDirectionAmount', 0),
      colorOn: this.bool(n, S, 'ColorModule.enabled', false),
      gradient,
      sizeOn: this.bool(n, S, 'SizeModule.enabled', false),
      sizeCurve,
      velocityOn: this.bool(n, S, 'VelocityModule.enabled', false),
      velocity: [this.num(n, S, 'VelocityModule.x.scalar', 0), this.num(n, S, 'VelocityModule.y.scalar', 0), this.num(n, S, 'VelocityModule.z.scalar', 0)],
      noiseOn: this.bool(n, S, 'NoiseModule.enabled', false),
      noiseStrength: this.num(n, S, 'NoiseModule.strength.scalar', 1),
      noiseFrequency: this.num(n, S, 'NoiseModule.frequency', 0.5),
      rotationOn: this.bool(n, S, 'RotationModule.enabled', false),
      angular: this.num(n, S, 'RotationModule.curve.scalar', 45),
      limitOn: this.bool(n, S, 'ClampVelocityModule.enabled', false),
      limitSpeed: this.num(n, S, 'ClampVelocityModule.magnitude.scalar', 1),
      dampen: this.num(n, S, 'ClampVelocityModule.dampen', 0),
      render: renderMode === 1 ? 'Stretch' : 'Billboard',
      lengthScale: this.num(n, S, 'm_LengthScale', 2),
      velocityScale: this.num(n, S, 'm_VelocityScale', 0),
      additive: n.data.name === 'Motes',
      rendererOn: this.bool(n, S, 'm_Enabled', true)
    }
  }

  private objectChoices(type: string): ObjectChoice[] {
    const t = type.replace(/^.*\./, '')
    if (t === 'Mesh') return ['Cube', 'Cylinder', 'Capsule', 'Sphere', 'Plane', 'Quad'].map((m) => ({ name: m, typeName: 'Mesh', ref: { guid: `mesh-${m}`, path: m } }))
    if (t === 'Material') return [...this.scene.materials.keys()].filter((m) => m !== 'Motes').map((m) => ({ name: m, typeName: 'Material', ref: { guid: `mat-${m}`, path: m } }))
    if (t === 'Transform' || t === 'GameObject') return [...this.scene.nodes.values()].map((n) => ({ name: n.data.name, typeName: 'Transform', ref: { path: n.data.path, scene: SCENE } }))
    if (t === 'ParticleSystem') return [...this.scene.nodes.values()].filter((n) => n.emitter).map((n) => ({ name: n.data.name, typeName: 'ParticleSystem', ref: { path: n.data.path, scene: SCENE, component: 'ParticleSystem' } }))
    if (t === 'RuntimeAnimatorController') return [{ name: 'Monolith', typeName: 'AnimatorController', ref: { guid: 'ctrl-Monolith', path: 'Monolith' } }]
    return []
  }

  private queryObjects(q: TunerObjectQuery): { ok: boolean; total: number; items: TunerObjectCandidate[] } {
    const s = q.search.toLowerCase()
    const all = this.objectChoices(q.type).filter((c) => !s || c.name.toLowerCase().includes(s))
    const items = all.slice(q.offset, q.offset + q.limit).map((c) => ({ ...c.ref, name: c.name, typeName: c.typeName }))
    return { ok: true, total: all.length, items }
  }

  private addable(n: SimNode): { type: string; label: string }[] {
    const have = new Set(n.data.components)
    const out: { type: string; label: string }[] = []
    if (!have.has('BoxCollider') && !have.has('SphereCollider') && !have.has('CapsuleCollider')) {
      out.push({ type: 'BoxCollider', label: 'Box Collider' }, { type: 'SphereCollider', label: 'Sphere Collider' }, { type: 'CapsuleCollider', label: 'Capsule Collider' })
    }
    if (!have.has('Light')) out.push({ type: 'Light', label: 'Light' })
    return out
  }

  private template(type: string): { path: string; key: string } | null {
    const src: Record<string, string> = { BoxCollider: 'Monolith/Slab', SphereCollider: 'Room/Walls/Niche L/Statue/Head', CapsuleCollider: 'Room/Walls/Niche L/Statue', Light: 'Lights/Floor Glow' }
    return src[type] ? { path: src[type], key: type } : null
  }

  state(): TunerState {
    if (this.focused) return this.focusState()
    const s = structuredClone(this.fx.start.data)
    s.session = this.session
    s.members = this.members.map((m) => ({ ...m, active: this.scene.nodes.get(m.id)?.active ?? m.active }))
    s.overrides = []
    s.unsaved = { scenes: this.unsaved ? [SCENE_PATH] : [], prefabs: [], assets: [] }
    return s
  }

  private focusState(): TunerState {
    const f = this.fx.focus!
    const s = structuredClone(f.start.data)
    s.session = this.session
    s.playing = true
    const fm = f.start.data.members ?? []
    const pathOf = (m: TunerMember): string => {
      const parts = [m.name]
      for (let p = fm.find((x) => x.id === m.parent); p; p = fm.find((x) => x.id === p!.parent)) parts.unshift(p.name)
      return parts.join('/')
    }
    const ids = new Map(fm.map((m) => [m.id, this.scene.byPath.get(pathOf(m))?.id ?? m.id]))
    s.members = fm.map((m) => ({ ...m, id: ids.get(m.id)!, parent: m.parent ? (ids.get(m.parent) ?? m.parent) : m.parent }))
    s.overrides = structuredClone(this.overrides)
    s.unsaved = { scenes: [], prefabs: [], assets: [] }
    return s
  }

  private emitState(): void {
    emit('tuner', 'onState', { projectPath: this.root, state: this.state() })
  }

  private touch(): void {
    const next = this.undoStack.length > 0 || this.redoStack.length > 0
    if (next !== this.unsaved) {
      this.unsaved = next
      this.emitState()
    }
    this.onChange?.('edit')
  }

  push(label: string, undo: () => void, redo: () => void): void {
    this.undoStack.push({ label, undo, redo })
    if (this.undoStack.length > 200) this.undoStack.shift()
    this.redoStack = []
    this.touch()
  }

  undo(): boolean {
    const e = this.undoStack.pop()
    if (!e) return false
    e.undo()
    this.redoStack.push(e)
    this.refresh()
    if (!this.undoStack.length) {
      this.redoStack = []
      this.touch()
    }
    return true
  }

  redo(): boolean {
    const e = this.redoStack.pop()
    if (!e) return false
    e.redo()
    this.undoStack.push(e)
    this.refresh()
    return true
  }

  get undoDepth(): number {
    return this.undoStack.length
  }

  private refresh(): void {
    this.dirty = true
    const i = this.inspector
    if (i) {
      const n = this.scene.nodes.get(i.id)
      if (n) {
        this.syncTransform(n, i.doc)
        this.syncCollider(n, i.doc)
      }
      this.pushInspector()
    }
    this.emitLive()
    this.touch()
  }

  liveObject(n: SimNode): TunerObject {
    const p = this.scene.pose(n)
    const base = this.fx.objects[n.id]
    const ancestors: string[] = []
    for (let x = n.parent; x; x = x.parent) ancestors.unshift(x.id)
    const at = this.members.findIndex((m) => m.id === n.id)
    return {
      ...(base ?? { id: n.id, kind: 'member', opened: false, path: n.data.path, scene: SCENE, label: n.data.name, ancestors, components: n.data.components.map((c) => ({ key: c, type: c })), at: [at] }),
      inspect: { kind: 'object', path: n.data.path, scene: SCENE },
      id: n.id,
      path: n.data.path,
      label: n.data.name,
      ancestors,
      active: p.active,
      position: p.position,
      rotation: p.rotation,
      localPosition: p.localPosition,
      localRotation: p.localRotation,
      localScale: p.localScale,
      bounds: p.bounds
    }
  }

  private emitLive(): void {
    if (!this.watched) return
    const n = this.scene.nodes.get(this.watched)
    if (n) emit('tuner', 'onLive', { projectPath: this.root, session: this.session, object: this.liveObject(n) })
  }

  private particlesInfo(): TunerParticles | null {
    const id = this.watched ?? this.selected[0]
    const n = id ? this.scene.nodes.get(id) : null
    const e = n?.emitter
    if (!n || !e) return null
    return { name: n.data.name, path: n.data.path, mode: 'edit', playing: e.playing, time: Math.round(e.time * 100) / 100, duration: e.params.duration, count: e.count, speed: this.particleSpeed }
  }

  private emitParticles(force = false): void {
    const now = performance.now()
    if (!force && now - this.lastParticles < 120) return
    this.lastParticles = now
    emit('tuner', 'onLive', { projectPath: this.root, session: this.session, particles: this.particlesInfo() })
  }

  pushInspector(hot = false): void {
    const i = this.inspector
    if (!i) return
    i.seq++
    emit('tunerInspector', 'onCapture', { projectPath: this.root, session: i.session, capture: i.doc.update(i.session, i.seq, hot) })
  }

  private recordTransform(n: SimNode, live: boolean, kind: 'lp' | 'lr' | 'ls'): void {
    if (!this.anim.anim.record) return
    const path = n.data.path
    if (path !== ANIM_ROOT && !path.startsWith(`${ANIM_ROOT}/`)) return
    const rel = path === ANIM_ROOT ? '' : path.slice(ANIM_ROOT.length + 1)
    const l = this.scene.local(n)
    if (kind === 'lp') this.anim.recordKeys(rel, 'm_LocalPosition', l.lp, live)
    else if (kind === 'lr') this.anim.recordKeys(rel, 'localEulerAnglesRaw', this.euler.get(n.id) ?? quatToEuler(l.lr), live)
    else this.anim.recordKeys(rel, 'm_LocalScale', l.ls, live)
  }

  private setTransform(n: SimNode, v: { lp?: Vec3; lr?: Quat; ls?: Vec3 }, euler?: Vec3): void {
    this.scene.setLocal(n.id, v)
    if (euler) this.euler.set(n.id, euler)
    else if (v.lr) this.euler.set(n.id, quatToEuler(v.lr, this.euler.get(n.id)))
  }

  applyField(n: SimNode, c: Change): void {
    const S = 'section' in c ? c.section : ''
    if (c.kind === 'number' && S === 'Transform') {
      const [field, axis] = c.prop.split('.')
      const kind = TRANSFORM[field]
      const k = AXES.indexOf(axis as 'x')
      if (!kind || k < 0) return
      const l = this.scene.local(n)
      if (kind === 'lr') {
        const e = [...(this.euler.get(n.id) ?? quatToEuler(l.lr))] as Vec3
        e[k] = c.value
        this.setTransform(n, { lr: eulerToQuat(e) }, e)
      } else {
        const v = [...l[kind]] as Vec3
        const doc = this.docs.get(n.id)
        if (kind === 'ls' && doc?.link && v[k] !== 0) {
          const r = c.value / v[k]
          for (let i = 0; i < 3; i++) v[i] = i === k ? c.value : v[i] * r
          if (doc) for (let i = 0; i < 3; i++) doc.write('Transform', `m_LocalScale.${AXES[i]}`, v[i])
        } else v[k] = c.value
        this.setTransform(n, { [kind]: v })
      }
      this.recordTransform(n, !c.final, kind)
      this.emitLive()
      return
    }
    if (c.kind === 'bool') {
      if (S === 'GameObject' && c.prop === 'm_IsActive') {
        this.scene.setActive(n.id, c.value)
        const m = this.members.find((x) => x.id === n.id)
        if (m) m.active = c.value
        this.emitState()
        return
      }
      if (c.prop === 'm_Enabled') {
        const col = n.colliders.find((x) => x.type === S)
        if (col) col.enabled = c.value
        if (S === 'MeshRenderer' && n.mesh) {
          n.rendererOn = c.value
          n.mesh.visible = c.value
        }
        if (S === 'Light' && n.light) {
          n.lightOn = c.value
          n.light.visible = c.value
        }
      }
      if (c.prop === 'm_IsTrigger') {
        const col = n.colliders.find((x) => x.type === S)
        if (col) col.trigger = c.value
      }
      if (c.prop === 'm_CastShadows' && n.mesh) n.mesh.castShadow = c.value
    }
    if (c.kind === 'number') {
      const col = n.colliders.find((x) => x.type === S)
      if (col) {
        const [f, axis] = c.prop.split('.')
        const k = AXES.indexOf(axis as 'x')
        if (f === 'm_Center' && k >= 0) col.center = col.center.map((v, i) => (i === k ? c.value : v)) as Vec3
        if (f === 'm_Size' && k >= 0) col.size = col.size.map((v, i) => (i === k ? c.value : v)) as Vec3
        if (f === 'm_Radius') col.radius = c.value
        if (f === 'm_Height') col.height = c.value
      }
      if (S === 'Light' && n.light) {
        if (c.prop === 'm_Intensity') n.light.intensity = c.value * (n.light.type === 'DirectionalLight' ? 2.2 : 2.5)
        if (c.prop === 'm_Range' && 'distance' in n.light) n.light.distance = c.value
      }
    }
    if (c.kind === 'enum') {
      const col = n.colliders.find((x) => x.type === S)
      if (col && c.prop === 'm_Direction') col.direction = c.index
      if (S === 'MeshRenderer' && c.prop === 'm_CastShadows' && n.mesh) n.mesh.castShadow = c.label !== 'Off'
      if (S === 'Light' && (c.prop === 'm_Type' || c.prop === 'm_Shadows.m_Type')) this.swapLight(n)
    }
    if (c.kind === 'color' && S === 'Light' && n.light) n.light.color.setRGB(c.value.r, c.value.g, c.value.b, 'srgb')
    if (c.kind === 'object') {
      if (S === 'MeshFilter') this.scene.setMesh(n, c.name || null)
      if (S === 'MeshRenderer' && n.material) {
        n.data.material = c.name
        this.scene.paint(n.material, c.name)
      }
    }
    if (c.kind === 'name') {
      n.data.name = c.value
      const m = this.members.find((x) => x.id === n.id)
      if (m) m.name = c.value
      this.scene.reindex()
      this.emitState()
    }
    if (n.emitter && S === 'ParticleSystem') n.emitter.params = this.psParams(n)
  }

  private lightMemo = new Map<string, Map<string, string | number>>()

  private lightLayout(doc: InspectorDoc, memo?: Map<string, string | number>): string {
    const type = (doc.readText('Light', 'm_Type') ?? 'Point').replace(/ \(.*\)$/, '')
    const shadows = doc.readText('Light', 'm_Shadows.m_Type') ?? (memo?.get('m_Shadows.m_Type') as string | undefined) ?? 'No Shadows'
    return `${type}|${shadows === 'No Shadows' ? 'None' : 'Soft'}`
  }

  private swapLight(n: SimNode): void {
    const doc = this.docs.get(n.id)
    const old = doc?.section('Light')
    if (!doc || !old) return
    const L = 'Light'
    const memo = this.lightMemo.get(n.id) ?? new Map<string, string | number>()
    this.lightMemo.set(n.id, memo)
    const TEXTS = ['m_Lightmapping', 'm_Shadows.m_Type', 'm_CullingMask', 'm_UsePipelineSettings', 'm_SoftShadowQuality']
    const NUMS = ['m_Intensity', 'm_BounceIntensity', 'm_Range', 'm_SpotAngle', 'm_InnerSpotAngle', 'm_Shadows.m_Strength', 'm_Shadows.m_NearPlane']
    for (const p of TEXTS) {
      const v = doc.readText(L, p)
      if (v != null) memo.set(p, v)
    }
    for (const p of NUMS) {
      const v = doc.read(L, p)
      if (v != null) memo.set(p, v)
    }
    for (const f of n.data.fields) if (f.component === L && NUMS.includes(f.path) && typeof f.value === 'number' && !memo.has(f.path)) memo.set(f.path, f.value)
    const typeLabel = doc.readText(L, 'm_Type') ?? 'Point'
    const layout = this.lightLayout(doc, memo)
    const tpl = this.fx.templates?.[layout]
    const [type] = layout.split('|')
    const color = doc.colors.get(`${L}|m_Color`)
    const on = doc.readToggle(L, 'm_Enabled')
    if (tpl && (old as TiSection & { layout?: string }).layout !== layout) {
      const src = new InspectorDoc(n.data.path, tpl, this.fx.styles, this.ctxFor(n), this.inspectorWidth)
      const got = doc.adopt(src, L, this.fx.textures)
      if (got) {
        ;(got.sec as TiSection & { layout?: string }).layout = layout
        doc.full[doc.full.indexOf(old)] = got.sec
        doc.folds = [...doc.folds.filter((f) => f.section !== L), ...got.folds]
        for (const f of got.folds) doc.closed.delete(f.key)
        for (const k of got.closed) doc.closed.add(k)
        doc.writeText(L, 'm_Type', typeLabel)
        if (type === 'Area') memo.set('m_Lightmapping', 'Baked')
        for (const [p, v] of memo) {
          if (typeof v === 'number') doc.write(L, p, v)
          else doc.writeText(L, p, v)
        }
        if (color) doc.writeColor(L, 'm_Color', color)
        if (on != null) doc.writeToggle(L, 'm_Enabled', on)
      }
    }
    const c = color ?? { r: 1, g: 1, b: 1, a: 1 }
    const num = (p: string, d: number): number => doc.read(L, p) ?? (memo.get(p) as number | undefined) ?? d
    const shadows = (doc.readText(L, 'm_Shadows.m_Type') ?? 'No Shadows') !== 'No Shadows'
    this.scene.setLight(n, type, { color: new Color().setRGB(c.r, c.g, c.b, 'srgb'), intensity: num('m_Intensity', 1), range: num('m_Range', n.data.light?.range ?? 10), angle: num('m_SpotAngle', n.data.light?.spotAngle ?? 30), shadows })
    this.dirty = true
    this.pushInspector()
  }

  private writeBack(n: SimNode, doc: InspectorDoc, c: Change, v: unknown): Change | null {
    switch (c.kind) {
      case 'number': {
        const integer = doc.section(c.section)?.props?.find((p) => p.p === c.prop)?.k === 'Integer'
        doc.write(c.section, c.prop, v as number, integer)
        return { ...c, value: v as number, final: true }
      }
      case 'bool':
        doc.writeToggle(c.section, c.prop, v as boolean)
        if (c.section === 'GameObject' || c.prop === 'm_Enabled') {
          const sec = doc.section(c.section)
          const t = sec ? (sec.draws ?? []).find((d) => d.k === 's' && doc.name(d) === 'toggle' && d.y < 22) : null
          if (t && t.k === 's') {
            if (v) t.on = 1
            else delete t.on
          }
        }
        return { ...c, value: v as boolean }
      case 'enum':
        doc.writeText(c.section, c.prop, v as string)
        return { ...c, label: v as string, index: this.enumIndex(n, c.prop, v as string) }
      case 'color':
        doc.writeColor(c.section, c.prop, v as TunerColor)
        return { ...c, value: v as TunerColor }
      case 'gradient':
        doc.writeGradient(c.section, c.prop, v as TunerGradient)
        return { ...c, value: v as TunerGradient }
      case 'curve':
        doc.writeCurve(c.section, c.prop, v as TunerCurve)
        return { ...c, value: v as TunerCurve }
      case 'object':
        doc.writeText(c.section, c.prop, v as string)
        return { ...c, name: (v as string).replace(/ \(.*\)$/, '') }
      case 'name':
        doc.writeName(v as string)
        return { ...c, value: v as string }
    }
    return null
  }

  private enumIndex(n: SimNode, prop: string, label: string): number {
    const f = n.data.fields.find((x) => x.path === prop && x.names)
    const i = f?.names?.indexOf(label) ?? -1
    if (prop === 'm_Direction') return ['X-Axis', 'Y-Axis', 'Z-Axis'].indexOf(label)
    return i
  }

  private record(n: SimNode, doc: InspectorDoc, c: Change): void {
    let before: unknown
    let after: unknown
    switch (c.kind) {
      case 'number':
        if (!c.final) return
        before = c.before
        after = c.value
        break
      case 'bool':
        before = !c.value
        after = c.value
        break
      case 'enum':
        before = c.before
        after = c.label
        break
      case 'color':
      case 'gradient':
      case 'curve':
        if (!c.final) return
        before = c.before
        after = c.value
        break
      case 'object':
        before = c.before
        after = doc.readText(c.section, c.prop) ?? c.name
        break
      case 'name':
        before = c.before
        after = c.value
        break
      default:
        return
    }
    if (JSON.stringify(before) === JSON.stringify(after)) return
    const id = n.id
    const apply = (v: unknown): void => {
      const node = this.scene.nodes.get(id)
      const d = this.docs.get(id)
      if (!node || !d) return
      const ch = this.writeBack(node, d, c, v)
      if (ch) this.applyField(node, ch)
    }
    this.push(`${'section' in c ? c.section : ''} ${'prop' in c ? c.prop : ''}`, () => apply(before), () => apply(after))
  }

  private menuAction(n: SimNode, doc: InspectorDoc, section: string, action: string): void {
    const sec = doc.section(section)
    if (!sec) return
    if (action === 'copy') {
      const values: Record<string, string> = {}
      for (const p of sec.props ?? []) {
        const v = doc.read(section, p.p)
        if (v != null) values[p.p] = String(v)
      }
      this.clipboard = { type: section, values }
      return
    }
    if (action === 'paste' && this.clipboard?.type === section) {
      const prev: Record<string, number> = {}
      for (const [p, v] of Object.entries(this.clipboard.values)) {
        prev[p] = doc.read(section, p) ?? parseFloat(v)
      }
      const next = Object.fromEntries(Object.entries(this.clipboard.values).map(([p, v]) => [p, parseFloat(v)]))
      const apply = (vals: Record<string, number>): void => {
        for (const [p, v] of Object.entries(vals)) {
          doc.write(section, p, v)
          this.applyField(n, { kind: 'number', section, prop: p, value: v, final: true })
        }
      }
      apply(next)
      this.push(`Paste ${section}`, () => apply(prev), () => apply(next))
      return
    }
    if (action === 'reset') {
      const base = new InspectorDoc(doc.path, doc.base, this.fx.styles, this.ctxFor(n), this.inspectorWidth)
      const prev: Record<string, number> = {}
      const next: Record<string, number> = {}
      for (const p of sec.props ?? []) {
        const a = doc.read(section, p.p)
        const b = base.read(section, p.p)
        if (a != null && b != null && a !== b) {
          prev[p.p] = a
          next[p.p] = b
        }
      }
      if (section === 'Transform') {
        const l = this.scene.local(n)
        const before = { lp: l.lp, lr: l.lr, ls: l.ls }
        const after = { lp: [0, 0, 0] as Vec3, lr: [0, 0, 0, 1] as Quat, ls: [1, 1, 1] as Vec3 }
        const set = (v: typeof before, e?: Vec3): void => {
          this.setTransform(n, v, e)
          this.refresh()
        }
        set(after, [0, 0, 0])
        this.push('Reset Transform', () => set(before), () => set(after, [0, 0, 0]))
        return
      }
      const apply = (vals: Record<string, number>): void => {
        for (const [p, v] of Object.entries(vals)) {
          doc.write(section, p, v)
          this.applyField(n, { kind: 'number', section, prop: p, value: v, final: true })
        }
        this.pushInspector()
      }
      apply(next)
      this.push(`Reset ${section}`, () => apply(prev), () => apply(next))
      return
    }
    if (action === 'remove') {
      const comps = n.data.components
      const col = n.colliders.find((x) => x.type === section)
      const setRemoved = (on: boolean): void => {
        if (on) doc.removed.add(section)
        else doc.removed.delete(section)
        if (col) col.enabled = !on && (doc.readToggle(section, 'm_Enabled') ?? true)
        if (section === 'MeshRenderer' && n.mesh) n.mesh.visible = !on
        if (section === 'Light' && n.light) n.light.visible = !on
        if (section === 'ParticleSystem' && n.emitter) n.emitter.mesh.visible = !on
        n.data.components = on ? comps.filter((c) => c !== section) : comps
        if (on && doc.tool === section) this.setTool(doc, null)
        this.dirty = true
        this.pushInspector()
      }
      setRemoved(true)
      this.push(`Remove ${section}`, () => setRemoved(false), () => setRemoved(true))
    }
  }

  private addComponent(n: SimNode, doc: InspectorDoc, type: string): void {
    const t = this.template(type)
    if (!t) return
    const cap = this.fx.captures[t.path]
    const sec = cap?.sections.find((s) => s.key === type)
    if (!cap || !sec) return
    const srcDoc = new InspectorDoc(t.path, cap, this.fx.styles, this.ctxFor(n), this.inspectorWidth)
    const fresh = srcDoc.full.find((s) => s.key === type)
    if (!fresh) return
    const folds = srcDoc.folds.filter((f) => f.section === type)
    const at = doc.full.findIndex((s) => s.key === 'AddComponent')
    const collider: ColliderState | null = /Collider$/.test(type)
      ? { type: type as ColliderState['type'], enabled: true, trigger: false, center: [0, 0, 0], size: [1, 1, 1], radius: 0.5, height: 2, direction: 1 }
      : null
    const insert = (): void => {
      doc.full.splice(at < 0 ? doc.full.length : at, 0, fresh)
      doc.folds.push(...folds)
      for (const f of folds) if (srcDoc.closed.has(f.key)) doc.closed.add(f.key)
      doc.removed.delete(type)
      if (collider) n.colliders.unshift(collider)
      n.data.components = [...n.data.components, type]
      if (collider) {
        this.syncCollider(n, doc)
      }
      this.dirty = true
      this.pushInspector()
    }
    const remove = (): void => {
      doc.full = doc.full.filter((s) => s !== fresh)
      doc.folds = doc.folds.filter((f) => !folds.includes(f))
      if (collider) n.colliders = n.colliders.filter((c) => c !== collider)
      n.data.components = n.data.components.filter((c) => c !== type)
      if (doc.tool === type) this.setTool(doc, null)
      this.dirty = true
      this.pushInspector()
    }
    insert()
    this.push(`Add ${type}`, remove, insert)
  }

  private setTool(doc: InspectorDoc | null, section: string | null): void {
    for (const d of this.docs.values()) if (d !== doc && d.tool) d.setTool(null)
    doc?.setTool(section)
    this.hover = null
    this.drag = null
    this.dirty = true
    this.onChange?.('tool')
  }

  private handleChange(c: Change): void {
    const i = this.inspector
    if (!i) return
    const n = this.scene.nodes.get(i.id)
    if (!n) return
    if (c.kind === 'fold' || c.kind === 'link') return
    if (c.kind === 'ping') {
      this.onChange?.('ping')
      return
    }
    if (c.kind === 'tool') {
      this.setTool(i.doc, c.on ? c.section : null)
      return
    }
    if (c.kind === 'menu') {
      this.menuAction(n, i.doc, c.section, c.action)
      return
    }
    if (c.kind === 'add') {
      this.addComponent(n, i.doc, c.type)
      return
    }
    if (this.focused && c.kind === 'number') this.docs.get(n.id)?.write(c.section, c.prop, c.value)
    if (this.focused && c.kind === 'color') this.docs.get(n.id)?.writeColor(c.section, c.prop, c.value)
    this.applyField(n, c)
    this.dirty = true
    this.record(n, i.doc, c)
    if (this.focused) this.trackOverride(n, c)
    if (c.kind === 'number' && !c.final) this.onChange?.('edit')
  }

  private handlesState(): TunerHandlesState {
    const tool = this.activeTool()
    return { tool: !!tool, editors: false, name: tool ? 'Edit Collider' : '', near: !!tool && (this.hover?.handle ?? -1) >= 0, hot: !!this.drag, used: !!this.drag }
  }

  readFocus(section: string, prop: string): number | null {
    const d = this.inspector?.doc
    if (!d) return null
    for (const p of [prop, `${prop}.scalar`]) {
      const v = d.read(section, p)
      if (typeof v === 'number') return Number(v.toFixed(3))
    }
    return null
  }

  activeTool(): { n: SimNode; doc: InspectorDoc; section: string } | null {
    const id = this.selected[0]
    const n = id ? this.scene.nodes.get(id) : null
    const doc = n ? this.docs.get(n.id) : null
    if (!n || !doc?.tool) return null
    return { n, doc, section: doc.tool }
  }

  private nearest(handles: Handle[], x: number, y: number, ev: TunerHandleEvent): number {
    if (!this.camera) return -1
    let best = -1
    let bd = 10
    for (const h of handles) {
      const p = this.scene.screenOf(h.world, this.camera)
      const sx = (p.x / this.camera.width) * ev.w
      const sy = (p.y / this.camera.height) * ev.h
      const d = Math.hypot(sx - x, sy - y)
      if (d < bd) {
        bd = d
        best = h.id
      }
    }
    return best
  }

  private paramAt(ev: TunerHandleEvent, h: Handle, center: Vector3): number {
    const cam = this.camera!
    const r = this.scene.rayFrom(cam, ev.x / Math.max(1, ev.w), ev.y / Math.max(1, ev.h))
    return rayAxisParam(r.origin, r.dir, center, h.dir)
  }

  private handlesEvent(ev: TunerHandleEvent): TunerHandlesState {
    const t = this.activeTool()
    if (!t || !this.camera) return this.handlesState()
    const col = t.n.colliders.find((c) => c.type === t.section) ?? t.n.colliders[0]
    if (!col) return this.handlesState()
    const handles = this.scene.handlesFor(t.n.id)
    if (ev.type === 'move' || ev.type === 'leave') {
      const h = ev.type === 'leave' ? -1 : this.nearest(handles, ev.x, ev.y, ev)
      if ((this.hover?.handle ?? -1) !== h) this.dirty = true
      this.hover = { handle: h, x: ev.x, y: ev.y }
      return this.handlesState()
    }
    if (ev.type === 'down') {
      const id = this.nearest(handles, ev.x, ev.y, ev)
      const h = handles.find((x) => x.id === id)
      if (!h) return this.handlesState()
      const center = h.world.clone().addScaledVector(h.dir, 0)
      const param0 = this.paramAt(ev, h, center)
      this.drag = { id: t.n.id, handle: h, center, start: structuredClone(col), param0, last: { x: ev.x, y: ev.y } }
      this.hover = { handle: h.id, x: ev.x, y: ev.y }
      this.dirty = true
      return this.handlesState()
    }
    if (ev.type === 'drag' && this.drag) {
      const p = this.paramAt(ev, this.drag.handle, this.drag.center)
      applyDrag(this.drag, col, t.n.node.matrixWorld, p, !!ev.alt)
      this.drag.last = { x: ev.x, y: ev.y }
      this.syncCollider(t.n, t.doc)
      this.pushInspector(true)
      this.dirty = true
      this.render()
      return this.handlesState()
    }
    if (ev.type === 'up' && this.drag) {
      const before = this.drag.start
      const after = structuredClone(col)
      const id = this.drag.id
      this.drag = null
      const set = (v: ColliderState): void => {
        const node = this.scene.nodes.get(id)
        const c = node?.colliders.find((x) => x.type === v.type)
        if (!node || !c) return
        Object.assign(c, structuredClone(v))
        const d = this.docs.get(id)
        if (d) this.syncCollider(node, d)
        this.dirty = true
      }
      if (JSON.stringify(before) !== JSON.stringify(after)) this.push('Edit Collider', () => set(before), () => set(after))
      this.pushInspector()
      this.dirty = true
      return this.handlesState()
    }
    return this.handlesState()
  }

  handleScreen(): { x: number; y: number } | null {
    const t = this.activeTool()
    if (!t || !this.camera || !this.drag) return null
    const h = this.scene.handlesFor(t.n.id).find((x) => x.id === this.drag!.handle.id)
    return h ? this.scene.screenOf(h.world, this.camera) : null
  }

  private surfaceCanvas(): HTMLCanvasElement | null {
    const key = tunerSurfaceKey(this.root, this.session).replace(/["\\]/g, '\\$&')
    return document.querySelector<HTMLCanvasElement>(`canvas[data-unity-session="${key}"]`)
  }

  render(): void {
    const cam = this.camera
    if (!cam || !this.visible) return
    this.dirty = false
    const target = this.surfaceCanvas()
    const t = this.activeTool()
    const hv = t ? { handles: this.scene.handlesFor(t.n.id), hot: this.hover?.handle ?? -1, active: this.drag?.handle.id ?? -1 } : null
    const out = this.scene.render(cam, this.selected, target, hv, this.camBusy && isPhoneView() ? 1.5 : 2)
    if (!out) return
    const poses = [...this.scene.nodes.values()].filter((n) => this.selected.includes(n.id) || n.id === this.watched).map((n) => this.scene.pose(n))
    const seq = ++this.seq
    emit('tuner', 'onFrame', { projectPath: this.root, meta: { session: this.session, seq, width: out.width, height: out.height, camera: cam, poses }, surface: { key: tunerSurfaceKey(this.root, this.session), surfaceId: 1, generation: 1, flipY: false } })
    if (this.frameLog && this.drag && this.camera) {
      const h = this.handleScreen()
      const pointer = this.drag.last
      const hp = h ? { x: (h.x / this.camera.width) * this.camera.width, y: h.y } : null
      let axisErr: number | null = null
      if (hp) {
        const center = this.scene.screenOf(this.drag.center, this.camera)
        const tip = this.scene.screenOf(this.drag.center.clone().add(this.drag.handle.dir), this.camera)
        const ax = { x: tip.x - center.x, y: tip.y - center.y }
        const len = Math.hypot(ax.x, ax.y) || 1
        axisErr = ((pointer.x - hp.x) * ax.x + (pointer.y - hp.y) * ax.y) / len
      }
      this.frameLog.push({ t: performance.now(), seq, pointer, handle: hp, axisErr })
    }
  }

  private loop = (now: number): void => {
    this.raf = requestAnimationFrame(this.loop)
    const dt = Math.min(0.1, (now - this.last) / 1000)
    this.last = now
    if (!this.visible || !this.camera) return
    if (this.camBusy && now - this.camAt > 180) {
      this.camBusy = false
      this.dirty = true
    }
    const moving = this.scene.step(dt)
    if (moving || this.dirty) this.render()
    if (this.particlesInfo()) this.emitParticles()
  }

  holdFocus = false
  private pendingFocus: [string[] | null, boolean, boolean] = [null, false, false]

  releaseFocus(): void {
    this.holdFocus = false
    this.scene.setFocus(...this.pendingFocus)
    this.dirty = true
  }

  setVisible(v: boolean): void {
    this.visible = v
    if (v) this.dirty = true
  }

  private applyTransform(t: TunerTransform): void {
    const items = t.items?.length ? t.items : [{ id: t.id, position: t.position, rotation: t.rotation, localScale: t.localScale }]
    for (const it of items) {
      const n = this.scene.nodes.get(it.id)
      if (!n) continue
      const l = this.scene.local(n)
      const before = this.dragStart.get(n.id) ?? { lp: l.lp, lr: l.lr, ls: l.ls }
      if (!this.dragStart.has(n.id)) this.dragStart.set(n.id, before)
      this.scene.setWorld(it.id, it.position, it.rotation, it.localScale)
      if (it.rotation) this.euler.set(n.id, quatToEuler(this.scene.local(n).lr, this.euler.get(n.id)))
      if (t.final) {
        this.dragStart.delete(n.id)
        const a = this.scene.local(n)
        const after = { lp: a.lp, lr: a.lr, ls: a.ls }
        const id = n.id
        const set = (v: typeof after): void => {
          const node = this.scene.nodes.get(id)
          if (node) this.setTransform(node, v)
        }
        if (JSON.stringify(before) !== JSON.stringify(after)) this.push('Move', () => set(before), () => set(after))
      }
      this.recordTransform(n, !t.final, handlePrefs.mode === 'rotate' ? 'lr' : handlePrefs.mode === 'scale' ? 'ls' : 'lp')
      const i = this.inspector
      if (i && i.id === n.id && this.syncTransform(n, i.doc)) this.pushInspector()
    }
    this.dirty = true
    this.emitLive()
  }

  private snapshot(): string {
    const nodes = [...this.scene.nodes.values()].map((n) => ({ id: n.id, l: this.scene.local(n), active: n.active, colliders: n.colliders, mesh: n.meshName, material: n.data.material, rendererOn: n.rendererOn, lightOn: n.lightOn, name: n.data.name, parent: n.parent?.id ?? null, components: n.data.components }))
    const docs = [...this.docs.entries()].map(([id, d]) => ({ id, full: d.full, folds: d.folds, closed: [...d.closed], removed: [...d.removed], colors: [...d.colors], gradients: [...d.gradients], curves: [...d.curves], extra: [...d.extra], styles: d.addedStyles }))
    return JSON.stringify({ nodes, docs, members: this.members, euler: [...this.euler] })
  }

  private restore(json: string | null): void {
    if (!json) {
      this.rebuild()
      return
    }
    const s = JSON.parse(json)
    this.rebuild()
    for (const v of s.nodes) {
      const n = this.scene.nodes.get(v.id)
      if (!n) continue
      this.scene.setLocal(n.id, v.l)
      this.scene.setActive(n.id, v.active)
      n.colliders = v.colliders
      if (v.mesh !== n.meshName) this.scene.setMesh(n, v.mesh)
      if (v.material && n.material && v.material !== n.data.material) {
        n.data.material = v.material
        this.scene.paint(n.material, v.material)
      }
      n.data.name = v.name
      n.data.components = v.components
    }
    this.members = s.members
    this.euler = new Map(s.euler)
    for (const v of s.docs) {
      const n = this.scene.nodes.get(v.id)
      if (!n) continue
      const d = this.doc(n)
      if (!d) continue
      d.full = v.full
      d.folds = v.folds
      d.closed = new Set(v.closed)
      d.removed = new Set(v.removed)
      d.colors = new Map(v.colors)
      d.gradients = new Map(v.gradients)
      d.curves = new Map(v.curves)
      d.extra = new Map(v.extra)
      d.addStyles(v.styles ?? [])
      if (n.emitter) n.emitter.params = this.psParams(n)
      const t = d.readText('Light', 'm_Type')
      if (t && t !== n.data.light?.type) this.swapLight(n)
    }
    this.scene.reindex()
  }

  private rebuild(): void {
    const selected = this.selected
    this.scene.dispose()
    this.members = structuredClone(this.fx.start.data.members ?? [])
    this.scene = new ArenaScene(structuredClone(this.fx.scene), this.members)
    this.euler.clear()
    this.docs.clear()
    this.lightMemo.clear()
    for (const n of this.scene.nodes.values()) {
      this.euler.set(n.id, n.data.euler.map(wrap180) as Vec3)
      if (n.data.components.includes('ParticleSystem')) this.scene.addEmitter(n, this.psParams(n))
    }
    this.selected = selected.filter((id) => this.scene.nodes.has(id))
    this.dirty = true
  }

  private reopenInspector(): void {
    const i = this.inspector
    if (!i) return
    const n = this.scene.nodes.get(i.id)
    const full = n ? this.doc(n) : null
    const doc = n && full && i.focus && this.focused ? this.focusDoc(n) : full
    if (!n || !doc) return
    this.syncTransform(n, doc)
    this.inspector = { ...i, doc }
    i.seq++
    emit('tunerInspector', 'onCapture', { projectPath: this.root, session: i.session, capture: doc.full_(i.session, this.fx.textures, i.seq) })
  }

  save(): void {
    this.saved = this.snapshot()
    this.unsaved = false
    this.undoStack = []
    this.redoStack = []
    this.emitState()
    this.onChange?.('save')
  }

  discard(): void {
    this.restore(this.saved)
    this.focusDocs.clear()
    if (this.overrides.length) this.overrides = []
    this.unsaved = false
    this.undoStack = []
    this.redoStack = []
    this.anim.reset()
    this.reopenInspector()
    this.emitState()
    this.emitLive()
    this.onChange?.('discard')
  }

  reset(): void {
    this.saved = null
    this.discard()
  }

  get isUnsaved(): boolean {
    return this.unsaved
  }

  private newId(): string {
    return `m${(this.nextId++).toString(16).padStart(6, '0')}d0`
  }

  private uniqueName(base: string, parent: SimNode | null): string {
    const sib = new Set((parent ? parent.children : [...this.scene.nodes.values()].filter((n) => !n.parent)).map((n) => n.data.name))
    if (!sib.has(base)) return base
    for (let i = 1; ; i++) if (!sib.has(`${base} (${i})`)) return `${base} (${i})`
  }

  private cloneNode(src: SimNode, parent: SimNode | null, name: string, made: SimNode[]): SimNode {
    const id = this.newId()
    const data: SceneObjectData & { template?: string } = { ...structuredClone(src.data), name, template: (src.data as { template?: string }).template ?? src.data.path }
    const n = this.scene.make(data, id)
    n.colliders = structuredClone(src.colliders)
    this.scene.attach(n, parent)
    const l = this.scene.local(src)
    this.scene.setLocal(n.id, l)
    this.euler.set(n.id, [...(this.euler.get(src.id) ?? [0, 0, 0])] as Vec3)
    if (src.emitter) this.scene.addEmitter(n, { ...src.emitter.params })
    const sd = this.docs.get(src.id)
    const doc = this.doc(n)
    if (sd && doc) {
      doc.full = structuredClone(sd.full)
      doc.folds = structuredClone(sd.folds)
      doc.closed = new Set(sd.closed)
      doc.removed = new Set(sd.removed)
      doc.colors = new Map(sd.colors)
      doc.gradients = new Map(sd.gradients)
      doc.curves = new Map(sd.curves)
    }
    doc?.writeName(name)
    made.push(n)
    for (const c of src.children) this.cloneNode(c, n, c.data.name, made)
    return n
  }

  private memberOf(n: SimNode): TunerMember {
    const siblings = n.parent ? n.parent.children : [...this.scene.nodes.values()].filter((x) => !x.parent)
    return { id: n.id, parent: n.parent ? n.parent.id : `scene:${SCENE}`, name: n.data.name, index: siblings.indexOf(n), active: n.active, icon: n.mesh ? 'UnityEngine.MeshFilter' : n.light ? 'UnityEngine.Light' : n.emitter ? 'UnityEngine.ParticleSystem' : 'UnityEngine.Transform' }
  }

  private syncMembers(): void {
    const order = new Map<string, number>()
    const out: TunerMember[] = []
    const walk = (list: SimNode[]): void => {
      list.forEach((n, i) => {
        order.set(n.id, i)
        const old = this.members.find((m) => m.id === n.id)
        out.push({ ...(old ?? this.memberOf(n)), name: n.data.name, parent: n.parent ? n.parent.id : `scene:${SCENE}`, index: i, active: n.active })
        walk(n.children)
      })
    }
    const top = this.members.filter((m) => m.parent.startsWith('scene:')).map((m) => this.scene.nodes.get(m.id)).filter((n): n is SimNode => !!n && !n.parent)
    const extra = [...this.scene.nodes.values()].filter((n) => !n.parent && !top.includes(n))
    walk([...top, ...extra])
    this.members = out
    this.scene.reindex()
  }

  private hierarchy(req: TunerHierarchyRequest): { ok: true; data: { ids: string[]; add: { id: string; path: string; scene: string }[] } } | { ok: false; error: string } {
    const ids = req.ids ?? []
    if (req.op === 'rename') {
      const n = this.scene.nodes.get(ids[0])
      const name = (req.name ?? '').trim()
      if (!n || !name) return { ok: false, error: 'Nothing to rename' }
      const before = n.data.name
      const set = (v: string): void => {
        const node = this.scene.nodes.get(n.id)
        if (!node) return
        node.data.name = v
        this.docs.get(n.id)?.writeName(v)
        this.syncMembers()
        this.emitState()
        if (this.inspector?.id === n.id) this.pushInspector()
      }
      set(name)
      this.push('Rename', () => set(before), () => set(name))
      return { ok: true, data: { ids: [n.id], add: [] } }
    }
    if (req.op === 'delete') {
      const nodes = ids.map((id) => this.scene.nodes.get(id)).filter((n): n is SimNode => !!n)
      const saved = nodes.map((n) => ({ n, parent: n.parent, index: n.parent ? n.parent.children.indexOf(n) : -1, subtree: this.subtree(n) }))
      const del = (): void => {
        for (const s of saved) this.scene.remove(s.n)
        this.selected = this.selected.filter((id) => this.scene.nodes.has(id))
        this.syncMembers()
        this.emitState()
        this.dirty = true
      }
      const back = (): void => {
        for (const s of saved) {
          this.scene.attach(s.n, s.parent, s.index)
          for (const c of s.subtree) {
            this.scene.nodes.set(c.id, c)
            this.scene.restoreEmitter(c)
          }
        }
        this.scene.reindex()
        this.syncMembers()
        this.emitState()
        this.dirty = true
      }
      del()
      this.push('Delete', back, del)
      return { ok: true, data: { ids: [], add: [] } }
    }
    if (req.op === 'duplicate' || req.op === 'create') {
      const made: SimNode[] = []
      if (req.op === 'duplicate') {
        for (const id of ids) {
          const src = this.scene.nodes.get(id)
          if (src) this.cloneNode(src, src.parent, this.uniqueName(src.data.name, src.parent), made)
        }
      } else {
        const parent = req.parent ? (this.scene.nodes.get(req.parent) ?? null) : null
        const prim = req.primitive ?? 'empty'
        const src: Record<string, string> = { empty: 'Lights', cube: 'Room/Walls/Niche L/Pedestal', sphere: 'Room/Walls/Niche L/Statue/Mesh', capsule: 'Room/Walls/Niche L/Statue/Mesh', cylinder: 'Room/Walls/Niche L/Arch', plane: 'Room/Walls/Niche L/Recess', quad: 'Room/Walls/Niche L/Recess', camera: 'Main Camera', light: 'Lights/Skylight', pointlight: 'Lights/Floor Glow', spotlight: 'Lights/Floor Glow' }
        const names: Record<string, string> = { empty: 'GameObject', camera: 'Camera', light: 'Directional Light', pointlight: 'Point Light', spotlight: 'Spot Light' }
        const solid = ['cube', 'sphere', 'capsule', 'cylinder', 'plane', 'quad'].includes(prim)
        const tpl = this.scene.byPath.get(src[prim]) ?? null
        if (!tpl) return { ok: false, error: 'Not part of the demo' }
        const name = this.uniqueName(names[prim] ?? prim[0].toUpperCase() + prim.slice(1), parent)
        const shell: SimNode = { ...tpl, children: [] }
        const n = this.cloneNode(shell, parent, name, made)
        const mesh = solid ? prim[0].toUpperCase() + prim.slice(1) : null
        if (mesh) this.scene.setMesh(n, mesh)
        const lift = prim === 'empty' ? 0 : solid ? 0.5 : 2
        this.scene.setLocal(n.id, { lp: parent ? [0, 0, 0] : [0, lift, -2.2], lr: [0, 0, 0, 1], ls: solid ? [0.6, 0.6, 0.6] : [1, 1, 1] })
        this.euler.set(n.id, [0, 0, 0])
        const d = this.docs.get(n.id)
        if (d && mesh) d.writeText('MeshFilter', 'm_Mesh', mesh)
        if (d && prim === 'spotlight') {
          d.writeText('Light', 'm_Type', 'Spot')
          this.swapLight(n)
        }
        if (d) {
          d.removed.add('Rigidbody')
          this.syncTransform(n, d)
        }
        n.data.components = n.data.components.filter((c) => c !== 'Rigidbody')
      }
      if (!made.length) return { ok: false, error: 'Nothing to copy' }
      const top = made.filter((n) => !made.includes(n.parent as SimNode))
      const removeAll = (): void => {
        for (const n of top) this.scene.remove(n)
        this.selected = this.selected.filter((id) => this.scene.nodes.has(id))
        this.syncMembers()
        this.emitState()
        this.dirty = true
      }
      const addAll = (): void => {
        for (const n of top) {
          const p = n.parent
          this.scene.attach(n, p && this.scene.nodes.has(p.id) ? p : null)
        }
        for (const n of made) {
          this.scene.nodes.set(n.id, n)
          this.scene.restoreEmitter(n)
        }
        this.scene.reindex()
        this.syncMembers()
        this.emitState()
        this.dirty = true
      }
      this.syncMembers()
      this.emitState()
      this.dirty = true
      this.push(req.op === 'create' ? 'Create' : 'Duplicate', removeAll, addAll)
      return { ok: true, data: { ids: top.map((n) => n.id), add: [] } }
    }
    if (req.op === 'move') {
      const parent = req.parent && !req.parent.startsWith('scene:') ? (this.scene.nodes.get(req.parent) ?? null) : null
      const nodes = ids.map((id) => this.scene.nodes.get(id)).filter((n): n is SimNode => !!n)
      for (const n of nodes) for (let p: SimNode | null = parent; p; p = p.parent) if (p === n) return { ok: false, error: 'Cannot move an object into its own child' }
      const prev = nodes.map((n) => ({ n, parent: n.parent, index: n.parent ? n.parent.children.indexOf(n) : -1 }))
      const place = (n: SimNode, p: SimNode | null, index: number): void => {
        const pos = this.scene.worldPos(n)
        const rot = this.scene.worldRot(n)
        const lossy = new Vector3()
        n.node.getWorldScale(lossy)
        this.scene.attach(n, p, index)
        this.scene.setWorld(n.id, pos, rot)
        const ps = new Vector3(1, 1, 1)
        p?.node.getWorldScale(ps)
        this.scene.setLocal(n.id, { ls: [lossy.x / (ps.x || 1), lossy.y / (ps.y || 1), lossy.z / (ps.z || 1)] })
        this.euler.set(n.id, quatToEuler(this.scene.local(n).lr))
        const d = this.docs.get(n.id)
        if (d) this.syncTransform(n, d)
      }
      const indexIn = (p: SimNode | null): number => {
        const list = p ? p.children : [...this.scene.nodes.values()].filter((x) => !x.parent)
        const ref = req.before ?? req.after
        const i = ref ? list.findIndex((x) => x.id === ref) : -1
        return i < 0 ? -1 : req.after ? i + 1 : i
      }
      const go = (): void => {
        for (const n of nodes) place(n, parent, indexIn(parent))
        this.syncMembers()
        this.emitState()
        this.dirty = true
      }
      const back = (): void => {
        for (const s of prev) place(s.n, s.parent, s.index)
        this.syncMembers()
        this.emitState()
        this.dirty = true
      }
      go()
      this.push('Move', back, go)
      return { ok: true, data: { ids: nodes.map((n) => n.id), add: [] } }
    }
    return { ok: false, error: 'Not part of the demo' }
  }

  private subtree(n: SimNode): SimNode[] {
    const out: SimNode[] = []
    const walk = (x: SimNode): void => {
      out.push(x)
      x.children.forEach(walk)
    }
    walk(n)
    return out
  }

  private annotations: TunerAnnotations = {
    use3dIcons: true,
    iconSize: 0.5,
    fadeGizmos: false,
    fadeGizmoSize: 0.5,
    selectionOutline: true,
    selectionWire: false,
    lodLabels: true,
    canHideLodLabels: true,
    terrainWarnings: true,
    lightProbes: { supported: false, mode: 0, weights: false, occlusion: false, invalidCells: false },
    items: [],
    recent: [],
    thumbs: {}
  }

  private annotate(req: TunerAnnotationsRequest): TunerAnnotations {
    if (req.op === 'general') {
      const a = this.annotations
      const v = req.value ?? 0
      const on = !!req.on
      if (req.key === 'iconSize') a.iconSize = v
      else if (req.key === 'fadeGizmoSize') a.fadeGizmoSize = v
      else if (req.key === 'probeMode') a.lightProbes.mode = v
      else if (req.key === 'probeWeights') a.lightProbes.weights = on
      else if (req.key === 'probeOcclusion') a.lightProbes.occlusion = on
      else if (req.key === 'probeInvalid') a.lightProbes.invalidCells = on
      else a[req.key] = on
      this.scene.selectionOutline = a.selectionOutline
      this.scene.selectionWire = a.selectionWire
      this.dirty = true
    }
    return { ...this.annotations, lightProbes: { ...this.annotations.lightProbes } }
  }

  private world(): { observed: WorldObserved; desired: WorldDesired } {
    const id = 'primary'
    return {
      observed: {
        version: 1,
        project: { path: this.root, isUnityProject: true, editorVersion: '6000.6.0f1' },
        scenes: [SCENE_PATH],
        instances: {
          [id]: {
            id,
            role: 'primary',
            playerIndex: 0,
            lifecycle: 'editmode',
            compile: 'idle',
            compileError: null,
            error: null,
            warning: null,
            progressLabel: '',
            progressPct: 0,
            scene: SCENE_PATH,
            refreshGen: 0,
            sceneGen: 0,
            playGen: 0,
            pauseGen: 0,
            assetSeq: 0,
            paused: false,
            hotReloadActive: false,
            saving: false,
            sceneDirty: false,
            dirtyScenes: '',
            connected: true,
            alive: true,
            reachable: true,
            unityMode: 'headless-graphics',
            fps: 60,
            ping: 1
          }
        }
      },
      desired: { version: 1, playerCount: 1, stopped: false, instances: { [id]: { ...defaultInstanceDesired('primary'), scene: SCENE_PATH } } }
    }
  }

  install(): () => void {
    const r = this.root
    this.offs.push(
      handle('tuner', 'listViews', (p) => (this.mine(p) ? Promise.resolve([...this.fx.listViews.filter((v) => v.name === VIEW), ...(this.fx.focus ? [this.fx.focus.view] : [])]) : PASS)),
      handle('tuner', 'watchViews', (p) => (this.mine(p) ? Promise.resolve() : PASS)),
      handle('tuner', 'unwatchViews', (p) => (this.mine(p) ? Promise.resolve() : PASS)),
      handle('tuner', 'start', (p, _s, view) => {
        if (!this.mine(p)) return PASS
        const next = typeof view === 'string' ? view : VIEW
        if (next !== this.viewName) {
          this.viewName = next
          this.overrides = []
          this.focusDocs.clear()
          this.onView?.(next)
        }
        this.sentClip = -999
        setTimeout(() => this.anim.request({ op: 'model' }), 0)
        return Promise.resolve({ ok: true as const, data: this.state() })
      }),
      handle('tuner', 'refresh', (p) => (this.mine(p) ? Promise.resolve({ ok: true as const, data: this.state() }) : PASS)),
      handle('tuner', 'canvasView', (p) => (this.mine(p) ? Promise.resolve({ ok: true as const, data: null }) : PASS)),
      handle('tuner', 'stop', (p) => (this.mine(p) ? Promise.resolve() : PASS)),
      handle('tuner', 'open', (p, _s, target) => {
        if (!this.mine(p)) return PASS
        const n = this.scene.byPath.get(target.path)
        return Promise.resolve(n ? { ok: true as const, data: { id: n.id, created: false, state: this.state() } } : { ok: false as const, error: 'Not found' })
      }),
      handle('tuner', 'close', (p) => (this.mine(p) ? Promise.resolve({ ok: true as const, data: this.state() }) : PASS)),
      handle('tuner', 'camera', (p, _s, cam) => {
        if (!this.mine(p)) return PASS
        this.camera = cam
        this.camAt = performance.now()
        this.camBusy = true
        this.dirty = true
      }),
      handle('tuner', 'surface', (p) => {
        if (!this.mine(p)) return PASS
        this.dirty = true
      }),
      handle('tuner', 'dropSurface', (p) => (this.mine(p) ? undefined : PASS)),
      handle('tuner', 'theme', (p, _s, theme: TunerTheme) => {
        if (!this.mine(p)) return PASS
        this.scene.setTheme(theme.outline, theme.outlineChild)
        this.dirty = true
      }),
      handle('tuner', 'sceneSettings', (p, _s, settings) => {
        if (!this.mine(p)) return PASS
        const g = (settings as { gizmos?: boolean }).gizmos
        if (typeof g === 'boolean') this.scene.showGizmos = g
        const grid = (settings as { grid?: boolean }).grid
        if (typeof grid === 'boolean') this.scene.showGrid = grid
        const lit = (settings as { lighting?: boolean }).lighting
        if (typeof lit === 'boolean') this.scene.showLighting = lit
        const fx = (settings as { effects?: { skybox?: boolean; fog?: boolean; particles?: boolean } }).effects
        if (fx) this.scene.effects = { skybox: fx.skybox !== false, fog: fx.fog !== false, particles: fx.particles !== false }
        this.dirty = true
      }),
      handle('tuner', 'visibility', (p, _s, v) => {
        if (!this.mine(p)) return PASS
        this.setVisible(v)
      }),
      handle('tuner', 'sceneSelection', (p, _s, sel: TunerSceneSelection | null) => {
        if (!this.mine(p)) return PASS
        const next = sel ? (sel.ids?.length ? sel.ids : sel.id ? [sel.id] : []) : []
        if (next[0] !== this.selected[0]) {
          const t = this.activeTool()
          if (t) this.setTool(t.doc, null)
        }
        this.selected = next
        this.pendingFocus = [sel?.focusOn && sel.focus ? sel.focus : null, !!sel?.focusTree, !sel?.context]
        if (!this.holdFocus) this.scene.setFocus(...this.pendingFocus)
        this.dirty = true
        this.emitParticles(true)
        this.onChange?.('select')
      }),
      handle('tuner', 'mirror', (m) => {
        if (!m || !this.mine(m.projectPath)) return PASS
        if (!m.ask || this.mirrored) return
        this.mirrored = true
        const ids = [...this.selected]
        setTimeout(() => emit('tuner', 'onMirror', { projectPath: m.projectPath, session: m.session, from: 'landing-desktop', selection: { ids, active: ids[0] ?? null } }), 0)
      }),
      handle('tuner', 'watch', (p, _s, id) => {
        if (!this.mine(p)) return PASS
        this.watched = id
        this.emitLive()
        this.emitParticles(true)
      }),
      handle('tuner', 'handles', (p, _s, req: TunerHandlesRequest) => {
        if (!this.mine(p)) return PASS
        if (req.op === 'event') return Promise.resolve({ ok: true as const, data: this.handlesEvent(req) })
        if (req.op === 'tool') {
          const t = this.activeTool()
          if (t) this.setTool(t.doc, null)
          this.pushInspector()
        }
        return Promise.resolve({ ok: true as const, data: this.handlesState() })
      }),
      handle('tuner', 'pick', (p, _s, req) => {
        if (!this.mine(p)) return PASS
        const cam = req.camera ?? this.camera
        if (!cam) return Promise.resolve({ ok: true as const, data: { hits: [], icons: {} } })
        const hits: TunerPickHit[] = this.scene.pick(cam as TunerCamera, req.x, req.y).map((n) => ({ path: n.data.path, scene: SCENE, name: n.data.name, target: n.id, owner: n.id, kind: 'mesh', icon: 'UnityEngine.MeshFilter', base: null }))
        return Promise.resolve({ ok: true as const, data: { hits, icons: {} } })
      }),
      handle('tuner', 'addObject', (p) => (this.mine(p) ? Promise.resolve({ ok: true as const, data: 0 }) : PASS)),
      handle('tuner', 'canvases', (p) => (this.mine(p) ? Promise.resolve({ ok: true as const, data: [] }) : PASS)),
      handle('tuner', 'pickRect', (p) => (this.mine(p) ? Promise.resolve({ ok: true as const, data: { ids: [] } }) : PASS)),
      handle('tuner', 'transform', (p, _s, t: TunerTransform) => {
        if (!this.mine(p)) return PASS
        this.applyTransform(t)
      }),
      handle('tuner', 'rect', (p, _s, req) => {
        if (!this.mine(p)) return PASS
        const op = (req as { op?: string }).op
        if (op === 'undo') this.undo()
        else if (op === 'redo') this.redo()
        return Promise.resolve({ ok: true as const, data: null })
      }),
      handle('tuner', 'reset', (p) => {
        if (!this.mine(p)) return PASS
        this.reset()
        return Promise.resolve({ ok: true as const, data: this.state() })
      }),
      handle('tuner', 'save', (p) => {
        if (!this.mine(p)) return PASS
        this.save()
        return Promise.resolve({ ok: true as const, data: { summary: `Saved ${SCENE_PATH}`, unsaved: { scenes: [], prefabs: [], assets: [] } } })
      }),
      handle('tuner', 'discard', (p) => {
        if (!this.mine(p)) return PASS
        this.discard()
        return Promise.resolve({ ok: true as const, data: { summary: 'Discarded', unsaved: { scenes: [], prefabs: [], assets: [] } } })
      }),
      handle('tuner', 'particles', (p, _s, op, speed) => {
        if (!this.mine(p)) return PASS
        const id = this.watched ?? this.selected[0]
        const e = id ? this.scene.nodes.get(id)?.emitter : null
        if (e) {
          if (op === 'play') e.playing = true
          if (op === 'pause') e.playing = false
          if (op === 'restart') e.restart()
          if (op === 'stop') e.stop()
          if (op === 'speed' && typeof speed === 'number') {
            this.particleSpeed = speed
            for (const n of this.scene.nodes.values()) if (n.emitter) n.emitter.speed = speed
          }
        }
        this.emitParticles(true)
        return Promise.resolve({ ok: true as const, data: null })
      }),
      handle('tuner', 'hierarchy', (p, _s, req) => {
        if (!this.mine(p)) return PASS
        const r = this.hierarchy(req)
        return Promise.resolve(r.ok ? { ok: true as const, data: { ...r.data, state: this.state() } } : r)
      }),
      handle('tunerInspector', 'open', (p, s, target: TunerInspectTarget) => {
        if (!this.mine(p)) return PASS
        const n = this.scene.byPath.get(target.path)
        if (n && !this.docs.get(n.id)) this.doc(n)
        const focus = this.focused && target.kind === 'object' && !!target.components
        const doc = n ? (focus ? this.focusDoc(n) : this.doc(n)) : null
        if (!doc || !n) return Promise.resolve({ ok: false, error: 'Not part of the demo' })
        doc.at = target.path !== n.data.path || n.data.name !== doc.path.split('/').pop() ? { path: target.path, name: n.data.name } : null
        this.syncTransform(n, doc)
        this.inspector = { session: s, doc, id: n.id, seq: 1, focus }
        this.onChange?.('inspect')
        return Promise.resolve({ ok: true, data: doc.full_(s, this.fx.textures, 1) })
      }),
      handle('tunerInspector', 'input', (p, s, input: TunerInspectorInput) => {
        if (!this.mine(p)) return PASS
        const i = this.inspector
        this.debug?.(`input ${s} ${i?.session} ${JSON.stringify(input)}`)
        if (!i || i.session !== s) return Promise.resolve({ ok: true })
        if (input.op === 'undo' || input.op === 'redo') {
          if (input.op === 'undo') this.undo()
          else this.redo()
          i.seq++
          return Promise.resolve({ ok: true, data: i.doc.update(s, i.seq) })
        }
        const c = i.doc.input(input)
        if (c) this.handleChange(c)
        i.seq++
        const data = this.inspector?.doc.update(s, i.seq, i.doc.dragging())
        if (input.op === 'mouse' && input.type === 'down') return new Promise((ok) => setTimeout(() => ok({ ok: true, data }), 0))
        return Promise.resolve({ ok: true, data })
      }),
      handle('tunerInspector', 'capture', (p, s) => {
        if (!this.mine(p)) return PASS
        const i = this.inspector
        if (!i || i.session !== s) return Promise.resolve({ ok: false, error: 'closed' })
        return Promise.resolve({ ok: true, data: i.doc.full_(s, this.fx.textures, ++i.seq) })
      }),
      handle('tunerInspector', 'resize', (p) => (this.mine(p) ? Promise.resolve({ ok: true }) : PASS)),
      handle('tunerInspector', 'close', (p, s) => {
        if (!this.mine(p)) return PASS
        if (this.inspector?.session === s) this.inspector = null
        return Promise.resolve()
      }),
      handle('tunerPopup', 'objects', (p, q) => (this.mine(p) ? Promise.resolve(this.queryObjects(q)) : PASS)),
      handle('tuner', 'annotations', (p, _s, req) => (this.mine(p) ? Promise.resolve({ ok: true as const, data: this.annotate(req) }) : PASS)),
      handle('unity', 'getWorld', (p) => (this.mine(p) ? Promise.resolve(this.fx.world ? JSON.parse(JSON.stringify(this.fx.world).split(this.fx.root).join(r)) : this.world()) : PASS)),
      handle('unity', 'isProject', (p) => (this.mine(p) ? Promise.resolve(true) : PASS)),
      handle('unity', 'isEditorRevealed', (p) => (this.mine(p) ? Promise.resolve(false) : PASS)),
      handle('unity', 'getConsolePrefs', (p) => (this.mine(p) ? Promise.resolve(null) : PASS)),
      handle('unity', 'subscribeLog', (p) => (this.mine(p) ? Promise.resolve([]) : PASS))
    )
    const offAnim = this.anim.install()
    this.last = performance.now()
    this.raf = requestAnimationFrame(this.loop)
    return () => {
      offAnim()
      for (const off of this.offs) off()
      this.offs = []
      cancelAnimationFrame(this.raf)
      this.scene.dispose()
    }
  }
}
