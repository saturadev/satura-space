import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LEGACY_TUNER_VIEWS_DIR,
  TUNER_SCENE_VIEW,
  TUNER_VIEWS_DIR,
  isTunerViewName,
  type TunerAnimateStep,
  type TunerAssetSpec,
  type TunerButtonSpec,
  type TunerCanvas,
  type TunerCanvasMode,
  type TunerEntryTarget,
  type TunerCallStep,
  type TunerCameraSpec,
  type TunerComponentSpec,
  type TunerObjectSpec,
  type TunerOverride,
  type TunerRestore,
  type TunerResult,
  type TunerSetStep,
  type TunerSetupStep,
  type TunerStateSpec,
  type TunerUiSpec,
  type TunerView,
  type TunerViewObject,
  type Vec3
} from '@shared/tuner'
import { SSPACE_DIR, ensureSspaceForSync } from '../sspace'
import { parseTunerAnimatorSpec } from '@shared/tuner-animator'
import { debugLog } from '@shared/debug-log'

const TYPE_RE = /^[A-Za-z_][\w.+]*$/
const FIELD_RE = /^[A-Za-z_](?:[\w.[\]]| (?=[\w[]))*$/
const KEY_RE = /^([A-Za-z_][\w.+]*)(?:#(\d+))?$/
const STATE_RE = /^[A-Za-z0-9._-]{1,64}$/
const METHOD_RE = /^[A-Za-z_]\w*$/
const ASSET_RE = /^(Assets|Packages)\/[^\r\n"\\]{1,500}$/
export const TUNER_MAX_STATES = 16
const TUNER_MAX_OPENED = 512
const OPENED_ID_RE = /^u\d{1,6}$/
const CANVAS_MODES: readonly TunerCanvasMode[] = ['overlay', 'camera', 'world']

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined
}

function tunerComponentKey(type: string, index = 0): string {
  return index > 0 ? `${type}#${index}` : type
}

function parseTunerComponent(raw: unknown): TunerComponentSpec | null {
  if (typeof raw === 'string') {
    const m = KEY_RE.exec(raw.trim())
    if (!m) return null
    const index = m[2] ? Number(m[2]) : 0
    return index > 0 ? { type: m[1], index } : { type: m[1] }
  }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const type = str(o.type)
  if (!type || !TYPE_RE.test(type)) return null
  const out: TunerComponentSpec = { type }
  if (typeof o.index === 'number' && Number.isInteger(o.index) && o.index > 0) out.index = o.index
  return { ...out, ...parseTunerPropertyFilter(o) }
}

function uniqueMatching(v: unknown, re: RegExp): string[] | undefined {
  if (!Array.isArray(v)) return undefined
  return [...new Set(v.filter((f): f is string => typeof f === 'string' && re.test(f)))]
}

export function parseTunerPropertyFilter(o: Record<string, unknown>): { fields?: string[]; exclude?: string[] } {
  const fields = uniqueMatching(o.fields, FIELD_RE)
  if (fields) return { fields }
  const exclude = uniqueMatching(o.exclude, FIELD_RE)
  return exclude?.length ? { exclude } : {}
}

export function parseTunerObject(raw: unknown): TunerObjectSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const path = str(o.path)?.replace(/^\/+|\/+$/g, '')
  if (!path) return null
  const out: TunerObjectSpec = { path }
  if (Array.isArray(o.components)) {
    const components: TunerComponentSpec[] = []
    const seen = new Set<string>()
    for (const c of o.components) {
      const spec = parseTunerComponent(c)
      if (!spec) continue
      const key = tunerComponentKey(spec.type, spec.index)
      if (seen.has(key)) continue
      seen.add(key)
      components.push(spec)
    }
    out.components = components
  } else {
    const exclude = uniqueMatching(o.exclude, KEY_RE)
    if (exclude?.length) out.exclude = exclude
  }
  const scene = str(o.scene)
  const label = str(o.label)
  if (scene) out.scene = scene
  if (label) out.label = label
  if (o.children === true) out.children = true
  return out
}

function parseTunerUi(raw: unknown): TunerUiSpec | null {
  const o = typeof raw === 'string' ? { path: raw } : raw
  const spec = parseTunerObject(o)
  if (!spec) return null
  const { children: _children, ...ui } = spec
  return ui
}

export function isTunerAssetPath(v: unknown): v is string {
  return typeof v === 'string' && ASSET_RE.test(v) && !v.split('/').includes('..')
}

function parseTunerAsset(raw: unknown): TunerAssetSpec | null {
  const o = typeof raw === 'string' ? { path: raw } : raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : null
  const path = o ? str(o.path) : undefined
  if (!path || !isTunerAssetPath(path)) return null
  const label = str(o?.label)
  const out: TunerAssetSpec = label ? { path, label } : { path }
  return o ? { ...out, ...parseTunerPropertyFilter(o) } : out
}

function parseTunerButton(raw: unknown): TunerButtonSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const label = str(o.label)
  const method = str(o.method)
  if (!label || !method || !METHOD_RE.test(method)) return null
  const type = str(o.type)
  const path = str(o.path)?.replace(/^\/+|\/+$/g, '')
  const component = str(o.component)
  const asset = str(o.asset)
  const extra: Pick<TunerButtonSpec, 'tip' | 'mode' | 'step'> = {}
  const tip = str(o.tip)
  if (tip) extra.tip = tip.slice(0, 400)
  if (o.mode === 'play' || o.mode === 'edit') extra.mode = o.mode
  const step = str(o.step)
  if (step) extra.step = step.slice(0, 40)
  if (asset) return isTunerAssetPath(asset) ? { label, method, asset, ...extra } : null
  if (path && component && TYPE_RE.test(component)) {
    const out: TunerButtonSpec = { label, method, path, component }
    const scene = str(o.scene)
    if (scene) out.scene = scene
    return { ...out, ...extra }
  }
  if (type && TYPE_RE.test(type)) return { label, method, type, ...extra }
  return null
}

export function cleanTunerEntryTarget(raw: unknown): TunerEntryTarget | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.kind === 'asset') return isTunerAssetPath(o.path) ? { kind: 'asset', path: o.path } : null
  if (o.kind !== 'object') return null
  const path = str(o.path)?.replace(/^\/+|\/+$/g, '')
  if (!path || path.length > 512 || /[\r\n]/.test(path)) return null
  const scene = str(o.scene)
  return scene ? { kind: 'object', path, scene } : { kind: 'object', path }
}

function vec3(v: unknown): Vec3 | undefined {
  if (!Array.isArray(v) || v.length !== 3) return undefined
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) return undefined
  return [v[0], v[1], v[2]]
}

function parseTunerCamera(raw: unknown): TunerCameraSpec | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const position = vec3(o.position)
  const lookAt = vec3(o.lookAt)
  if (!position || !lookAt) return undefined
  if (position[0] === lookAt[0] && position[1] === lookAt[1] && position[2] === lookAt[2]) return undefined
  return { position, lookAt }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined
}

function stepValue(v: unknown): string | undefined {
  if (typeof v === 'string') return v
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number' && Number.isFinite(v)) return String(v)
  if (Array.isArray(v) && v.length > 0 && v.every((n) => typeof n === 'number' && Number.isFinite(n))) return v.join(',')
  return undefined
}

function parseTunerStep(raw: unknown): TunerSetupStep | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (o.animate && typeof o.animate === 'object') {
    const a = o.animate as Record<string, unknown>
    const path = str(a.path)?.replace(/^\/+|\/+$/g, '')
    const state = str(a.state)
    const clip = str(a.clip)
    if (!path || (!state && !clip)) return null
    const out: TunerAnimateStep = { animate: { path } }
    const scene = str(a.scene)
    if (scene) out.animate.scene = scene
    if (state) out.animate.state = state
    if (clip) out.animate.clip = clip
    const layer = num(a.layer)
    if (layer != null && Number.isInteger(layer) && layer >= 0) out.animate.layer = layer
    const time = num(a.time)
    if (time != null && time >= 0) out.animate.time = time
    const seconds = num(a.seconds)
    if (seconds != null && seconds >= 0) out.animate.seconds = seconds
    return out
  }
  if (o.call && typeof o.call === 'object') {
    const c = o.call as Record<string, unknown>
    const method = str(c.method)
    if (!method || !METHOD_RE.test(method)) return null
    const path = str(c.path)?.replace(/^\/+|\/+$/g, '')
    const component = str(c.component)
    const type = str(c.type)
    if (path && component && TYPE_RE.test(component)) {
      const out: TunerCallStep = { call: { method, path, component } }
      const scene = str(c.scene)
      if (scene) out.call.scene = scene
      return out
    }
    if (type && TYPE_RE.test(type)) return { call: { method, type } }
    return null
  }
  if (o.set && typeof o.set === 'object') {
    const t = o.set as Record<string, unknown>
    const path = str(t.path)?.replace(/^\/+|\/+$/g, '')
    const component = str(t.component)
    const field = str(t.field)
    const value = stepValue(t.value)
    if (!path || !component || !TYPE_RE.test(component) || !field || !FIELD_RE.test(field) || value == null) return null
    const out: TunerSetStep = { set: { path, component, field, value } }
    const scene = str(t.scene)
    if (scene) out.set.scene = scene
    return out
  }
  return null
}

export function parseTunerState(raw: unknown): TunerStateSpec | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const name = str(o.name)
  if (!name || !STATE_RE.test(name)) return null
  const objects: TunerObjectSpec[] = []
  for (const it of Array.isArray(o.objects) ? o.objects : []) {
    const obj = parseTunerObject(it)
    if (obj) objects.push(obj)
  }
  let pause = o.pause === true
  const setup: TunerSetupStep[] = []
  for (const it of Array.isArray(o.setup) ? o.setup : []) {
    if (it && typeof it === 'object' && (it as Record<string, unknown>).pause === true) {
      pause = true
      continue
    }
    const step = parseTunerStep(it)
    if (step) setup.push(step)
  }
  const out: TunerStateSpec = {
    name,
    label: str(o.label) ?? name,
    note: typeof o.note === 'string' ? o.note : '',
    objects,
    setup
  }
  const camera = parseTunerCamera(o.camera)
  if (camera) out.camera = camera
  if (pause) out.pause = true
  return out
}

const MAX_PREFABS = 32

function parseTunerPrefabs(v: unknown): string[] {
  const out: string[] = []
  for (const it of Array.isArray(v) ? v : []) {
    const raw = typeof it === 'string' ? it : it && typeof it === 'object' ? (it as Record<string, unknown>).path : undefined
    if (typeof raw !== 'string') continue
    const p = raw.trim().replace(/\\/g, '/')
    if (!p.startsWith('Assets/') || !/\.prefab$/i.test(p) || p.split('/').includes('..') || /[\r\n]/.test(p) || p.length > 512) continue
    if (!out.includes(p) && out.length < MAX_PREFABS) out.push(p)
  }
  return out
}

export function tunerViewHasObjects(view: TunerView): boolean {
  if (view.kind === 'prefabs') return (view.prefabs?.length ?? 0) > 0
  if (view.kind === 'scene' || view.ui || view.objects.length > 0 || view.assets.length > 0) return true
  return !!view.states?.some((s) => s.objects.length > 0)
}

function isLegacyTunerView(raw: unknown): boolean {
  if (!raw || typeof raw !== 'object') return false
  const r = raw as Record<string, unknown>
  return 'items' in r && !('objects' in r) && !('states' in r)
}

function parseTunerView(name: string, raw: unknown, updatedAt = 0): TunerView | null {
  if (!raw || typeof raw !== 'object' || isLegacyTunerView(raw)) return null
  const r = raw as Record<string, unknown>
  const objects: TunerObjectSpec[] = []
  for (const it of Array.isArray(r.objects) ? r.objects : []) {
    const obj = parseTunerObject(it)
    if (obj) objects.push(obj)
  }
  const states: TunerStateSpec[] = []
  const seen = new Set<string>()
  for (const it of Array.isArray(r.states) ? r.states : []) {
    if (states.length >= TUNER_MAX_STATES) break
    const st = parseTunerState(it)
    if (!st || seen.has(st.name)) continue
    seen.add(st.name)
    states.push(st)
  }
  const assets: TunerAssetSpec[] = []
  for (const it of Array.isArray(r.assets) ? r.assets : []) {
    const a = parseTunerAsset(it)
    if (a && !assets.some((x) => x.path === a.path)) assets.push(a)
  }
  const buttons: TunerButtonSpec[] = []
  for (const it of Array.isArray(r.buttons) ? r.buttons : []) {
    const b = parseTunerButton(it)
    if (b && !buttons.some((x) => x.label === b.label)) buttons.push(b)
  }
  const prefabs = r.kind === 'prefabs'
  const scene = r.kind === 'scene'
  const ui = prefabs || scene || r.kind === 'objects' ? null : parseTunerUi(r.ui)
  const view: TunerView = {
    name,
    title: str(r.title) ?? name,
    note: typeof r.note === 'string' ? r.note : '',
    paneKey: typeof r.paneKey === 'string' ? r.paneKey : '',
    kind: prefabs ? 'prefabs' : scene ? 'scene' : ui ? 'ui' : 'objects',
    objects: ui || scene || prefabs ? [] : objects,
    assets,
    buttons,
    updatedAt
  }
  if (ui) view.ui = ui
  if (scene && str(r.scene)) view.scene = str(r.scene)
  if (prefabs) view.prefabs = parseTunerPrefabs(r.prefabs)
  if (ui || scene || prefabs) for (const st of states) st.objects = []
  if (states.length > 0) view.states = states
  const camera = parseTunerCamera(r.camera)
  if (camera) view.camera = camera
  if (r.mode === '2d' || r.mode === '3d') view.mode = r.mode
  const animator = parseTunerAnimatorSpec(r.animator)
  if (animator) {
    view.animator = animator
    if (view.kind === 'objects' && view.objects.length === 0 && !view.states?.some((s) => s.objects.length > 0))
      view.objects = [{ path: animator.path }]
  }
  return view
}

const MAX_OVERRIDES = 2000
const OVERRIDE_KEYS = ['state', 'id', 'path', 'component', 'field', 'before', 'after', 'beforeRaw', 'afterRaw'] as const

export function cleanTunerRestore(raw: unknown): TunerRestore | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const overrides: TunerOverride[] = []
  for (const it of Array.isArray(r.overrides) ? r.overrides : []) {
    if (overrides.length >= MAX_OVERRIDES) break
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    if (!OVERRIDE_KEYS.every((k) => typeof o[k] === 'string')) continue
    const clean = Object.fromEntries(OVERRIDE_KEYS.map((k) => [k, o[k] as string])) as unknown as TunerOverride
    if (!clean.beforeRaw || !clean.afterRaw || !clean.field || !clean.component) continue
    overrides.push(clean)
  }
  const out: TunerRestore = { overrides }
  if (typeof r.activeState === 'string' && STATE_RE.test(r.activeState)) out.activeState = r.activeState
  if (Array.isArray(r.opened)) {
    const opened: TunerEntryTarget[] = []
    for (const it of r.opened) {
      if (opened.length >= TUNER_MAX_OPENED) break
      const t = cleanTunerEntryTarget(it)
      if (!t) continue
      const o = it as Record<string, unknown>
      if (t.kind === 'object' && typeof o.id === 'string' && OPENED_ID_RE.test(o.id)) t.id = o.id
      if (t.kind === 'object' && o.ghost === true) t.ghost = true
      opened.push(t)
    }
    if (opened.length > 0) out.opened = opened
  }
  return out
}

export function engineSetupStep(step: TunerSetupStep): Record<string, unknown> {
  if ('animate' in step) {
    const a = step.animate
    return { animate: { ...a, layer: a.layer ?? -1, time: a.time ?? -1, seconds: a.seconds ?? -1 } }
  }
  return { ...step }
}

function engineFilter<T extends { fields?: string[] }>(c: T): T & { hasFields?: true } {
  return c.fields ? { ...c, hasFields: true } : c
}

export function engineObject(o: TunerObjectSpec): Record<string, unknown> {
  return o.components ? { ...o, components: o.components.map(engineFilter) } : { ...o, all: true }
}

function tunerViewObjects(view: TunerView): TunerObjectSpec[] {
  return view.ui ? [{ ...view.ui, children: true }] : view.objects
}

export function tunerStartArgs(
  session: string,
  view: TunerView,
  restore: TunerRestore | null
): Record<string, unknown> {
  const args: Record<string, unknown> = { session, kind: view.kind, objects: tunerViewObjects(view).map(engineObject) }
  if (view.ui) args.ui = view.ui.scene ? { path: view.ui.path, scene: view.ui.scene } : { path: view.ui.path }
  if (view.kind === 'scene' && view.scene) args.scene = view.scene
  if (view.kind === 'prefabs') args.prefabs = view.prefabs ?? []
  if (view.camera) args.camera = view.camera
  if (view.states?.length)
    args.states = view.states.map((st) => ({
      ...st,
      objects: st.objects.map(engineObject),
      pause: st.pause === true,
      setup: st.setup.map(engineSetupStep)
    }))
  if (view.assets.length) args.assets = view.assets.map(engineFilter)
  if (view.animator) args.animator = view.animator
  if (restore?.activeState) args.activeState = restore.activeState
  if (restore?.overrides.length) args.overrides = restore.overrides
  if (restore?.opened?.length) args.opened = restore.opened
  return args
}

export function tunerViewsDir(projectPath: string): string {
  return join(projectPath, SSPACE_DIR, TUNER_VIEWS_DIR)
}

function tunerCanvasViewNames(names: readonly string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => {
    const slug = name.toLowerCase().replace(/[^a-z0-9._]+/g, '-').replace(/^[-._]+|[-._]+$/g, '') || 'canvas'
    for (let n = 1; ; n++) {
      const suffix = n === 1 ? '' : `-${n}`
      const view = `canvas-${slug.slice(0, 57 - suffix.length).replace(/[-._]+$/, '')}${suffix}`
      if (used.has(view)) continue
      used.add(view)
      return view
    }
  })
}

function hierarchyPath(v: unknown): string | undefined {
  return str(v)?.replace(/^\/+|\/+$/g, '') || undefined
}

export function parseTunerCanvases(raw: unknown): TunerCanvas[] {
  const list: Omit<TunerCanvas, 'view'>[] = []
  for (const it of Array.isArray(raw) ? raw : []) {
    if (!it || typeof it !== 'object') continue
    const o = it as Record<string, unknown>
    const name = str(o.name)
    const path = hierarchyPath(o.path)
    if (!name || !path) continue
    const mode = CANVAS_MODES.find((m) => m === o.mode) ?? 'overlay'
    list.push({ name, path, scene: str(o.scene) ?? '', mode })
  }
  const views = tunerCanvasViewNames(list.map((c) => c.name))
  return list.map((c, i) => ({ ...c, view: views[i] }))
}

function tunerQuickViewFile(raw: unknown): { name: string; json: Record<string, unknown> } | null {
  if (!raw || typeof raw !== 'object') return null
  const q = raw as Record<string, unknown>
  if (q.kind === 'scene') return { name: TUNER_SCENE_VIEW, json: { kind: 'scene', title: 'Whole scene' } }
  if (q.kind !== 'canvas' || !q.canvas || typeof q.canvas !== 'object') return null
  const c = q.canvas as Record<string, unknown>
  const title = str(c.name)
  const path = hierarchyPath(c.path)
  const view = typeof c.view === 'string' && c.view.startsWith('canvas-') && isTunerViewName(c.view) ? c.view : null
  if (!title || !path || !view) return null
  const scene = str(c.scene)
  return { name: view, json: { kind: 'ui', title, ui: scene ? { path, scene } : { path } } }
}

function matchCase(dir: string, file: string): void {
  const names = readdirSync(dir)
  if (names.includes(file)) return
  const other = names.find((n) => n.toLowerCase() === file.toLowerCase())
  if (!other) return
  const a = statSync(join(dir, other), { throwIfNoEntry: false })
  const b = statSync(join(dir, file), { throwIfNoEntry: false })
  if (a && b && a.ino === b.ino && a.dev === b.dev) renameSync(join(dir, other), join(dir, file))
}

export function writeTunerViewFile(projectPath: string, name: string, json: unknown): void {
  const dir = tunerViewsDir(projectPath)
  const tmp = join(dir, `.${name}.${process.pid}.${Date.now()}.tmp`)
  ensureSspaceForSync(dir)
  mkdirSync(dir, { recursive: true })
  try {
    writeFileSync(tmp, JSON.stringify(json, null, 2), 'utf8')
    matchCase(dir, `${name}.json`)
    renameSync(tmp, join(dir, `${name}.json`))
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
    }
    throw e
  }
}

export function writeTunerQuickView(projectPath: string, quick: unknown): TunerResult<string> {
  const file = tunerQuickViewFile(quick)
  if (!file) return { ok: false, error: 'Invalid quick view' }
  try {
    writeTunerViewFile(projectPath, file.name, file.json)
  } catch (e) {
    return { ok: false, error: `Could not write the view: ${(e as Error).message}` }
  }
  return { ok: true, data: file.name }
}

function addTunerViewObjectJson(raw: unknown, obj: TunerViewObject): { json: Record<string, unknown>; index: number } | string {
  if (!raw || typeof raw !== 'object' || isLegacyTunerView(raw)) return 'The view file is not a Tuner view'
  const r = { ...(raw as Record<string, unknown>) }
  if (r.kind === 'scene') return 'A scene Tuner already shows every object in its scene'
  if (r.kind === 'prefabs') return "A prefab Tuner shows prefab assets and can't take scene objects"
  if (r.kind !== 'objects' && r.ui != null) return "A UI Tuner shows one canvas subtree and can't take other objects"
  const path = hierarchyPath(obj?.path)
  if (!path || path.length > 512 || /[\r\n]/.test(path)) return 'Invalid object path'
  const scene = str(obj.scene)
  const objects = Array.isArray(r.objects) ? [...r.objects] : []
  const animator = objects.length === 0 ? parseTunerAnimatorSpec(r.animator) : null
  if (animator) objects.push({ path: animator.path })
  const at = objects.findIndex((o) => {
    const p = o && typeof o === 'object' ? hierarchyPath((o as Record<string, unknown>).path) : undefined
    const sc = o && typeof o === 'object' ? str((o as Record<string, unknown>).scene) : undefined
    return p === path && (sc ?? '') === (scene ?? '')
  })
  if (at >= 0) return { json: r, index: at }
  objects.push(scene ? { path, scene } : { path })
  r.objects = objects
  return { json: r, index: objects.length - 1 }
}

export function addTunerViewObject(projectPath: string, view: string, obj: TunerViewObject): TunerResult<number> {
  if (!isTunerViewName(view)) return { ok: false, error: 'Invalid view name' }
  const dir = tunerViewsDir(projectPath)
  const file = join(dir, `${view}.json`)
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    return { ok: false, error: `Could not read the view: ${(e as Error).message}` }
  }
  const next = addTunerViewObjectJson(raw, obj)
  if (typeof next === 'string') return { ok: false, error: next }
  const tmp = join(dir, `.${view}.${process.pid}.${Date.now()}.tmp`)
  try {
    writeFileSync(tmp, JSON.stringify(next.json, null, 2), 'utf8')
    renameSync(tmp, file)
  } catch (e) {
    try {
      rmSync(tmp, { force: true })
    } catch {
    }
    return { ok: false, error: `Could not write the view: ${(e as Error).message}` }
  }
  debugLog(`[tuner] view ${view}: added object ${obj.path} as entry ${next.index}`)
  return { ok: true, data: next.index }
}

function isLegacyTunerViewFile(file: string): boolean {
  try {
    return isLegacyTunerView(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return false
  }
}

function migrateLegacyTunerViews(projectPath: string): number {
  const legacyDir = join(projectPath, SSPACE_DIR, LEGACY_TUNER_VIEWS_DIR)
  let names: string[]
  try {
    names = readdirSync(legacyDir)
  } catch {
    return 0
  }
  const dir = tunerViewsDir(projectPath)
  let moved = 0
  for (const file of names) {
    if (!file.endsWith('.json') || !isTunerViewName(file.slice(0, -5))) continue
    const target = join(dir, file)
    if (existsSync(target) && !isLegacyTunerViewFile(target)) continue
    try {
      if (moved === 0) {
        ensureSspaceForSync(dir)
        mkdirSync(dir, { recursive: true })
      }
      renameSync(join(legacyDir, file), target)
      moved++
    } catch (e) {
      console.log(`[tuner] could not move view ${file} out of ${legacyDir}: ${(e as Error).message}`)
    }
  }
  try {
    rmdirSync(legacyDir)
  } catch {
  }
  if (moved > 0) console.log(`[tuner] moved ${moved} view(s) from ${legacyDir} to ${dir}`)
  return moved
}

function readTunerViewFile(dir: string, name: string): TunerView | null {
  const f = join(dir, `${name}.json`)
  try {
    return parseTunerView(name, JSON.parse(readFileSync(f, 'utf8')), statSync(f).mtimeMs)
  } catch {
    return null
  }
}

export function readTunerView(projectPath: string, name: string): TunerView | null {
  if (!isTunerViewName(name)) return null
  migrateLegacyTunerViews(projectPath)
  return readTunerViewFile(tunerViewsDir(projectPath), name)
}

export function listTunerViews(projectPath: string): TunerView[] {
  migrateLegacyTunerViews(projectPath)
  const dir = tunerViewsDir(projectPath)
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const out: TunerView[] = []
  for (const file of names) {
    const name = file.endsWith('.json') ? file.slice(0, -5) : ''
    if (!isTunerViewName(name)) continue
    const v = readTunerViewFile(dir, name)
    if (v) out.push(v)
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt)
}
