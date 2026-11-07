import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Filter, TriangleAlert } from 'lucide-react'
import { PendingState } from '../../ui/PendingState'
import type {
  TiCapture,
  TiMods,
  TiStyle,
  TiPopup,
  TiRect,
  TiScroll,
  TiSection,
  TiTextCommit,
  TunerInspectOpen,
  TunerInspectTarget,
  TunerInspectorInput,
  TunerInspectorResult
} from '@shared/tuner-inspector'
import { contains, InspectorModel, pressClick, propsUnder, trackKey, unityKeyCode, type ClickMark, type InspectorView } from '../../../lib/tuner/inspector/model'
import { ensureUnityFonts, TextureStore } from '../../../lib/tuner/inspector/textures'
import { imguiTipAt, installTunerTips, tunerTip } from '../../../lib/tuner/inspector/tooltip'
import { retainUitkTextures } from './uitk/uitk-textures'
import { retainPopupIcons } from './popups/popup-icons'
import { filterBadge, ImguiIsland, InspectorSection } from './InspectorSection'
import { PopupHost } from './PopupHost'
import { TextOverlay, type TextOverlayHandle } from './TextOverlay'
import type { MenuExtra } from './PopupHost'
import { TunerPopupHost } from './popups/TunerPopupHost'
import { ParticleCurves } from './ParticleCurves'
import { WindowPopup } from './popups/WindowPopup'
import { asTunerPopup } from '@shared/tuner-inspector-popups'
import { UitkSection } from './uitk/UitkSection'
import type { UitkCapture, UitkInput } from '@shared/tuner-inspector-uitk'
import { blockTab } from '../../../lib/tuner/no-tab'
import { noteRender } from '../../../lib/tuner/perf'
import { TouchMarks } from './TouchMarks'

export interface TunerInspectorProps {
  projectPath: string
  target: TunerInspectTarget
  width?: number
  changed?: (componentKey: string, propertyPath: string) => boolean
  onResetProperty?: (componentKey: string, propertyPath: string) => void
  onOpen?: (target: TunerInspectOpen) => void
  onPing?: (target: TunerInspectTarget) => void
  scope?: InspectorScope
}

export interface InspectorScope {
  mode: 'filtered' | 'all'
  onToggle: () => void
}

function scopeText(view: InspectorView, mode: InspectorScope['mode']): string | null {
  const c = view.target.components
  if (mode === 'all') return c ? `Showing all ${c.total} ${c.total === 1 ? 'component' : 'components'}` : 'Showing every component'
  if (c && c.shown < c.total) return `Showing ${c.shown} of ${c.total} ${c.total === 1 ? 'component' : 'components'}`
  let shown = 0
  let total = 0
  for (const s of view.sections) {
    if (!s.filter) continue
    shown += s.filter.shown
    total += s.filter.total
  }
  return total > 0 ? `Showing ${shown} of ${total} fields` : null
}

const RETRY_MS = 2500
const RESIZE_DEBOUNCE_MS = 120
const LIVE_MS = 90
const IMGUI_WHEEL_PX = 20

function lossyKey(input: TunerInspectorInput): string | null {
  if (input.op === 'wheel' || input.op === 'hover') return input.op
  if (input.op === 'mouse' && input.type === 'move') return 'move'
  if (input.op !== 'uitk') return null
  const d = input.data as UitkInput | undefined
  if (d?.op === 'wheel') return `uitk-wheel:${input.section}`
  if (d?.op === 'pointer' && d.type === 'move') return `uitk-move:${input.section}`
  return null
}

function mergeLossy(prev: TunerInspectorInput, next: TunerInspectorInput): TunerInspectorInput {
  if (prev.op === 'wheel' && next.op === 'wheel') return { ...next, dx: prev.dx + next.dx, dy: prev.dy + next.dy }
  if (prev.op === 'uitk' && next.op === 'uitk') {
    const a = prev.data as UitkInput
    const b = next.data as UitkInput
    if (a.op === 'wheel' && b.op === 'wheel') return { ...next, data: { ...b, dx: a.dx + b.dx, dy: a.dy + b.dy } }
  }
  return next
}

function cssScale(el: HTMLElement | null, r: DOMRect): number {
  const w = el?.offsetWidth ?? 0
  const k = w > 0 && r.width > 0 ? r.width / w : 1
  return Math.abs(k - 1) > 0.02 ? k : 1
}

function canScroll(s: TiScroll, dx: number, dy: number): boolean {
  const maxX = s.cw - s.vw
  const maxY = s.ch - s.vh
  const y = maxY > 0.5 && ((dy > 0 && s.sy < maxY - 0.5) || (dy < 0 && s.sy > 0.5))
  const x = maxX > 0.5 && ((dx > 0 && s.sx < maxX - 0.5) || (dx < 0 && s.sx > 0.5))
  return x || y
}

function scrollTarget(scrolls: TiScroll[], x: number, y: number, dx: number, dy: number): TiScroll | null {
  const under = scrolls.filter((s) => contains(s, x, y)).sort((a, b) => a.w * a.h - b.w * b.h)
  return under.find((s) => canScroll(s, dx, dy)) ?? null
}

export interface IslandPointer {
  down: (e: React.PointerEvent<HTMLDivElement>) => void
  move: (e: React.PointerEvent<HTMLDivElement>) => void
  up: (e: React.PointerEvent<HTMLDivElement>) => void
}

function mods(e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }): TiMods {
  return { shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, cmd: e.metaKey }
}

function refocusAfterPopup(canvas: () => HTMLElement | null | undefined): void {
  requestAnimationFrame(() => {
    const a = document.activeElement
    if (a && a !== document.body && a.isConnected) return
    canvas()?.focus({ preventScroll: true })
  })
}

function propRectAt(sec: TiSection, x: number, y: number): TiRect | null {
  let best: TiRect | null = null
  for (const p of sec.props ?? []) {
    if (p.c !== undefined || !contains(p, x, y)) continue
    if (!best || p.w * p.h < best.w * best.h) best = { x: sec.x + p.x, y: sec.y + p.y, w: p.w, h: p.h }
  }
  return best
}

function sectionAt(view: InspectorView | null, x: number, y: number): TiSection | undefined {
  if (!view) return undefined
  for (const s of view.sections) if (contains(s, x, y)) return s
  return undefined
}

function UitkSectionSlot({
  section,
  onInput,
  changed,
  styles,
  store,
  texVersion,
  pointer,
  projectPath
}: {
  section: TiSection
  onInput: (section: string, input: UitkInput) => void
  changed?: (componentKey: string, propertyPath: string) => boolean
  styles: Map<number, TiStyle>
  store: TextureStore
  texVersion: number
  pointer: IslandPointer
  projectPath: string
}) {
  const data = section.uitk as UitkCapture | undefined
  const headerBottom = (section.draws ?? []).reduce((m, d) => (d.c === undefined ? Math.max(m, d.y + d.h) : m), 0)
  const key = trackKey(section)
  const uitkRef = useRef<HTMLDivElement>(null)
  const renderImgui = useCallback(
    (index: number, size: { w: number; h: number }) => (
      <ImguiIsland sec={section} index={index} size={size} styles={styles} store={store} texVersion={texVersion} pointer={pointer} />
    ),
    [section, styles, store, texVersion, pointer]
  )
  const input = useCallback((i: UitkInput) => onInput(section.key, i), [onInput, section.key])
  const isChanged = useCallback((p: string) => key != null && (changed?.(key, p) ?? false), [changed, key])
  if (data && data.root) {
    const top = Math.max(headerBottom, section.h - data.h)
    return (
      <div ref={uitkRef} data-ti-uitk={section.key} className="pointer-events-auto absolute left-0" style={{ top, width: data.w, height: data.h }}>
        <UitkSection data={data} onInput={input} changed={changed ? isChanged : undefined} renderImgui={renderImgui} />
        <TunerPopupHost
          popup={asTunerPopup(data.popup)}
          projectPath={projectPath}
          onAnswer={(p, action, value) => {
            input({ op: 'popup', id: String(p.id), action, value })
            if (action !== 'change') refocusAfterPopup(() => uitkRef.current?.closest<HTMLElement>('[data-ti-canvas]'))
          }}
        />
      </div>
    )
  }
  if (section.h - headerBottom < 4) return null
  return (
    <div
      data-ti-uitk-placeholder={section.key}
      className="absolute left-0 right-0 flex items-center justify-center px-4 text-center text-[11px] text-zinc-500"
      style={{ top: headerBottom, height: section.h - headerBottom }}
    >
      Unity sent no UI Toolkit inspector for this component.
    </div>
  )
}

export const TunerInspector = memo(function TunerInspector({ projectPath, target, width: fixedWidth, changed, onResetProperty, onOpen, onPing, scope }: TunerInspectorProps) {
  noteRender('TunerInspector')
  const session = useMemo(() => `ti-${Math.random().toString(36).slice(2, 10)}`, [])
  const model = useRef(new InspectorModel())
  const store = useMemo(() => new TextureStore(), [])
  const texVersion = useSyncExternalStore(store.subscribe, store.getVersion)
  const [view, setView] = useState<InspectorView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [measured, setMeasured] = useState(0)
  const [hover, setHover] = useState<{ section: string; id: number } | null>(null)
  const [cursor, setCursor] = useState('default')
  const [dismissedFocus, setDismissedFocus] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLDivElement>(null)
  const overlayRef = useRef<TextOverlayHandle>(null)
  const queue = useRef<Promise<void>>(Promise.resolve())
  const opened = useRef(false)
  const alive = useRef(true)
  const drag = useRef<{ lastX: number; lastY: number; button: number; clicks: number; pending: { x: number; y: number; mods: TiMods } | null; inFlight: boolean } | null>(null)
  const lastClick = useRef<ClickMark | null>(null)
  const ctxProps = useRef<{ section: string; path: string }[]>([])
  const lastPointer = useRef<{ clientX: number; clientY: number } | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const width = Math.round(fixedWidth ?? measured)
  const widthRef = useRef(width)
  widthRef.current = width
  const targetKey = JSON.stringify(target)
  const targetRef = useRef(target)
  targetRef.current = target
  const onOpenRef = useRef(onOpen)
  onOpenRef.current = onOpen
  const onPingRef = useRef(onPing)
  onPingRef.current = onPing

  const apply = useCallback(
    (c: TiCapture, bytes: number) => {
      if (c.reset) store.clear()
      const r = model.current.apply(c, bytes)
      store.add(r.newTextures)
      if (r.view) {
        ensureUnityFonts(r.view.fontDir)
        setView(r.view)
        setError(null)
        for (const s of c.sections) {
          const open = (s.uitk as UitkCapture | undefined)?.open
          if (open && onOpenRef.current) onOpenRef.current(open as TunerInspectOpen)
        }
        for (const open of c.opens ?? []) onOpenRef.current?.(open)
      }
      for (const p of c.pings ?? []) onPingRef.current?.(p)
      if (r.needFull) void window.api.tunerInspector.capture(projectPath, session, true).then((res) => res.ok && res.data && apply(res.data, 0))
    },
    [store, projectPath, session]
  )

  const handle = useCallback(
    (r: TunerInspectorResult): void => {
      if (!alive.current) return
      if (!r.ok || !r.data) {
        if (r.error) setError(r.error)
        return
      }
      apply(r.data, 0)
    },
    [apply]
  )

  const run = useCallback((fn: () => Promise<TunerInspectorResult>): Promise<void> => {
    const next = queue.current.then(async () => {
      if (!alive.current) return
      try {
        handle(await fn())
      } catch (e) {
        setError((e as Error).message)
      }
    })
    queue.current = next.catch(() => {})
    return next
  }, [handle])

  const lossy = useRef(new Map<string, { input: TunerInspectorInput; done: Promise<void> }>())
  const pressRect = useRef<TiRect | null>(null)
  const [edits, setEdits] = useState<Record<string, TiRect & { n: number }>>({})

  const editRect = useCallback((input: TunerInspectorInput): TiRect | null => {
    const v = viewRef.current
    if (!v) return null
    if (input.op === 'text' && input.commit !== 'live') {
      const f = v.focus
      const s = f ? v.sections.find((x) => x.key === f.section) : undefined
      return f && s ? { x: s.x + f.x, y: s.y + f.y, w: f.w, h: f.h } : null
    }
    if (input.op === 'mouse' && input.type === 'down') {
      const s = input.button === 0 ? sectionAt(v, input.x, input.y) : undefined
      pressRect.current = s ? propRectAt(s, input.x - s.x, input.y - s.y) : null
      return pressRect.current
    }
    if ((input.op === 'mouse' && input.type === 'up') || (input.op === 'popup' && input.action === 'commit')) return pressRect.current
    return null
  }, [])

  const trackEdit = useCallback((r: TiRect, done: Promise<void>): void => {
    const key = `${Math.round(r.x)},${Math.round(r.y)},${Math.round(r.w)},${Math.round(r.h)}`
    setEdits((m) => ({ ...m, [key]: { ...r, n: (m[key]?.n ?? 0) + 1 } }))
    void done.finally(() =>
      setEdits((m) => {
        const cur = m[key]
        if (!cur) return m
        const next = { ...m }
        if (cur.n > 1) next[key] = { ...cur, n: cur.n - 1 }
        else delete next[key]
        return next
      })
    )
  }, [])

  const send = useCallback(
    (input: TunerInspectorInput): Promise<void> => {
      const key = lossyKey(input)
      if (!key) {
        lossy.current.clear()
        const mark = editRect(input)
        const done = run(() => window.api.tunerInspector.input(projectPath, session, input))
        if (mark) trackEdit(mark, done)
        return done
      }
      const waiting = lossy.current.get(key)
      if (waiting) {
        waiting.input = mergeLossy(waiting.input, input)
        return waiting.done
      }
      const slot = { input, done: Promise.resolve() }
      lossy.current.set(key, slot)
      slot.done = run(() => {
        if (lossy.current.get(key) === slot) lossy.current.delete(key)
        return window.api.tunerInspector.input(projectPath, session, slot.input)
      })
      return slot.done
    },
    [run, projectPath, session, editRect, trackEdit]
  )

  useEffect(() => {
    alive.current = true
    const off = window.api.tunerInspector.onCapture((e) => {
      if (e.session !== session || e.projectPath !== projectPath) return
      apply(e.capture, 0)
    })
    return () => {
      alive.current = false
      off()
      void window.api.tunerInspector.close(projectPath, session)
      store.clear()
    }
  }, [session, projectPath, apply, store])

  useEffect(() => () => store.dispose(), [store])

  useEffect(() => {
    if (width <= 0) return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const open = (): void => {
      void run(async () => {
        const r = await window.api.tunerInspector.open(projectPath, session, targetRef.current, widthRef.current)
        if (!r.ok && !cancelled) timer = setTimeout(open, RETRY_MS)
        if (r.ok) opened.current = true
        return r
      })
    }
    opened.current = false
    model.current.reset()
    setView(null)
    open()
    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }, [targetKey, projectPath, session, run, width > 0])

  useEffect(() => {
    if (!opened.current || width <= 0) return
    const t = setTimeout(() => void run(() => window.api.tunerInspector.resize(projectPath, session, width)), RESIZE_DEBOUNCE_MS)
    return () => clearTimeout(t)
  }, [width, run, projectPath, session])

  useLayoutEffect(() => {
    if (fixedWidth) return
    const el = scrollRef.current
    if (!el) return
    const measure = (): void => setMeasured(Math.max(0, Math.floor(el.clientWidth)))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [fixedWidth])

  const local = (e: { clientX: number; clientY: number; target?: EventTarget | null }): { x: number; y: number } => {
    const win = (e.target as HTMLElement | null)?.closest?.('[data-tuner-window]') as HTMLElement | null
    const key = win?.dataset.tunerWindow
    const sec = key ? viewRef.current?.sections.find((x) => x.key === key) : undefined
    if (win && sec) {
      const w = win.getBoundingClientRect()
      const k = cssScale(win, w)
      return { x: sec.x + (e.clientX - w.left) / k, y: sec.y + (e.clientY - w.top) / k }
    }
    const r = canvasRef.current?.getBoundingClientRect()
    const k = r ? cssScale(canvasRef.current, r) : 1
    return { x: (e.clientX - (r?.left ?? 0)) / k, y: (e.clientY - (r?.top ?? 0)) / k }
  }

  const focusKey = view?.focus?.editing ? `${view.focus.section}:${view.focus.control}` : null
  const showOverlay = view?.focus?.editing === true && focusKey !== dismissedFocus

  const commitOverlay = useCallback(
    (value: string, how: TiTextCommit, didChange: boolean): void => {
      const f = viewRef.current?.focus
      if (live.current.timer) clearTimeout(live.current.timer)
      live.current.timer = null
      live.current.value = null
      if (!f) return
      setDismissedFocus(`${f.section}:${f.control}`)
      if (!didChange && how === 'blur') void send({ op: 'textCancel' })
      else void send({ op: 'text', control: f.control, value, commit: how })
      if (how !== 'blur' && how !== 'live') canvasRef.current?.focus({ preventScroll: true })
    },
    [send]
  )

  const cancelOverlay = useCallback((): void => {
    const f = viewRef.current?.focus
    if (f) setDismissedFocus(`${f.section}:${f.control}`)
    void send({ op: 'textCancel' })
    canvasRef.current?.focus({ preventScroll: true })
  }, [send])

  useEffect(() => {
    if (!view?.focus) setDismissedFocus(null)
  }, [view?.focus])

  const flushDrag = useCallback((): void => {
    const d = drag.current
    if (!d || d.inFlight || !d.pending) return
    const p = d.pending
    d.pending = null
    d.inFlight = true
    const dx = p.x - d.lastX
    const dy = p.y - d.lastY
    d.lastX = p.x
    d.lastY = p.y
    void send({ op: 'mouse', type: 'drag', x: p.x, y: p.y, button: d.button, dx, dy, mods: p.mods }).finally(() => {
      const cur = drag.current
      if (cur !== d) return
      d.inFlight = false
      flushDrag()
    })
  }, [send])

  const inUitk = (e: { target: EventTarget | null }): boolean => !!(e.target as HTMLElement | null)?.closest?.('[data-ti-uitk]')

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>, island = false): void => {
    if (!view || (!island && inUitk(e))) return
    const { x, y } = local(e)
    canvasRef.current?.focus({ preventScroll: true })
    overlayRef.current?.commit('blur')
    const button = e.button === 2 ? 1 : e.button === 1 ? 2 : 0
    if (button === 1) {
      const sec = sectionAt(view, x, y)
      const tracked = sec ? trackKey(sec) : null
      ctxProps.current = sec && tracked ? propsUnder(sec, x - sec.x, y - sec.y).map((path) => ({ section: tracked, path })) : []
    }
    tunerTip.hide()
    lastClick.current = pressClick(lastClick.current, e.timeStamp, x, y, button, e.detail)
    const clicks = lastClick.current.n
    drag.current = { lastX: x, lastY: y, button, clicks, pending: null, inFlight: false }
    try {
      e.currentTarget.setPointerCapture(e.pointerId)
    } catch {
    }
    void send({ op: 'mouse', type: 'down', x, y, button, clicks, mods: mods(e) })
  }

  const updateTip = (sec: TiSection | undefined, lx: number, ly: number, clientX: number, clientY: number): void => {
    const badge = sec && !drag.current ? filterBadge(sec) : null
    const d = badge && contains(badge, lx, ly) ? { ...badge, k: 's' as const, st: 0 } : sec && !drag.current ? imguiTipAt(sec, lx, ly) : undefined
    const box = canvasRef.current?.getBoundingClientRect()
    if (!sec || !d?.tip || !box) {
      tunerTip.hide(session)
      return
    }
    tunerTip.schedule({
      text: d.tip,
      owner: session,
      key: `${sec.key}|${d.x},${d.y},${d.w},${d.h}|${d.tip}`,
      anchor: { left: box.left + sec.x + d.x, top: box.top + sec.y + d.y, width: d.w, height: d.h },
      pointer: { x: clientX, y: clientY },
      scope: scrollRef.current
    })
  }

  const updateHover = (x: number, y: number, clientX: number, clientY: number): void => {
    const sec = sectionAt(view, x, y)
    let id = 0
    let cur = 'default'
    if (sec) {
      const lx = x - sec.x
      const ly = y - sec.y
      for (const d of sec.draws ?? []) {
        if (d.c !== undefined || !contains(d, lx, ly)) continue
        if (d.k === 's' && d.id) id = d.id
      }
      for (const c of sec.cursors ?? []) if (c.im === undefined && contains(c, lx, ly)) cur = c.c
    }
    const next = sec && id ? { section: sec.key, id } : null
    if (next?.section !== hover?.section || next?.id !== hover?.id) setHover(next)
    if (cur !== cursor) setCursor(cur)
    lastPointer.current = { clientX, clientY }
    updateTip(sec, x - (sec?.x ?? 0), y - (sec?.y ?? 0), clientX, clientY)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>, island = false): void => {
    if (!drag.current && !island && inUitk(e)) {
      lastPointer.current = null
      tunerTip.hide(session)
      return
    }
    const { x, y } = local(e)
    const d = drag.current
    if (d) {
      d.pending = { x, y, mods: mods(e) }
      flushDrag()
      return
    }
    updateHover(x, y, e.clientX, e.clientY)
  }

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (!d) return
    const { x, y } = local(e)
    drag.current = null
    if (d.pending) {
      const p = d.pending
      void send({ op: 'mouse', type: 'drag', x: p.x, y: p.y, button: d.button, dx: p.x - d.lastX, dy: p.y - d.lastY, mods: p.mods })
    }
    void send({ op: 'mouse', type: 'up', x, y, button: d.button, clicks: d.clicks, mods: mods(e) })
  }

  const pointerRef = useRef({ down: onPointerDown, move: onPointerMove, up: onPointerUp })
  pointerRef.current = { down: onPointerDown, move: onPointerMove, up: onPointerUp }
  const islandPointer = useMemo<IslandPointer>(
    () => ({
      down: (e) => {
        e.stopPropagation()
        pointerRef.current.down(e, true)
      },
      move: (e) => {
        e.stopPropagation()
        pointerRef.current.move(e, true)
      },
      up: (e) => {
        e.stopPropagation()
        pointerRef.current.up(e)
      }
    }),
    []
  )

  const live = useRef<{ timer: ReturnType<typeof setTimeout> | null; value: string | null; control: number }>({ timer: null, value: null, control: 0 })
  const liveText = useCallback(
    (value: string): void => {
      const f = viewRef.current?.focus
      if (!f || f.delayed) return
      const l = live.current
      l.value = value
      l.control = f.control
      if (l.timer) return
      l.timer = setTimeout(() => {
        l.timer = null
        if (l.value === null) return
        const v = l.value
        l.value = null
        void send({ op: 'text', control: l.control, value: v, commit: 'live' })
      }, LIVE_MS)
    },
    [send]
  )

  const onPointerLeave = (): void => {
    if (drag.current) return
    setHover(null)
    setCursor('default')
    lastPointer.current = null
    tunerTip.hide(session)
  }

  useEffect(() => {
    const release = installTunerTips()
    const releaseTextures = retainUitkTextures()
    const releaseIcons = retainPopupIcons()
    return () => {
      tunerTip.hide(session)
      release()
      releaseTextures()
      releaseIcons()
    }
  }, [session])

  useLayoutEffect(() => {
    if (!view || !tunerTip.owns(session)) return
    const p = lastPointer.current
    if (!p || view.popups.length > 0) {
      tunerTip.hide(session)
      return
    }
    const { x, y } = local(p)
    const sec = sectionAt(view, x, y)
    updateTip(sec, x - (sec?.x ?? 0), y - (sec?.y ?? 0), p.clientX, p.clientY)
  }, [view])

  useLayoutEffect(() => {
    if ((view?.popups.length ?? 0) > 0) tunerTip.hide()
  }, [view?.popups.length])

  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>): void => {
    const own = e.target === canvasRef.current
    if (!own && !(e.target as HTMLElement).hasAttribute?.('data-uitk-section')) return
    const mod = e.metaKey || e.ctrlKey
    if (mod && e.key.toLowerCase() === 's') return
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault()
      void send({ op: e.shiftKey ? 'redo' : 'undo' })
      return
    }
    if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault()
      void send({ op: 'redo' })
      return
    }
    if (!own) return
    const key = unityKeyCode(e)
    if (!key || key === 'Tab') return
    if (['UpArrow', 'DownArrow', 'LeftArrow', 'RightArrow', 'Return', 'Space', 'Delete', 'Backspace', 'Escape', 'Home', 'End', 'PageUp', 'PageDown'].includes(key))
      e.preventDefault()
    void send({ op: 'key', type: 'down', key, char: e.key.length === 1 ? e.key : undefined, mods: mods(e) })
  }

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      const v = viewRef.current
      if (!v || inUitk(e) || (e.target as HTMLElement | null)?.closest?.('[data-tuner-popup-depth], [data-ti-popup]')) return
      const { x, y } = local(e)
      const sec = sectionAt(v, x, y)
      if (!sec?.scrolls?.length || !scrollTarget(sec.scrolls, x - sec.x, y - sec.y, e.deltaX, e.deltaY)) return
      e.preventDefault()
      const unit = e.deltaMode === 1 ? 1 : e.deltaMode === 2 ? 10 : 1 / IMGUI_WHEEL_PX
      void send({ op: 'wheel', x, y, dx: e.deltaX * unit, dy: e.deltaY * unit, mods: mods(e) })
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [send, view !== null])

  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const areas = (view?.sections ?? []).flatMap((sec) =>
      (sec.scrolls ?? []).filter((s) => s.ch > s.vh + 0.5 || s.cw > s.vw + 0.5).map((s) => [sec.x + s.x, sec.y + s.y, s.w, s.h].map((n) => Math.round(n)).join(','))
    )
    if (areas.length) el.setAttribute('data-drift-wheel-areas', areas.join(';'))
    else el.removeAttribute('data-drift-wheel-areas')
  }, [view])

  const sendUitk = useCallback((section: string, input: UitkInput) => void send({ op: 'uitk', section, data: input }), [send])

  const answerPopup = useCallback(
    (p: TiPopup, action: 'change' | 'commit' | 'cancel', value?: unknown): void => {
      setView((v) => (v ? { ...v, popups: v.popups.filter((x) => x.id !== p.id || action === 'change') } : v))
      void send({ op: 'popup', id: p.id, action, value })
      if (action !== 'change') refocusAfterPopup(() => canvasRef.current)
    },
    [send]
  )

  const menuExtras = useCallback(
    (p: TiPopup): MenuExtra[] | undefined => {
      const ctx = onResetProperty && changed ? ctxProps.current.find((c) => changed(c.section, c.path)) : undefined
      if (!ctx || !onResetProperty) return undefined
      return [
        {
          label: "Reset to the Tuner's start value",
          onPick: () => {
            answerPopup(p, 'cancel')
            onResetProperty(ctx.section, ctx.path)
          }
        }
      ]
    },
    [changed, onResetProperty, answerPopup]
  )

  const styles = model.current.styles
  const sectionNodes: ReactNode[] = []
  const windowNodes = new Map<string, { sec: TiSection; node: ReactNode }>()
  if (view)
    for (const sec of view.sections) {
      const node = (
        <InspectorSection
          key={sec.key}
          sec={sec}
          styles={styles}
          store={store}
          texVersion={texVersion}
          hoverId={hover?.section === sec.key ? hover.id : 0}
          changed={changed}
          uitk={
            sec.ui === 'uitk' ? (
              <UitkSectionSlot
                section={sec}
                onInput={sendUitk}
                changed={changed}
                styles={styles}
                store={store}
                texVersion={texVersion}
                pointer={islandPointer}
                projectPath={projectPath}
              />
            ) : sec.psc ? (
              <ParticleCurves key={sec.psc.inst} section={sec.key} psc={sec.psc} send={send} />
            ) : undefined
          }
        />
      )
      if (sec.kind === 'popupWindow') windowNodes.set(sec.key, { sec, node })
      else sectionNodes.push(node)
    }

  const renderWindow = (key: string): ReactNode | null => {
    const w = windowNodes.get(key)
    if (!w) return null
    return (
      <WindowPopup section={w.sec} send={send}>
        {w.node}
      </WindowPopup>
    )
  }

  const focusSection = view?.focus ? view.sections.find((s) => s.key === view.focus?.section) : undefined

  return (
    <div
      ref={scrollRef}
      data-tuner-inspector
      data-ti-session={session}
      data-ti-seq={view?.seq ?? 0}
      data-ti-ms={view?.ms ?? 0}
      data-ti-found={view ? String(view.target.found) : undefined}
      data-ti-target={view ? `${view.target.scene ?? ''}|${view.target.path}` : undefined}
      className="relative h-full min-h-0 w-full overflow-y-auto overflow-x-hidden bg-panel text-zinc-200 [&_:focus-visible]:outline-none"
      onKeyDownCapture={(e) => blockTab(e, scrollRef.current)}
    >
      {error && (
        <div data-ti-error className="m-2 flex items-start gap-2 rounded border border-amber-500/30 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-200/90">
          <TriangleAlert className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="min-w-0">{error}</span>
        </div>
      )}
      {view?.target.error && (
        <div data-ti-target-error className="m-2 rounded border border-white/10 bg-white/[0.03] px-2 py-1.5 text-xs text-zinc-400">
          {view.target.error}
        </div>
      )}
      {!view && !error && <PendingState tag="inspector" label="Loading the inspector…" className="h-24" />}
      {view && (
        <div
          ref={canvasRef}
          tabIndex={0}
          data-ti-canvas
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onPointerLeave={onPointerLeave}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={onKeyDown}
          className="relative select-none outline-none"
          style={{ width: view.width, height: view.height, cursor }}
        >
          {sectionNodes}
          {view.sections.map((sec) => (sec.kind === 'popupWindow' ? null : <TouchMarks key={`tm${sec.key}`} cursors={sec.cursors} dx={sec.x} dy={sec.y} />))}
          {Object.entries(edits).map(([key, r]) => (
            <div
              key={key}
              data-ti-pending-edit={key}
              className="pointer-events-none absolute flex items-center justify-end pr-1"
              style={{ left: r.x, top: r.y, width: r.w, height: r.h }}
            >
              <PendingState tag="inspector edit" label="Waiting for Unity to apply the edit…" bare className="rounded-full bg-panel/80 p-0.5" />
            </div>
          ))}
          {view.popups.length > 0 && (
            <PopupHost popups={view.popups} onAnswer={answerPopup} menuExtras={menuExtras} projectPath={projectPath} renderWindow={renderWindow} />
          )}
          {showOverlay && view.focus && focusSection && (
            <TextOverlay
              key={focusKey ?? ''}
              ref={overlayRef}
              focus={view.focus}
              left={focusSection.x}
              top={focusSection.y}
              style={styles.get(view.focus.style)}
              onCommit={commitOverlay}
              onCancel={cancelOverlay}
              onLive={liveText}
            />
          )}
        </div>
      )}
      {view && scope && !view.target.error && (() => {
        const text = scopeText(view, scope.mode)
        if (!text) return null
        return (
          <div
            data-ti-scope={scope.mode}
            className="flex items-center gap-1.5 border-t border-white/5 px-3 py-1.5 text-[11px] text-zinc-500"
            style={{ width: view.width }}
          >
            <Filter className="h-3 w-3 shrink-0 text-zinc-500" />
            <span className="min-w-0 truncate">{text}</span>
            <span className="text-zinc-600">·</span>
            <button
              type="button"
              data-ti-scope-toggle
              onClick={scope.onToggle}
              className="shrink-0 rounded px-1 text-sky-300/90 hover:bg-white/5 hover:text-sky-200"
            >
              {scope.mode === 'all' ? "Back to the agent's picks" : 'Show all'}
            </button>
          </div>
        )
      })()}
    </div>
  )
})
