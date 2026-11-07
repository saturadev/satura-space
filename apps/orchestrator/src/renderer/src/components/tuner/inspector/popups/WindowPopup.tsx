import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { TiMods, TiRect, TiSection, TunerInspectorInput } from '@shared/tuner-inspector'
import { unityKeyCode } from '../../../../lib/tuner/inspector/model'
import { imguiTipAt, tunerTip } from '../../../../lib/tuner/inspector/tooltip'
import { viewRect } from '../../../../lib/floating'

function mods(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): TiMods {
  return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, cmd: e.metaKey }
}

const MODIFIER_KEYS = new Set(['Shift', 'Alt', 'Meta', 'Control'])
const SURFACE_INSET = 14
const TOUCH_SLOP = 8
const WHEEL_PX = 20

function fitHeight(el: HTMLElement | null): number {
  const view = Math.max(0, Math.floor(viewRect().height - SURFACE_INSET))
  const surface = el?.closest<HTMLElement>('[data-tuner-popup]')
  if (!surface) return view
  const cs = getComputedStyle(surface)
  const max = parseFloat(cs.maxHeight)
  if (!Number.isFinite(max)) return view
  const chrome = [cs.paddingTop, cs.paddingBottom, cs.borderTopWidth, cs.borderBottomWidth].reduce((n, v) => n + (parseFloat(v) || 0), 0)
  return Math.max(0, Math.min(view, Math.floor(max - chrome)))
}

interface TouchPan {
  id: number
  x: number
  y: number
  lastY: number
  at: { x: number; y: number }
  mode: 'tap' | 'scroll' | 'drag'
  wheel: number
  busy: boolean
}

function unityButton(b: number): number {
  return b === 2 ? 1 : b === 1 ? 2 : 0
}

export function WindowPopup({
  section,
  children,
  send
}: {
  section: TiRect & { key: string; title?: string; draws?: TiSection['draws'] }
  children: ReactNode
  send: (input: TunerInspectorInput) => Promise<unknown> | void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const drag = useRef<{ button: number; x: number; y: number; pending: { x: number; y: number; mods: TiMods } | null; busy: boolean } | null>(null)
  const hoverFrame = useRef(0)
  const lastHover = useRef<{ x: number; y: number } | null>(null)
  const secRef = useRef(section)
  secRef.current = section
  const pan = useRef<TouchPan | null>(null)
  const [cap, setCap] = useState(0)
  const fitted = useRef(false)

  useEffect(() => {
    ref.current?.focus({ preventScroll: true })
    const measure = (): void => setCap(fitHeight(ref.current))
    const surface = ref.current?.closest<HTMLElement>('[data-tuner-popup]')
    const ro = new ResizeObserver(measure)
    if (surface) ro.observe(surface)
    window.addEventListener('resize', measure)
    measure()
    return () => {
      cancelAnimationFrame(hoverFrame.current)
      ro.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [])

  useEffect(() => {
    if (!cap || (section.h <= cap && !fitted.current)) return
    fitted.current = true
    console.info(`[tuner] popup window ${section.title ?? section.key} is ${Math.round(section.h)} px high, fitting it into ${cap} px`)
    void send({ op: 'popupFit', section: section.key, h: cap })
  }, [section.key, cap, section.h > cap])

  const flushWheel = (): void => {
    const t = pan.current
    if (!t || t.busy || Math.abs(t.wheel) < 0.5) return
    const dy = t.wheel / WHEEL_PX
    t.wheel = 0
    t.busy = true
    void Promise.resolve(send({ op: 'wheel', x: t.at.x, y: t.at.y, dx: 0, dy })).finally(() => {
      t.busy = false
      if (pan.current === t) flushWheel()
    })
  }

  const scrollBy = (t: TouchPan, delta: number): void => {
    const surface = ref.current?.closest<HTMLElement>('[data-tuner-popup]')
    if (surface && surface.scrollHeight > surface.clientHeight + 1) {
      const before = surface.scrollTop
      surface.scrollTop = before + delta
      delta -= surface.scrollTop - before
    }
    if (Math.abs(delta) < 0.01) return
    t.wheel += delta
    flushWheel()
  }

  const at = (e: { clientX: number; clientY: number }): { x: number; y: number } => {
    const r = ref.current!.getBoundingClientRect()
    return { x: secRef.current.x + (e.clientX - r.left), y: secRef.current.y + (e.clientY - r.top) }
  }

  const inUitk = (e: { target: EventTarget | null }): boolean => !!(e.target as HTMLElement | null)?.closest?.('[data-ti-uitk]')

  const flush = (): void => {
    const d = drag.current
    if (!d || d.busy || !d.pending) return
    const p = d.pending
    d.pending = null
    d.busy = true
    const dx = p.x - d.x
    const dy = p.y - d.y
    d.x = p.x
    d.y = p.y
    void Promise.resolve(send({ op: 'mouse', type: 'drag', x: p.x, y: p.y, button: d.button, dx, dy, mods: p.mods })).finally(() => {
      if (drag.current !== d) return
      d.busy = false
      flush()
    })
  }

  return (
    <div
      ref={ref}
      tabIndex={-1}
      data-popup-focus
      data-tuner-window={section.key}
      data-sec-x={section.x}
      data-sec-y={section.y}
      className="relative shrink-0 touch-none overflow-hidden outline-none"
      style={{ width: section.w, height: section.h }}
      onPointerDown={(e) => {
        if (inUitk(e)) return
        e.preventDefault()
        ref.current?.focus({ preventScroll: true })
        if (e.pointerType === 'touch') {
          if (pan.current) return
          pan.current = { id: e.pointerId, x: e.clientX, y: e.clientY, lastY: e.clientY, at: at(e), mode: 'tap', wheel: 0, busy: false }
          return
        }
        const p = at(e)
        const button = unityButton(e.button)
        drag.current = { button, x: p.x, y: p.y, pending: null, busy: false }
        e.currentTarget.setPointerCapture(e.pointerId)
        void send({ op: 'mouse', type: 'down', x: p.x, y: p.y, button, clicks: Math.max(1, e.detail || 1), mods: mods(e) })
      }}
      onPointerMove={(e) => {
        const t = pan.current
        if (t && e.pointerId === t.id && t.mode !== 'drag') {
          const dx = e.clientX - t.x
          const dy = e.clientY - t.y
          if (t.mode === 'tap') {
            if (Math.abs(dy) > TOUCH_SLOP && Math.abs(dy) >= Math.abs(dx)) t.mode = 'scroll'
            else if (Math.abs(dx) > TOUCH_SLOP) {
              t.mode = 'drag'
              drag.current = { button: 0, x: t.at.x, y: t.at.y, pending: null, busy: false }
              e.currentTarget.setPointerCapture(e.pointerId)
              void send({ op: 'mouse', type: 'down', x: t.at.x, y: t.at.y, button: 0, clicks: 1, mods: mods(e) })
            } else return
          }
          if (t.mode === 'scroll') {
            scrollBy(t, t.lastY - e.clientY)
            t.lastY = e.clientY
            return
          }
        }
        const p = at(e)
        const d = drag.current
        if (d) {
          d.pending = { x: p.x, y: p.y, mods: mods(e) }
          flush()
          return
        }
        lastHover.current = p
        const tip = inUitk(e) ? undefined : imguiTipAt(secRef.current, p.x - secRef.current.x, p.y - secRef.current.y)
        if (tip?.tip && ref.current) {
          const r = ref.current.getBoundingClientRect()
          tunerTip.schedule({
            text: tip.tip,
            owner: ref.current,
            key: `${tip.x},${tip.y},${tip.w},${tip.h}|${tip.tip}`,
            anchor: { left: r.left + tip.x, top: r.top + tip.y, width: tip.w, height: tip.h },
            pointer: { x: e.clientX, y: e.clientY },
            scope: ref.current
          })
        } else if (ref.current) tunerTip.hide(ref.current)
        if (inUitk(e) || hoverFrame.current) return
        const m = mods(e)
        hoverFrame.current = requestAnimationFrame(() => {
          hoverFrame.current = 0
          void send({ op: 'hover', x: p.x, y: p.y, mods: m })
        })
      }}
      onPointerUp={(e) => {
        const t = pan.current
        if (t && e.pointerId === t.id) {
          pan.current = null
          if (t.mode === 'scroll') return
          if (t.mode === 'tap') {
            void send({ op: 'mouse', type: 'down', x: t.at.x, y: t.at.y, button: 0, clicks: 1, mods: mods(e) })
            void send({ op: 'mouse', type: 'up', x: t.at.x, y: t.at.y, button: 0, clicks: 1, mods: mods(e) })
            return
          }
        }
        const d = drag.current
        if (!d) return
        drag.current = null
        const p = at(e)
        void send({ op: 'mouse', type: 'up', x: p.x, y: p.y, button: d.button, clicks: Math.max(1, e.detail || 1), mods: mods(e) })
      }}
      onPointerCancel={(e) => {
        const t = pan.current
        if (t && e.pointerId === t.id) pan.current = null
        const d = drag.current
        if (!d) return
        drag.current = null
        const p = at(e)
        void send({ op: 'mouse', type: 'up', x: p.x, y: p.y, button: d.button, clicks: 1, mods: mods(e) })
      }}
      onPointerLeave={() => {
        if (ref.current) tunerTip.hide(ref.current)
        if (!drag.current) void send({ op: 'leave' })
      }}
      onWheel={(e) => {
        const p = at(e)
        const unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 10 : 1 / 20
        void send({ op: 'wheel', x: p.x, y: p.y, dx: e.deltaX * unit, dy: e.deltaY * unit, mods: mods(e) })
      }}
      onKeyUp={(e) => {
        const p = lastHover.current
        if (p && MODIFIER_KEYS.has(e.key)) void send({ op: 'hover', x: p.x, y: p.y, mods: mods(e) })
      }}
      onKeyDown={(e) => {
        const p = lastHover.current
        if (p && MODIFIER_KEYS.has(e.key)) void send({ op: 'hover', x: p.x, y: p.y, mods: mods(e) })
        if (e.key === 'Escape' || e.target !== ref.current) return
        const key = unityKeyCode(e)
        if (!key) return
        e.preventDefault()
        void send({ op: 'key', type: 'down', key, char: e.key.length === 1 ? e.key : undefined, mods: mods(e) })
      }}
    >
      <div className="absolute" style={{ left: -section.x, top: -section.y }}>
        {children}
      </div>
    </div>
  )
}
