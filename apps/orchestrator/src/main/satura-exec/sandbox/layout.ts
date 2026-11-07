import type { Locator } from '../playwright/client/locator'
import {
  dims,
  emptyGroups,
  fits,
  inspectorHeightWant,
  inspectorWidthWant,
  layoutSentence,
  limitReasons,
  nodeAt,
  paneName,
  planLayout,
  shrunkPanes,
  splitKey,
  stepsTo,
  planStretch,
  timelineHeightWant,
  type LayoutPlan,
  type LayoutStep,
  type PaneAct,
  type PaneModel,
  type PlaceHow,
  type PlanChange,
  type PlanLimit,
  type Side,
  type Size
} from '../../../shared/pane-plan'

type Box = { x: number; y: number; width: number; height: number }
type Point = { x: number; y: number }
type Options = Record<string, unknown>

export interface LayoutPage {
  readonly _window: number | null
  readonly mouse: {
    move(x: number, y: number, options?: { steps?: number; __show?: boolean }): Promise<void>
    down(options?: Record<string, unknown>): Promise<void>
    up(options?: Record<string, unknown>): Promise<void>
  }
  locator(selector: string): Locator
}

export type LayoutRpc = (args: Options) => Promise<unknown>

type Placed = { group: string; how: PlaceHow; near: string; size: Size; want: Size; splitsRejected: boolean; pruned?: number }
type Model = PaneModel & { placed?: Placed | null }

let layoutRpc: LayoutRpc | null = null
const grown = new Set<string>()
const SETTLE = 0.01
const INNER_TOL = 8

export function useLayoutRpc(rpc: LayoutRpc): void {
  layoutRpc = rpc
}

export async function inFront(page: LayoutPage): Promise<boolean> {
  return (await page.locator('[data-workspace][data-active="true"]').count()) > 0
}

async function call(page: LayoutPage, args: Options): Promise<unknown> {
  if (!layoutRpc) return null
  return layoutRpc({ window: page._window, ...args }).catch(() => null)
}

async function read(page: LayoutPage, take = false): Promise<Model | null> {
  const r = await call(page, { action: 'read', take })
  return r && typeof r === 'object' ? (r as Model) : null
}

const log = (page: LayoutPage, text: string): Promise<unknown> => call(page, { action: 'log', text: `layout: ${text}` })
const note = (page: LayoutPage, text: string | null | undefined): Promise<unknown> => (text ? call(page, { action: 'note', text }) : Promise.resolve(null))
const pct = (r: number | null): string => (r === null ? 'nowhere' : `${Math.round(r * 100)}%`)

function splitPath(path: string): Side[] {
  return path === 'root' ? [] : (path.split('.') as Side[])
}

function ratioAt(model: Model | null, path: string): number | null {
  const n = model ? nodeAt(model.tree, splitPath(path)) : null
  return n && n.type === 'split' ? (n.ratio ?? 0.5) : null
}

function why(l: PlanLimit, model: Model): string {
  const who = paneName(model.groups.find((g) => g.id === l.group))
  if (l.why === 'user') return 'you sized that splitter yourself, so it stays'
  if (l.why === 'limit') return `the splitter next to ${who} can't go further`
  return `${who} is at its minimum`
}

async function drag(page: LayoutPage, from: Point, to: Point): Promise<void> {
  await page.mouse.move(from.x, from.y, { __show: true })
  await page.mouse.down({ __show: true })
  await page.mouse.move(to.x, to.y, { steps: 12, __show: true })
  await page.mouse.up({ __show: true })
}

async function moveSplit(page: LayoutPage, c: PlanChange, groupId: string): Promise<number | null> {
  const sep = page.locator(`[data-workspace]:has([data-group-id="${groupId}"]) [data-split-path="${c.path}"]`).first()
  if (!(await sep.count())) return null
  const g = (await sep.evaluate((el: Element) => {
    const R = (e: Element): { x: number; y: number; w: number; h: number } => {
      const r = e.getBoundingClientRect()
      return { x: r.x, y: r.y, w: r.width, h: r.height }
    }
    return el.parentElement ? { c: R(el.parentElement), s: R(el) } : null
  })) as { c: { x: number; y: number; w: number; h: number }; s: { x: number; y: number; w: number; h: number } } | null
  if (!g) return null
  const across = c.direction === 'horizontal'
  const from = across ? { x: g.s.x + g.s.w / 2, y: g.c.y + g.c.h / 2 } : { x: g.c.x + g.c.w / 2, y: g.s.y + g.s.h / 2 }
  const to = across ? { x: g.c.x + c.to * g.c.w, y: from.y } : { x: from.x, y: g.c.y + c.to * g.c.h }
  await drag(page, from, to)
  return ratioAt(await read(page), c.path)
}

async function act(page: LayoutPage, what: PaneAct, group?: string): Promise<Model | null> {
  const r = await call(page, { action: 'act', act: what, ...(group ? { group } : {}) })
  return r && typeof r === 'object' ? (r as Model) : null
}

function planLine(name: string, plan: LayoutPlan): string {
  const todo = [
    plan.steps.includes('sidebar') ? 'hide the sidebar' : '',
    plan.steps.includes('fullscreen') ? 'fullscreen' : `${plan.grow.changes.length} splitter move(s)${plan.steps.includes('squeeze') ? ', panels beside it down to their minimum' : ''}`
  ].filter(Boolean)
  return `${name} is ${dims(plan.before)}, wants ${dims(plan.want)}, usable from ${dims(plan.floor)}: ${todo.join(', then ')}`
}

function sizeIn(model: Model | null, groupId: string, fallback: Size): Size {
  if (model?.fullscreen === groupId) return { w: model.width, h: model.height }
  const r = model?.groups.find((g) => g.id === groupId)?.rect
  return r ? { w: r.w, h: r.h } : fallback
}

async function growGroup(page: LayoutPage, groupId: string, lead: string | null): Promise<void> {
  const first = await read(page)
  const group = first?.groups.find((g) => g.id === groupId)
  if (!first || !group) return void (await note(page, lead))
  if (first.fullscreen) {
    if (first.fullscreen !== groupId) await log(page, 'another panel is fullscreen, so the layout stays as it is')
    return void (await note(page, lead))
  }
  const name = paneName(group)
  let model: Model = first
  let plan = planLayout(model, groupId)
  const empties = emptyGroups(model, groupId)
  if (empties.length && (!plan.usable || plan.steps.length || shrunkPanes(model, { ...model, tree: plan.grow.tree }, groupId).some((x) => x.kind !== 'empty'))) {
    const after = await act(page, 'prune', groupId)
    const closed = after ? empties.length - emptyGroups(after, groupId).length : 0
    if (after && closed > 0) {
      await log(page, `closed ${closed} empty panel group${closed === 1 ? '' : 's'} to make room for ${name}`)
      model = after
      plan = planLayout(model, groupId)
    }
  }
  if (!plan.grow.changes.length && !plan.grow.limits.length && !plan.steps.length) {
    return void (await note(page, lead && `${lead} at ${dims(sizeIn(model, groupId, plan.size))}`))
  }
  await log(page, planLine(name, plan))
  const done: LayoutStep[] = []
  const stop = async (why: string): Promise<void> => {
    await log(page, `${why}; stopped resizing`)
    const size = dims(sizeIn(await read(page), groupId, plan.before))
    await note(page, lead ? `${lead}, but it stayed at ${size}: ${why}` : `${name} stayed at ${size}: ${why}`)
  }
  if (plan.steps.includes('sidebar')) {
    const after = await act(page, 'sidebar')
    if (!after || after.sidebar?.open) return stop("the sidebar didn't close")
    done.push('sidebar')
    model = after
    plan = planLayout(model, groupId)
    await log(page, `hid the sidebar; now ${planLine(name, plan)}`)
  }
  if (plan.steps.includes('fullscreen')) {
    const after = await act(page, 'fullscreen', groupId)
    if (!after || after.fullscreen !== groupId) return stop("fullscreen didn't turn on")
    await log(page, `put ${name} in fullscreen: the other panels can't make room for ${dims(plan.floor)}`)
    const size = sizeIn(after, groupId, plan.size)
    return void (await note(page, layoutSentence({ lead, name, size, steps: [...done, 'fullscreen'], shrunk: [], moved: false, usable: true, reasons: '' })))
  }
  const held = new Map<string, PlanLimit>()
  for (const l of plan.grow.limits) {
    if (l.moved) held.set(l.path, l)
    else await log(page, `left splitter ${l.path} where it is: ${why(l, model)}`)
  }
  for (const c of plan.grow.changes) {
    const got = await moveSplit(page, c, groupId)
    if (got === null || Math.abs(got - c.to) > SETTLE) return stop(`splitter ${c.path} stopped at ${pct(got)}, not the planned ${pct(c.to)}`)
    const l = held.get(c.path)
    await log(page, `moved splitter ${c.path} from ${pct(c.from)} to ${pct(got)}${l ? `, as far as it goes: ${why(l, model)}` : ''}`)
    await call(page, { action: 'mark', key: c.key, ratio: got })
  }
  if (plan.steps.includes('squeeze')) done.push('squeeze')
  const last = (await read(page)) ?? model
  const size = sizeIn(last, groupId, plan.size)
  await note(
    page,
    layoutSentence({
      lead,
      name,
      size,
      steps: done,
      shrunk: shrunkPanes(first, last, groupId),
      moved: plan.grow.changes.length > 0,
      usable: plan.usable,
      reasons: limitReasons(plan.grow.limits)
    })
  )
}

type Inner = { cur: number; total: number; from: Point; dir: 1 | -1; axis: 'x' | 'y' }
type InnerGeo = { timeline: Inner | null; width: Inner | null; height: Inner | null }

function innerGeo(el: Element): InnerGeo {
  const pane = el.closest('[data-tuner-pane]')
  const out: InnerGeo = { timeline: null, width: null, height: null }
  if (!pane) return out
  const R = (e: Element): DOMRect => e.getBoundingClientRect()
  const mid = (r: DOMRect): { x: number; y: number } => ({ x: r.x + r.width / 2, y: r.y + r.height / 2 })
  const tl = el.closest('[data-tuner-animator]')
  const grip = tl?.querySelector('[data-anim-resize]')
  if (tl && grip && tl.parentElement) {
    out.timeline = { cur: R(tl).height, total: R(tl.parentElement).height, from: mid(R(grip)), dir: -1, axis: 'y' }
  }
  const column = el.closest('[data-tuner-inspector-column]')
  if (column) {
    const wideSplit = Array.from(pane.querySelectorAll('[data-scene-splitter="horizontal"]')).find((s) => !!s.nextElementSibling?.contains(column))
    if (wideSplit && wideSplit.parentElement && wideSplit.nextElementSibling) {
      out.width = { cur: R(wideSplit.nextElementSibling).width, total: R(wideSplit.parentElement).width, from: mid(R(wideSplit)), dir: -1, axis: 'x' }
    }
    const tallSplit = Array.from(pane.querySelectorAll('[data-scene-splitter="vertical"]')).find((s) => s.nextElementSibling === column)
    if (tallSplit && tallSplit.parentElement) {
      out.height = { cur: R(column).height, total: R(tallSplit.parentElement).height, from: mid(R(tallSplit)), dir: -1, axis: 'y' }
    }
  }
  return out
}

async function stretch(page: LayoutPage, pane: Locator, part: keyof InnerGeo, label: string): Promise<void> {
  const geo = ((await pane.evaluate(innerGeo)) as InnerGeo)[part]
  if (!geo) return
  const want = part === 'timeline' ? timelineHeightWant(geo.total) : part === 'width' ? inspectorWidthWant(geo.total) : inspectorHeightWant(geo.total)
  const plan = planStretch({ cur: geo.cur, total: geo.total, want: want.want, floorOther: want.floorOther })
  if (plan.why === 'enough') return
  if (plan.size === null) {
    await log(page, `left the ${label} at ${Math.round(geo.cur)}px: the rest of the Tuner is at its minimum`)
    return
  }
  const d = (plan.size - geo.cur) * geo.dir
  const to = geo.axis === 'x' ? { x: geo.from.x + d, y: geo.from.y } : { x: geo.from.x, y: geo.from.y + d }
  await drag(page, geo.from, to)
  const got = ((await pane.evaluate(innerGeo)) as InnerGeo)[part]?.cur ?? 0
  if (Math.abs(got - plan.size) > INNER_TOL) {
    await log(page, `the ${label} stopped at ${Math.round(got)}px, not the planned ${plan.size}px; stopped resizing`)
    await note(page, `the Tuner's ${label} stayed at ${Math.round(got)}px`)
    return
  }
  await log(page, `made the ${label} ${Math.round(got)}px`)
}

async function cramped(page: LayoutPage, groupId: string): Promise<boolean> {
  const model = await read(page)
  if (!model || model.fullscreen || !model.groups.some((g) => g.id === groupId)) return false
  const plan = planLayout(model, groupId)
  return !fits(plan.before, plan.floor) && (plan.grow.changes.length > 0 || plan.steps.length > 0 || emptyGroups(model, groupId).length > 0)
}

export async function showPane(page: LayoutPage, pane: Locator, lead: string | null = null): Promise<Box | null> {
  if (!(await pane.count()) || !(await inFront(page))) {
    await note(page, lead)
    return null
  }
  const where = (await pane.evaluate((el: Element) => ({
    group: el.closest('[data-group-id]')?.getAttribute('data-group-id') ?? null,
    tuner: !!el.closest('[data-tuner-pane]'),
    timeline: !!el.closest('[data-tuner-animator]'),
    column: !!el.closest('[data-tuner-inspector-column]')
  }))) as { group: string | null; tuner: boolean; timeline: boolean; column: boolean }
  if (where.group && (!grown.has(where.group) || (await cramped(page, where.group)))) {
    grown.add(where.group)
    await growGroup(page, where.group, lead)
  } else await note(page, lead)
  const inner = `${where.group}:${where.timeline ? 'timeline' : where.column ? 'column' : ''}`
  if (where.tuner && (where.timeline || where.column) && !grown.has(inner)) {
    grown.add(inner)
    if (where.timeline) await stretch(page, pane, 'timeline', 'timeline')
    if (where.column) {
      await stretch(page, pane, 'width', 'inspector')
      await stretch(page, pane, 'height', 'inspector')
    }
  }
  return (await pane.evaluate((el: Element) => {
    const g = el.closest('[data-group-id]') ?? el
    const r = g.getBoundingClientRect()
    return { x: r.x, y: r.y, width: r.width, height: r.height }
  })) as Box
}

export async function notePlacement(page: LayoutPage, what: string): Promise<string | null> {
  const model = await read(page, true)
  const p = model?.placed
  if (!p) return null
  const where =
    p.how === 'right'
      ? `in a split right of ${p.near}`
      : p.how === 'down'
        ? `in a split below ${p.near}`
        : p.how === 'reuse'
          ? 'in the panel Drift opened before'
          : p.how === 'replace'
            ? 'in place of a preview tab'
            : `as a tab beside ${p.near}`
  const pruned = p.pruned ? `, after closing ${p.pruned} empty panel group${p.pruned === 1 ? '' : 's'}` : ''
  await log(page, `opened ${what} ${where}${p.how === 'tab' && p.splitsRejected ? ': there was no room for a split' : ''}${pruned}, planned ${dims(p.size)} of ${dims(p.want)}`)
  const steps = model && (p.how === 'right' || p.how === 'down') ? stepsTo(model.tree, p.group) : null
  const last = steps?.[steps.length - 1]
  const node = last && model ? nodeAt(model.tree, last.path) : null
  if (last && node && node.type === 'split') await call(page, { action: 'mark', key: splitKey(node, last.path), ratio: node.ratio ?? 0.5 })
  return `opened ${what} ${where}`
}
