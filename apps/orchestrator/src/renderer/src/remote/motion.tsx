import { createContext, useContext, useEffect, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from 'react'
import { createPortal, flushSync } from 'react-dom'

export type Nav = 'push' | 'pop' | 'swap'

const Leaving = createContext(false)

export function reducedMotion(): boolean {
  return window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
}

export function exitMs(): number {
  return reducedMotion() ? 120 : 200
}

export function useLeaving(): boolean {
  return useContext(Leaving)
}

export function usePresence<T>(value: T | null | undefined | false): [T | null, boolean] {
  const kept = useRef<T | null>(value || null)
  const [, bump] = useState(0)
  if (value) kept.current = value
  const leaving = !value && kept.current !== null
  useEffect(() => {
    if (!leaving) return
    const t = window.setTimeout(() => {
      kept.current = null
      bump((n) => n + 1)
    }, exitMs())
    return () => window.clearTimeout(t)
  }, [leaving])
  return [value || kept.current, leaving]
}

export function Presence<T>({ when, children }: { when: T | null | undefined | false; children: (value: T) => ReactNode }) {
  const [shown, leaving] = usePresence(when)
  if (shown === null) return null
  return (
    <Leaving.Provider value={leaving}>
      <div style={{ display: 'contents' }} data-leaving={leaving ? '' : undefined} inert={leaving}>
        {children(shown)}
      </div>
    </Leaving.Provider>
  )
}

export function Layer({ className = '', children, ...rest }: HTMLAttributes<HTMLDivElement> & { children: ReactNode }) {
  const leaving = useLeaving()
  return createPortal(
    <div {...rest} className={`ws-layer ${className}`} data-leaving={leaving ? '' : undefined} inert={leaving}>
      {children}
    </div>,
    document.body
  )
}

export function Crossfade({ k, children, className = '' }: { k: string; children: ReactNode; className?: string }) {
  const cur = useRef<{ k: string; node: ReactNode }>({ k, node: children })
  const prev = useRef<{ k: string; node: ReactNode } | null>(null)
  const [, bump] = useState(0)
  if (cur.current.k !== k) prev.current = cur.current
  cur.current = { k, node: children }
  useEffect(() => {
    if (!prev.current) return
    const t = window.setTimeout(() => {
      prev.current = null
      bump((n) => n + 1)
    }, exitMs())
    return () => window.clearTimeout(t)
  }, [k])
  const old = prev.current
  return (
    <div className={`ws-xfade ${className}`}>
      {old && old.k !== k && (
        <div key={old.k} className="ws-swap" data-leaving="" inert>
          {old.node}
        </div>
      )}
      <div key={k} className="ws-swap">
        {children}
      </div>
    </div>
  )
}

export const PROGRESS_CAP = 0.96

export function ProgressBar({ value, className = '' }: { value: number | null; className?: string }) {
  const top = useRef(0)
  if (value !== null) top.current = Math.max(top.current, Math.min(PROGRESS_CAP, Math.max(0, value)))
  return (
    <div className={`ws-bar ${className}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value === null ? undefined : Math.round(top.current * 100)} data-indeterminate={value === null ? '' : undefined} data-progress={Math.round(top.current * 1000) / 1000} style={{ '--p': top.current } as CSSProperties}>
      <i />
    </div>
  )
}

export function useStageProgress(stage: string, from: number, to: number, pct = -1, tauMs = 6000): number {
  const since = useRef({ stage, at: Date.now() })
  if (since.current.stage !== stage) since.current = { stage, at: Date.now() }
  const [, tick] = useState(0)
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 500)
    return () => window.clearInterval(t)
  }, [])
  const f = pct >= 0 ? Math.min(1, pct / 100) : 0.9 * (1 - Math.exp(-(Date.now() - since.current.at) / tauMs))
  return from + (to - from) * f
}

export function flipSnapshot(root: HTMLElement | null): Map<string, DOMRect> {
  const out = new Map<string, DOMRect>()
  for (const el of root?.querySelectorAll<HTMLElement>('[data-flip]') ?? []) out.set(el.dataset.flip as string, el.getBoundingClientRect())
  return out
}

export function flipPlay(root: HTMLElement | null, before: Map<string, DOMRect>): number {
  if (reducedMotion()) return 0
  let moved = 0
  for (const el of root?.querySelectorAll<HTMLElement>('[data-flip]') ?? []) {
    const was = before.get(el.dataset.flip as string)
    if (!was) continue
    const now = el.getBoundingClientRect()
    const dx = was.left - now.left
    const dy = was.top - now.top
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue
    moved++
    el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 260, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' })
  }
  return moved
}

type Transitioning = { finished: Promise<void>; ready?: Promise<void> }
type StartTransition = (update: () => Promise<void> | void) => Transitioning

let running: Transitioning | null = null

function nav(dir: Nav, finished: Promise<void>, t: Transitioning): void {
  const html = document.documentElement
  if (!reducedMotion()) html.dataset.nav = dir
  running = t
  void finished.finally(() => {
    if (running !== t) return
    running = null
    delete html.dataset.nav
  })
}

export function navigate(dir: Nav, update: () => void, settleMs = 0): void {
  const start = (document as Document & { startViewTransition?: StartTransition }).startViewTransition?.bind(document)
  if (!start || document.visibilityState !== 'visible') return update()
  const t = start(() => {
    flushSync(update)
    if (settleMs) return new Promise<void>((r) => window.setTimeout(r, settleMs))
  })
  t.ready?.catch(() => {})
  nav(dir, t.finished, t)
}

function syncViewport(): void {
  const vv = window.visualViewport
  const h = window.innerHeight
  const top = vv ? Math.max(0, vv.offsetTop) : 0
  const height = vv ? vv.height : h
  const kb = Math.max(0, Math.round(h - height - top))
  const s = document.documentElement.style
  s.setProperty('--ws-kb', `${h - height > 60 ? kb : 0}px`)
  s.setProperty('--ws-vv-top', `${Math.round(top)}px`)
  s.setProperty('--ws-vv-h', `${Math.round(height)}px`)
}

const TAPPABLE = 'button, a[href], [role="button"], [role="switch"], [role="menuitem"], [role="tab"], [data-tap], summary, select, .scm-row'
const PRESS_MIN_MS = 110
const PRESS_SLOP_PX = 10

let tapLogOn: boolean | null = null

function tapLogging(): boolean {
  if (tapLogOn === null) {
    let flag = ''
    try {
      flag = window.localStorage.getItem('satura-remote-taplog') ?? ''
    } catch {
    }
    tapLogOn = flag === '1' || (flag !== '0' && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname))
  }
  return tapLogOn
}

function tapName(el: Element | null): string {
  const h = el instanceof HTMLElement ? el : null
  const text = h?.getAttribute('aria-label') || h?.dataset.tapName || h?.textContent || h?.tagName.toLowerCase() || ''
  return text.trim().replace(/\s+/g, ' ').slice(0, 40)
}

export function afterPaint(fn: (at: number) => void): void {
  requestAnimationFrame(() => requestAnimationFrame(fn))
}

let lastTap: { at: number; el: HTMLElement } | null = null

export function tapStartedAt(): number | null {
  return lastTap && performance.now() - lastTap.at < 1500 ? lastTap.at : null
}

export function logTap(what: string, stages: Record<string, number | null>): void {
  if (!tapLogging()) return
  const parts = Object.entries(stages)
    .filter(([, v]) => v !== null)
    .map(([k, v]) => `${k} ${Math.round(v as number)} ms`)
  console.info(`[tap] ${what}: ${parts.join(', ')}`)
}

function installPress(): void {
  let pressed: { el: HTMLElement; at: number; x: number; y: number } | null = null
  const release = (): void => {
    const p = pressed
    if (!p) return
    pressed = null
    const left = PRESS_MIN_MS - (performance.now() - p.at)
    if (left > 0) window.setTimeout(() => pressed?.el !== p.el && p.el.removeAttribute('data-pressed'), left)
    else p.el.removeAttribute('data-pressed')
  }
  const drop = (): void => {
    pressed?.el.removeAttribute('data-pressed')
    pressed = null
  }
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return
      const el = e.target instanceof Element ? e.target.closest<HTMLElement>(TAPPABLE) : null
      drop()
      if (!el || el.closest('[data-no-press]') || (el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') return
      el.setAttribute('data-pressed', '')
      pressed = { el, at: performance.now(), x: e.clientX, y: e.clientY }
      lastTap = { at: e.timeStamp, el }
      if (tapLogging()) afterPaint((at) => logTap(`press ${tapName(el)}`, { shown: at - e.timeStamp }))
    },
    { capture: true, passive: true }
  )
  document.addEventListener(
    'pointermove',
    (e) => {
      if (pressed && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > PRESS_SLOP_PX) drop()
    },
    { capture: true, passive: true }
  )
  for (const type of ['pointerup', 'pointercancel', 'dragstart']) document.addEventListener(type, release, { capture: true, passive: true })
  document.addEventListener('scroll', drop, { capture: true, passive: true })
  document.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Enter' || e.key.length === 1) lastTap = { at: e.timeStamp, el: e.target instanceof HTMLElement ? e.target : document.body }
    },
    { capture: true, passive: true }
  )
  document.addEventListener('click', (e) => {
    const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null
    if (!a || e.defaultPrevented || a.target === '_blank' || a.hasAttribute('download') || a.origin !== location.origin || !/^https?:$/.test(a.protocol)) return
    e.preventDefault()
    if (a.href === location.href) return
    const page = a.pathname !== location.pathname || a.search !== location.search
    if (page) markLeaving(a)
    const whole = a.target === '_top' && window.top && window.top !== window ? window.top : null
    console.info(`[web-shell] link to ${a.pathname}${a.search}${a.hash} replaces ${whole ? 'the whole tab' : 'this page'}${page ? `, "${tapName(a)}" shows it` : ''}`)
    ;(whole ?? window).location.replace(a.href)
  })
  window.addEventListener('pageshow', (e) => {
    if (!e.persisted) return
    for (const el of document.querySelectorAll('[data-pressed], [data-leaving-page]')) {
      el.removeAttribute('data-pressed')
      el.removeAttribute('data-leaving-page')
      el.removeAttribute('aria-busy')
    }
  })
}

function markLeaving(el: HTMLElement): void {
  el.setAttribute('data-leaving-page', '')
  el.setAttribute('aria-busy', 'true')
}

export function leavePage(url: string, why = ''): void {
  const el = lastTap && performance.now() - lastTap.at < 1500 && lastTap.el.isConnected ? lastTap.el : null
  if (el) markLeaving(el)
  console.info(`[web-shell] leaving for ${url}${why ? ` (${why})` : ''}, replacing this page${el ? `, "${tapName(el)}" shows it` : ''}`)
  location.replace(url)
}

let installed = false

export function installMotion(): void {
  if (installed) return
  installed = true
  installPress()
  syncViewport()
  window.visualViewport?.addEventListener('resize', syncViewport)
  window.visualViewport?.addEventListener('scroll', syncViewport)
  window.addEventListener('resize', syncViewport)
  window.addEventListener('pagereveal', (e) => {
    const t = (e as Event & { viewTransition?: Transitioning | null }).viewTransition
    if (t) nav(location.pathname.startsWith('/h/all') ? 'pop' : 'push', t.finished, t)
  })
}
