import { Locator } from '../playwright/client/locator'
import { inspectQuiet, scenePoint, sceneRows, tunerOpen, tunerPinned, tunerReady, tunerTabList, tunerTitle, type PageLike, type SceneRow } from './tuner'
import { closestTunerRows, tunerSearchOrder } from '../../../shared/tuner-find'
import { kindOf } from './unity'

type Options = Record<string, unknown>
type Api = Record<string, any>
type Lines = string | string[] | undefined | null

type UiPart = { what: string; find: (page: Api, tuner: Api) => unknown }

const TUNER = '[data-tuner-pane] >> visible=true'
const PLAYER = '[data-unity-player] >> visible=true'

const inTuner = (page: Api, name: string) => page.locator(TUNER).first().getByRole('button', { name, exact: true }).first()
const PLAYER_PARTS = new Set(['player', 'play', 'pause', 'add-player', 'refresh'])
const inPlayer = (page: Api, name: string | RegExp) => page.locator(PLAYER).first().getByRole('button', { name }).first()

const UI: Record<string, UiPart> = {
  tuner: {
    what: "The Tuner is a small Unity editor for one scene or prefab: a hierarchy, a scene view and an inspector. Edits land in the project, the same as editing in Unity's Inspector.",
    find: (page) => page.locator(TUNER).first()
  },
  hierarchy: {
    what: "Every object in the scene as a tree, like Unity's Hierarchy. Click a row to select it, double-click to frame it, drag a row to reparent it.",
    find: (_page, tuner) => tuner.hierarchy
  },
  search: {
    what: 'Type part of a name to find objects. Matching objects stay lit in the scene view and the rest dims. Escape clears it.',
    find: (page) => page.locator(TUNER).first().locator('[data-hierarchy-search]').first()
  },
  scene: {
    what: 'The scene view, rendered live by Unity. Scroll to zoom, middle-drag to pan, Alt+drag to orbit, right-drag with WASD to fly, F to frame the selection. Drag the handles to move, rotate or scale.',
    find: (_page, tuner) => tuner.viewport
  },
  inspector: {
    what: "Unity's own Inspector for the selected object: its components and their values. Change a value and it lands in the scene, with Undo.",
    find: (_page, tuner) => tuner.inspector
  },
  timeline: {
    what: "The selected object's animation clips, like Unity's Animation window. Drag the playhead to scrub through a clip.",
    find: (_page, tuner) => tuner.timeline
  },
  toolbar: {
    what: 'Tools for the scene view: Move, Rotate and Scale (W, E, R), Frame selected (F), Lighting, Grid, Scene camera, Gizmos, Effects and the animation timeline.',
    find: (page) => page.locator(TUNER).first().locator('[data-tuner-toolbar]').first()
  },
  move: { what: 'The Move tool (W): drag the arrows in the scene view to move the selected object.', find: (page) => inTuner(page, 'Move') },
  rotate: { what: 'The Rotate tool (E): drag the rings in the scene view to turn the selected object.', find: (page) => inTuner(page, 'Rotate') },
  scale: { what: 'The Scale tool (R): drag the handles in the scene view to resize the selected object.', find: (page) => inTuner(page, 'Scale') },
  frame: { what: 'Frames the selected object in the scene view, like pressing F in Unity.', find: (page) => inTuner(page, 'Frame selected') },
  lighting: { what: "Turns the scene's lighting on or off in the scene view.", find: (page) => inTuner(page, 'Lighting') },
  grid: { what: 'Shows or hides the grid in the scene view.', find: (page) => inTuner(page, 'Grid') },
  camera: { what: "Settings for the scene view's camera.", find: (page) => inTuner(page, 'Scene camera') },
  gizmos: { what: "Picks which gizmos the scene view draws, like Unity's Gizmos menu.", find: (page) => inTuner(page, 'Gizmos menu') },
  effects: {
    what: 'Fog, post-processing, skybox and particles in the scene view. Turn them off to see the scene plainly.',
    find: (page) => inTuner(page, 'Effects menu')
  },
  animation: {
    what: 'Shows or hides the animation timeline under the scene view.',
    find: (page) => page.locator(TUNER).first().locator('[data-tuner-animation-toggle]').first()
  },
  save: { what: "Writes the scene's changes to disk. Edit Mode only.", find: (page) => page.locator(TUNER).first().locator('[data-tuner-save]').first() },
  discard: { what: 'Throws away unsaved changes and goes back to the saved scene.', find: (page) => page.locator(TUNER).first().locator('[data-tuner-discard]').first() },
  'copy-changes': {
    what: 'Copies what you changed in the Tuner, so you can paste it to an agent.',
    find: (page) => page.locator(TUNER).first().locator('[data-tuner-copy-changes]').first()
  },
  'ask-drift': {
    what: 'Ask an agent a question or give it a task about what you see. The shortcut is /. Drift shows the answer right here.',
    find: (page) => inTuner(page, 'Ask Drift')
  },
  filter: {
    what: 'Shows when an agent narrowed the Tuner down to a few objects. Clear filter brings the whole scene back.',
    find: (page) => page.locator(TUNER).first().locator('[data-tuner-filter]').first()
  },
  player: {
    what: "The Unity Player: your game, streamed live from the project's Unity editor. Press Play to run it, then click the picture and use the game's controls.",
    find: (page) => page.locator(PLAYER).first()
  },
  play: {
    what: 'Enters Play Mode, the same as Play in Unity (Ctrl/Cmd+P). Click the game picture, then play with the keys and mouse. Press it again to stop.',
    find: (page) => inPlayer(page, /^(Play|Stop)$/)
  },
  pause: { what: 'Pauses the game. Next to it, Step moves one frame at a time.', find: (page) => inPlayer(page, /pause/i) },
  'add-player': {
    what: 'Adds another player viewport to test multiplayer: a copy of the editor joins the game as a second player.',
    find: (page) => inPlayer(page, 'Add a player viewport')
  },
  refresh: {
    what: 'Refresh recompiles scripts and reimports assets. Relaunch restarts the Unity editor if it gets stuck.',
    find: (page) => inPlayer(page, /Refresh, relaunch/)
  },
  console: {
    what: "Unity's console: every log, warning and error, with a filter box and toggles for each kind.",
    find: (page) => page.locator('[data-unity-console] >> visible=true').first().or(page.getByRole('tab', { name: 'Unity Console' }).first()).first()
  },
  sidebar: { what: "Workspaces, the agents you're running and the project's files.", find: (page) => page.locator('[data-pane="sidebar"]').first() },
  files: { what: "Filters the project's files by name.", find: (page) => page.getByPlaceholder('Filter files by name…').first() },
  'new-session': {
    what: 'Starts an agent, or opens a panel: Unity Player, Unity Console, Tuner, Scratchpads, Reports, Git or a terminal.',
    find: (page) => page.getByRole('button', { name: 'New session' }).first()
  }
}

const PANELS: Record<string, string> = {
  tuner: '[data-tuner-pane]',
  timeline: '[data-tuner-animator]',
  filter: '[data-tuner-filter]',
  player: '[data-unity-player]',
  console: '[data-unity-console]',
  sidebar: '[data-pane="sidebar"]'
}

const UI_ALIASES: Record<string, string> = {
  tree: 'hierarchy',
  viewport: 'scene',
  'scene-view': 'scene',
  view: 'scene',
  stop: 'play',
  game: 'player',
  'unity-player': 'player',
  'copy': 'copy-changes',
  ask: 'ask-drift',
  drift: 'ask-drift',
  'clear-filter': 'filter',
  logs: 'console',
  'unity-console': 'console',
  fx: 'effects',
  relaunch: 'refresh',
  new: 'new-session',
  plus: 'new-session'
}

type Target =
  | { kind: 'ui'; name: string; label: string }
  | { kind: 'object'; path: string; label: string; others: string[]; tuner?: string }
  | { kind: 'component'; path: string; component: string; label: string; others: string[]; tuner?: string }
  | { kind: 'field'; path: string; component: string; field: string; label: string; others: string[]; tuner?: string }

type Named = { component: string; section: string; label: string; value: unknown; path: string; from: string }

function pickNamed(components: Options[], want: string): Named | null {
  const key = (v: string): string => v.toLowerCase().replace(/^m_/, '').replace(/[^a-z0-9]/g, '')
  const w = want.trim()
  const n = key(w)
  if (!n) return null
  type Row = Named & { alt: string[] }
  const rows: Row[] = []
  const later: Row[] = []
  for (const c of components) {
    const names = (c.names ?? {}) as Record<string, { path: string; from: string; alt: string[] }>
    const section = String(c.name ?? '')
    for (const [list, into] of [[(c.fields ?? {}) as Options, rows], [(c.hidden ?? {}) as Options, later]] as const) {
      for (const label of Object.keys(list)) {
        const info = names[label]
        into.push({ component: section.replace(/#\d+$/, ''), section, label, value: list[label], path: info?.path ?? '', from: info?.from ?? '', alt: info?.alt ?? [] })
      }
    }
  }
  rows.push(...later)
  const all = (r: Row): string[] => [r.label, ...r.alt]
  const lw = w.toLowerCase()
  const tiers: ((r: Row) => boolean)[] = [
    (r) => r.label === w,
    (r) => all(r).includes(w),
    (r) => all(r).some((x) => key(x) === n),
    (r) => n.length >= 3 && all(r).some((x) => x.toLowerCase().endsWith(` ${lw}`) || key(x.split('.').pop() ?? '') === n)
  ]
  for (const tier of tiers) {
    const hit = rows.find(tier)
    if (hit) return { component: hit.component, section: hit.section, label: hit.label, value: hit.value, path: hit.path, from: hit.from }
  }
  return null
}

class NoMatch extends Error {
  constructor(readonly want: string, readonly near: string[], filtered = '') {
    super(
      filtered
        ? `Nothing in ${filtered} matches "${want}": an agent filtered it to a few objects. ${near.length ? `Closest objects: ${near.map((p) => `'${p}'`).join(', ')}. ` : ''}tuner.open({ scene: true }) shows the whole scene again, replacing that filter.`
        : `Nothing in the scene matches "${want}". ${near.length ? `Closest objects: ${near.map((p) => `'${p}'`).join(', ')}. ` : ''}drift.look() lists the scene's objects. For a part of the app, use 'ui:<name>'.`
    )
  }
}


const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '')
const short = (icon: string): string => icon.replace(/^UnityEngine\.(Rendering\.)?/, '').replace(/^.*\./, '')

function uiKey(name: string): string {
  const k = name.trim().toLowerCase().replace(/[\s_]+/g, '-')
  return UI_ALIASES[k] ?? k
}

function linesOf(text: Lines, what: string): string[] {
  if (text === undefined || text === null) return []
  const list: unknown[] = Array.isArray(text) ? text : [text]
  if (list.some((t) => (typeof t === 'object' && t !== null) || typeof t === 'function')) throw new TypeError(`${what} takes text or a list of lines, got ${Array.isArray(text) ? 'a list with an object in it' : kindOf(text)}`)
  return list.map((t) => String(t ?? '').trim()).filter(Boolean)
}

export function driftApi(page: PageLike & Api, tuner: Api, point: Function, say: Function, ask: Function, reveal: (tab: string) => Promise<unknown>): Record<string, unknown> {
  async function ensureTuner(): Promise<void> {
    if (!(await tunerOpen(page))) await tuner.open({ scene: true })
  }

  function rank(rows: SceneRow[], want: string): SceneRow[] {
    const w = want.replace(/^\/+|\/+$/g, '')
    const lw = w.toLowerCase()
    const leaf = lw.slice(lw.lastIndexOf('/') + 1)
    const tiers = [
      rows.filter((r) => r.path === w),
      rows.filter((r) => r.path.toLowerCase() === lw),
      rows.filter((r) => r.path.toLowerCase().endsWith(`/${lw}`)),
      lw.includes('/') ? [] : rows.filter((r) => r.name.toLowerCase() === leaf)
    ]
    const hit = tiers.find((t) => t.length) ?? []
    return [...hit].sort((a, b) => Number(b.active) - Number(a.active) || a.depth - b.depth || a.path.length - b.path.length)
  }

  function alsoNamed(hits: SceneRow[]): string[] {
    const first = hits[0]
    if (!first) return []
    const scenes = new Set(hits.map((r) => r.scene ?? ''))
    const label = (r: SceneRow): string => (scenes.size > 1 && r.scene ? `${r.scene}/${r.path}` : r.path)
    const groups = new Map<string, SceneRow[]>()
    for (const r of hits) {
      const k = label(r)
      groups.set(k, [...(groups.get(k) ?? []), r])
    }
    const out: string[] = []
    for (const [k, rows] of groups) {
      const leaf = rows[0].name || k.slice(k.lastIndexOf('/') + 1)
      if (rows.includes(first)) {
        if (rows.length < 2) continue
        out.push(`${k}: ${rows.length - 1} more ${rows.length === 2 ? 'object has' : 'objects have'} this exact path (${rows.length} siblings named '${leaf}'). Reach the others with an index: '${k}[2]' is the second`)
        continue
      }
      out.push(rows.length > 1 ? `${k} (${rows.length} siblings named '${leaf}')` : k)
      if (out.length >= 4) break
    }
    return out
  }

  async function findObject(want: string, lazy = true): Promise<SceneRow[]> {
    const clean = want.replace(/^\/+|\/+$/g, '')
    if (!clean) return []
    let rows = await sceneRows(page)
    let hits = rank(rows, clean)
    if (hits.length || !lazy) return hits
    const leaf = clean.slice(clean.lastIndexOf('/') + 1)
    rows = await sceneRows(page, leaf, clean.includes('/') ? clean : '')
    hits = rank(rows, clean)
    if (hits.length) return hits
    const cut = clean.indexOf('/')
    if (cut > 0) {
      const tail = clean.slice(cut + 1)
      hits = rank(rows, tail)
      if (hits.length) return hits
    }
    return []
  }

  async function closest(want: string): Promise<string[]> {
    const leaf = want.replace(/\.[^/]*$/, '').split('/').pop() ?? want
    const seen = new Map<string, SceneRow>()
    for (const r of await sceneRows(page)) seen.set(r.path, r)
    for (const r of await sceneRows(page, leaf.slice(0, 3))) seen.set(r.path, r)
    const rows = [...seen.values()].map((r) => ({ key: r.path, path: r.path, scene: '', name: r.name }))
    return closestTunerRows(rows, leaf, 6, false)
  }

  async function componentsOf(path: string): Promise<string[]> {
    const data = (await inspectQuiet(page, path)) as { components?: { name: string }[] }
    return (data.components ?? []).map((c) => String(c.name))
  }

  async function checkComponent(path: string, component: string): Promise<string> {
    const names = await componentsOf(path)
    const hit = names.find((n) => norm(n.replace(/#\d+$/, '')) === norm(component))
    if (!hit) throw new Error(`${path} has no ${component} component. It has: ${names.join(', ') || 'none'}. Try drift.look('${path}').`)
    return hit.replace(/#\d+$/, '')
  }

  async function resolve(raw: unknown): Promise<Target> {
    if (typeof raw !== 'string' || !raw.trim()) throw new TypeError(`A target is a string: an object 'Player', a component 'Player/Rigidbody', a field 'Player/Rigidbody.mass', or a part of the app 'ui:inspector'. ${uiHelp()}`)
    const s = raw.trim()
    if (/^ui:/i.test(s)) {
      const key = uiKey(s.slice(3))
      if (!UI[key]) throw new Error(`There is no app part "${s}". ${uiHelp()}`)
      return { kind: 'ui', name: key, label: `ui:${key}` }
    }
    await ensureTuner()
    const tabs = tunerPinned(page) ? [] : await tunerTabList(page)
    if (tabs.filter((t) => t.view).length < 2) {
      try {
        return await resolveHere(s)
      } catch (e) {
        if (!(e instanceof NoMatch) || !(await filteredHere())) throw e
        throw new NoMatch(e.want, e.near, tunerTitle({ view: await tunerReady(page).catch(() => 'tuner') }))
      }
    }
    const start = await tunerReady(page)
    const order = tunerSearchOrder(tabs, start)
    const misses: { tab: { view: string; label: string }; miss: NoMatch }[] = []
    let at = start
    for (const tab of order) {
      if (tab.view !== at) at = await tunerReady(page, tab.view)
      try {
        const t = await resolveHere(s)
        if (at !== start && t.kind !== 'ui') t.tuner = tunerTitle(tab)
        return t
      } catch (e) {
        if (!(e instanceof NoMatch)) throw e
        misses.push({ tab, miss: e })
      }
    }
    if (at !== start) await tunerReady(page, start)
    const near = misses.filter((m) => m.miss.near.length).map((m) => `in ${tunerTitle(m.tab)}: ${m.miss.near.slice(0, 4).map((p) => `'${p}'`).join(', ')}`)
    throw new Error(`Nothing in the ${misses.length} open Tuners matches "${s}" (${misses.map((m) => tunerTitle(m.tab).replace(/^the /, '')).join(', ')}). ${near.length ? `Closest objects ${near.join('; ')}. ` : ''}drift.look() lists the objects of the Tuner in front; tuner.use(name) picks another one.`)
  }

  async function filteredHere(): Promise<boolean> {
    return Boolean(
      await page
        .evaluate(() => Array.from(document.querySelectorAll('button')).some((b) => b.textContent?.trim() === 'Clear filter' && (b as HTMLElement).offsetParent !== null))
        .catch(() => false)
    )
  }

  async function resolveHere(s: string): Promise<Target> {
    const found = (await resolveWith(s, false)) ?? (await resolveWith(s, true))
    if (found) return found
    const slash = s.lastIndexOf('/')
    const dot = s.indexOf('.', slash + 1)
    const base = dot > 0 ? s.slice(0, dot) : s
    const field = dot > 0 ? s.slice(dot + 1).trim() : ''
    const cut = base.lastIndexOf('/')
    if (cut < 0) {
      const sel = String(await tuner.selected().catch(() => ''))
      if (sel) {
        const names = await componentsOf(sel)
        const hit = names.find((n) => norm(n.replace(/#\d+$/, '')) === norm(base))
        if (hit) {
          const component = hit.replace(/#\d+$/, '')
          if (field) return { kind: 'field', path: sel, component, field, label: `${sel}/${component}.${field}`, others: [] }
          return { kind: 'component', path: sel, component, label: `${sel}/${component}`, others: [] }
        }
      }
    }
    throw new NoMatch(s, await closest(base))
  }

  async function resolveWith(s: string, lazy: boolean): Promise<Target | null> {
    const whole = await findObject(s, lazy)
    if (whole.length) return { kind: 'object', path: whole[0].path, label: whole[0].path, others: alsoNamed(whole) }
    const slash = s.lastIndexOf('/')
    const dot = s.indexOf('.', slash + 1)
    const base = dot > 0 ? s.slice(0, dot) : s
    const field = dot > 0 ? s.slice(dot + 1).trim() : ''
    if (field) {
      const obj = await findObject(base, lazy)
      if (obj.length) return { kind: 'field', path: obj[0].path, component: '', field, label: `${obj[0].path}.${field}`, others: alsoNamed(obj) }
    }
    const cut = base.lastIndexOf('/')
    if (cut <= 0) return null
    const obj = await findObject(base.slice(0, cut), lazy)
    if (!obj.length) return null
    const component = await checkComponent(obj[0].path, base.slice(cut + 1))
    const others = alsoNamed(obj)
    if (field) return { kind: 'field', path: obj[0].path, component, field, label: `${obj[0].path}/${component}.${field}`, others }
    return { kind: 'component', path: obj[0].path, component, label: `${obj[0].path}/${component}`, others }
  }

  async function revealPlayer(name: string, spot: unknown): Promise<unknown> {
    if (!PLAYER_PARTS.has(name) || !(spot instanceof Locator) || (await spot.count())) return spot
    try {
      await reveal('Unity Player')
      await spot.waitFor({ state: 'attached', timeout: 2000 })
    } catch {
    }
    return spot
  }

  function uiHelp(): string {
    return `App parts: ${Object.keys(UI).map((k) => `ui:${k}`).join(', ')}.`
  }

  async function spotOf(t: Target): Promise<unknown> {
    if (t.kind === 'ui') return revealPlayer(t.name, UI[t.name].find(page, tuner))
    if (t.kind === 'object') return tuner.object(t.path)
    if (t.kind === 'component') return tuner.component(t.component)
    return tuner.field(t.field, t.component ? { section: t.component } : {})
  }

  async function bringObject(t: Target, fly: boolean): Promise<void> {
    if (t.kind === 'ui') return
    const sel = String(await tuner.selected().catch(() => ''))
    if (fly && (t.kind === 'object' || sel !== t.path)) await tuner.focus(t.path)
    else if (sel !== t.path) await tuner.row(t.path).click()
  }

  async function bringShot(t: Target, sel: string): Promise<boolean> {
    if (t.kind === 'ui') return true
    if (t.kind !== 'object' && sel === t.path) return true
    const r = (await tuner.focus(t.path, { shot: true })) as Options
    return !r?.invisible
  }

  async function openField(t: Target): Promise<void> {
    if (t.kind !== 'field') return
    const section = t.component ? { section: t.component } : {}
    if (t.component) await (tuner.component(t.component) as Api)._reveal()
    else if (!(await hasField(t.field.split('.')[0]))) {
      const data = (await tuner.inspect(t.path, { fields: 0 }).catch(() => null)) as { components?: { name: string; folded?: boolean }[] } | null
      const folded = (data?.components ?? []).filter((c) => c.folded).map((c) => String(c.name).replace(/#\d+$/, ''))
      if (folded.length) throw new Error(`${t.path} shows no field "${t.field}" in its open components. Name the component: '${t.path}/<Component>.${t.field}'. Folded components: ${folded.join(', ')}.`)
    }
    const parts = t.field.split('.')
    for (let i = 1; i < parts.length; i++) {
      const group = tuner.field(parts.slice(0, i).join('.'), section) as Api
      await group.expand(true).catch(() => null)
    }
  }

  async function hasField(name: string): Promise<boolean> {
    try {
      await (tuner.field(name) as Api).value()
      return true
    } catch {
      return false
    }
  }

  async function named(t: Target): Promise<Named | null> {
    if (t.kind !== 'field') return null
    const data = (await (tuner._named as (p: string, c?: string) => Promise<Options>)(t.path, t.component || undefined).catch(() => null)) as { components?: Options[] } | null
    return pickNamed(data?.components ?? [], t.field)
  }

  async function fieldSpot(t: Target, hit: Named | null): Promise<{ spot: unknown; note?: string }> {
    if (t.kind !== 'field') return { spot: await spotOf(t) }
    const section = t.component ? { section: t.component } : {}
    const tries = hit && hit.label !== t.field ? [t.field, hit.label] : [t.field]
    if (!hit || hit.from !== 'uitk') {
      for (const name of tries) {
        const f = tuner.field(name, section) as Api
        try {
          await f.value()
          return { spot: await (f._reveal as () => Promise<unknown>)() }
        } catch {
        }
      }
    }
    if (hit?.from === 'uitk' && hit.path) {
      const loc = page.locator(`[data-tuner-inspector] [data-ti-section=${JSON.stringify(hit.section)}] [data-uitk-path=${JSON.stringify(hit.path)}]`).first()
      if (await loc.count()) return { spot: Object.assign(loc, { _part: 'value' }) }
    }
    if (!hit) return { spot: await spotOf(t) }
    return { spot: tuner.component(hit.component), note: `${hit.label} has no spot of its own in the ${hit.component} inspector, so Drift pointed at the component` }
  }

  async function fieldValue(t: Target): Promise<unknown> {
    if (t.kind !== 'field') return undefined
    return tuner.field(t.field, t.component ? { section: t.component } : {}).value().catch(() => undefined)
  }

  async function uiVisible(t: Target): Promise<unknown> {
    const spot = await spotOf(t)
    const name = t.kind === 'ui' ? t.name : ''
    if (spot instanceof Locator) {
      if (!(await spot.count())) throw new Error(`${t.label} isn't open in this workspace right now. ${name === 'player' || name === 'play' || name === 'console' ? 'Open it from New session (ui:new-session).' : ''}`.trim())
    }
    return spot
  }

  return {
    async show(target: unknown, text?: Lines): Promise<Options> {
      const before = String(await tuner.selected().catch(() => ''))
      const t = await resolve(target)
      const seen = await bringShot(t, before)
      const lines = linesOf(text, 'drift.show()')
      if (t.kind === 'ui') {
        const loose = await spotOf(t)
        if (loose instanceof Locator && !(await loose.count())) {
          for (const line of lines) await say(line, { wait: true, camera: false })
          return { shown: t.label, note: `${t.label} isn't on screen right now, so Drift said it without pointing` }
        }
      }
      if (t.kind === 'component') await (tuner.component(t.component) as Api)._reveal()
      const hit = await named(t)
      if (hit && t.kind === 'field' && !t.component) t.component = hit.component
      await openField(t)
      const inScene = t.kind === 'object' && !seen ? await scenePoint(page, t.path).catch(() => null) : null
      const at = t.kind === 'field' ? await fieldSpot(t, hit) : null
      const spot = t.kind === 'ui' ? await uiVisible(t) : t.kind === 'object' && !seen ? inScene ?? tuner.row(t.path) : at ? at.spot : await spotOf(t)
      if (!lines.length) lines.push('')
      for (const line of lines) await point(spot, line, { camera: false })
      const value = hit ? hit.value : await fieldValue(t)
      return {
        shown: t.label,
        ...(value !== undefined ? { value } : {}),
        ...(at?.note ? { note: at.note } : {}),
        ...(t.kind === 'object' && !seen ? { note: `${t.path} has nothing visible in the scene (no mesh or sprite), so the camera stayed and Drift pointed at ${inScene ? 'its position in the scene view' : 'it in the hierarchy'}` } : {}),
        ...(t.kind !== 'ui' && t.others.length ? { alsoNamedLikeThis: t.others } : {}),
        ...(t.kind !== 'ui' && t.tuner ? { tuner: t.tuner } : {})
      }
    },

    async say(text: Lines): Promise<void> {
      for (const line of linesOf(text, 'drift.say()')) await say(line, { wait: true, camera: false })
    },

    async ask(text: unknown, buttons?: string[]): Promise<string | null> {
      return (await ask(text, { buttons: buttons ?? ['Next'], camera: false })) as string | null
    },

    async look(target?: unknown): Promise<unknown> {
      if (target === undefined || target === null || target === '' || target === 'scene') {
        await ensureTuner()
        const rows = await sceneRows(page)
        const selected = String(await tuner.selected().catch(() => ''))
        const objects = rows
          .filter((r) => r.depth <= 2)
          .slice(0, 80)
          .map((r) => {
            const types = r.types ? r.types.split(',').join(', ') : r.icon ? short(r.icon) : ''
            return `${'  '.repeat(Math.max(0, r.path.split('/').length - 1))}${r.path}${types ? `: ${types}` : ''}${r.kids ? ' (has children)' : ''}${r.active ? '' : ' (inactive)'}`
          })
        const tabs = (await tunerTabList(page).catch(() => [])).filter((t) => t.view)
        const filtered = await filteredHere()
        const here = tabs.length > 1 || filtered ? await tunerReady(page).catch(() => '') : ''
        const others = here ? tabs.filter((t) => t.view !== here).map(tunerTitle) : []
        return {
          ...(here ? { tuner: `${tunerTitle({ view: here })}${filtered ? ', filtered by an agent' : ''}` } : {}),
          ...(others.length ? { otherTuners: others } : {}),
          selected,
          objects,
          next: `drift.look('<object>') lists its components and values. drift.look('ui') lists the app's parts.${others.length ? ' tuner.use(name) lists the objects of another Tuner.' : ''}${filtered ? ' tuner.open({ scene: true }) shows the whole scene again, replacing the filter.' : ''}`
        }
      }
      if (typeof target === 'string' && /^ui:?$/i.test(target.trim())) {
        const open = (await page.evaluate((sels: Record<string, string>) => {
          const out: Record<string, boolean> = {}
          for (const [k, sel] of Object.entries(sels)) {
            out[k] = Array.from(document.querySelectorAll(sel)).some((el) => {
              const r = el.getBoundingClientRect()
              return r.width > 4 && r.height > 4 && !!(el as HTMLElement).offsetParent
            })
          }
          return out
        }, PANELS)) as Record<string, boolean>
        const onScreen = Object.keys(PANELS).filter((k) => open[k])
        return { onScreen: onScreen.map((k) => `ui:${k}`), parts: Object.fromEntries(Object.entries(UI).map(([k, v]) => [`ui:${k}`, v.what])) }
      }
      const t = await resolve(target)
      if (t.kind === 'ui') return { part: t.label, what: UI[t.name].what }
      if (t.kind === 'object') {
        const data = (await tuner.inspect(t.path)) as Options
        const rows = await sceneRows(page)
        const children = rows.filter((r) => r.path.startsWith(`${t.path}/`) && !r.path.slice(t.path.length + 1).includes('/')).map((r) => r.name)
        return { ...data, ...(children.length ? { children } : {}), ...(t.others.length ? { alsoNamedLikeThis: t.others } : {}), ...(t.tuner ? { tuner: t.tuner } : {}) }
      }
      if (t.kind === 'component') {
        const data = (await tuner.inspect(t.path, { component: t.component })) as { path: string; components: Options[] }
        return { path: data.path, ...(data.components[0] ?? {}) }
      }
      const hit = await named(t)
      if (hit) return { path: t.path, component: hit.component, field: hit.label, value: hit.value }
      await bringObject(t, false)
      const value = await fieldValue(t)
      if (value === undefined) {
        const where = t.component ? `${t.path}/${t.component}` : t.path
        throw new Error(`${where} has no field "${t.field}". drift.look('${where}') lists its fields with their values.`)
      }
      return { path: t.path, component: t.component || undefined, field: t.field, value }
    },

    async click(target: unknown): Promise<string> {
      const t = await resolve(target)
      if (t.kind === 'object') {
        await tuner.row(t.path).click()
        return `selected ${t.path}`
      }
      await bringObject(t, false)
      const spot = (t.kind === 'ui' ? await uiVisible(t) : await spotOf(t)) as Api
      await spot.click()
      return `clicked ${t.label}`
    },

    async type(target: unknown, text: unknown): Promise<string> {
      if (text === undefined || text === null) throw new TypeError("drift.type(target, text) needs the text to type, like drift.type('ui:search', 'Cart')")
      const t = await resolve(target)
      const value = String(text ?? '')
      if (t.kind === 'field') {
        await bringObject(t, false)
        await tuner.field(t.field, t.component ? { section: t.component } : {}).set(value)
        return `set ${t.label} to ${value}`
      }
      if (t.kind !== 'ui') throw new Error(`drift.type() types into a box of the app ('ui:search') or sets a field ('Player/Rigidbody.mass'), not ${t.label}`)
      const spot = (await uiVisible(t)) as Api
      if (spot instanceof Locator) {
        await spot.click()
        await spot.fill('')
        await spot.pressSequentially(value)
      } else {
        await spot.click()
        await page.keyboard.type(value)
      }
      return `typed into ${t.label}`
    },

    async key(a: unknown, b?: unknown): Promise<string> {
      if (a === undefined || a === null || a === '') throw new TypeError("drift.key(key) needs a key name, like drift.key('Escape'), or drift.key('ui:scene', 'F')")
      if (b === undefined) {
        await page.keyboard.press(String(a))
        return `pressed ${String(a)}`
      }
      const t = await resolve(a)
      await bringObject(t, false)
      const spot = (t.kind === 'ui' ? await uiVisible(t) : await spotOf(t)) as Api
      if (spot instanceof Locator) await spot.press(String(b))
      else {
        await spot.hover()
        await page.keyboard.press(String(b))
      }
      return `pressed ${String(b)} on ${t.label}`
    },

    async scroll(target: unknown, amount: unknown = 300): Promise<string> {
      const dy = Number(amount)
      if (typeof amount === 'boolean' || !Number.isFinite(dy) || dy === 0) throw new TypeError(`drift.scroll(target, dy) needs a number of pixels like 300 (negative goes up), got ${String(amount)}`)
      const t = await resolve(target)
      await bringObject(t, false)
      const spot = (t.kind === 'ui' ? await uiVisible(t) : await spotOf(t)) as Api
      if (spot instanceof Locator) {
        await spot.hover()
        await page.mouse.wheel(0, dy)
      } else await spot.wheel(0, dy)
      return `scrolled ${t.label} by ${dy}`
    }
  }
}
