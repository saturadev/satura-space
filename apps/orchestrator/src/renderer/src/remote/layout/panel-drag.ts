import { useEffect, useRef, useState, type CSSProperties, type RefObject } from 'react'

const HOLD_MS = 380
const SLOP = 8
const EDGE = 56

interface Box {
  x: number
  y: number
  w: number
  h: number
}

interface Section {
  gid: string
  ids: string[]
}

interface Pick {
  tabId: string
  from: string
  grab: { x: number; y: number }
  boxes: Map<string, Box>
  sections: Section[]
  width: number
  cols: number
  step: number
}

export interface Drop {
  tabId: string
  gid: string
  before: string | null
  from: string
  index: number
}

interface Drag {
  pick: Pick
  at: { x: number; y: number }
  gid: string
  index: number
  dropping: boolean
}

function haptic(): void {
  try {
    navigator.vibrate?.(8)
  } catch {
  }
}

function slotBox(pick: Pick, s: Section, k: number): Box {
  const own = s.ids.map((id) => pick.boxes.get(id) as Box)
  if (k < own.length) return own[k]
  const last = own[own.length - 1]
  const prev = own[own.length - 2]
  if (prev && prev.y === last.y && last.x + last.w * 2 <= pick.width + 1) return { ...last, x: last.x + (last.x - prev.x) }
  return { ...last, x: own[0].x, y: last.y + (prev && prev.y !== last.y ? last.y - prev.y : last.h) }
}

function arrange(pick: Pick, gid: string, index: number): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const s of pick.sections) {
    const ids = s.ids.filter((id) => id !== pick.tabId)
    if (s.gid === gid) ids.splice(index, 0, pick.tabId)
    out.set(s.gid, ids)
  }
  return out
}

function shiftBefore(pick: Pick, plan: Map<string, string[]>, gid: string): number {
  let dy = 0
  for (const s of pick.sections) {
    if (s.gid === gid) break
    dy += (Math.ceil((plan.get(s.gid) ?? []).length / pick.cols) - Math.ceil(s.ids.length / pick.cols)) * pick.step
  }
  return dy
}

function nearest(pick: Pick, cx: number, cy: number): { gid: string; index: number } {
  let best = { gid: pick.from, index: 0, d: Infinity }
  for (const s of pick.sections) {
    const rest = s.ids.filter((id) => id !== pick.tabId).length
    for (let k = 0; k <= rest; k++) {
      const b = slotBox(pick, s, k)
      const d = Math.hypot(b.x + b.w / 2 - cx, b.y + shiftBefore(pick, arrange(pick, s.gid, k), s.gid) + b.h / 2 - cy)
      if (d < best.d) best = { gid: s.gid, index: k, d }
    }
  }
  return { gid: best.gid, index: best.index }
}

export function usePanelDrag(listRef: RefObject<HTMLDivElement | null>, sections: Section[], onDrop: (d: Drop) => Promise<unknown>) {
  const [drag, setDrag] = useState<Drag | null>(null)
  const live = useRef({ sections, onDrop, drag })
  live.current = { sections, onDrop, drag }

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    let press: { id: string; x: number; y: number; timer: number } | null = null
    let state: Drag | null = null
    let swallow = 0
    let scroller = 0
    const local = (x: number, y: number): { x: number; y: number } => {
      const r = el.getBoundingClientRect()
      return { x: x - r.left, y: y - r.top + el.scrollTop }
    }
    const set = (next: Drag | null): void => {
      state = next
      setDrag(next)
    }
    const move = (cx: number, cy: number): void => {
      if (!state) return
      const p = local(cx, cy)
      const box = state.pick.boxes.get(state.pick.tabId) as Box
      const t = nearest(state.pick, p.x - state.pick.grab.x + box.w / 2, p.y - state.pick.grab.y + box.h / 2)
      if (t.gid !== state.gid || t.index !== state.index) haptic()
      set({ ...state, at: p, gid: t.gid, index: t.index })
    }
    const autoScroll = (cy: number): void => {
      window.cancelAnimationFrame(scroller)
      const r = el.getBoundingClientRect()
      const speed = cy < r.top + EDGE ? -(r.top + EDGE - cy) / 4 : cy > r.bottom - EDGE ? (cy - (r.bottom - EDGE)) / 4 : 0
      if (!speed || !state) return
      const step = (): void => {
        if (!state) return
        el.scrollTop += speed
        move(lastX, cy)
        scroller = window.requestAnimationFrame(step)
      }
      scroller = window.requestAnimationFrame(step)
    }
    let lastX = 0
    const pickUp = (id: string, x: number, y: number): void => {
      press = null
      const rows = [...el.querySelectorAll<HTMLElement>('[data-remote-panels-row]')]
      const r = el.getBoundingClientRect()
      const boxes = new Map<string, Box>()
      for (const row of rows) {
        const b = row.getBoundingClientRect()
        boxes.set(row.dataset.remotePanelsRow as string, { x: b.left - r.left, y: b.top - r.top + el.scrollTop, w: b.width, h: b.height })
      }
      const secs = live.current.sections.filter((s) => s.ids.every((i) => boxes.has(i)))
      const from = secs.find((s) => s.ids.includes(id))
      const box = boxes.get(id)
      if (!from || !box) return
      const p = local(x, y)
      const cols = Math.max(1, ...secs.map((s) => new Set(s.ids.map((i) => (boxes.get(i) as Box).x)).size))
      const pick: Pick = { tabId: id, from: from.gid, grab: { x: p.x - box.x, y: p.y - box.y }, boxes, sections: secs, width: el.clientWidth, cols, step: box.h }
      haptic()
      swallow = performance.now() + 1500
      console.log(`[layout] picked up ${id.slice(0, 8)} from group ${secs.indexOf(from) + 1}`)
      set({ pick, at: p, gid: from.gid, index: from.ids.indexOf(id), dropping: false })
    }
    const finish = (): void => {
      window.cancelAnimationFrame(scroller)
      const d = state
      if (!d) return
      const s = d.pick.sections.find((x) => x.gid === d.gid) as Section
      const rest = s.ids.filter((id) => id !== d.pick.tabId)
      const same = d.gid === d.pick.from && s.ids.indexOf(d.pick.tabId) === d.index
      set({ ...d, dropping: true })
      haptic()
      const drop: Drop = { tabId: d.pick.tabId, gid: d.gid, before: rest[d.index] ?? null, from: d.pick.from, index: d.index }
      window.setTimeout(() => {
        const done = (): void => {
          if (state === d || state?.dropping) set(null)
        }
        if (same) return done()
        void live.current.onDrop(drop).then(done, done)
      }, 220)
    }
    const onStart = (e: TouchEvent): void => {
      if (e.touches.length !== 1 || state) return
      const row = e.target instanceof Element ? e.target.closest<HTMLElement>('[data-remote-panels-row]') : null
      if (!row) return
      const t = e.touches[0]
      const id = row.dataset.remotePanelsRow as string
      lastX = t.clientX
      press = { id, x: t.clientX, y: t.clientY, timer: window.setTimeout(() => press && pickUp(press.id, press.x, press.y), HOLD_MS) }
    }
    const onMove = (e: TouchEvent): void => {
      const t = e.touches[0]
      if (!t) return
      if (press && Math.hypot(t.clientX - press.x, t.clientY - press.y) > SLOP) {
        window.clearTimeout(press.timer)
        press = null
      }
      if (!state || state.dropping) return
      e.preventDefault()
      lastX = t.clientX
      move(t.clientX, t.clientY)
      autoScroll(t.clientY)
    }
    const onEnd = (): void => {
      if (press) window.clearTimeout(press.timer)
      press = null
      if (state && !state.dropping) finish()
    }
    const onClick = (e: MouseEvent): void => {
      if (performance.now() > swallow) return
      swallow = 0
      e.preventDefault()
      e.stopPropagation()
    }
    const onMenu = (e: Event): void => {
      if (state || press) e.preventDefault()
    }
    el.addEventListener('touchstart', onStart, { passive: true })
    el.addEventListener('touchmove', onMove, { passive: false })
    el.addEventListener('touchend', onEnd)
    el.addEventListener('touchcancel', onEnd)
    el.addEventListener('click', onClick, true)
    el.addEventListener('contextmenu', onMenu)
    return () => {
      window.cancelAnimationFrame(scroller)
      if (press) window.clearTimeout(press.timer)
      el.removeEventListener('touchstart', onStart)
      el.removeEventListener('touchmove', onMove)
      el.removeEventListener('touchend', onEnd)
      el.removeEventListener('touchcancel', onEnd)
      el.removeEventListener('click', onClick, true)
      el.removeEventListener('contextmenu', onMenu)
    }
  }, [listRef.current])

  const plan = drag ? arrange(drag.pick, drag.gid, drag.index) : null

  const headerStyle = (gid: string): CSSProperties | undefined => {
    if (!drag || !plan) return undefined
    return { transform: `translate3d(0, ${shiftBefore(drag.pick, plan, gid)}px, 0)`, transition: 'transform 220ms var(--m-out)' }
  }

  const rowStyle = (id: string): CSSProperties | undefined => {
    if (!drag || !plan) return undefined
    const { pick } = drag
    const own = pick.boxes.get(id)
    if (!own) return undefined
    const sec = pick.sections.find((s) => (plan.get(s.gid) ?? []).includes(id))
    if (!sec) return undefined
    const slot = slotBox(pick, sec, (plan.get(sec.gid) ?? []).indexOf(id))
    const to = { ...slot, y: slot.y + shiftBefore(pick, plan, sec.gid) }
    if (id === pick.tabId) {
      const x = drag.dropping ? to.x : drag.at.x - pick.grab.x
      const y = drag.dropping ? to.y : drag.at.y - pick.grab.y
      return {
        transform: `translate3d(${x - own.x}px, ${y - own.y}px, 0) scale(${drag.dropping ? 1 : 1.03})`,
        transition: drag.dropping ? 'transform 220ms var(--m-out)' : 'none',
        zIndex: 5,
        position: 'relative'
      }
    }
    return { transform: `translate3d(${to.x - own.x}px, ${to.y - own.y}px, 0)`, transition: 'transform 220ms var(--m-out)' }
  }

  return { dragging: drag?.pick.tabId ?? null, target: drag ? drag.gid : null, rowStyle, headerStyle }
}
