export const DASHBOARD_COLS = 12
export const DASHBOARD_ROW_PX = 40
export const DASHBOARD_MIN_EVERY_S = 2
export const DASHBOARD_TAB_LABEL = 'Dashboard'

export interface DashboardTile {
  widget: string
  x: number
  y: number
  w: number
  h: number
}

export interface DashboardPage {
  id: string
  title: string
  tiles: DashboardTile[]
}

export interface DashboardDoc {
  title: string
  pages: DashboardPage[]
}

export interface DashboardLoad {
  project: string
  dir: string
  exists: boolean
  doc: DashboardDoc
  error: string | null
  widgets: string[]
  state: Record<string, Record<string, unknown>>
}

export type DashboardEdit =
  | { kind: 'tiles'; page: string; tiles: { index: number; x: number; y: number; w: number; h: number }[] }
  | { kind: 'addPage'; title: string }
  | { kind: 'renamePage'; page: string; title: string }
  | { kind: 'movePage'; page: string; to: number }
  | { kind: 'deletePage'; page: string }
  | { kind: 'create'; title: string }

export interface DashboardFetchRequest {
  id?: string
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string
  as?: 'json' | 'text'
}

export interface DashboardFetchResult {
  ok: boolean
  status: number
  data?: unknown
  error?: string
  ms: number
  at: number
  bytes: number
}

export interface DashboardHandleRequest {
  name: string
  args?: unknown[]
  player?: string
}

export interface DashboardHandleResult {
  ok: boolean
  value?: unknown
  logs?: string[]
  status?: string
  error?: string
  at: number
  ms: number
}

export interface DashboardGitRequest {
  log?: number
  status?: boolean
}

export interface DashboardGitResult {
  ok: boolean
  branch?: string | null
  ahead?: number
  behind?: number
  changes?: { path: string; status: string; staged: boolean }[]
  log?: { hash: string; message: string; author: string; date: number }[]
  error?: string
  at: number
}

export interface DashboardLogsRequest {
  source?: 'unity' | 'app'
  grep?: string
  tail?: number
}

export interface DashboardLogsResult {
  ok: boolean
  lines: string[]
  error?: string
  at: number
}

export interface DashboardFileResult {
  ok: boolean
  data?: unknown
  error?: string
  at: number
  path: string
}

export type DashboardAlertStatus = 'ok' | 'firing' | 'error' | 'starting'

export interface DashboardAlertState {
  id: string
  file: string
  status: DashboardAlertStatus
  every: number
  to: 'agent' | 'new'
  message?: string
  error?: string
  checkedAt?: number
  firedAt?: number
  deliveredTo?: string | null
  undelivered?: boolean
}

export interface DashboardAlertsEvent {
  project: string
  alerts: DashboardAlertState[]
}

export interface DashboardOpenRequest {
  projectPath: string
  page?: string
  ptyId?: string
}

export function dashboardDir(project: string): string {
  return `${project.replace(/\\/g, '/').replace(/\/+$/, '')}/.sspace/dashboard`
}

export function widgetFile(project: string, widget: string): string {
  return `${dashboardDir(project)}/widgets/${widget}.tsx`
}

export function isWidgetId(id: string): boolean {
  return /^[A-Za-z0-9][\w.-]{0,63}$/.test(id) && !id.includes('..')
}

export function dashboardKindOf(file: string): 'widget' | 'alert' | null {
  const f = file.replace(/\\/g, '/')
  if (/\/\.sspace\/dashboard\/widgets\/[^/]+\.tsx$/.test(f)) return 'widget'
  if (/\/\.sspace\/dashboard\/alerts\/[^/]+\.ts$/.test(f)) return 'alert'
  return null
}

function num(v: unknown, fallback: number, min: number, max: number): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : fallback
  return Math.min(max, Math.max(min, n))
}

function slug(text: string, taken: Set<string>): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) || 'page'
  let id = base
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`
  return id
}

export function pageId(title: string, taken: Iterable<string>): string {
  return slug(title, new Set(taken))
}

export function normalizeDashboard(raw: unknown, fallbackTitle: string): { doc: DashboardDoc; problems: string[] } {
  const problems: string[] = []
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
  if (!obj) problems.push('dashboard.json must be an object with "title" and "pages".')
  const title = typeof obj?.title === 'string' && obj.title.trim() ? obj.title.trim() : fallbackTitle
  const pagesRaw = Array.isArray(obj?.pages) ? (obj?.pages as unknown[]) : []
  if (obj && !Array.isArray(obj.pages)) problems.push('"pages" must be an array.')
  const taken = new Set<string>()
  const pages: DashboardPage[] = []
  pagesRaw.forEach((p, i) => {
    const po = p && typeof p === 'object' ? (p as Record<string, unknown>) : {}
    const ptitle = typeof po.title === 'string' && po.title.trim() ? po.title.trim() : `Page ${i + 1}`
    let id = typeof po.id === 'string' && po.id.trim() ? po.id.trim() : slug(ptitle, taken)
    if (taken.has(id)) id = slug(id, taken)
    taken.add(id)
    const tiles: DashboardTile[] = []
    for (const t of Array.isArray(po.tiles) ? po.tiles : []) {
      const to = t && typeof t === 'object' ? (t as Record<string, unknown>) : {}
      const widget = typeof to.widget === 'string' ? to.widget.trim() : ''
      if (!widget) {
        problems.push(`Page "${id}" has a tile without "widget".`)
        continue
      }
      const w = num(to.w, 4, 1, DASHBOARD_COLS)
      tiles.push({ widget, x: num(to.x, 0, 0, DASHBOARD_COLS - w), y: num(to.y, 0, 0, 999), w, h: num(to.h, 4, 1, 60) })
    }
    pages.push({ id, title: ptitle, tiles })
  })
  return { doc: { title, pages }, problems }
}

const SECRET = /\{\{\s*secret:([\w.-]+)\s*\}\}/g

export function secretNames(text: string): string[] {
  return [...text.matchAll(SECRET)].map((m) => m[1])
}

export function fillSecrets(text: string, secrets: Record<string, string>, missing: Set<string>): string {
  return text.replace(SECRET, (_m, name: string) => {
    const v = secrets[name]
    if (typeof v !== 'string') {
      missing.add(name)
      return ''
    }
    return v
  })
}

export function maskSecrets(text: string, secrets: Record<string, string>): string {
  let out = text
  const values = Object.entries(secrets)
    .filter(([, v]) => typeof v === 'string' && v.length >= 4)
    .sort((a, b) => b[1].length - a[1].length)
  for (const [name, v] of values) {
    out = out.split(v).join(`{{secret:${name}}}`)
    const enc = encodeURIComponent(v)
    if (enc !== v) out = out.split(enc).join(`{{secret:${name}}}`)
  }
  return out
}

export function maskDeep<T>(value: T, secrets: Record<string, string>): T {
  if (!Object.keys(secrets).length) return value
  if (typeof value === 'string') return maskSecrets(value, secrets) as T
  if (Array.isArray(value)) return value.map((v) => maskDeep(v, secrets)) as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = maskDeep(v, secrets)
    return out as T
  }
  return value
}

export function buildDashboardAsk(opts: {
  widget: string
  title: string
  file: string
  page: string
  question: string
  snapshot: string
}): string {
  return [
    `About the "${opts.title}" tile on the "${opts.page}" page of the Satura Space dashboard (widget ${opts.file}):`,
    opts.question.trim(),
    opts.snapshot ? `What the tile has now: ${opts.snapshot}` : '',
    'The dashboard lives in .sspace/dashboard/. Edit the files, then check with satura_exec dashboard.read().'
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function buildAlertMessage(alert: { id: string; file: string; message: string; data: string }): string {
  return [
    `Dashboard alert "${alert.id}" fired: ${alert.message}`,
    alert.data ? `Data: ${alert.data}` : '',
    `Alert file: ${alert.file}. Look into it and tell me what you find.`
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function snapshotText(value: unknown, max = 1500): string {
  let text: string
  try {
    text = JSON.stringify(value) ?? ''
  } catch {
    text = String(value)
  }
  return text.length > max ? `${text.slice(0, max)}…` : text
}
