import { useEffect, useMemo, useRef, useState } from 'react'
import type { Tab } from '@shared/types'
import { leafIds, onPanelActionsChange, panelActions, runAction, toWire, type ActionNode, type WireAction } from '../lib/actions/action-tree'
import { setActionMenuPresenter } from '../lib/actions/ActionMenu'
import { useConfirmStore, type ConfirmChoice } from '../lib/confirm/confirm-store'
import { setRemoteFileOpener } from '../lib/editor/open-file'
import { useUnityPlayerController } from '../components/workbench/PaneUnitySlot'
import { invokeRemote, onDrive, trackCalls } from './ws-transport'
import { pruneForPhone } from './phone-menu-policy'
import { exposeToShell, postToShell } from './shell-bus'

type DesktopResult<T> = { session: unknown; value: T }

const DESKTOP_POLL_MS = 1500
const CTX_SELECTOR = '.scm-row, [data-scm-stash], [data-ctx-menu]'
const LONG_PRESS_MS = 650

let shown: { tabId: string; scopes: string[] } | null = null
let refreshDesktop: (() => void) | null = null
const desktopTrees = new Map<string, WireAction[]>()

function localNodes(scopes: string[]): ActionNode[] {
  return scopes.flatMap((s) => panelActions(s))
}

export function desktopCall<T>(action: string, args: unknown[]): Promise<T> {
  return invokeRemote<DesktopResult<T>>('remote:storeAction', { action, args }).then((r) => r.value)
}

async function runTracked(fn: () => unknown): Promise<void> {
  let ret: unknown
  await trackCalls(() => {
    ret = fn()
  })
  await ret
}

function prefix(tree: WireAction[], p: string): WireAction[] {
  return tree.map((n) => ({ ...n, id: p + n.id, ...(n.children ? { children: prefix(n.children, p) } : {}) }))
}

export function useLocalActionsVersion(): number {
  const [v, setV] = useState(0)
  useEffect(() => onPanelActionsChange(() => setV((n) => n + 1)), [])
  return v
}

export function usePhonePanelActions(tab: Tab | undefined, scopes: string[]): WireAction[] {
  const version = useLocalActionsVersion()
  const [desktop, setDesktop] = useState<WireAction[]>([])
  const tabId = tab?.id ?? null
  const scopeKey = scopes.join('|')
  useEffect(() => {
    shown = tabId ? { tabId, scopes } : null
    return () => {
      if (shown?.tabId === tabId) shown = null
    }
  }, [tabId, scopeKey])
  useEffect(() => {
    if (!tabId) {
      setDesktop([])
      return
    }
    let alive = true
    let last = ''
    let timer: ReturnType<typeof setTimeout> | null = null
    const pull = (): void => {
      if (timer) clearTimeout(timer)
      void desktopCall<{ tree: WireAction[] }>('panelActions', [tabId])
        .then((r) => {
          if (!alive) return
          const text = JSON.stringify(r.tree)
          if (text !== last) {
            last = text
            desktopTrees.set(tabId, r.tree)
            setDesktop(r.tree)
          }
        })
        .catch(() => {})
        .finally(() => {
          if (alive) timer = setTimeout(pull, DESKTOP_POLL_MS)
        })
    }
    setDesktop(desktopTrees.get(tabId) ?? [])
    refreshDesktop = pull
    pull()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      if (refreshDesktop === pull) refreshDesktop = null
    }
  }, [tabId])
  return useMemo(() => [...prefix(toWire(localNodes(scopes)), 'l:'), ...prefix(desktop, 'd:')], [version, desktop, scopeKey])
}

let lastLogged = ''

export function logActionTree(kind: string, tree: WireAction[]): void {
  const ids = leafIds(tree)
  const text = `${kind}:${ids.join(',')}`
  if (text === lastLogged) return
  lastLogged = text
  const render = (nodes: WireAction[], depth: number): string[] =>
    nodes.flatMap((n) => [
      `${'  '.repeat(depth)}${n.inline ? '§' : n.children ? '▸' : '•'} ${n.label}${n.checked ? ' ✓' : ''}${n.enabled ? '' : ' (off)'}${n.primary ? ' [primary]' : ''} <${n.id}>`,
      ...(n.children ? render(n.children, depth + 1) : [])
    ])
  console.info(`[actions] ${kind} tree, ${ids.length} actions\n${render(tree, 0).join('\n')}`)
}

async function runShown(id: string, value: string | undefined): Promise<void> {
  if (!shown) throw new Error('No panel is open')
  if (id.startsWith('l:')) {
    const nodes = localNodes(shown.scopes)
    console.info(`[actions] run local ${id}`)
    await untilConfirm(() => runTracked(() => runAction(nodes, id.slice(2), value)))
    return
  }
  if (id.startsWith('d:')) {
    console.info(`[actions] run desktop ${id} on ${shown.tabId}`)
    const r = await desktopCall<{ confirm: RemoteConfirmMsg | null; picker?: string | null }>('runPanelAction', [shown.tabId, id.slice(2), value ?? null])
    if (r?.confirm) postToShell({ type: 'confirm', origin: 'd', ...r.confirm })
    if (r?.picker) openPhonePicker(r.picker)
    setTimeout(() => refreshDesktop?.(), 150)
    return
  }
  throw new Error('Unknown action')
}

interface RemoteConfirmMsg {
  id: number
  title: string
  message: string
  confirmLabel?: string
  secondaryLabel?: string
  cancelLabel?: string
  danger?: boolean
}

function ack(req: unknown, ok: boolean, error?: string): void {
  if (req === undefined || req === null) return
  postToShell({ type: 'ack', id: req, ok, ...(error ? { error } : {}) })
}

async function acked(req: unknown, fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn()
    ack(req, true)
  } catch (e) {
    ack(req, false, (e as Error)?.message ?? String(e))
  }
}

const confirmWaiters = new Set<() => void>()

function untilConfirm(start: () => Promise<void>): Promise<void> {
  let release: () => void = () => {}
  let detached = false
  const asked = new Promise<void>((resolve) => {
    release = () => {
      detached = true
      resolve()
    }
    confirmWaiters.add(release)
  })
  const p = start()
  p.catch((e: Error) => {
    if (detached) postToShell({ type: 'toast', text: e?.message || 'That failed', retryId: null })
  })
  return Promise.race([p, asked]).finally(() => confirmWaiters.delete(release))
}

let pickerSeq = 0
let picker: { seq: number; kind: string; query: string; started: number } | null = null

function openPhonePicker(kind: string): void {
  picker = { seq: ++pickerSeq, kind, query: '', started: Date.now() }
  console.info(`[picker] open ${kind} seq ${picker.seq}`)
  void loadPicker(picker)
}

async function loadPicker(p: NonNullable<typeof picker>): Promise<void> {
  const query = p.query
  try {
    const data = await desktopCall<{ loading: boolean; sections: { items: unknown[] }[] }>('pickerData', [p.kind, query])
    if (picker !== p || p.query !== query) return
    console.info(`[picker] ${p.kind} seq ${p.seq} ${data.loading ? 'loading' : `${data.sections.reduce((n, s) => n + s.items.length, 0)} items in ${data.sections.length} sections`}${query ? ` for ${JSON.stringify(query)}` : ''}`)
    postToShell({ type: 'picker', seq: p.seq, query, ...data })
    if (data.loading && Date.now() - p.started < 15_000) setTimeout(() => void loadPicker(p), 400)
  } catch (e) {
    if (picker !== p) return
    picker = null
    console.info(`[picker] ${p.kind} closed: ${(e as Error).message}`)
    postToShell({ type: 'pickerClosed', seq: p.seq, reason: (e as Error).message })
  }
}

let ctxSeq = 0
let ctx: { seq: number; nodes: ActionNode[]; dismiss: () => void } | null = null
let swipeCapture: ((nodes: ActionNode[], dismiss: () => void) => void) | null = null

function dispatchContextMenu(x: number, y: number): boolean {
  const el = document.elementFromPoint(x, y)
  const target = el?.closest(CTX_SELECTOR) ?? el
  if (!target) return false
  target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
  return true
}

function installContextMenus(): void {
  setActionMenuPresenter((nodes, at, onDismiss) => {
    if (swipeCapture) {
      const take = swipeCapture
      swipeCapture = null
      take(nodes, onDismiss)
      return () => {}
    }
    const seq = ++ctxSeq
    ctx = { seq, nodes, dismiss: onDismiss }
    const { tree, excluded } = pruneForPhone(toWire(nodes))
    if (excluded.length) console.info(`[actions] context left out ${excluded.join(', ')}`)
    logActionTree('context', tree)
    postToShell({ type: 'contextMenu', seq, tree, x: at.x, y: at.y })
    return () => {
      if (ctx?.seq === seq) ctx = null
    }
  })
  let press: { x: number; y: number; timer: number } | null = null
  const cancelPress = (): void => {
    if (press) window.clearTimeout(press.timer)
    press = null
  }
  document.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0]
      const hit = e.touches.length === 1 && e.target instanceof Element ? e.target.closest<HTMLElement>(CTX_SELECTOR) : null
      cancelPress()
      if (hit && t) {
        const at = { x: t.clientX, y: t.clientY }
        press = {
          ...at,
          timer: window.setTimeout(() => {
            press = null
            console.info(`[actions] long press at ${Math.round(at.x)},${Math.round(at.y)}`)
            swallowClickUntil = performance.now() + 900
            postToShell({ type: 'haptic' })
            ctx = null
            dispatchContextMenu(at.x, at.y)
          }, LONG_PRESS_MS)
        }
      }
    },
    { capture: true, passive: true }
  )
  document.addEventListener(
    'touchmove',
    (e) => {
      const t = e.touches[0]
      if (press && t && Math.hypot(t.clientX - press.x, t.clientY - press.y) > 8) cancelPress()
    },
    { capture: true, passive: true }
  )
  let swallowClickUntil = 0
  document.addEventListener(
    'click',
    (e) => {
      if (performance.now() > swallowClickUntil) return
      if (e.target instanceof Element && e.target.closest('[data-ws-menu]')) return
      swallowClickUntil = 0
      e.preventDefault()
      e.stopPropagation()
    },
    { capture: true }
  )
  document.addEventListener('touchend', cancelPress, { capture: true, passive: true })
  document.addEventListener('touchcancel', cancelPress, { capture: true, passive: true })
  installSwipe()
}

function installSwipe(): void {
  let start: { x: number; y: number; row: HTMLElement; t: number } | null = null
  let tray: HTMLElement | null = null
  let opened: { row: HTMLElement; tray: HTMLElement; dismiss: () => void } | null = null
  const close = (): void => {
    if (!opened) return
    opened.row.style.transition = 'transform 160ms ease'
    opened.row.style.transform = ''
    opened.tray.remove()
    opened.dismiss()
    opened = null
  }
  const openTray = (row: HTMLElement, x: number, y: number): void => {
    swipeCapture = (nodes, dismiss) => {
      const flat = (ns: ActionNode[]): ActionNode[] => ns.flatMap((n) => (n.children ? flat(n.children) : [n]))
      const picks = flat(nodes).filter((n) => n.swipe && n.enabled !== false).slice(0, 3)
      if (!picks.length) {
        dismiss()
        row.style.transform = ''
        return
      }
      const shifted = row.style.transform
      row.style.transform = ''
      const r = row.getBoundingClientRect()
      row.style.transform = shifted
      const el = document.createElement('div')
      el.dataset.phoneSwipeTray = ''
      el.style.cssText = `position:fixed;z-index:60;top:${r.top}px;height:${r.height}px;right:${Math.max(0, window.innerWidth - r.right)}px;display:flex;`
      let width = 0
      for (const n of picks) {
        const b = document.createElement('button')
        b.textContent = n.label.replace(/ \(.*\)$/, '').replace(' Changes', '')
        b.dataset.phoneSwipe = n.id
        const bg = n.destructive ? 'var(--err, #ef6e6b)' : n.swipe === 'unstage' ? '#636366' : 'var(--accent, #8196ff)'
        b.style.cssText = `background:${bg};color:#fff;font:600 12px var(--ui, system-ui);padding:0 14px;border:0;`
        b.addEventListener('click', (ev) => {
          ev.stopPropagation()
          b.classList.add('remote-pending')
          console.info(`[actions] swipe ${n.id}`)
          void runTracked(() => n.run?.())
            .then(
              () => postToShell({ type: 'haptic', kind: 'success' }),
              (err: Error) => postToShell({ type: 'toast', text: err.message || `${n.label} failed`, retryId: null })
            )
            .finally(() => close())
        })
        el.appendChild(b)
        width += 74
      }
      document.body.appendChild(el)
      width = el.getBoundingClientRect().width || width
      row.style.transition = 'transform 160ms ease'
      row.style.transform = `translateX(${-width}px)`
      opened = { row, tray: el, dismiss }
      tray = el
    }
    const mine = swipeCapture
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 2 }))
    setTimeout(() => {
      if (swipeCapture !== mine) return
      swipeCapture = null
      row.style.transition = 'transform 160ms ease'
      row.style.transform = ''
    }, 800)
  }
  document.addEventListener(
    'touchstart',
    (e) => {
      if (opened && !(e.target instanceof Element && e.target.closest('[data-phone-swipe-tray]'))) close()
      const t = e.touches[0]
      const row = e.target instanceof Element ? e.target.closest<HTMLElement>('.scm-row, [data-scm-stash]') : null
      start = row && t && e.touches.length === 1 ? { x: t.clientX, y: t.clientY, row, t: Date.now() } : null
    },
    { capture: true, passive: true }
  )
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!start) return
      const t = e.touches[0]
      const dx = t.clientX - start.x
      const dy = t.clientY - start.y
      if (Math.abs(dy) > 14 && Math.abs(dy) > Math.abs(dx)) {
        start.row.style.transform = ''
        start = null
        return
      }
      if (dx < -6 && Math.abs(dx) > Math.abs(dy)) {
        start.row.style.transition = ''
        start.row.style.transform = `translateX(${Math.max(dx, -220)}px)`
      }
    },
    { capture: true, passive: true }
  )
  document.addEventListener(
    'touchend',
    (e) => {
      if (!start) return
      const t = e.changedTouches[0]
      const dx = t.clientX - start.x
      const s = start
      start = null
      if (dx < -48) {
        openTray(s.row, s.x, s.y)
        return
      }
      s.row.style.transition = 'transform 160ms ease'
      s.row.style.transform = ''
    },
    { capture: true, passive: true }
  )
  void tray
}

function installConfirmRouting(): void {
  useConfirmStore.subscribe((st, prev) => {
    const req = st.request
    if (!req || req === prev.request || req.remote) return
    useConfirmStore.setState({ request: { ...req, remote: true } })
    console.info(`[actions] confirm ${req.title}`)
    for (const w of [...confirmWaiters]) w()
    postToShell({
      type: 'confirm',
      origin: 'l',
      id: req.id,
      title: req.title,
      message: req.message,
      ...(req.confirmLabel ? { confirmLabel: req.confirmLabel } : {}),
      ...(req.secondaryLabel ? { secondaryLabel: req.secondaryLabel } : {}),
      ...(req.cancelLabel ? { cancelLabel: req.cancelLabel } : {}),
      ...(req.danger ? { danger: true } : {})
    })
  })
}

function installClipboard(): void {
  const write = (text: string): Promise<void> => {
    postToShell({ type: 'copy', text: String(text) })
    return Promise.resolve()
  }
  try {
    window.api.ui.writeClipboardText = write as typeof window.api.ui.writeClipboardText
  } catch {
  }
  const w = window as unknown as { ClipboardItem?: unknown }
  if (!w.ClipboardItem)
    w.ClipboardItem = class {
      constructor(readonly items: Record<string, unknown>) {}
    }
  try {
    Object.defineProperty(navigator, 'clipboard', { value: { ...(navigator.clipboard ?? {}), writeText: write, write: () => Promise.resolve() }, configurable: true })
  } catch {
  }
}

function findRole(tree: ActionNode[], role: 'undo' | 'redo'): ActionNode | null {
  for (const n of tree) {
    if (n.role === role) return n
    if (n.children) {
      const hit = findRole(n.children, role)
      if (hit) return hit
    }
  }
  return null
}

function installEditingReport(): void {
  let on = false
  const editable = (t: EventTarget | null): boolean =>
    t instanceof HTMLElement && !t.classList.contains('xterm-helper-textarea') && (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t.isContentEditable)
  const report = (): void => {
    const next = editable(document.activeElement)
    if (next === on) return
    on = next
    postToShell({ type: 'editing', on })
  }
  document.addEventListener('focusin', () => setTimeout(report, 0), true)
  document.addEventListener('focusout', () => setTimeout(report, 0), true)
}

function rowText(el: Element): string {
  return (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60)
}

function touch(el: Element, x: number, y: number): Touch {
  return new Touch({ identifier: 7, target: el, clientX: x, clientY: y, pageX: x, pageY: y, screenX: x, screenY: y })
}

function installDriveHooks(): void {
  onDrive((m) => {
    if (m.action === 'rows') {
      const rows = [...document.querySelectorAll(CTX_SELECTOR)].map((el) => {
        const r = el.getBoundingClientRect()
        return `${Math.round(r.left + r.width / 2)},${Math.round(r.top + r.height / 2)} ${rowText(el)}`
      })
      console.info(`[actions] rows\n${rows.join('\n')}`)
    }
    if (m.action === 'swipe') {
      const want = String(m.text ?? '')
      const row = [...document.querySelectorAll(CTX_SELECTOR)].find((el) => rowText(el).includes(want))
      if (!row) return console.info(`[actions] swipe: no row ${want}`)
      const r = row.getBoundingClientRect()
      const y = r.top + r.height / 2
      const x0 = r.right - 30
      const fire = (type: string, x: number): void => {
        const t = touch(row, x, y)
        row.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t] }))
      }
      fire('touchstart', x0)
      fire('touchmove', x0 - 40)
      fire('touchmove', x0 - 90)
      fire('touchend', x0 - 90)
      setTimeout(() => {
        const buttons = [...document.querySelectorAll<HTMLElement>('[data-phone-swipe]')].map((b) => `${b.dataset.phoneSwipe}=${b.textContent}`)
        console.info(`[actions] swipe ${want}: tray ${buttons.join(', ') || 'empty'}`)
      }, 700)
    }
    if (m.action === 'pull') {
      const scroller = document.querySelector<HTMLElement>('[data-scm-changes] .overflow-auto')
      if (!scroller) return console.info('[actions] pull: no list')
      const r = scroller.getBoundingClientRect()
      const fire = (type: string, y: number): void => {
        const t = touch(scroller, r.left + 40, y)
        scroller.dispatchEvent(new TouchEvent(type, { bubbles: true, cancelable: true, touches: type === 'touchend' ? [] : [t], targetTouches: type === 'touchend' ? [] : [t], changedTouches: [t] }))
      }
      fire('touchstart', r.top + 10)
      fire('touchmove', r.top + 60)
      fire('touchmove', r.top + 110)
      fire('touchend', r.top + 110)
    }
    if (m.action === 'swipeTap') {
      const b = document.querySelector<HTMLElement>(`[data-phone-swipe="${String(m.text ?? '')}"]`)
      console.info(`[actions] swipe tap ${m.text}: ${b ? 'found' : 'missing'}`)
      b?.click()
    }
  })
}

function installPullToRefresh(): void {
  let start: { y: number; scroller: HTMLElement } | null = null
  let tag: HTMLElement | null = null
  const clear = (): void => {
    tag?.remove()
    tag = null
  }
  document.addEventListener(
    'touchstart',
    (e) => {
      const t = e.touches[0]
      const scroller = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-scm-changes] .overflow-auto') : null
      start = scroller && t && scroller.scrollTop <= 0 && e.touches.length === 1 ? { y: t.clientY, scroller } : null
    },
    { capture: true, passive: true }
  )
  document.addEventListener(
    'touchmove',
    (e) => {
      if (!start) return
      const dy = e.touches[0].clientY - start.y
      if (dy < 20 || start.scroller.scrollTop > 0) return clear()
      if (!tag) {
        tag = document.createElement('div')
        tag.dataset.phonePtr = ''
        start.scroller.parentElement?.appendChild(tag)
      }
      tag.textContent = dy > 70 ? 'Release to refresh' : 'Pull to refresh'
    },
    { capture: true, passive: true }
  )
  document.addEventListener(
    'touchend',
    (e) => {
      const s = start
      start = null
      clear()
      if (!s || !shown) return
      const dy = e.changedTouches[0].clientY - s.y
      if (dy <= 70 || s.scroller.scrollTop > 0) return
      const node = localNodes(shown.scopes).flatMap(function flat(n: ActionNode): ActionNode[] { return n.children ? n.children.flatMap(flat) : [n] }).find((n) => n.id === 'scm.toolbar.refresh')
      console.info(`[actions] pull to refresh ${node ? 'run' : 'no refresh here'}`)
      if (node) void runTracked(() => node.run?.()).then(() => postToShell({ type: 'haptic', kind: 'success' }))
    },
    { capture: true, passive: true }
  )
}

export function installPhoneActions(): void {
  installPullToRefresh()
  installDriveHooks()
  installEditingReport()
  installContextMenus()
  installConfirmRouting()
  installClipboard()
  setRemoteFileOpener((req) => {
    console.info(`[actions] open on Mac ${req.file}`)
    void desktopCall('openFile', [req]).catch((e: Error) => postToShell({ type: 'toast', text: e.message, retryId: null }))
    return true
  })
  exposeToShell({
    panelAction: (id: string, value: unknown, req: unknown) => {
      const v = value === null || value === undefined ? undefined : String(value)
      void acked(req, () => runShown(String(id), v))
      return true
    },
    contextPick: (seq: number, id: string, value: unknown, req: unknown) => {
      const cur = ctx
      if (!cur || cur.seq !== Number(seq)) {
        ack(req, false, 'That menu closed')
        return false
      }
      ctx = null
      console.info(`[actions] context pick ${id}`)
      void acked(req, async () => {
        try {
          await untilConfirm(() => runTracked(() => runAction(cur.nodes, String(id), value === null || value === undefined ? undefined : String(value))))
        } finally {
          cur.dismiss()
        }
      })
      return true
    },
    contextDismiss: (seq: number) => {
      if (ctx && ctx.seq === Number(seq)) {
        const d = ctx.dismiss
        ctx = null
        d()
      }
      return true
    },
    confirm: (origin: string, id: number, choice: string, req: unknown) => {
      const c = (choice === 'confirm' || choice === 'secondary' ? choice : 'cancel') as ConfirmChoice
      console.info(`[actions] confirm answer ${origin}:${id} ${c}`)
      if (origin === 'd') {
        void acked(req, () => desktopCall('answerConfirm', [id, c]))
        return true
      }
      const cur = useConfirmStore.getState().request
      if (cur && cur.id === Number(id)) useConfirmStore.getState().respond(c)
      ack(req, true)
      return true
    },
    undo: (role: string, req: unknown) => {
      const r = role === 'redo' ? 'redo' : 'undo'
      const node = shown ? findRole(localNodes(shown.scopes), r) : null
      if (!node) {
        ack(req, false, `Nothing to ${r} here`)
        return false
      }
      void acked(req, () => runTracked(() => node.run?.()))
      return true
    },
    pickerQuery: (seq: number, text: string) => {
      if (!picker || picker.seq !== Number(seq)) return false
      picker.query = String(text ?? '')
      void loadPicker(picker)
      return true
    },
    pickerPick: (seq: number, id: string, req: unknown) => {
      const p = picker
      if (!p || p.seq !== Number(seq)) {
        ack(req, false, 'That list closed')
        return false
      }
      console.info(`[picker] ${p.kind} pick ${id}`)
      void acked(req, async () => {
        await desktopCall('pickerPick', [p.kind, String(id)])
        if (picker === p) picker = null
        setTimeout(() => refreshDesktop?.(), 150)
      })
      return true
    },
    pickerDismiss: (seq: number) => {
      const p = picker
      if (!p || p.seq !== Number(seq)) return false
      picker = null
      console.info(`[picker] ${p.kind} dismissed`)
      void desktopCall('pickerDismiss', [p.kind]).catch(() => {})
      return true
    }
  })
}

export function UnityActionsHost({ ptyId, projectPath, canStop = true }: { ptyId: string; projectPath: string; canStop?: boolean }) {
  useUnityPlayerController({ id: ptyId, projectPath, canStop, remote: true })
  return null
}

export function useRefreshOnSelect(tabId: string | null): void {
  const prev = useRef<string | null>(null)
  useEffect(() => {
    if (prev.current !== tabId) refreshDesktop?.()
    prev.current = tabId
  }, [tabId])
}
