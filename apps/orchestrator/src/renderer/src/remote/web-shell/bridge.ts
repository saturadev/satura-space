import { create } from 'zustand'
import type { WireAction } from '../../lib/actions/action-tree'
import type { InputBox } from '../claude-input'
import { onShellMessage, shellFn } from '../shell-bus'
import { pairTextInUrl } from '../pair-marker'
import { getMac, hostKey, macLabel, pathHostId } from '../macs'
import { readAllowance, type RemoteAllowance } from '@shared/remote-protocol'
import type { ActivityEntry } from '@shared/remote-push'
import { afterPaint, logTap, navigate, tapStartedAt } from '../motion'
import { accountReady, configNow, onAccountChange, ticketNow } from '../account'

export type Conn = 'connecting' | 'online' | 'offline' | 'unpaired' | 'busy' | 'replaced' | 'signin' | 'denied' | 'away'
export type Outage = 'stuck' | 'offline' | 'relay'
export type Fit = 'update' | 'relay'
export type Dot = 'work' | 'wait' | 'ok' | 'err' | 'off'

export interface Option {
  key: string
  label: string
  selected: boolean
}

export interface Chip {
  id: string
  label: string
  kind: string
  dot: Dot | null
  badge: string | null
  group: string
  groupActive: boolean
}

export interface ChipGroup {
  id: string
  name: string
  count: number
  focused: boolean
}

export interface Panel {
  kind: string
  tabId: string | null
  ptyId: string | null
  composer: string
  agent: boolean
  working: boolean
  menu: Option[]
  canBack: boolean
  stack: string[]
  actions: WireAction[]
  tabActions: WireAction[]
  workspaceActions: WireAction[]
}

export interface Workspace {
  id: string
  title: string
  subtitle: string
  project: string
  root: string
  tabs: Chip[]
  groups: ChipGroup[]
  selected: string | null
  restore?: { title: string; tabId: string | null } | null
  panel: Panel | null
}

export interface Project {
  id: string
  title: string
  path: string
  unity: boolean
  agents: { tabId: string; label: string; status: string; dot: Dot }[]
}

export interface ActivityItem extends ActivityEntry {
  options: Option[]
}

export interface PickerItem {
  id: string
  label: string
  detail?: string
  icon?: string
  badge?: string
}

export interface Picker {
  seq: number
  query: string
  kind: string
  title: string
  placeholder: string
  loading: boolean
  empty: string
  sections: { title: string; items: PickerItem[] }[]
}

export interface Confirm {
  origin: string
  id: number
  title: string
  message: string
  confirmLabel?: string
  secondaryLabel?: string
  cancelLabel?: string
  danger?: boolean
  onAnswer?: (choice: 'confirm' | 'secondary' | 'cancel') => void
}

export interface Toast {
  id: number
  text: string
  icon: 'warn' | 'ok'
  retry: (() => void) | null
}

export interface MenuRequest {
  key: number
  tree: WireAction[]
  title: string
  at: { x: number; y: number; w?: number; h?: number }
  seq: number | null
  sheet: boolean
  onPick?: (item: WireAction) => void
}

export interface Prompt {
  item: WireAction
  seq: number | null
  onSubmit?: (value: string) => void
}

export type Tab = 'projects' | 'activity' | 'settings'
export type NotifyKind = ActivityItem['kind']

export interface ShellState {
  webReady: number
  conn: Conn
  detail: string
  hostName: string
  version: string
  hostGone: boolean
  outage: Outage | null
  fit: Fit | null
  halted: '' | 'cancelled' | 'failed'
  paired: boolean | null
  verify: boolean
  explain: boolean
  allow: { device: string } | null
  access: 'local' | 'any' | null
  wasOnline: boolean
  awayCheck: 'idle' | 'checking' | 'error'
  awayCheckedAt: number
  fresh: number
  projects: Project[]
  activeProjectId: string | null
  activity: ActivityItem[]
  workspace: Workspace | null
  openId: string | null
  tab: Tab
  switcher: boolean
  pending: Record<string, true>
  working: { control: string; text: string }[]
  optimistic: Record<string, boolean>
  selecting: string | null
  toast: Toast | null
  banner: ActivityItem | null
  picker: Picker | null
  confirm: Confirm | null
  menu: MenuRequest | null
  prompt: Prompt | null
  files: string[] | null
  filesFocus: string | null
  typing: boolean
  ctrl: boolean
  editing: boolean
  inputBox: { ptyId: string; box: InputBox } | null
  resuming: boolean
  account: string | false | null
  allowance: RemoteAllowance | null
  notify: Record<NotifyKind, boolean>
}

const NOTIFY_KEY = hostKey('satura-remote-notify')
const OPEN_KEY = hostKey('satura-remote-open')
const NOTIFY_DEFAULTS: Record<NotifyKind, boolean> = { ask: true, finished: true, tuner: true, unity: true, alert: true, report: false }

const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
const realWrite = clipboard?.writeText ? clipboard.writeText.bind(clipboard) : null
const realRead = clipboard?.readText ? clipboard.readText.bind(clipboard) : null

function readJson<T>(store: Storage | undefined, key: string): T | null {
  try {
    const raw = store?.getItem(key)
    return raw ? (JSON.parse(raw) as T) : null
  } catch {
    return null
  }
}

function writeJson(store: Storage | undefined, key: string, value: unknown): void {
  try {
    if (value === null) store?.removeItem(key)
    else store?.setItem(key, JSON.stringify(value))
  } catch {
  }
}

export function storedPairing(): boolean {
  const m = getMac(pathHostId())
  return !!m && !m.removed
}

export function pairedName(): string {
  const m = getMac(pathHostId())
  return m ? macLabel(m) : ''
}

function checkAccount(): void {
  const show = (): void => {
    const c = configNow()
    const t = ticketNow()
    useShell.setState({ account: !c ? null : !c.account ? false : t ? t.email || t.sub : null })
  }
  onAccountChange(show)
  void accountReady('the desktop page opened').then(({ config, ticket }) => {
    console.info(`[web-shell] account: ${!config ? 'unknown, no phone config' : !config.account ? 'none on this relay' : ticket ? `signed in as ${ticket.email || ticket.sub}` : 'signed out'}`)
    show()
  })
}

function pairInUrl(): boolean {
  return !!pairTextInUrl()
}

export function deviceName(): string {
  const ua = navigator.userAgent
  if (/iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return 'iPad'
  if (/iPhone/.test(ua)) return 'iPhone'
  if (/Android/.test(ua)) return 'Android phone'
  return 'Browser'
}

function tabFromUrl(): Tab {
  const want = new URLSearchParams(location.search).get('tab')
  if (want === null) return 'projects'
  history.replaceState(history.state, '', location.pathname + location.hash)
  return want === 'settings' || want === 'activity' ? want : 'projects'
}

export const useShell = create<ShellState>(() => ({
  webReady: 0,
  conn: 'connecting',
  detail: '',
  hostName: '',
  version: '',
  hostGone: false,
  outage: null,
  fit: null,
  halted: '',
  paired: null,
  verify: false,
  explain: false,
  allow: null,
  access: null,
  wasOnline: false,
  awayCheck: 'idle',
  awayCheckedAt: 0,
  fresh: 0,
  projects: [],
  activeProjectId: null,
  activity: [],
  workspace: null,
  openId: null,
  tab: tabFromUrl(),
  switcher: false,
  pending: {},
  working: [],
  optimistic: {},
  selecting: null,
  toast: null,
  banner: null,
  picker: null,
  confirm: null,
  menu: null,
  prompt: null,
  files: null,
  filesFocus: null,
  typing: false,
  ctrl: false,
  editing: false,
  inputBox: null,
  resuming: false,
  account: null,
  allowance: null,
  notify: { ...NOTIFY_DEFAULTS, ...(readJson<Record<NotifyKind, boolean>>(window.localStorage, 'satura-remote-notify') ?? {}), ...(readJson<Record<NotifyKind, boolean>>(window.localStorage, NOTIFY_KEY) ?? {}) }
}))

export function call(fn: string, ...args: unknown[]): unknown {
  const f = shellFn(fn)
  if (!f) return null
  try {
    return f(...args)
  } catch (e) {
    console.warn(`[web-shell] ${fn} threw: ${(e as Error)?.message ?? String(e)}`)
    return null
  }
}

export function haptic(kind: 'tap' | 'success' | 'error' = 'tap'): void {
  try {
    navigator.vibrate?.(kind === 'success' ? [8, 40, 8] : kind === 'error' ? [20, 60, 20] : 8)
  } catch {
  }
}

let toastSeq = 0
let toastTimer = 0

export function showToast(text: string, retry: (() => void) | null = null, icon: Toast['icon'] = 'warn'): void {
  window.clearTimeout(toastTimer)
  const id = ++toastSeq
  useShell.setState({ toast: { id, text, icon, retry } })
  toastTimer = window.setTimeout(() => {
    if (useShell.getState().toast?.id === id) useShell.setState({ toast: null })
  }, 5000)
}

export function dismissToast(): void {
  window.clearTimeout(toastTimer)
  useShell.setState({ toast: null })
}

let bannerTimer = 0

function showBanner(item: ActivityItem): void {
  window.clearTimeout(bannerTimer)
  useShell.setState({ banner: item })
  bannerTimer = window.setTimeout(() => {
    if (useShell.getState().banner?.id === item.id) useShell.setState({ banner: null })
  }, 5000)
}

export function dismissBanner(): void {
  window.clearTimeout(bannerTimer)
  useShell.setState({ banner: null })
}

function setPending(control: string, on: boolean, pill?: string): void {
  const st = useShell.getState()
  const cur = st.pending
  if (!!cur[control] === on) return
  const next = { ...cur }
  if (on) next[control] = true
  else delete next[control]
  const working = on ? (pill ? [...st.working, { control, text: pill }] : st.working) : st.working.filter((w) => w.control !== control)
  useShell.setState({ pending: next, ...(working !== st.working ? { working } : {}) })
}

export interface RunOpts {
  onOk?: () => void
  onFail?: () => void
  until?: (s: ShellState) => boolean
  settle?: number
  pill?: string
  retry?: boolean
}

interface Wait {
  control: string
  label: string
  timer: number
  opts: RunOpts
  again: () => void
  tap: number
  shown: number | null
  acked: number | null
}

let nextReq = 1
const waits = new Map<number, Wait>()

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? '')
}

function isThenable(v: unknown): v is PromiseLike<unknown> {
  return !!v && typeof (v as { then?: unknown }).then === 'function'
}

export function run(control: string, label: string, deadline: number, invoke: (req: number) => unknown, opts: RunOpts = {}): void {
  if (useShell.getState().pending[control]) return console.info(`[web-shell] ${control} is still running, the tap waits for it`)
  const req = nextReq++
  const tap = tapStartedAt() ?? performance.now()
  const again = (): void => run(control, label, deadline, invoke, opts)
  setPending(control, true, opts.pill)
  const w: Wait = { control, label, opts, again, tap, shown: null, acked: null, timer: 0 }
  afterPaint((at) => (w.shown = at))
  w.timer = window.setTimeout(() => {
    if (!waits.delete(req)) return
    fail(w, `${label} didn't answer in ${deadline} s`)
  }, deadline * 1000)
  waits.set(req, w)
  let r: unknown
  try {
    r = invoke(req)
  } catch (e) {
    r = Promise.reject(e)
  }
  if (isThenable(r))
    r.then(
      () => settle(req, true),
      (e) => settle(req, false, message(e))
    )
  else if (r === null || r === undefined) settle(req, false, `${label} isn't ready yet`)
}

function fail(w: Wait, error: string): void {
  window.clearTimeout(w.timer)
  setPending(w.control, false)
  w.opts.onFail?.()
  haptic('error')
  console.warn(`[web-shell] ${w.control} failed: ${error}`)
  logTap(`${w.control} failed`, { pending: w.shown && w.shown - w.tap, desktop: w.acked && w.acked - w.tap, failed: performance.now() - w.tap })
  showToast(error, w.opts.retry === false || useShell.getState().outage ? null : w.again)
}

function finish(w: Wait): void {
  setPending(w.control, false)
  w.opts.onOk?.()
  afterPaint((at) => logTap(w.control, { pending: w.shown && w.shown - w.tap, desktop: w.acked && w.acked - w.tap, shown: at - w.tap }))
}

function settle(id: number, ok: boolean, error?: string): void {
  const w = waits.get(id)
  if (!w) return
  waits.delete(id)
  window.clearTimeout(w.timer)
  w.acked = performance.now()
  if (!ok) return fail(w, error || `${w.label} failed`)
  const until = w.opts.until
  if (!until || until(useShell.getState())) return finish(w)
  const settleS = w.opts.settle ?? 10
  let off = (): void => {}
  const timer = window.setTimeout(() => {
    off()
    fail(w, `${w.label} didn't take effect in ${settleS} s`)
  }, settleS * 1000)
  off = useShell.subscribe((s) => {
    if (!until(s)) return
    window.clearTimeout(timer)
    off()
    finish(w)
  })
}

export function revealInFiles(path: string): boolean {
  const s = useShell.getState()
  const root = s.workspace?.root?.replace(/\/+$/, '')
  if (!root) return false
  const rel = path.startsWith(`${root}/`) ? path.slice(root.length + 1) : ''
  const stack = [root]
  let cur = root
  for (const part of rel.split('/').slice(0, -1).filter(Boolean)) {
    cur = `${cur}/${part}`
    stack.push(cur)
  }
  if (s.typing) stopTyping()
  console.info(`[files] show ${path} in ${cur}`)
  navigate(s.files ? 'swap' : 'push', () => useShell.setState({ files: stack, filesFocus: rel ? path : null }))
  return true
}

function findAction(nodes: WireAction[] | undefined, id: string): WireAction | null {
  for (const n of nodes ?? []) {
    if (n.id === id) return n
    const hit = findAction(n.children, id)
    if (hit) return hit
  }
  return null
}

export function panelAction(s: ShellState, id: string): WireAction | null {
  const p = s.workspace?.panel
  return p ? findAction(p.actions, id) ?? findAction(p.tabActions, id) ?? findAction(p.workspaceActions, id) : null
}

export function checkedOf(optimistic: Record<string, boolean>, a: WireAction): boolean | null | undefined {
  return a.id in optimistic ? optimistic[a.id] : a.checked
}

function dropOptimistic(id: string): void {
  const cur = useShell.getState().optimistic
  if (!(id in cur)) return
  const next = { ...cur }
  delete next[id]
  useShell.setState({ optimistic: next })
}

export function perform(item: WireAction, value: string | null = null, from: 'bar' | 'menu' = 'bar'): void {
  if (item.id === 'd:tab.explorer') {
    const tabId = useShell.getState().workspace?.panel?.tabId ?? ''
    const file = (call('viewerFile', tabId) as string | null) ?? ''
    if (!revealInFiles(file || `${useShell.getState().workspace?.root ?? ''}/`)) showToast("This panel isn't in a project folder")
    return
  }
  if (item.input && value === null) {
    useShell.setState({ prompt: { item, seq: null } })
    return
  }
  const toggle = typeof item.checked === 'boolean' && !item.children && value === null
  const changed = (s: ShellState): boolean => {
    const now = panelAction(s, item.id)
    return !now || now.checked !== item.checked || now.label !== item.label
  }
  const optimistic = toggle && !item.primary
  if (optimistic) useShell.setState({ optimistic: { ...useShell.getState().optimistic, [item.id]: !item.checked } })
  run(`panel:${item.id}`, item.label, 15, (req) => call('panelAction', item.id, value, req), {
    until: toggle ? changed : undefined,
    settle: item.primary ? 10 : 6,
    pill: from === 'menu' ? `${item.label}…` : undefined,
    onOk: () => dropOptimistic(item.id),
    onFail: () => dropOptimistic(item.id)
  })
}

export function openWorkspace(id: string, control = `project:${id}`, then?: () => void): void {
  const s = useShell.getState()
  if (s.pending[control]) return
  const was = s.openId
  if (was !== id) setOpen(id)
  run(control, 'Opening the project', 8, (req) => call('openWorkspace', id, req), {
    onOk: then,
    onFail: () => {
      if (useShell.getState().openId === id && was !== id) setOpen(was)
    }
  })
}

export function setOpen(id: string | null): void {
  const s = useShell.getState()
  writeJson(window.sessionStorage, OPEN_KEY, id)
  if (id === null) {
    if (s.typing) stopTyping()
    const close = (): void => useShell.setState({ openId: null, workspace: null, files: null })
    if (s.openId) navigate('pop', close)
    else close()
    return
  }
  const open = (): void => useShell.setState({ openId: id, ...(s.openId === id ? {} : { files: null }), workspace: latest?.id === id ? latest : s.workspace?.id === id ? s.workspace : null })
  if (s.openId === id) open()
  else navigate(s.openId ? 'swap' : 'push', open, 40)
}

export function closeWorkspace(): void {
  setOpen(null)
  call('closeWorkspace')
}

export function openFiles(): void {
  const s = useShell.getState()
  const root = s.workspace?.root
  if (!root || s.files) return
  if (s.typing) stopTyping()
  console.info(`[files] open ${root}`)
  navigate('push', () => useShell.setState({ files: [root] }))
}

export function filesInto(dir: string): void {
  const cur = useShell.getState().files
  if (cur) navigate('push', () => useShell.setState({ files: [...cur, dir] }))
}

export function filesBack(): void {
  const cur = useShell.getState().files
  if (!cur) return
  navigate('pop', () => useShell.setState({ files: cur.length > 1 ? cur.slice(0, -1) : null, filesFocus: null }))
  if (cur.length <= 1) console.info('[files] closed')
}

export function closeFiles(): void {
  if (useShell.getState().files) navigate('pop', () => useShell.setState({ files: null, filesFocus: null }))
}

export function setTab(tab: Tab): void {
  if (useShell.getState().tab !== tab) navigate('swap', () => useShell.setState({ tab }))
}

export function goBack(): void {
  const used = call('back')
  if (used !== true) closeWorkspace()
}

export function selectTab(tabId: string): void {
  const s = useShell.getState()
  if (s.workspace?.selected === tabId || s.pending[`tab:${tabId}`]) return
  useShell.setState({ selecting: tabId })
  const clear = (): void => {
    if (useShell.getState().selecting === tabId) useShell.setState({ selecting: null })
  }
  run(`tab:${tabId}`, 'That tab', 5, (req) => call('selectTab', tabId, req), { until: (st) => st.workspace?.selected === tabId || st.selecting !== tabId, settle: 5, onOk: clear, onFail: clear })
}

export function sendKey(name: string, control = `key:${name}`): void {
  run(control, 'That key', 3, (req) => call('key', name, req))
}

export function answer(item: ActivityItem, option: Option): void {
  const pty = item.link.ptyId
  if (!pty) return
  run(`answer:${item.id}:${option.key}`, option.label, 3, (req) => call('answer', pty, option.key, req))
}

export function setNotify(kind: NotifyKind, on: boolean): void {
  const notify = { ...useShell.getState().notify, [kind]: on }
  writeJson(window.localStorage, NOTIFY_KEY, notify)
  useShell.setState({ notify })
}

let composerEl: HTMLTextAreaElement | null = null

export function setComposer(el: HTMLTextAreaElement | null): void {
  composerEl = el
}

export function startTyping(): void {
  composerEl?.focus({ preventScroll: true })
  useShell.setState({ typing: true })
  call('revealInput')
}

export function stopTyping(): void {
  if (composerEl && document.activeElement === composerEl) composerEl.blur()
  useShell.setState({ typing: false, ctrl: false })
}

export function readClipboard(): Promise<string> {
  return realRead ? realRead() : Promise.reject(new Error('The clipboard needs a secure connection'))
}

function copyNow(text: string): void {
  const fallback = (): boolean => {
    const span = document.createElement('span')
    span.textContent = text
    span.style.cssText = 'position:fixed;left:0;top:0;opacity:0;white-space:pre;-webkit-user-select:text;user-select:text;pointer-events:none'
    document.body.appendChild(span)
    const range = document.createRange()
    range.selectNodeContents(span)
    const sel = window.getSelection()
    sel?.removeAllRanges()
    sel?.addRange(range)
    let ok = false
    try {
      ok = document.execCommand('copy')
    } catch {
    }
    sel?.removeAllRanges()
    span.remove()
    return ok
  }
  const done = (ok: boolean): void => {
    console.info(`[web-shell] copy ${text.length} chars: ${ok ? 'done' : 'refused'}`)
    if (ok) {
      haptic('success')
      showToast('Copied', null, 'ok')
    } else showToast('The browser blocked the copy.')
  }
  if (realWrite)
    realWrite(text).then(
      () => done(true),
      () => done(fallback())
    )
  else done(fallback())
}

let latest: Workspace | null = null
const seenActivity = new Set<string>()
let activityPrimed = false

function receive(m: Record<string, any>): void {
  const s = useShell.getState()
  switch (m.type) {
    case 'ready': {
      useShell.setState({ webReady: s.webReady + 1 })
      const restore = s.openId ?? readJson<string>(window.sessionStorage, OPEN_KEY)
      if (restore) {
        call('openWorkspace', restore, null)
        if (!s.openId) setOpen(restore)
      }
      call('setDevice', deviceName())
      call('setVisible', document.visibilityState === 'visible')
      return
    }
    case 'connection': {
      const conn = String(m.state) as Conn
      const outage = (m.outage ?? null) as Outage | null
      const next: Partial<ShellState> = { conn, detail: String(m.detail ?? ''), hostGone: !!m.hostGone, outage, fit: m.fit === 'update' || m.fit === 'relay' ? m.fit : null, halted: m.halted === 'cancelled' || m.halted === 'failed' ? m.halted : '' }
      if (outage && !s.outage) {
        console.info(`[web-shell] covering the Mac's state: ${outage}`)
        if (s.typing) stopTyping()
        dismissBanner()
        if (s.menu?.seq != null) call('contextDismiss', s.menu.seq)
        if (s.prompt?.seq != null) call('contextDismiss', s.prompt.seq)
        if (s.picker) call('pickerDismiss', s.picker.seq)
        Object.assign(next, { menu: null, picker: null, confirm: null, prompt: null })
      }
      if (m.hostName) next.hostName = String(m.hostName)
      next.verify = !!m.verify
      next.explain = !!m.explain
      next.allow = m.allow && typeof m.allow === 'object' ? { device: String((m.allow as { device?: unknown }).device ?? '').slice(0, 60) } : null
      next.access = m.access === 'local' || m.access === 'any' ? m.access : s.access
      next.wasOnline = !!m.wasOnline
      next.awayCheck = m.awayCheck === 'checking' || m.awayCheck === 'error' ? m.awayCheck : 'idle'
      next.awayCheckedAt = Number(m.awayCheckedAt) || 0
      if (conn === 'online') next.paired = true
      else if (conn === 'unpaired') next.paired = false
      else if (s.paired === null) next.paired = !!m.paired
      useShell.setState(next)
      return
    }
    case 'allowance': {
      const a = readAllowance(m.allowance)
      if (a) useShell.setState({ allowance: a })
      return
    }
    case 'host':
      useShell.setState({ hostName: String(m.hostName ?? s.hostName), version: String(m.version ?? ''), fresh: s.fresh + 1 })
      if (s.fresh === 0) afterPaint((at) => logTap(`desktop page ${location.pathname}`, { 'state from the desktop shown': at }))
      return
    case 'projects':
      useShell.setState({ projects: Array.isArray(m.items) ? m.items : [], activeProjectId: m.activeId ?? null })
      return
    case 'activity': {
      const items: ActivityItem[] = Array.isArray(m.items) ? m.items : []
      const fresh = items.filter((i) => !seenActivity.has(`${i.id}@${i.at}`))
      for (const i of items) seenActivity.add(`${i.id}@${i.at}`)
      useShell.setState({ activity: items })
      if (!activityPrimed) {
        activityPrimed = true
        return
      }
      const first = fresh.find((i) => i.kind !== 'ask' || i.open)
      if (!first || !s.notify[first.kind]) return
      const onScreen = !!first.link.tabId && s.openId === first.link.workspaceId && s.workspace?.selected === first.link.tabId
      if (!onScreen) showBanner(first)
      return
    }
    case 'home':
      console.info('[shell] the panel asks for the projects list')
      if (s.openId) closeWorkspace()
      return
    case 'show': {
      const id = String(m.workspaceId ?? '')
      if (!id) return
      if (s.openId !== id) setOpen(id)
      if (s.typing) stopTyping()
      closeFiles()
      return
    }
    case 'workspace': {
      latest = m as Workspace
      if (latest.id !== s.openId) return
      useShell.setState({ workspace: latest })
      if (s.typing && latest.panel?.composer !== 'terminal') stopTyping()
      return
    }
    case 'ack':
      settle(Number(m.id), !!m.ok, m.error ? String(m.error) : undefined)
      return
    case 'toast': {
      const retryId = typeof m.retryId === 'number' ? m.retryId : null
      showToast(String(m.text ?? ''), retryId === null ? null : () => call('retry', retryId))
      return
    }
    case 'contextMenu': {
      const tree = Array.isArray(m.tree) ? (m.tree as WireAction[]) : []
      if (!tree.length) return
      useShell.setState({ menu: { key: Date.now(), tree, title: '', at: { x: Number(m.x) || 0, y: Number(m.y) || 0 }, seq: Number(m.seq), sheet: false } })
      return
    }
    case 'picker': {
      const cur = s.picker
      const seq = Number(m.seq)
      const query = String(m.query ?? '')
      if (cur && cur.seq === seq) {
        if (query !== cur.query) return
      } else if (cur && seq <= cur.seq) return
      useShell.setState({
        picker: {
          seq,
          query,
          kind: String(m.kind ?? ''),
          title: String(m.title ?? ''),
          placeholder: String(m.placeholder ?? ''),
          loading: !!m.loading,
          empty: String(m.empty ?? ''),
          sections: Array.isArray(m.sections) ? m.sections : []
        }
      })
      return
    }
    case 'pickerClosed':
      if (s.picker && s.picker.seq === Number(m.seq)) {
        useShell.setState({ picker: null })
        showToast(String(m.reason || 'That list closed'))
      }
      return
    case 'confirm':
      useShell.setState({ confirm: m as Confirm })
      return
    case 'haptic':
      haptic(m.kind === 'success' ? 'success' : 'tap')
      return
    case 'inputBox': {
      const ptyId = String(m.ptyId ?? '')
      if (m.box) useShell.setState({ inputBox: { ptyId, box: m.box as InputBox } })
      else if (s.inputBox?.ptyId === ptyId) useShell.setState({ inputBox: null })
      return
    }
    case 'editing': {
      const el = document.activeElement
      useShell.setState({ editing: !!m.on && !(el instanceof Element && el.closest('div[data-web-shell]')) })
      return
    }
  }
}

export function setPickerQuery(query: string): void {
  const p = useShell.getState().picker
  if (!p) return
  useShell.setState({ picker: { ...p, query } })
}

function clone<T>(m: T): T {
  try {
    return structuredClone(m)
  } catch {
    return m
  }
}

onShellMessage((m) => {
  if (m.type === 'copy') return copyNow(String(m.text ?? ''))
  const msg = clone(m)
  queueMicrotask(() => receive(msg))
})
const w = window as unknown as { __saturaDevice?: string; __saturaWebShell?: () => ShellState }
w.__saturaDevice = deviceName()
w.__saturaWebShell = () => useShell.getState()
useShell.subscribe((now, before) => {
  if (!!now.files !== !!before.files) call('setOverlay', now.files ? 'files' : null)
})
document.documentElement.dataset.webShell = ''
checkAccount()
if (!getMac(pathHostId()) && !pairInUrl()) {
  console.info('[web-shell] not paired, sending the phone to /m/')
  location.replace('/m/')
}
