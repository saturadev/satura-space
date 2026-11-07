const LAYERS = '[data-menu-layer], [data-ti-popup], [data-ti-menu], [data-report-popover], [data-tuner-popup-depth]'
const TOUCH_GRACE_MS = 1500

let touching = false
let touchEnd = 0

function openLayers(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(LAYERS)].filter((el) => el.isConnected && el.getClientRects().length > 0)
}

function describe(el: EventTarget | null): string {
  if (!(el instanceof Element)) return 'the page'
  const tag = el.tagName.toLowerCase()
  const mark = [...el.attributes].find((a) => a.name.startsWith('data-'))?.name
  return mark ? `${tag}[${mark}]` : el.className && typeof el.className === 'string' ? `${tag}.${el.className.split(' ')[0]}` : tag
}

export function dismissPopovers(why: string): number {
  const open = openLayers()
  if (!open.length) return 0
  for (const type of ['pointerdown', 'mousedown']) {
    const Ctor = type === 'pointerdown' && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent
    document.body.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, view: window, clientX: 0, clientY: 0 }))
  }
  requestAnimationFrame(() => console.info(`[popover] ${why}: closed ${open.length - openLayers().length} of ${open.length} open popover(s)`))
  return open.length
}

export function installPopoverDismiss(): void {
  document.addEventListener('touchstart', () => (touching = true), { capture: true, passive: true })
  const up = (): void => {
    touching = false
    touchEnd = Date.now()
  }
  document.addEventListener('touchend', up, { capture: true, passive: true })
  document.addEventListener('touchcancel', up, { capture: true, passive: true })
  document.addEventListener(
    'scroll',
    (e) => {
      if (!touching && Date.now() - touchEnd > TOUCH_GRACE_MS) return
      const t = e.target
      if (t instanceof Element && t.closest(LAYERS)) return
      if (document.activeElement?.closest(LAYERS)) return
      if (!openLayers().length) return
      dismissPopovers(`scroll of ${describe(t === document ? null : t)}`)
    },
    { capture: true, passive: true }
  )
}
