const SCROLLER = '[data-tuner-phone-scene] > [data-tuner-toolbar] .bar-x-scroll'
const PAD = 3
const MIN_THUMB = 18

function lane(host: HTMLElement, attr: string): HTMLElement {
  let el = host.querySelector<HTMLElement>(`:scope > [${attr}]`)
  if (!el) {
    el = document.createElement('div')
    el.setAttribute(attr, '')
    el.setAttribute('aria-hidden', 'true')
    host.appendChild(el)
  }
  return el
}

function sync(el: HTMLElement): void {
  const host = el.parentElement
  if (!host) return
  const rail = lane(host, 'data-toolbar-track')
  const thumb = lane(host, 'data-toolbar-thumb')
  const view = el.clientHeight
  const full = el.scrollHeight
  if (full <= view + 1 || view < MIN_THUMB + 2 * PAD) {
    rail.hidden = true
    thumb.hidden = true
    return
  }
  const track = view - 2 * PAD
  const h = Math.max(MIN_THUMB, (track * view) / full)
  const top = PAD + ((track - h) * Math.min(1, Math.max(0, el.scrollTop / (full - view))))
  rail.hidden = false
  rail.style.height = `${track.toFixed(1)}px`
  rail.style.transform = `translateY(${(el.offsetTop + PAD).toFixed(1)}px)`
  thumb.hidden = false
  thumb.style.height = `${h.toFixed(1)}px`
  thumb.style.transform = `translateY(${(el.offsetTop + top).toFixed(1)}px)`
}

export function installToolbarScrollbar(): void {
  const seen = new WeakSet<HTMLElement>()
  const ro = new ResizeObserver((entries) => {
    for (const e of entries) {
      const el = (e.target as HTMLElement).closest<HTMLElement>(SCROLLER)
      if (el) sync(el)
    }
  })
  let queued = 0
  const scan = (): void => {
    queued = 0
    for (const el of document.querySelectorAll<HTMLElement>(SCROLLER)) {
      if (!seen.has(el)) {
        seen.add(el)
        ro.observe(el)
        for (const c of Array.from(el.children)) ro.observe(c)
      }
      sync(el)
    }
  }
  new MutationObserver(() => {
    if (!queued) queued = requestAnimationFrame(scan)
  }).observe(document.body, { childList: true, subtree: true })
  document.addEventListener(
    'scroll',
    (e) => {
      const t = e.target
      if (t instanceof HTMLElement && t.matches(SCROLLER)) sync(t)
    },
    { capture: true, passive: true }
  )
  scan()
}
