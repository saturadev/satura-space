import { flushSync } from 'react-dom'
import { create } from 'zustand'
import type { WireAction } from '../../lib/actions/action-tree'
import { call, goBack, perform, run, useShell } from './bridge'

export interface View {
  w: number
  h: number
  top: number
  kb: number
  keyboard: number
  safe: { t: number; r: number; b: number; l: number }
  landscape: boolean
  corner: number
  islandLeft: boolean
}

let probe: HTMLDivElement | null = null

function safeArea(): View['safe'] {
  if (!probe) {
    probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
    document.body.appendChild(probe)
  }
  const cs = getComputedStyle(probe)
  return { t: parseFloat(cs.paddingTop) || 0, r: parseFloat(cs.paddingRight) || 0, b: parseFloat(cs.paddingBottom) || 0, l: parseFloat(cs.paddingLeft) || 0 }
}

export function standalone(): boolean {
  return window.matchMedia?.('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true
}

function measure(): View {
  const vv = window.visualViewport
  const w = window.innerWidth
  const h = window.innerHeight
  const vvH = vv ? vv.height : h
  const top = vv ? Math.max(0, vv.offsetTop) : 0
  const keyboard = Math.max(0, Math.round(h - vvH))
  const kb = Math.max(0, Math.round(h - vvH - top))
  const safe = safeArea()
  const edge = Math.max(safe.t, safe.l, safe.r)
  const angle = screen.orientation?.angle ?? Number((window as unknown as { orientation?: number }).orientation ?? 0)
  return {
    w,
    h,
    top: Math.round(top),
    kb: keyboard > 60 ? kb : 0,
    keyboard: keyboard > 60 ? keyboard : 0,
    safe,
    landscape: w > h && h < 500 && !screen.orientation?.type.startsWith('portrait'),
    corner: edge >= 51 ? 55 : edge >= 44 ? 47 : 0,
    islandLeft: angle === 90
  }
}

export const useView = create<View>(() => ({ w: 0, h: 0, top: 0, kb: 0, keyboard: 0, safe: { t: 0, r: 0, b: 0, l: 0 }, landscape: false, corner: 0, islandLeft: false }))

let frame = 0
let settleTimer = 0

function update(): void {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    const next = measure()
    const prev = useView.getState()
    if (next.keyboard !== prev.keyboard || (next.keyboard && (next.kb !== prev.kb || next.top !== prev.top)))
      console.info(`[web-shell] keyboard ${next.keyboard ? `up ${next.keyboard} px, page panned ${next.top} px, ${next.kb} px of the page under it` : 'down'} in ${next.w}x${next.h}`)
    if (JSON.stringify(next) !== JSON.stringify(prev)) useView.setState(next)
    if (document.scrollingElement && document.scrollingElement.scrollTop) document.scrollingElement.scrollTop = 0
  })
  window.clearTimeout(settleTimer)
  settleTimer = window.setTimeout(update, 350)
}

function leaves(nodes: WireAction[]): WireAction[] {
  return nodes.flatMap((n) => (n.children ? leaves(n.children) : [n]))
}

const KEY_NAMES: Record<string, string> = { plus: '+', minus: '-', enter: 'enter', esc: 'escape', up: 'arrowup', down: 'arrowdown', left: 'arrowleft', right: 'arrowright', space: ' ', backspace: 'backspace', tab: 'tab' }
const apple = /Mac|iPhone|iPad/.test(navigator.platform) || /iPhone|iPad|Macintosh/.test(navigator.userAgent)

function matches(shortcut: string, e: KeyboardEvent): boolean {
  if (!shortcut || shortcut.includes(' ')) return false
  const parts = shortcut.toLowerCase().split('+')
  const key = parts.pop() ?? ''
  const mods = new Set(parts)
  const wantMeta = apple && mods.has('mod')
  const wantCtrl = mods.has('ctrl') || (!apple && mods.has('mod'))
  if (e.metaKey !== wantMeta || e.ctrlKey !== wantCtrl) return false
  if (mods.has('shift') !== e.shiftKey || mods.has('alt') !== e.altKey) return false
  const want = KEY_NAMES[key] ?? key
  const got = e.key.toLowerCase()
  return got === want || (want.length === 1 && e.code.toLowerCase() === `key${want}`) || (/^f\d+$/.test(want) && got === want)
}

function editable(t: EventTarget | null): boolean {
  return t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || (t instanceof HTMLElement && t.isContentEditable)
}

function onShortcut(e: KeyboardEvent): void {
  if (e.defaultPrevented || e.repeat) return
  const s = useShell.getState()
  const panel = s.workspace?.panel
  if (!s.openId || !panel || s.confirm || s.prompt || s.picker || s.menu) return
  if (editable(e.target) && !(e.target instanceof Element && e.target.closest('[data-web-shell-composer]'))) return
  const mod = apple ? e.metaKey : e.ctrlKey
  const seen = new Set<string>()
  for (const item of leaves([...panel.actions, ...panel.tabActions, ...panel.workspaceActions])) {
    if (!item.shortcut || !item.enabled || seen.has(item.shortcut)) continue
    seen.add(item.shortcut)
    if (!matches(item.shortcut, e)) continue
    e.preventDefault()
    console.info(`[web-shell] shortcut ${item.shortcut} -> ${item.id}`)
    perform(item)
    return
  }
  if (mod && e.key.toLowerCase() === 'z' && panel.composer !== 'terminal') {
    e.preventDefault()
    const role = e.shiftKey ? 'redo' : 'undo'
    run(`undo:${role}`, role === 'redo' ? 'Redo' : 'Undo', 6, (req) => call('undo', role, req))
    return
  }
  if (mod && e.key === '[' && !editable(e.target)) {
    e.preventDefault()
    goBack()
  }
}

let hiddenAt = 0
let resumeTimer = 0

function cover(): boolean {
  const s = useShell.getState()
  if (s.conn === 'unpaired' || s.conn === 'denied' || s.conn === 'away') return false
  if (!s.resuming) flushSync(() => useShell.setState({ resuming: true }))
  return true
}

function resume(why: string): void {
  const away = hiddenAt ? Date.now() - hiddenAt : 0
  hiddenAt = 0
  call('setVisible', true)
  if (!cover()) return
  console.info(`[web-shell] resumed (${why}) after ${(away / 1000).toFixed(1)} s, checking the connection`)
  window.clearTimeout(resumeTimer)
  resumeTimer = window.setTimeout(() => {
    if (useShell.getState().resuming) console.info('[web-shell] the Mac did not answer after resume yet')
  }, 12_000)
  const sync = call('resync') as Promise<void> | null
  if (!sync || typeof sync.then !== 'function') return endResume('nothing to refresh yet')
  sync.then(
    () => endResume('resynced'),
    (e: Error) => console.info(`[web-shell] resync after resume failed: ${e?.message ?? e}`)
  )
}

export function endResume(why: string): void {
  if (!useShell.getState().resuming) return
  window.clearTimeout(resumeTimer)
  console.info(`[web-shell] fresh again: ${why}`)
  useShell.setState({ resuming: false })
}

function hide(why: string): void {
  if (!hiddenAt) hiddenAt = Date.now()
  cover()
  console.info(`[web-shell] hidden (${why}), mirrored state covered until the Mac answers`)
  call('setVisible', false)
}

let installed = false

export function installViewport(): void {
  if (installed) return
  installed = true
  useView.setState(measure())
  update()
  window.addEventListener('resize', update)
  window.addEventListener('orientationchange', update)
  window.visualViewport?.addEventListener('resize', update)
  window.visualViewport?.addEventListener('scroll', update)
  screen.orientation?.addEventListener?.('change', update)
  document.addEventListener('focusin', update, true)
  document.addEventListener('focusout', update, true)
  document.addEventListener('visibilitychange', () => (document.visibilityState === 'visible' ? resume('visible') : hide('hidden')))
  window.addEventListener('pagehide', () => hide('pagehide'))
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) resume('back from the page cache')
  })
  document.addEventListener('freeze', () => hide('frozen'))
  document.addEventListener('resume', () => resume('unfrozen'))
  window.addEventListener('online', () => resume('network back'))
  window.addEventListener('keydown', onShortcut)
  for (const type of ['gesturestart', 'gesturechange', 'gestureend'])
    document.addEventListener(type, (e) => e.preventDefault(), { passive: false } as AddEventListenerOptions)
}
