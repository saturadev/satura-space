export const PUSH_INNER_VERSION = 1
export const PUSH_INNER_AAD = 'satura-remote-push v1'
export const PUSH_DB_NAME = 'satura-remote'
export const PUSH_DB_STORE = 'keys'
export const PUSH_OPEN_KEY = 'push-open'
export const PUSH_GENERIC_TAG = 'satura-generic'
export const PUSH_GENERIC_TITLE = 'Satura Remote'
export const PUSH_GENERIC_BODY = 'Something on your desktop may need you. Open Satura Remote to see it.'

export type PushCategory = 'ask' | 'finished' | 'tuner' | 'unity' | 'alert'

export const PUSH_CATEGORIES: readonly PushCategory[] = ['ask', 'finished', 'tuner', 'unity', 'alert']

export interface PushPrefs {
  on: boolean
  ask: boolean
  finished: boolean
  tuner: boolean
  unity: boolean
  alert: boolean
}

export const PUSH_DEFAULT_PREFS: PushPrefs = { on: true, ask: true, finished: true, tuner: true, unity: true, alert: true }

export type PushLinkKind = 'agent' | 'tuner' | 'unity' | 'alert' | 'report' | 'test'

export interface PushLink {
  kind: PushLinkKind
  workspaceId?: string
  tabId?: string
  ptyId?: string
  projectPath?: string
  view?: string
  file?: string
}

export interface PushNote {
  v: number
  id: string
  tag: string
  cat: PushCategory | 'test'
  title: string
  body: string
  link: PushLink
  at: number
  loud?: boolean
  clear?: string[]
}

export type ActivityKind = PushCategory | 'report'

export interface ActivityEntry {
  id: string
  kind: ActivityKind
  title: string
  body: string
  at: number
  count: number
  open: boolean
  link: PushLink
}

export interface PushSealed {
  v: number
  n: string
  c: string
}

export interface PushRegister {
  endpoint: string
  p256dh: string
  auth: string
  token: string
  key: string
  prefs?: Partial<PushPrefs>
}

export interface PushState {
  supported: boolean
  registered: boolean
  endpoint: string | null
  prefs: PushPrefs
  lastSent: { at: number; status: number; title: string } | null
}

export function pushKeyName(hostId: string): string {
  return `push:${hostId}`
}

export function pushOpenKey(hostId: string): string {
  return `${PUSH_OPEN_KEY}:${hostId}`
}

export function desktopNameKey(hostId: string): string {
  return `desktop:${hostId}`
}

export function pushGenericBody(mac: string): string {
  return mac ? `Something on ${mac} may need you. Open Satura Remote to see it.` : PUSH_GENERIC_BODY
}

export function cleanPushPrefs(raw: unknown, base: PushPrefs = PUSH_DEFAULT_PREFS): PushPrefs {
  const r = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  const pick = (k: keyof PushPrefs): boolean => (typeof r[k] === 'boolean' ? (r[k] as boolean) : base[k])
  return { on: pick('on'), ask: pick('ask'), finished: pick('finished'), tuner: pick('tuner'), unity: pick('unity'), alert: pick('alert') }
}

export function readPushLink(raw: unknown): PushLink | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kinds: PushLinkKind[] = ['agent', 'tuner', 'unity', 'alert', 'report', 'test']
  if (!kinds.includes(r.kind as PushLinkKind)) return null
  const text = (k: string, max: number): Record<string, string> => (typeof r[k] === 'string' && r[k] ? { [k]: (r[k] as string).slice(0, max) } : {})
  return { kind: r.kind as PushLinkKind, ...text('workspaceId', 80), ...text('tabId', 80), ...text('ptyId', 80), ...text('projectPath', 1024), ...text('view', 200), ...text('file', 1024) }
}
