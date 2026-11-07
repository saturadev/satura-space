import type { TabGroupLayoutNode } from './types'

export const RATIO_MIN = 0.15
export const RATIO_MAX = 0.85
export const LAYOUT_TOL = 12

export type PaneKind = 'tuner' | 'unity' | 'terminal' | 'other' | 'empty'
export type Axis = 'w' | 'h'
export type Side = 'first' | 'second'

export interface Size {
  w: number
  h: number
}

export interface Rect extends Size {
  x: number
  y: number
}

export interface PaneGroup {
  id: string
  kind: PaneKind
  tabs: number
  caller?: boolean
  drift?: boolean
  preview?: string | null
  rect?: Rect | null
  hasTuner?: boolean
  hasTerminal?: boolean
}

export interface PaneModel {
  width: number
  height: number
  tree: TabGroupLayoutNode
  groups: PaneGroup[]
  fullscreen?: string | null
  sidebar?: { open: boolean; width: number } | null
  respect?: string[]
}

const HARD: Record<PaneKind, Size> = {
  tuner: { w: 320, h: 300 },
  unity: { w: 240, h: 180 },
  terminal: { w: 200, h: 120 },
  other: { w: 200, h: 120 },
  empty: { w: 120, h: 80 }
}

const CALLER_FLOOR: Size = { w: 320, h: 200 }

const COMFORT: Record<PaneKind, Size> = {
  tuner: { w: 480, h: 320 },
  unity: { w: 400, h: 260 },
  terminal: { w: 420, h: 220 },
  other: { w: 320, h: 200 },
  empty: { w: 160, h: 100 }
}

const FLOOR: Record<PaneKind, Size> = {
  tuner: { w: 640, h: 420 },
  unity: { w: 480, h: 320 },
  terminal: { w: 420, h: 220 },
  other: { w: 320, h: 200 },
  empty: { w: 160, h: 100 }
}

const LADDER: ReadonlySet<PaneKind> = new Set<PaneKind>(['tuner'])

const WANT: Record<PaneKind, { w: number; h: number; minW: number; minH: number }> = {
  tuner: { w: 0.62, h: 0.72, minW: 760, minH: 480 },
  unity: { w: 0.55, h: 0.6, minW: 640, minH: 400 },
  terminal: { w: 0.45, h: 0.45, minW: 560, minH: 300 },
  other: { w: 0.5, h: 0.5, minW: 520, minH: 320 },
  empty: { w: 0.5, h: 0.5, minW: 520, minH: 320 }
}

function wantOf(kind: PaneKind, W: number, H: number): Size {
  const r = WANT[kind]
  return { w: Math.round(Math.min(W, Math.max(r.minW, r.w * W))), h: Math.round(Math.min(H, Math.max(r.minH, r.h * H))) }
}

export function pathKey(path: readonly Side[]): string {
  return path.length ? path.join('.') : 'root'
}

export function leafIds(node: TabGroupLayoutNode): string[] {
  return node.type === 'leaf' ? [node.groupId] : [...leafIds(node.first), ...leafIds(node.second)]
}

export function splitKey(node: TabGroupLayoutNode, path: readonly Side[]): string {
  if (node.type !== 'split') return pathKey(path)
  return `${pathKey(path)}|${leafIds(node.first).join(',')}|${leafIds(node.second).join(',')}`
}

export function nodeAt(root: TabGroupLayoutNode, path: readonly Side[]): TabGroupLayoutNode | null {
  let n: TabGroupLayoutNode = root
  for (const side of path) {
    if (n.type !== 'split') return null
    n = n[side]
  }
  return n
}

function withRatio(root: TabGroupLayoutNode, path: readonly Side[], ratio: number): TabGroupLayoutNode {
  if (root.type !== 'split') return root
  if (!path.length) return { ...root, ratio }
  const [side, ...rest] = path
  return { ...root, [side]: withRatio(root[side], rest, ratio) }
}

function replaceGroup(root: TabGroupLayoutNode, groupId: string, next: TabGroupLayoutNode): TabGroupLayoutNode {
  if (root.type === 'leaf') return root.groupId === groupId ? next : root
  return { ...root, first: replaceGroup(root.first, groupId, next), second: replaceGroup(root.second, groupId, next) }
}

export interface Rects {
  groups: Map<string, Rect>
  nodes: Map<string, Rect>
}

function rectsOf(tree: TabGroupLayoutNode, W: number, H: number): Rects {
  const groups = new Map<string, Rect>()
  const nodes = new Map<string, Rect>()
  const walk = (n: TabGroupLayoutNode, r: Rect, path: Side[]): void => {
    nodes.set(pathKey(path), r)
    if (n.type === 'leaf') {
      groups.set(n.groupId, r)
      return
    }
    const k = n.ratio ?? 0.5
    if (n.direction === 'horizontal') {
      walk(n.first, { x: r.x, y: r.y, w: r.w * k, h: r.h }, [...path, 'first'])
      walk(n.second, { x: r.x + r.w * k, y: r.y, w: r.w * (1 - k), h: r.h }, [...path, 'second'])
    } else {
      walk(n.first, { x: r.x, y: r.y, w: r.w, h: r.h * k }, [...path, 'first'])
      walk(n.second, { x: r.x, y: r.y + r.h * k, w: r.w, h: r.h * (1 - k) }, [...path, 'second'])
    }
  }
  walk(tree, { x: 0, y: 0, w: W, h: H }, [])
  return { groups, nodes }
}

export function stepsTo(tree: TabGroupLayoutNode, groupId: string): { path: Side[]; side: Side }[] | null {
  const out: { path: Side[]; side: Side }[] = []
  const find = (n: TabGroupLayoutNode, path: Side[]): boolean => {
    if (n.type === 'leaf') return n.groupId === groupId
    for (const side of ['first', 'second'] as const) {
      out.push({ path, side })
      if (find(n[side], [...path, side])) return true
      out.pop()
    }
    return false
  }
  return find(tree, []) ? out : null
}

const axisOf = (direction: 'horizontal' | 'vertical'): Axis => (direction === 'horizontal' ? 'w' : 'h')
const round4 = (v: number): number => Math.round(v * 10000) / 10000
const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v))

export function floorOf(kind: PaneKind, want: Size): Size {
  return { w: Math.min(FLOOR[kind].w, want.w), h: Math.min(FLOOR[kind].h, want.h) }
}

export function fits(size: Size, need: Size, tol = LAYOUT_TOL): boolean {
  return size.w >= need.w - tol && size.h >= need.h - tol
}

export function fitOf(size: Size, want: Size): number {
  return Math.min(1, size.w / Math.max(1, want.w)) * Math.min(1, size.h / Math.max(1, want.h))
}

type Tier = 'gentle' | 'hard'
type Floors = (id: string) => Size

function neighbourFloor(g: PaneGroup | undefined, kind: PaneKind, tier: Tier, now: Size): Size {
  const gentle = tier === 'gentle'
  const base = g?.caller
    ? gentle
      ? { w: Math.max(COMFORT.terminal.w, CALLER_FLOOR.w), h: Math.max(COMFORT.terminal.h, CALLER_FLOOR.h) }
      : CALLER_FLOOR
    : gentle && !g?.drift
      ? COMFORT[kind]
      : HARD[kind]
  return { w: Math.min(base.w, now.w), h: Math.min(base.h, now.h) }
}

function minExtent(n: TabGroupLayoutNode, axis: Axis, floor: Floors, flexible: boolean): number {
  if (n.type === 'leaf') return floor(n.groupId)[axis]
  const a = minExtent(n.first, axis, floor, flexible)
  const b = minExtent(n.second, axis, floor, flexible)
  if (axisOf(n.direction) !== axis) return Math.max(a, b)
  if (flexible) return Math.max(a + b, a / RATIO_MAX, b / RATIO_MAX)
  const r = clamp(n.ratio ?? 0.5, 0.01, 0.99)
  return Math.max(a / r, b / (1 - r))
}

function needOf(n: TabGroupLayoutNode, axis: Axis, target: string, want: Size, floor: Floors, flexible: boolean): number {
  if (n.type === 'leaf') return n.groupId === target ? want[axis] : floor(n.groupId)[axis]
  const inFirst = leafIds(n.first).includes(target)
  const inSecond = !inFirst && leafIds(n.second).includes(target)
  if (!inFirst && !inSecond) return minExtent(n, axis, floor, flexible)
  const a = inFirst ? needOf(n.first, axis, target, want, floor, flexible) : minExtent(n.first, axis, floor, flexible)
  const b = inSecond ? needOf(n.second, axis, target, want, floor, flexible) : minExtent(n.second, axis, floor, flexible)
  return axisOf(n.direction) === axis ? a + b : Math.max(a, b)
}

function tightest(n: TabGroupLayoutNode, axis: Axis, floor: Floors, rects: Map<string, Rect>): string {
  let best = { id: '', k: -1 }
  for (const id of leafIds(n)) {
    const size = rects.get(id)?.[axis] ?? 0
    const k = size > 0 ? floor(id)[axis] / size : Infinity
    if (k > best.k) best = { id, k }
  }
  return best.id
}

export interface PlanChange {
  key: string
  path: string
  direction: 'horizontal' | 'vertical'
  from: number
  to: number
  gain: number
}

export interface PlanLimit {
  key: string
  path: string
  group: string
  why: 'min' | 'limit' | 'user'
  moved: boolean
}

export interface GrowPlan {
  group: string
  want: Size
  floor: Size
  before: Size
  size: Size
  space: Size
  changes: PlanChange[]
  limits: PlanLimit[]
  reached: boolean
  usable: boolean
  tree: TabGroupLayoutNode
}

function allocate(tree: TabGroupLayoutNode, path: Side[], axis: Axis, E: number, floor: Floors, changes: PlanChange[]): TabGroupLayoutNode {
  const node = nodeAt(tree, path)
  if (!node || node.type !== 'split') return tree
  if (axisOf(node.direction) !== axis) {
    const next = allocate(tree, [...path, 'first'], axis, E, floor, changes)
    return allocate(next, [...path, 'second'], axis, E, floor, changes)
  }
  const a = minExtent(node.first, axis, floor, true)
  const b = minExtent(node.second, axis, floor, true)
  const r = node.ratio ?? 0.5
  const lo = Math.max(a, RATIO_MIN * E)
  const hi = Math.min(E - b, RATIO_MAX * E)
  let next = tree
  let e1 = r * E
  if (lo <= hi + 0.5 && (e1 < lo - 0.5 || e1 > hi + 0.5)) {
    const to = round4(clamp(e1, lo, hi) / E)
    e1 = to * E
    next = withRatio(next, path, to)
    changes.push({ key: splitKey(node, path), path: pathKey(path), direction: node.direction, from: r, to, gain: 0 })
  }
  next = allocate(next, [...path, 'first'], axis, e1, floor, changes)
  return allocate(next, [...path, 'second'], axis, E - e1, floor, changes)
}

function growWith(model: PaneModel, groupId: string, opts: { want?: Size; kind?: PaneKind; squeeze?: boolean }, tier: Tier): GrowPlan {
  const W = model.width
  const H = model.height
  const byId = new Map(model.groups.map((g) => [g.id, g]))
  const kindOf = (id: string): PaneKind => (id === groupId && opts.kind ? opts.kind : (byId.get(id)?.kind ?? 'other'))
  const kind = kindOf(groupId)
  const want = opts.want ? { w: Math.min(W, opts.want.w), h: Math.min(H, opts.want.h) } : wantOf(kind, W, H)
  const floor = floorOf(kind, want)
  const respect = new Set(model.respect ?? [])
  const flexible = !!opts.squeeze
  let tree = model.tree
  const start = rectsOf(tree, W, H).groups
  const floors = new Map<string, Size>()
  for (const [id, r] of start) if (id !== groupId) floors.set(id, neighbourFloor(byId.get(id), kindOf(id), tier, r))
  const fl: Floors = (id) => floors.get(id) ?? { w: 0, h: 0 }
  const s0 = start.get(groupId)
  const before = { w: Math.round(s0?.w ?? 0), h: Math.round(s0?.h ?? 0) }
  const changes: PlanChange[] = []
  const limits: PlanLimit[] = []
  for (const step of stepsTo(tree, groupId) ?? []) {
    const node = nodeAt(tree, step.path)
    if (!node || node.type !== 'split') continue
    const { nodes, groups } = rectsOf(tree, W, H)
    const R = nodes.get(pathKey(step.path))
    if (!R) continue
    const axis = axisOf(node.direction)
    const C = R[axis]
    const ratio = node.ratio ?? 0.5
    const side = step.side
    const other: Side = side === 'first' ? 'second' : 'first'
    const t = side === 'first' ? ratio * C : (1 - ratio) * C
    const key = splitKey(node, step.path)
    const path = pathKey(step.path)
    const own = respect.has(key)
    const full = Math.min(C, needOf(node[side], axis, groupId, want, fl, flexible))
    const need = own ? Math.min(full, needOf(node[side], axis, groupId, floor, fl, flexible)) : full
    if (t >= need - LAYOUT_TOL) {
      if (own && t < full - LAYOUT_TOL) limits.push({ key, path, group: groupId, why: 'user', moved: false })
      continue
    }
    const o = C - t
    const byMin = C - Math.min(o, minExtent(node[other], axis, fl, flexible))
    const byClamp = RATIO_MAX * C
    const goal = Math.min(need, byMin, byClamp)
    const who = tightest(node[other], axis, fl, groups)
    const why = byMin <= byClamp ? 'min' : 'limit'
    if (goal <= t + LAYOUT_TOL) {
      limits.push({ key, path, group: who, why: own ? 'user' : why, moved: false })
      continue
    }
    const to = round4(side === 'first' ? goal / C : 1 - goal / C)
    tree = withRatio(tree, step.path, to)
    changes.push({ key, path, direction: node.direction, from: ratio, to, gain: Math.round(goal - t) })
    if (flexible) tree = allocate(tree, [...step.path, other], axis, side === 'first' ? (1 - to) * C : to * C, fl, changes)
    if (goal < need - LAYOUT_TOL && !own) limits.push({ key, path, group: who, why, moved: true })
  }
  const r = rectsOf(tree, W, H).groups.get(groupId)
  const size = { w: Math.round(r?.w ?? 0), h: Math.round(r?.h ?? 0) }
  return { group: groupId, want, floor, before, size, space: { w: W, h: H }, changes, limits, reached: fits(size, want), usable: fits(size, floor), tree }
}

function planGrow(model: PaneModel, groupId: string, opts: { want?: Size; kind?: PaneKind; squeeze?: boolean } = {}): GrowPlan {
  const hard = growWith(model, groupId, opts, 'hard')
  const gentle = growWith(model, groupId, opts, 'gentle')
  return gentle.size.w >= hard.size.w - 1 && gentle.size.h >= hard.size.h - 1 ? gentle : hard
}

export type LayoutStep = 'sidebar' | 'squeeze' | 'fullscreen'

export interface LayoutPlan {
  group: string
  want: Size
  floor: Size
  before: Size
  size: Size
  grow: GrowPlan
  steps: LayoutStep[]
  usable: boolean
}

export function planLayout(model: PaneModel, groupId: string, opts: { want?: Size; kind?: PaneKind; fullscreen?: boolean } = {}): LayoutPlan {
  const kind = opts.kind ?? model.groups.find((g) => g.id === groupId)?.kind ?? 'other'
  const first = planGrow(model, groupId, { want: opts.want, kind })
  const done = (grow: GrowPlan, steps: LayoutStep[], size = grow.size): LayoutPlan => ({
    group: groupId,
    want: first.want,
    floor: grow.floor,
    before: first.before,
    size,
    grow,
    steps,
    usable: fits(size, grow.floor)
  })
  const still = (g: GrowPlan, size: Size): GrowPlan => ({ ...g, changes: [], limits: [], size, tree: model.tree })
  if (model.fullscreen === groupId) {
    const whole = { w: model.width, h: model.height }
    return { ...done(still(first, whole), [], whole), before: whole }
  }
  if (first.usable || !LADDER.has(kind)) return done(first, [])
  const steps: LayoutStep[] = []
  let m = model
  let grow = first
  if (m.sidebar?.open && m.sidebar.width > 0) {
    m = { ...m, width: m.width + m.sidebar.width, sidebar: { open: false, width: 0 } }
    steps.push('sidebar')
    grow = planGrow(m, groupId, { want: opts.want, kind })
    if (grow.usable) return done(grow, steps)
  }
  const squeezed = planGrow(m, groupId, { want: opts.want, kind, squeeze: true })
  if (squeezed.changes.length && fitOf(squeezed.size, grow.want) > fitOf(grow.size, grow.want) + 0.005) {
    grow = squeezed
    steps.push('squeeze')
  }
  if (grow.usable || opts.fullscreen === false) return done(grow, steps)
  const roomy = model.width >= FLOOR[kind].w - LAYOUT_TOL
  const whole = { w: roomy ? model.width : m.width, h: model.height }
  return done(still(first, whole), roomy || !steps.includes('sidebar') ? ['fullscreen'] : ['sidebar', 'fullscreen'], whole)
}

export interface Shrunk {
  id: string
  kind: PaneKind
  caller: boolean
  toMin: boolean
}

function sizesOf(model: PaneModel): Map<string, Size> {
  if (model.fullscreen) return new Map([[model.fullscreen, { w: model.width, h: model.height }]])
  return rectsOf(model.tree, model.width, model.height).groups
}

export function shrunkPanes(before: PaneModel, after: PaneModel, target: string): Shrunk[] {
  if (after.fullscreen) return []
  const a = sizesOf(before)
  const b = sizesOf(after)
  const out: Shrunk[] = []
  for (const g of after.groups) {
    const s0 = a.get(g.id)
    const s1 = b.get(g.id)
    if (g.id === target || !s0 || !s1) continue
    const dw = s0.w - s1.w
    const dh = s0.h - s1.h
    if (dw <= LAYOUT_TOL && dh <= LAYOUT_TOL) continue
    const f = g.caller ? CALLER_FLOOR : HARD[g.kind]
    const toMin = (dw > LAYOUT_TOL && s1.w <= f.w + LAYOUT_TOL) || (dh > LAYOUT_TOL && s1.h <= f.h + LAYOUT_TOL)
    out.push({ id: g.id, kind: g.kind, caller: !!g.caller, toMin })
  }
  return out
}

function belowComfort(before: Map<string, Size>, after: Map<string, Size>, model: PaneModel, target: string): number {
  let n = 0
  for (const g of model.groups) {
    const s0 = before.get(g.id)
    const s1 = after.get(g.id)
    if (g.id === target || !s0 || !s1) continue
    const c = COMFORT[g.kind]
    if ((s0.w >= c.w && s1.w < c.w - 1) || (s0.h >= c.h && s1.h < c.h - 1)) n++
  }
  return n
}

export type PlaceHow = 'reuse' | 'replace' | 'tab' | 'right' | 'down'

export interface Placement {
  how: PlaceHow
  group: string
  ratio?: number
  previewTabId?: string
  size: Size
  want: Size
  grow: GrowPlan
  steps: LayoutStep[]
  score: number
  usable: boolean
  splitsRejected: boolean
}

const NEW_GROUP = '__new__'

function tunerHome(model: PaneModel): string | null {
  const { groups: rects } = rectsOf(model.tree, model.width, model.height)
  const laidOut = new Set(leafIds(model.tree))
  const areaOf = (g: PaneGroup): number => {
    const r = rects.get(g.id)
    return r && laidOut.has(g.id) ? r.w * r.h : 0
  }
  const tuner = (g: PaneGroup): boolean => g.hasTuner ?? g.kind === 'tuner'
  const terminal = (g: PaneGroup): boolean => !tuner(g) && (g.hasTerminal ?? g.kind === 'terminal')
  let best = Math.max(0, ...model.groups.filter(terminal).map(areaOf))
  let home: string | null = null
  for (const g of model.groups) {
    if (!tuner(g)) continue
    const a = areaOf(g)
    if (a > best) {
      best = a
      home = g.id
    }
  }
  return home
}

function planPlacement(model: PaneModel, kind: PaneKind, only?: string): Placement | null {
  const W = model.width
  const H = model.height
  const want = wantOf(kind, W, H)
  const floor = floorOf(kind, want)
  const { groups: rects } = rectsOf(model.tree, W, H)
  const laidOut = new Set(leafIds(model.tree))
  const home = tunerHome(model)
  const cands: { how: PlaceHow; group: string; ratio?: number; previewTabId?: string; model: PaneModel; target: string; factor: number; area: number }[] = []
  let splitsRejected = false
  for (const g of model.groups) {
    const r = rects.get(g.id)
    if (!r || !laidOut.has(g.id) || (home && g.id !== home) || (only && g.id !== only)) continue
    const asTab = { ...model, groups: model.groups.map((x) => (x.id === g.id ? { ...x, kind } : x)) }
    const area = r.w * r.h
    if (g.drift) cands.push({ how: 'reuse', group: g.id, model: asTab, target: g.id, factor: 1.08, area })
    else if (g.preview) cands.push({ how: 'replace', group: g.id, previewTabId: g.preview, model: asTab, target: g.id, factor: 1.02, area })
    else {
      const hides = g.tabs === 0 ? 1 : g.caller ? 0.4 : g.kind === 'unity' || g.kind === 'tuner' ? 0.8 : 0.9
      cands.push({ how: 'tab', group: g.id, model: asTab, target: g.id, factor: hides, area })
    }
    if (home || g.tabs === 0) continue
    for (const how of ['right', 'down'] as const) {
      const axis: Axis = how === 'right' ? 'w' : 'h'
      const room = r[axis] - COMFORT[g.kind][axis]
      if (room < floor[axis]) {
        splitsRejected = true
        continue
      }
      const fresh = Math.min(want[axis], room)
      const ratio = round4(clamp((r[axis] - fresh) / r[axis], RATIO_MIN, RATIO_MAX))
      const tree = replaceGroup(model.tree, g.id, {
        type: 'split',
        direction: how === 'right' ? 'horizontal' : 'vertical',
        first: { type: 'leaf', groupId: g.id },
        second: { type: 'leaf', groupId: NEW_GROUP },
        ratio
      })
      const crowd = laidOut.size >= 4 ? 0.95 : 1
      cands.push({ how, group: g.id, ratio, model: { ...model, tree, groups: [...model.groups, { id: NEW_GROUP, kind, tabs: 1 }] }, target: NEW_GROUP, factor: crowd, area })
    }
  }
  let best: Placement | null = null
  let bestArea = 0
  for (const c of cands) {
    const plan = planLayout(c.model, c.target, { want, kind, fullscreen: false })
    const g = plan.grow
    const comfy = Math.pow(0.99, belowComfort(rectsOf(c.model.tree, W, H).groups, rectsOf(g.tree, g.space.w, g.space.h).groups, c.model, c.target))
    const ladder = (plan.steps.includes('sidebar') ? 0.9 : 1) * (plan.steps.includes('squeeze') ? 0.95 : 1)
    const score = fitOf(plan.size, want) * (plan.usable ? 1 : 0.5) * c.factor * ladder * comfy * Math.pow(0.98, g.changes.length)
    if (!best || score > best.score + 1e-6 || (score > best.score - 1e-6 && c.area > bestArea)) {
      best = { how: c.how, group: c.group, ratio: c.ratio, previewTabId: c.previewTabId, size: plan.size, want, grow: g, steps: plan.steps, score, usable: plan.usable, splitsRejected }
      bestArea = c.area
    }
  }
  if (best) best.splitsRejected = splitsRejected
  return best
}

export type PaneAct = 'sidebar' | 'fullscreen' | 'prune'

export function isPaneAct(v: unknown): v is PaneAct {
  return v === 'sidebar' || v === 'fullscreen' || v === 'prune'
}

export function emptyGroups(model: PaneModel, keep?: string): string[] {
  const laidOut = new Set(leafIds(model.tree))
  return model.groups.filter((g) => g.tabs === 0 && g.id !== keep && g.id !== model.fullscreen && laidOut.has(g.id)).map((g) => g.id)
}

function dropLeaf(node: TabGroupLayoutNode, id: string): TabGroupLayoutNode | null {
  if (node.type === 'leaf') return node.groupId === id ? null : node
  const first = dropLeaf(node.first, id)
  const second = dropLeaf(node.second, id)
  if (!first) return second
  if (!second) return first
  return first === node.first && second === node.second ? node : { ...node, first, second }
}

function withoutGroups(model: PaneModel, ids: readonly string[]): PaneModel {
  let tree: TabGroupLayoutNode = model.tree
  for (const id of ids) {
    if (leafIds(tree).length <= 1) break
    tree = dropLeaf(tree, id) ?? tree
  }
  const kept = new Set(leafIds(tree))
  return { ...model, tree, groups: model.groups.filter((g) => kept.has(g.id)) }
}

export interface RoomyPlacement {
  plan: Placement | null
  drop: string[]
}

export function planPlacementRoomy(model: PaneModel, kind: PaneKind): RoomyPlacement {
  const first = planPlacement(model, kind)
  const empties = emptyGroups(model)
  if (!empties.length) return { plan: first, drop: [] }
  if (first?.usable && (tunerHome(model) || (first.how === 'tab' && empties.includes(first.group)))) return { plan: first, drop: [] }
  const { groups: rects } = rectsOf(model.tree, model.width, model.height)
  const area = (id: string): number => {
    const r = rects.get(id)
    return r ? r.w * r.h : 0
  }
  const biggest = [...empties].sort((a, b) => area(b) - area(a))[0]
  const rest = empties.filter((id) => id !== biggest)
  if (!tunerHome(model)) {
    const into = planPlacement(model, kind, biggest)
    if (into?.usable) return { plan: into, drop: [] }
    const roomier = planPlacement(withoutGroups(model, rest), kind, biggest)
    if (roomier?.usable) return { plan: roomier, drop: rest }
  }
  if (first?.usable) return { plan: first, drop: [] }
  let best: RoomyPlacement = { plan: first, drop: [] }
  for (const drop of [rest, empties].filter((d) => d.length > 0)) {
    const plan = planPlacement(withoutGroups(model, drop), kind)
    if (!plan) continue
    if (plan.usable) return { plan, drop }
    if (!best.plan || plan.score > best.plan.score + 1e-6) best = { plan, drop }
  }
  return best
}

export interface Stretch {
  size: number | null
  why: 'ok' | 'enough' | 'min'
}

export function planStretch(o: { cur: number; total: number; want: number; floorOther: number }): Stretch {
  if (o.cur >= o.want - LAYOUT_TOL) return { size: null, why: 'enough' }
  const goal = Math.min(o.want, o.total - o.floorOther)
  if (goal <= o.cur + LAYOUT_TOL) return { size: null, why: 'min' }
  return { size: Math.round(goal), why: 'ok' }
}

export function inspectorWidthWant(paneW: number): { want: number; floorOther: number } {
  return { want: Math.round(clamp(0.3 * paneW, 320, 440)), floorOther: Math.round(Math.max(240, 0.45 * paneW)) }
}

export function inspectorHeightWant(columnH: number): { want: number; floorOther: number } {
  return { want: Math.round(clamp(0.55 * columnH, 260, 440)), floorOther: Math.round(Math.max(120, 0.2 * columnH)) }
}

export function timelineHeightWant(areaH: number): { want: number; floorOther: number } {
  return { want: Math.round(clamp(0.3 * areaH, 180, 300)), floorOther: Math.round(Math.max(140, 0.45 * areaH)) }
}

export function userMoved(tree: TabGroupLayoutNode, set: Record<string, number>): string[] {
  const out: string[] = []
  const walk = (n: TabGroupLayoutNode, path: Side[]): void => {
    if (n.type !== 'split') return
    const key = splitKey(n, path)
    const mine = set[key]
    if (typeof mine === 'number' && Math.abs((n.ratio ?? 0.5) - mine) > 0.01) out.push(key)
    walk(n.first, [...path, 'first'])
    walk(n.second, [...path, 'second'])
  }
  walk(tree, [])
  return out
}

export function paneName(g: Pick<PaneGroup, 'kind' | 'caller'> | undefined): string {
  if (!g) return 'a panel'
  if (g.kind === 'terminal') return g.caller ? 'your terminal' : 'a terminal'
  if (g.kind === 'tuner') return 'the Tuner'
  if (g.kind === 'unity') return 'the Unity panel'
  if (g.kind === 'empty') return 'an empty panel'
  return 'a panel'
}

export const dims = (s: Size): string => `${Math.round(s.w)}x${Math.round(s.h)}`

export function joinAnd(parts: string[]): string {
  if (parts.length < 2) return parts[0] ?? ''
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`
}

const PANE_WORDS: [string, string, string][] = [
  ['caller', 'your terminal', 'your terminals'],
  ['terminal', 'a terminal', 'terminals'],
  ['unity', 'the Unity panel', 'Unity panels'],
  ['tuner', 'another Tuner', 'Tuners'],
  ['other', 'a panel', 'panels'],
  ['empty', 'an empty panel', 'empty panels']
]

export function paneList(list: { kind: PaneKind; caller?: boolean }[]): string {
  const count = new Map<string, number>()
  for (const p of list) {
    const k = p.caller ? 'caller' : p.kind
    count.set(k, (count.get(k) ?? 0) + 1)
  }
  return joinAnd(PANE_WORDS.filter(([k]) => count.has(k)).map(([k, one, many]) => (count.get(k) === 1 ? one : `${count.get(k)} ${many}`)))
}

function shrinkPhrase(list: Shrunk[]): string {
  if (!list.length) return ''
  const k = list.filter((s) => s.toMin).length
  const what = paneList(list)
  if (k === list.length) return `shrinking ${what} to ${list.length === 1 ? 'its' : 'their'} minimum`
  if (!k) return `shrinking ${what}`
  return `shrinking ${what}, ${k === 1 ? 'one' : k} of them to the minimum`
}

const WHY_TEXT: Record<PlanLimit['why'], string> = {
  min: 'the other panels are at their minimum',
  limit: "the splitters can't go further",
  user: 'you sized a splitter yourself'
}

export function limitReasons(limits: PlanLimit[]): string {
  return joinAnd([...new Set(limits.map((l) => WHY_TEXT[l.why]))])
}

export function layoutSentence(o: {
  lead?: string | null
  name: string
  size: Size
  steps: LayoutStep[]
  shrunk: Shrunk[]
  moved: boolean
  usable: boolean
  reasons: string
}): string {
  const size = dims(o.size)
  const sidebar = o.steps.includes('sidebar')
  if (o.steps.includes('fullscreen')) {
    const head = o.lead ? `${o.lead} and put it` : `put ${o.name}`
    return `${head} in fullscreen at ${size}${sidebar ? ' with the sidebar hidden' : ''} because the other panels couldn't make enough room`
  }
  if (o.moved || sidebar) {
    const head = o.lead ? `${o.lead} and made it` : `made ${o.name}`
    const by = joinAnd([sidebar ? 'hiding the sidebar' : '', shrinkPhrase(o.shrunk)].filter(Boolean))
    return `${head} ${size}${by ? ` by ${by}` : ''}${!o.usable && o.reasons ? `, and it can't grow because ${o.reasons}` : ''}`
  }
  if (o.usable || !o.reasons) return o.lead ? `${o.lead} at ${size}` : ''
  return o.lead ? `${o.lead} at ${size}, and it can't grow because ${o.reasons}` : `kept ${o.name} at ${size} because ${o.reasons}`
}
