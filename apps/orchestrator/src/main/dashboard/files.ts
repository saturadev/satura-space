import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  dashboardDir,
  isWidgetId,
  normalizeDashboard,
  pageId,
  type DashboardEdit,
  type DashboardLoad
} from '@shared/dashboard'
import { ensureSspaceDir } from '../sspace'

const queues = new Map<string, Promise<unknown>>()

function queued<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job)
  const tail = run.catch(() => null)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

export function cleanProject(project: string): string {
  return project.replace(/\\/g, '/').replace(/\/+$/, '')
}

async function readJson(file: string): Promise<{ value: unknown; exists: boolean; error: string | null }> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return { value: null, exists: false, error: null }
  }
  try {
    return { value: JSON.parse(text), exists: true, error: null }
  } catch (e) {
    return { value: null, exists: true, error: `${basename(file)} is not valid JSON: ${e instanceof Error ? e.message : String(e)}` }
  }
}

async function writeJson(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`)
  await rename(tmp, file)
}

async function listIds(dir: string, ext: string): Promise<string[]> {
  try {
    return (await readdir(dir))
      .filter((f) => f.endsWith(ext))
      .map((f) => f.slice(0, -ext.length))
      .filter(isWidgetId)
      .sort()
  } catch {
    return []
  }
}

export function listAlertIds(project: string): Promise<string[]> {
  return listIds(join(dashboardDir(project), 'alerts'), '.ts')
}

export async function loadDashboard(rawProject: string): Promise<DashboardLoad> {
  const project = cleanProject(rawProject)
  const dir = dashboardDir(project)
  const fallback = basename(project) || 'Dashboard'
  const [main, state, widgets] = await Promise.all([
    readJson(join(dir, 'dashboard.json')),
    readJson(join(dir, 'state.json')),
    listIds(join(dir, 'widgets'), '.tsx')
  ])
  const { doc, problems } = main.exists && !main.error ? normalizeDashboard(main.value, fallback) : { doc: { title: fallback, pages: [] }, problems: [] }
  const error = main.error ?? (problems.length ? problems.join('\n') : null)
  const st = state.value && typeof state.value === 'object' && !Array.isArray(state.value) ? (state.value as Record<string, Record<string, unknown>>) : {}
  return { project, dir, exists: main.exists, doc, error, widgets, state: st }
}

type RawDoc = { title?: unknown; pages?: unknown[]; [k: string]: unknown }
type RawPage = { id?: unknown; title?: unknown; tiles?: unknown[]; [k: string]: unknown }

function pagesOf(raw: RawDoc, fallback: string): RawPage[] {
  const { doc } = normalizeDashboard(raw, fallback)
  const list = Array.isArray(raw.pages) ? raw.pages : []
  return doc.pages.map((p, i) => {
    const orig = list[i] && typeof list[i] === 'object' ? (list[i] as RawPage) : {}
    return { ...orig, id: p.id, title: p.title, tiles: Array.isArray(orig.tiles) ? orig.tiles : [] }
  })
}

export function editDashboard(rawProject: string, edit: DashboardEdit): Promise<DashboardLoad> {
  const project = cleanProject(rawProject)
  return queued(project, async () => {
    const dir = dashboardDir(project)
    const file = join(dir, 'dashboard.json')
    const cur = await readJson(file)
    if (cur.error) throw new Error(`${cur.error} Fix it first: the layout was not saved.`)
    const fallback = basename(project) || 'Dashboard'
    const raw: RawDoc = cur.value && typeof cur.value === 'object' && !Array.isArray(cur.value) ? { ...(cur.value as RawDoc) } : { title: fallback, pages: [] }
    let pages = pagesOf(raw, fallback)
    const at = (id: string): number => pages.findIndex((p) => p.id === id)
    if (edit.kind === 'create') {
      if (!cur.exists) {
        raw.title = edit.title || fallback
        pages = [{ id: 'main', title: 'Main', tiles: [] }]
      }
    } else if (edit.kind === 'tiles') {
      const p = pages[at(edit.page)]
      if (!p) throw new Error(`No page ${edit.page}.`)
      const valid = (t: unknown): boolean => !!t && typeof t === 'object' && typeof (t as { widget?: unknown }).widget === 'string' && !!String((t as { widget: string }).widget).trim()
      const rawAt: number[] = []
      ;(p.tiles ?? []).forEach((t, i) => {
        if (valid(t)) rawAt.push(i)
      })
      const tiles = [...(p.tiles ?? [])]
      for (const m of edit.tiles) {
        const i = rawAt[m.index]
        if (i === undefined) throw new Error(`No tile ${m.index} on page ${edit.page}.`)
        tiles[i] = { ...(tiles[i] as Record<string, unknown>), x: m.x, y: m.y, w: m.w, h: m.h }
      }
      pages[at(edit.page)] = { ...p, tiles }
    } else if (edit.kind === 'addPage') {
      const title = edit.title.trim() || `Page ${pages.length + 1}`
      pages.push({ id: pageId(title, pages.map((p) => String(p.id))), title, tiles: [] })
    } else if (edit.kind === 'renamePage') {
      const i = at(edit.page)
      if (i < 0) throw new Error(`No page ${edit.page}.`)
      pages[i] = { ...pages[i], title: edit.title.trim() || pages[i].title }
    } else if (edit.kind === 'movePage') {
      const i = at(edit.page)
      if (i < 0) throw new Error(`No page ${edit.page}.`)
      const [p] = pages.splice(i, 1)
      pages.splice(Math.max(0, Math.min(pages.length, edit.to)), 0, p)
    } else if (edit.kind === 'deletePage') {
      const i = at(edit.page)
      if (i < 0) throw new Error(`No page ${edit.page}.`)
      pages.splice(i, 1)
    }
    const next = { ...raw, title: raw.title ?? fallback, pages }
    await ensureSspaceDir(join(project, '.sspace'))
    await mkdir(join(dir, 'widgets'), { recursive: true })
    await writeJson(file, next)
    return loadDashboard(project)
  })
}

const stateTimers = new Map<string, { timer: ReturnType<typeof setTimeout>; patch: Record<string, Record<string, unknown>> }>()

export function saveWidgetState(rawProject: string, widget: string, key: string, value: unknown): void {
  const project = cleanProject(rawProject)
  if (!isWidgetId(widget) || !key) return
  const pending = stateTimers.get(project) ?? { timer: setTimeout(() => {}, 0), patch: {} }
  clearTimeout(pending.timer)
  pending.patch[widget] = { ...(pending.patch[widget] ?? {}), [key]: value }
  pending.timer = setTimeout(() => {
    stateTimers.delete(project)
    void queued(`${project}#state`, async () => {
      const file = join(dashboardDir(project), 'state.json')
      const cur = await readJson(file)
      const base = cur.value && typeof cur.value === 'object' && !Array.isArray(cur.value) ? (cur.value as Record<string, Record<string, unknown>>) : {}
      for (const [w, kv] of Object.entries(pending.patch)) base[w] = { ...(base[w] ?? {}), ...kv }
      await mkdir(dashboardDir(project), { recursive: true })
      await writeJson(file, base)
    }).catch((e: unknown) => console.warn(`[dashboard] state.json write failed: ${e instanceof Error ? e.message : String(e)}`))
  }, 400)
  stateTimers.set(project, pending)
}

let secretsCache = new Map<string, { at: number; value: Record<string, string> }>()

export async function readSecrets(rawProject: string): Promise<Record<string, string>> {
  const project = cleanProject(rawProject)
  const hit = secretsCache.get(project)
  if (hit && Date.now() - hit.at < 1000) return hit.value
  const res = await readJson(join(dashboardDir(project), 'secrets.json'))
  const value: Record<string, string> = {}
  if (res.value && typeof res.value === 'object' && !Array.isArray(res.value)) {
    for (const [k, v] of Object.entries(res.value as Record<string, unknown>)) if (typeof v === 'string') value[k] = v
  }
  if (secretsCache.size > 32) secretsCache = new Map()
  secretsCache.set(project, { at: Date.now(), value })
  return value
}
