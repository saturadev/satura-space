import { create } from 'zustand'
import type { Tab, TabContentType } from '@shared/types'
import { DASHBOARD_TAB_LABEL } from '@shared/dashboard'
import { PUSH_DEFAULT_PREFS, cleanPushPrefs, desktopNameKey, pushKeyName, pushOpenKey, readPushLink, type PushLink, type PushPrefs, type PushState } from '@shared/remote-push'
import { useAppStore, type AppState } from '../store'
import { bindPushEndpoint, connectionState, currentHostId, invokeRemote, relayPushKey, wsTransport } from './ws-transport'
import { getMac, macLabel, macPath, onMacsChange, validHostId } from './macs'
import { runMirrored } from './mirror'
import { storeDelete, storeGet, storePut, type PendingOpen, type StoredPushKey } from './push-store'
import { call, dismissBanner, openWorkspace, run, showToast, useShell } from './web-shell/bridge'

export type PushPermission = NotificationPermission | 'unsupported'

export interface PushUi {
  checked: boolean
  support: string | null
  ios: boolean
  standalone: boolean
  permission: PushPermission
  registered: boolean
  prefs: PushPrefs
  busy: string | null
  error: string | null
}

const OPEN_FRESH_MS = 5 * 60_000
const READY_MS = 8000
const SUBSCRIBE_MS = 60_000
const LINK_WAIT_MS = 15_000

function isIos(): boolean {
  const ua = navigator.userAgent
  return /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)
}

function isStandalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function permissionNow(): PushPermission {
  return typeof Notification === 'undefined' ? 'unsupported' : Notification.permission
}

function supportProblem(): string | null {
  const ios = isIos()
  if (ios && !isStandalone()) return 'On iPhone and iPad, notifications work only in the Home Screen app. Tap Share, then Add to Home Screen, and open Satura Remote from there.'
  if (!window.isSecureContext) return "Notifications need a secure (HTTPS) page."
  if (!('serviceWorker' in navigator) || typeof PushManager === 'undefined' || typeof Notification === 'undefined') return ios ? 'Notifications need iOS 16.4 or newer.' : "This browser can't show notifications."
  return null
}

export const usePush = create<PushUi>(() => ({
  checked: false,
  support: null,
  ios: false,
  standalone: false,
  permission: 'default',
  registered: false,
  prefs: { ...PUSH_DEFAULT_PREFS },
  busy: null,
  error: null
}))

function hostId(): string {
  return currentHostId() ?? ''
}

let namedAs = ''

export function noteMacName(): void {
  const host = hostId()
  if (!host) return
  const name = macLabel(getMac(host) ?? { alias: '', name: connectionState().hostName })
  if (!name || name === namedAs) return
  namedAs = name
  void storePut(desktopNameKey(host), { name, at: Date.now() }).then(
    () => console.info(`[push] notifications from ${host} will say they come from ${name}`),
    () => {
      namedAs = ''
    }
  )
}

function b64u(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function unb64u(text: string): Uint8Array<ArrayBuffer> {
  const b = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4))
  const out = new Uint8Array(new ArrayBuffer(b.length))
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function registration(): Promise<ServiceWorkerRegistration> {
  const sw = navigator.serviceWorker
  const ready = sw.ready
  const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The notification worker didn't start")), READY_MS))
  return Promise.race([ready, late])
}

function sameKey(sub: PushSubscription, key: string): boolean {
  const have = sub.options?.applicationServerKey
  if (!have) return false
  return b64u(new Uint8Array(have)) === key
}

async function signUp(sub: PushSubscription): Promise<PushState> {
  const json = sub.toJSON()
  const endpoint = json.endpoint ?? sub.endpoint
  const p256dh = json.keys?.p256dh ?? ''
  const auth = json.keys?.auth ?? ''
  const { token } = await bindPushEndpoint(endpoint)
  const raw = crypto.getRandomValues(new Uint8Array(32))
  const key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt'])
  const host = hostId()
  const before = await storeGet<StoredPushKey>(pushKeyName(host)).catch(() => undefined)
  await storePut(pushKeyName(host), { key, endpoint, at: Date.now() } satisfies StoredPushKey)
  try {
    const state = await invokeRemote<PushState>('remote:push:register', { endpoint, p256dh, auth, token, key: b64u(raw), prefs: usePush.getState().prefs })
    console.info(`[push] signed up with the Mac via ${new URL(endpoint).hostname}`)
    return state
  } catch (e) {
    if (before) await storePut(pushKeyName(host), before).catch(() => {})
    else await storeDelete(pushKeyName(host)).catch(() => {})
    throw e
  } finally {
    raw.fill(0)
  }
}

async function subscription(reg: ServiceWorkerRegistration, key: string): Promise<PushSubscription> {
  let sub = await reg.pushManager.getSubscription()
  if (sub && !sameKey(sub, key)) {
    console.info('[push] the relay has a new push key, signing up again')
    await sub.unsubscribe().catch(() => false)
    sub = null
  }
  if (sub) return sub
  const late = new Promise<never>((_, reject) => setTimeout(() => reject(new Error("The browser's push service didn't answer in 60 s. Check the connection and try again.")), SUBSCRIBE_MS))
  return Promise.race([reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: unb64u(key) }), late])
}

function applyState(state: PushState): void {
  usePush.setState({ registered: state.registered, prefs: cleanPushPrefs(state.prefs) })
}

export function enablePush(): void {
  const problem = supportProblem()
  if (problem) {
    usePush.setState({ support: problem, error: null })
    return
  }
  const asked = Notification.permission === 'granted' ? Promise.resolve<NotificationPermission>('granted') : Notification.requestPermission()
  usePush.setState({ busy: 'Turning on', error: null })
  void (async () => {
    try {
      const permission = await asked
      usePush.setState({ permission })
      if (permission !== 'granted') throw new Error(isIos() ? 'Notifications are off for Satura Remote. Turn them on in Settings > Notifications > Satura Remote.' : 'This browser blocks notifications from Satura Remote. Allow them in the site settings.')
      const key = relayPushKey()
      if (!key) throw new Error("This relay can't send notifications yet.")
      const reg = await registration()
      const sub = await subscription(reg, key)
      applyState(await signUp(sub))
      console.info('[push] notifications on')
    } catch (e) {
      console.warn(`[push] turning on failed: ${message(e)}`)
      usePush.setState({ error: message(e) })
    } finally {
      usePush.setState({ busy: null })
    }
  })()
}

export async function disablePush(): Promise<void> {
  usePush.setState({ busy: 'Turning off', error: null })
  try {
    applyState(await invokeRemote<PushState>('remote:push:unregister'))
    const reg = await registration().catch(() => null)
    const sub = await reg?.pushManager.getSubscription()
    await sub?.unsubscribe().catch(() => false)
    await storeDelete(pushKeyName(hostId())).catch(() => {})
    console.info('[push] notifications off')
  } catch (e) {
    usePush.setState({ error: message(e) })
  } finally {
    usePush.setState({ busy: null })
  }
}

export async function setPushPref(name: keyof PushPrefs, on: boolean): Promise<void> {
  const before = usePush.getState().prefs
  const prefs = { ...before, [name]: on }
  usePush.setState({ prefs })
  try {
    applyState(await invokeRemote<PushState>('remote:push:prefs', { prefs }))
  } catch (e) {
    console.warn(`[push] the desktop didn't take the ${name} setting: ${message(e)}`)
    usePush.setState({ prefs: before, error: message(e) })
  }
}

export async function testPush(): Promise<void> {
  usePush.setState({ busy: 'Sending', error: null })
  try {
    const r = await invokeRemote<{ sent: number; records: { decision: string }[] }>('remote:push:test')
    if (!r.sent) throw new Error(r.records[0]?.decision ? `The desktop didn't send it: ${r.records[0].decision}` : 'The desktop has no notification address for this phone. Turn notifications off and on again.')
    showToast('Sent. It shows up in a few seconds.', null, 'ok')
  } catch (e) {
    usePush.setState({ error: message(e) })
  } finally {
    usePush.setState({ busy: null })
  }
}

async function closeTags(tags: string[], why: string): Promise<void> {
  if (!tags.length || !('serviceWorker' in navigator)) return
  const reg = await navigator.serviceWorker.getRegistration().catch(() => undefined)
  if (!reg) return
  let n = 0
  for (const t of tags) for (const note of await reg.getNotifications({ tag: t }).catch(() => [] as Notification[])) {
    note.close()
    n++
  }
  if (n) console.info(`[push] cleared ${n} notification(s) ${why}: ${tags.join(', ')}`)
}

export async function refreshPush(): Promise<void> {
  const problem = supportProblem()
  usePush.setState({ checked: true, support: problem, ios: isIos(), standalone: isStandalone(), permission: permissionNow() })
  if (problem || connectionState().state !== 'online') return
  let state: PushState
  try {
    state = await invokeRemote<PushState>('remote:push:state')
  } catch {
    return
  }
  applyState(state)
  const host = hostId()
  const local = await storeGet<StoredPushKey>(pushKeyName(host)).catch(() => undefined)
  const reg = await registration().catch(() => null)
  const sub = (await reg?.pushManager.getSubscription().catch(() => null)) ?? null
  const key = relayPushKey()
  if (state.registered) {
    if (permissionNow() !== 'granted') {
      console.info('[push] notifications were turned off in the system settings, telling the Mac')
      applyState(await invokeRemote<PushState>('remote:push:unregister').catch(() => state))
    } else if (reg && key && (!sub || !local || sub.endpoint !== state.endpoint || !sameKey(sub, key) || local.endpoint !== sub.endpoint)) {
      console.info(`[push] renewing the notification sign-up (${!sub ? 'no subscription' : !local ? 'no key on this phone' : !sameKey(sub, key) ? 'the relay key changed' : 'the push address changed'})`)
      try {
        applyState(await signUp(await subscription(reg, key)))
      } catch (e) {
        console.warn(`[push] renewing failed: ${message(e)}`)
      }
    }
  } else if (local) {
    await storeDelete(pushKeyName(host)).catch(() => {})
  }
  await syncPush()
}

async function syncPush(): Promise<void> {
  const { clear } = await invokeRemote<{ clear: string[] }>('remote:push:sync').catch(() => ({ clear: [] as string[] }))
  await closeTags(clear, 'seen on the desktop')
}

function tabsOf(s: AppState, workspaceId: string): Tab[] {
  return s.tabsByWorkspace[workspaceId] ?? []
}

function tabIn(s: AppState, tabId: string): { workspaceId: string; tab: Tab } | null {
  for (const [workspaceId, tabs] of Object.entries(s.tabsByWorkspace)) {
    const tab = tabs.find((t) => t.id === tabId)
    if (tab) return { workspaceId, tab }
  }
  return null
}

function workspaceOf(s: AppState, link: PushLink): string | null {
  if (link.workspaceId && s.workspaces.some((w) => w.id === link.workspaceId)) return link.workspaceId
  const p = link.projectPath
  if (!p) return null
  for (const w of s.workspaces) {
    const roots = [w.worktreePath, w.folderPath, ...(s.worktreesByWorkspace[w.id] ?? []).map((t) => t.path)].filter((r): r is string => !!r)
    if (roots.some((r) => p === r || p.startsWith(r.endsWith('/') ? r : `${r}/`))) return w.id
  }
  return null
}

async function ensureTab(workspaceId: string, kind: TabContentType, label: string, projectPath: string | undefined): Promise<string | null> {
  const s = useAppStore.getState()
  const trees = s.worktreesByWorkspace[workspaceId] ?? []
  const tree = trees.find((t) => projectPath && (projectPath === t.path || projectPath.startsWith(`${t.path}/`))) ?? trees[0]
  const have = tabsOf(s, workspaceId).filter((t) => t.contentType === kind)
  const pick = have.find((t) => !tree || t.worktreeId === tree.id) ?? have[0]
  if (pick) return pick.id
  const group = s.activeGroupIdByWorkspace[workspaceId] ?? (s.groupsByWorkspace[workspaceId] ?? [])[0]?.id
  if (!group || !tree) return null
  console.info(`[push] opening a ${label} panel on the Mac for the notification`)
  await runMirrored('openTabBeside', [workspaceId, group, tree.id, { label, contentType: kind }])
  const made = tabsOf(useAppStore.getState(), workspaceId).find((t) => t.contentType === kind && t.worktreeId === tree.id)
  return made?.id ?? null
}

function until(test: () => boolean, ms: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (test()) return resolve(true)
    const started = Date.now()
    const t = setInterval(() => {
      if (test()) {
        clearInterval(t)
        resolve(true)
      } else if (Date.now() - started > ms) {
        clearInterval(t)
        resolve(false)
      }
    }, 150)
  })
}

async function target(link: PushLink): Promise<{ workspaceId: string; tabId: string | null; why: string } | null> {
  const s = useAppStore.getState()
  if (link.kind === 'agent') {
    const byPty = link.ptyId ? Object.entries(s.tabsByWorkspace).flatMap(([w, tabs]) => tabs.filter((t) => t.ptyId === link.ptyId).map((t) => ({ workspaceId: w, tab: t })))[0] : undefined
    const hit = byPty ?? (link.tabId ? tabIn(s, link.tabId) : null)
    if (hit) return { workspaceId: hit.workspaceId, tabId: hit.tab.id, why: 'the agent' }
    const ws = workspaceOf(s, link)
    return ws ? { workspaceId: ws, tabId: null, why: 'the agent closed, its workspace' } : null
  }
  const ws = workspaceOf(s, link)
  if (!ws) return null
  if (link.kind === 'tuner') {
    const hit = (link.tabId ? tabIn(s, link.tabId) : null)?.tab ?? tabsOf(s, ws).find((t) => t.contentType === 'tuner' && (t.tuner?.filter === link.view || (!t.tuner?.filter && t.tuner?.id === link.view)))
    return { workspaceId: ws, tabId: hit?.id ?? null, why: hit ? `the Tuner ${link.view ?? ''}` : 'the Tuner closed, its workspace' }
  }
  if (link.kind === 'unity') {
    const tabId = link.tabId && tabIn(s, link.tabId) ? link.tabId : await ensureTab(ws, 'unity-console', 'Unity Console', link.projectPath).catch(() => null)
    return { workspaceId: ws, tabId, why: 'the Unity console' }
  }
  if (link.kind === 'report') {
    const hit = tabsOf(s, ws).find((t) => t.contentType === 'file-viewer' && s.viewerFileByTab[t.id] === link.file)
    return { workspaceId: ws, tabId: hit?.id ?? null, why: hit ? 'the report' : 'the report closed, its workspace' }
  }
  if (link.kind === 'alert') {
    const tabId = link.tabId && tabIn(s, link.tabId) ? link.tabId : await ensureTab(ws, 'dashboard', DASHBOARD_TAB_LABEL, link.projectPath).catch(() => null)
    return { workspaceId: ws, tabId, why: 'the dashboard' }
  }
  return null
}

let opening = ''

export function openActivity(item: { id: string; link: PushLink }): void {
  dismissBanner()
  run(`push:${item.id}`, 'Opening it', 15, () => openPushLink(item.link, item.id), { retry: false })
}

export async function openPushLink(raw: unknown, tag: string): Promise<void> {
  const link = readPushLink(raw)
  const key = JSON.stringify([link, tag])
  if (opening === key) return
  opening = key
  try {
    console.info(`[push] opening ${tag || 'a notification'}: ${link ? link.kind : 'no link'}`)
    if (!link || link.kind === 'test') {
      useShell.setState({ tab: 'settings' })
      return
    }
    const ready = await until(() => connectionState().state === 'online' && useShell.getState().fresh > 0 && useAppStore.getState().workspaces.length > 0, LINK_WAIT_MS)
    if (!ready) {
      showToast("Your desktop didn't answer, so the notification couldn't open its place.")
      return
    }
    const t = await target(link)
    if (!t) {
      console.info(`[push] ${tag}: nothing to open, it closed on the Mac`)
      showToast('That closed on your desktop.')
      return
    }
    console.info(`[push] ${tag}: showing ${t.why} (${t.workspaceId.slice(0, 8)}${t.tabId ? ` tab ${t.tabId.slice(0, 8)}` : ''})`)
    openWorkspace(t.workspaceId, `push-open:${tag}`, () => {
      if (t.tabId) call('selectTab', t.tabId, null)
    })
    if (tag) {
      void closeTags([tag], 'opened')
      void invokeRemote('remote:push:seen', { tags: [tag] }).catch(() => {})
    }
  } finally {
    setTimeout(() => {
      if (opening === key) opening = ''
    }, 1500)
  }
}

async function takePending(): Promise<void> {
  const host = hostId()
  if (!host) return
  const p = await storeGet<PendingOpen>(pushOpenKey(host)).catch(() => undefined)
  if (!p) return
  await storeDelete(pushOpenKey(host)).catch(() => {})
  if (Date.now() - p.at > OPEN_FRESH_MS) return
  await openPushLink(p.link, p.tag)
}

function tagsShown(): { tags: string[]; pty: string | null } {
  const sh = useShell.getState()
  const s = useAppStore.getState()
  const tabId = sh.openId ? sh.workspace?.selected ?? null : null
  if (!tabId) return { tags: [], pty: null }
  const hit = tabIn(s, tabId)
  if (!hit) return { tags: [], pty: null }
  const t = hit.tab
  const tags: string[] = []
  if (t.contentType === 'terminal' && t.ptyId) tags.push(`agent:${t.ptyId}`)
  const view = t.contentType === 'tuner' ? t.tuner?.filter || t.tuner?.id : ''
  if (view) for (const w of s.worktreesByWorkspace[hit.workspaceId] ?? []) tags.push(`tuner:${w.path}:${view}`)
  return { tags, pty: t.contentType === 'terminal' ? t.ptyId : null }
}

let lastShown = ''

function onScreenChange(): void {
  if (document.visibilityState !== 'visible') return
  const { tags } = tagsShown()
  const key = tags.join('|')
  if (!key || key === lastShown) return
  lastShown = key
  void closeTags(tags, 'seen on the phone')
  if (connectionState().state === 'online') void invokeRemote('remote:push:seen', { tags }).catch(() => {})
}

export function installPushClient(): void {
  if (!('serviceWorker' in navigator)) return
  navigator.serviceWorker.addEventListener('message', (e: MessageEvent) => {
    const m = (e.data ?? {}) as { t?: string; link?: unknown; tag?: unknown; host?: unknown }
    if (m.t === 'push-go' && validHostId(m.host) && m.host !== hostId()) {
      console.info(`[push] a notification from ${m.host} was tapped, switching to that Mac`)
      location.replace(macPath(m.host))
      return
    }
    if (m.t !== 'push-open' || (validHostId(m.host) && m.host !== hostId())) return
    void storeDelete(pushOpenKey(hostId())).catch(() => {})
    void openPushLink(m.link, typeof m.tag === 'string' ? m.tag : '')
  })
  const visible = (): void => {
    if (document.visibilityState !== 'visible') {
      lastShown = ''
      return
    }
    void takePending()
    void refreshPush()
    onScreenChange()
    void (navigator as Navigator & { clearAppBadge?: () => Promise<void> }).clearAppBadge?.().catch(() => {})
  }
  document.addEventListener('visibilitychange', visible)
  wsTransport.on('remote:push:resolved', () => void syncPush())
  wsTransport.on('remote:online', () => {
    noteMacName()
    void refreshPush()
    void takePending()
  })
  onMacsChange(() => noteMacName())
  useShell.subscribe((now, before) => {
    if (now.openId !== before.openId || now.workspace?.selected !== before.workspace?.selected) onScreenChange()
  })
  usePush.setState({ support: supportProblem(), ios: isIos(), standalone: isStandalone(), permission: permissionNow() })
  void takePending()
}

export function clickNotificationForTest(tag: string): Promise<boolean> {
  return navigator.serviceWorker.ready.then((reg) => {
    reg.active?.postMessage({ t: 'click-notification', tag })
    return !!reg.active
  })
}
