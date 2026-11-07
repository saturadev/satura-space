import { clampPhoneReportScale } from '@shared/types'
import { emit } from './channel'

const MEDIA_SURFACE = '[data-media-surface], .sr-viewport, .rk-overlay, [data-image-viewer]'

export function installFramePinch(currentZoom: () => number): void {
  let start: { d: number; z: number; host: HTMLElement; anchor: HTMLElement | null; top: number } | null = null
  let raf = 0
  let want = 0
  const opts = { capture: true, passive: false } as const
  const dist = (t: TouchList): number => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY)
  const within = (t: TouchList, sel: string): boolean => [0, 1].some((i) => t[i].target instanceof Element && !!(t[i].target as Element).closest(sel))
  const apply = (s: NonNullable<typeof start>, z: number): number => {
    const next = clampPhoneReportScale(z)
    s.host.style.zoom = next === 1 ? '' : String(next)
    s.host.toggleAttribute('data-scaled', next !== 1)
    if (s.anchor) {
      const r = s.host.getBoundingClientRect()
      const unit = s.host.clientHeight > 0 ? r.height / s.host.clientHeight : 1
      const moved = s.anchor.getBoundingClientRect().top - s.top
      if (Math.abs(moved) > 0.5) s.host.scrollTop += moved / (unit || 1)
      s.top = s.anchor.getBoundingClientRect().top
    }
    return next
  }
  window.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 2 || within(e.touches, MEDIA_SURFACE)) return
      const host = document.querySelector<HTMLElement>('.rk-host')
      if (!host) return
      const x = (e.touches[0].clientX + e.touches[1].clientX) / 2
      const y = (e.touches[0].clientY + e.touches[1].clientY) / 2
      const hit = document.elementFromPoint(x, y)
      const anchor = hit instanceof HTMLElement && host.contains(hit) ? hit : host.querySelector<HTMLElement>('.rk-report')
      start = { d: dist(e.touches), z: currentZoom(), host, anchor, top: anchor?.getBoundingClientRect().top ?? 0 }
      e.preventDefault()
      e.stopPropagation()
    },
    opts
  )
  window.addEventListener(
    'touchmove',
    (e) => {
      if (!start || e.touches.length !== 2) return
      e.preventDefault()
      e.stopPropagation()
      want = start.z * (dist(e.touches) / Math.max(1, start.d))
      if (!raf)
        raf = requestAnimationFrame(() => {
          raf = 0
          if (start) emit({ e: 'zoom', scale: apply(start, want), done: false })
        })
    },
    opts
  )
  const end = (e: TouchEvent): void => {
    if (!start || (e.type === 'touchend' && e.touches.length >= 2)) return
    const s = start
    start = null
    if (raf) {
      cancelAnimationFrame(raf)
      raf = 0
    }
    const z = apply(s, want || s.z)
    console.info(`[report] pinch scale ${Math.round(s.z * 100)}% -> ${Math.round(z * 100)}%`)
    emit({ e: 'zoom', scale: z, done: true })
  }
  window.addEventListener('touchend', end, opts)
  window.addEventListener('touchcancel', end, opts)
}
