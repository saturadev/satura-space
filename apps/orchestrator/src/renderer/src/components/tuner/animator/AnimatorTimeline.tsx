import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Circle, Flag, Footprints, Lock, Pause, Play, Plus, Repeat, Settings2, SkipBack, SkipForward, Spline, StepBack, StepForward, X } from 'lucide-react'
import { formatTimelineTime, frameOf, type TunerAnimator, type TunerAnimatorRequest, type TunerAnimClip, type TunerAnimEvent, type TunerAnimKey, type TunerBezier } from '@shared/tuner-animator'
import { TUNER_FRAME_MS } from '@shared/tuner'
import { createThrottle } from '../../../lib/tuner/session-memory'
import { DEFAULT_TUNER_LAYOUT } from '../../../lib/tuner/layout'
import {
  copyKeys,
  dopeRows,
  eventAt,
  eventMarkerXs,
  frameView,
  hitKey,
  keyOf,
  channelIndex,
  keysInRect,
  LABEL_MAX,
  LABEL_MIN,
  LABEL_W,
  makeScale,
  MIN_SPAN_FRAMES,
  movedSelection,
  panView,
  parseSelId,
  pruneSelection,
  rowAt,
  rowKeys,
  rowsHeight,
  selectedKeyArgs,
  selectionRange,
  selectionState,
  selId,
  snapTime,
  tOf,
  timeTicks,
  viewLength,
  visibleRows,
  xOf,
  zoomView,
  type ClipboardKey,
  type DopeRow,
  type TimeView
} from '../../../lib/tuner/animator'
import {
  applyEaseLocal,
  bezierMode,
  channelName,
  channelsOfRowKey,
  cloneKey,
  EASE_PRESETS,
  easeName,
  rowSegments,
  segKeys,
  segRep,
  shapeOf,
  updateTangents,
  withOverlay,
  type EaseSeg,
  type EaseTarget
} from '../../../lib/tuner/curves'
import { CurvesView, type CurvesContext, type CurvesHandle } from './CurvesView'
import { EasingPopover, easeGlyphPath } from './EasingPopover'
import { AddPropertyPopover, ClipSettings, EventEditor, HeaderCell, iconBtn, keyMenuEntries, rowFill, segMenuEntries, textBtn, TimelineMenu, type MenuEntry } from './TimelineParts'
import { BarXScroll } from '../../workbench/BarXScroll'
import { noteRender } from '../../../lib/tuner/perf'
import { zoomOf } from '../../../lib/css-zoom'
import { PendingState } from '../../ui/PendingState'

const RULER_H = 22
const CLIP_PICK_MAX_MS = 8000
const EVENTS_H = 18
const FOOTER_H = 26
const HBAR_H = 10
const HBAR_PAD = 4
const HBAR_EDGE = 5
const CLICK_PX = 3
const SCRUB_HOLD_MS = 400
export const TIMELINE_BODY_MIN = 60
const CHROME_H = 30 + RULER_H + EVENTS_H + FOOTER_H + HBAR_H
const AUTO_MIN = 180
const AUTO_SHARE = 0.42
const VIEWPORT_KEEP = 140
const LABEL_KEY = 'satura.anim.labelW'
const FRAMES_KEY = 'satura.anim.frames'
const EASING_KEY = 'satura.anim.easing'
const EASE_POP_W = 404
const EASE_POP_H = 300
const GESTURES =
  'The timeline edits the selected object\'s animation clip. Drag on the ruler to scrub. Click a key to select it, and Shift, Cmd or Ctrl adds more. Drag an empty spot to box-select. Drag keys to move them, and Alt-drag to copy. Delete removes keys, Ctrl+C and Ctrl+V copy and paste at the playhead. The wheel scrolls, Shift+wheel scrolls in time, and Ctrl+wheel or a pinch zooms. A shows everything and F frames the selection. C switches between Dopesheet and Curves. To edit easing, select a row and click the shape between two keys, or right-click a key.'

let clipboard: ClipboardKey[] = []

function loadNum(key: string, def: number): number {
  try {
    const v = Number(localStorage.getItem(key))
    return Number.isFinite(v) && v > 0 ? v : def
  } catch {
    return def
  }
}

function loadBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key)
    return v == null ? def : v === '1'
  } catch {
    return def
  }
}

function save(key: string, v: string): void {
  try {
    localStorage.setItem(key, v)
  } catch {
    return
  }
}

export function expandedFill(root: HTMLElement | null, avail: number, chrome: number): number {
  const host = root?.parentElement
  if (!host || avail <= 0 || !host.closest('[data-phone-expanded]')) return 0
  let used = chrome
  for (const el of host.children) if (el !== root && el instanceof HTMLElement) used += el.offsetHeight
  return Math.max(TIMELINE_BODY_MIN, Math.floor(avail - used))
}

function autoBodyHeight(rowsH: number, avail: number): number {
  const cap = Math.max(AUTO_MIN, Math.floor((avail > 0 ? avail : 600) * AUTO_SHARE))
  return Math.max(TIMELINE_BODY_MIN, Math.min(rowsH + 8, cap))
}

const FOLD_KEY = 'satura.tuner.animFolded'

export function sendAnimator(projectPath: string, session: string, req: TunerAnimatorRequest, onError?: (t: string) => void): Promise<boolean> {
  return window.api.tuner.animator(projectPath, session, req).then((r) => {
    if (!r.ok) onError?.(r.error)
    return r.ok
  })
}

export function animatorKey(e: React.KeyboardEvent, anim: TunerAnimator, projectPath: string, session: string): boolean {
  if (e.metaKey || e.ctrlKey || !anim.clip) return false
  if (e.code === 'Comma' || e.code === 'Period') {
    const dir = e.code === 'Comma' ? -1 : 1
    if (e.shiftKey) void sendAnimator(projectPath, session, { op: dir < 0 ? 'first' : 'last' })
    else if (e.altKey) void sendAnimator(projectPath, session, { op: dir < 0 ? 'prevKey' : 'nextKey' })
    else void sendAnimator(projectPath, session, { op: 'step', dir })
    return true
  }
  if (e.code === 'Space' && !e.altKey && !e.shiftKey) {
    void sendAnimator(projectPath, session, { op: anim.playing ? 'pause' : 'play' })
    return true
  }
  return false
}

function diamond(x: number, y: number, r: number): string {
  return `M ${x} ${y - r} L ${x + r} ${y} L ${x} ${y + r} L ${x - r} ${y} Z`
}

type Gesture =
  | { kind: 'scrub' }
  | { kind: 'keys'; x0: number; moved: boolean; copy: boolean; df: number }
  | { kind: 'marquee'; x0: number; y0: number; add: boolean; base: Set<string> }
  | { kind: 'event'; index: number; x0: number; t0: number; moved: boolean }
  | { kind: 'label'; x0: number; w0: number }
  | { kind: 'seg'; seg: EaseSeg; x0: number; y0: number; add: boolean; base: Set<string>; anchor: { x: number; y: number } }

type Menu = { x: number; y: number; entries: MenuEntry[]; at: number; row: DopeRow | null; event: number; seg?: EaseSeg | null; curve?: { id: string; t: number; v: number } | null }

type Popover =
  | { kind: 'event'; index: number; left: number; top: number }
  | { kind: 'addprop'; left: number; bottom: number }
  | { kind: 'settings'; left: number; top: number }
  | { kind: 'clips'; left: number; top: number }
  | { kind: 'ease'; seg: EaseSeg; left: number; top: number }

export function AnimatorTimeline({
  projectPath,
  session,
  anim,
  onHeight,
  onError,
  bodyHeight,
  onBodyHeight,
  onSelectObject,
  onClose
}: {
  projectPath: string
  session: string
  anim: TunerAnimator
  onHeight?: (px: number) => void
  onError: (text: string) => void
  bodyHeight: number
  onBodyHeight?: (px: number, final: boolean) => void
  onSelectObject?: (path: string) => void
  onClose?: () => void
}) {
  noteRender('AnimatorTimeline')
  const rootRef = useRef<HTMLDivElement>(null)
  const bodyRef = useRef<HTMLDivElement>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<SVGSVGElement>(null)
  const [width, setWidth] = useState(0)
  const [availH, setAvailH] = useState(0)
  const [toggled, setToggled] = useState<Set<string>>(() => new Set())
  const [view, setView] = useState<TimeView | null>(null)
  const [labelW, setLabelW] = useState(() => Math.max(LABEL_MIN, Math.min(LABEL_MAX, loadNum(LABEL_KEY, LABEL_W))))
  const [frames, setFramesState] = useState(() => loadBool(FRAMES_KEY, true))
  const [sel, setSel] = useState<Set<string>>(() => new Set())
  const [selEvent, setSelEvent] = useState<number | null>(null)
  const [scrub, setScrub] = useState<number | null>(null)
  const [scrubEnd, setScrubEnd] = useState(0)
  const [keyDrag, setKeyDrag] = useState<{ df: number; copy: boolean; x?: number; y?: number } | null>(null)
  const [evDrag, setEvDrag] = useState<{ index: number; t: number } | null>(null)
  const [marquee, setMarquee] = useState<{ x0: number; y0: number; x1: number; y1: number } | null>(null)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [folded, setFolded] = useState(() => {
    try {
      return localStorage.getItem(FOLD_KEY) === '1'
    } catch {
      return false
    }
  })
  const fold = (v: boolean): void => {
    setFolded(v)
    try {
      localStorage.setItem(FOLD_KEY, v ? '1' : '0')
    } catch {
      return
    }
  }
  const [popover, setPopover] = useState<Popover | null>(null)
  const [resizing, setResizing] = useState(false)
  const [barDrag, setBarDrag] = useState<'left' | 'right' | 'pan' | null>(null)
  const [tab, setTab] = useState<'dopesheet' | 'curves'>('dopesheet')
  const [rowSel, setRowSel] = useState<Set<string>>(() => new Set())
  const [normalize, setNormalize] = useState(false)
  const [easing, setEasingState] = useState(() => loadBool(EASING_KEY, true))
  const [overlay, setOverlay] = useState<{ map: Map<string, TunerAnimKey[]>; until: number } | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [scrollH, setScrollH] = useState(400)
  const gestureRef = useRef<Gesture | null>(null)
  const lastDownRef = useRef<{ t: number; x: number; y: number } | null>(null)
  const rulerRef = useRef<SVGSVGElement>(null)
  const curvesRef = useRef<CurvesHandle>(null)
  const draggingRef = useRef(false)
  const liveRef = useRef<{ busy: Promise<void> | null; next: TunerAnimatorRequest | null }>({ busy: null, next: null })
  const clip = useMemo(() => withOverlay(anim.clip, overlay?.map ?? null), [anim.clip, overlay])
  const fps = clip?.frameRate ?? 60
  const readOnly = !clip || clip.readOnly
  const rows = useMemo(() => dopeRows(clip, toggled), [clip, toggled])
  const curves = tab === 'curves'
  const canRecord = !readOnly
  const curveRowKeys = useMemo(() => [...rowSel].filter((k) => k !== 'summary'), [rowSel])
  const shownKey = useMemo(() => {
    const ids = new Set<string>()
    for (const k of curveRowKeys.length > 0 ? curveRowKeys : ['summary']) for (const id of channelsOfRowKey(clip, k)) ids.add(id)
    return [...ids].join('\n')
  }, [clip, curveRowKeys])
  const shown = useMemo(() => (shownKey ? shownKey.split('\n') : []), [shownKey])
  const names = useMemo(() => {
    const m = new Map<string, string>()
    if (clip) for (const p of clip.props) for (const c of p.channels) m.set(c.id, channelName(p, c))
    return m
  }, [clip])
  const bodyH = rowsHeight(rows)
  const trackH = Math.max(bodyH + (clip && clip.props.length === 0 ? 40 : 0), 24)
  const trackW = Math.max(40, width - labelW)
  const s = useMemo(() => makeScale(trackW, viewLength(clip?.length ?? 1, fps), view, fps), [trackW, clip?.length, view, fps])
  const markerXs = useMemo(() => eventMarkerXs(clip, s, evDrag), [clip, s, evDrag])
  const sRef = useRef(s)
  sRef.current = s
  const ticks = useMemo(() => timeTicks(s, fps, frames), [s, fps, frames])
  const time = scrub ?? anim.time
  const frame = frameOf(time, fps)
  const playX = xOf(s, time)
  const vis = useMemo(() => visibleRows(rows, scrollTop, Math.max(200, scrollH)), [rows, scrollTop, scrollH])
  const shownRows = useMemo(() => rows.slice(vis.from, vis.to), [rows, vis])
  const onBodyScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    setScrollTop(el.scrollTop)
    if (el.clientHeight !== scrollH) setScrollH(el.clientHeight)
  }
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    if (el.clientHeight > 0 && el.clientHeight !== scrollH) setScrollH(el.clientHeight)
    if (Math.abs(el.scrollTop - scrollTop) > 1) setScrollTop(el.scrollTop)
  })
  const selRows = useMemo(() => {
    const out = new Set<string>()
    for (const r of rows) if (r.kind !== 'summary' && rowKeys(r, fps).some((k) => k.ids.some((id) => sel.has(id)))) out.add(r.key)
    return out
  }, [rows, sel, fps])

  const setFrames = (v: boolean): void => {
    setFramesState(v)
    save(FRAMES_KEY, v ? '1' : '0')
  }

  const setEasing = (v: boolean): void => {
    setEasingState(v)
    save(EASING_KEY, v ? '1' : '0')
    if (!v) setPopover((p) => (p?.kind === 'ease' ? null : p))
  }

  const throttled = useRef(
    createThrottle((pp: string, sess: string, req: TunerAnimatorRequest) => {
      void window.api.tuner.animator(pp, sess, req)
    }, TUNER_FRAME_MS)
  ).current

  useEffect(() => () => throttled.cancel(), [throttled])

  const send = useCallback(
    async (req: TunerAnimatorRequest): Promise<boolean> => {
      const r = await window.api.tuner.animator(projectPath, session, req)
      if (!r.ok) onError(r.error)
      return r.ok
    },
    [projectPath, session, onError]
  )

  const [clipPick, setClipPick] = useState<{ name: string; seq: number; done: boolean } | null>(null)
  useEffect(() => {
    if (!clipPick) return
    if (clipPick.done && (anim.clip?.name === clipPick.name || anim.clipSeq !== clipPick.seq)) {
      setClipPick(null)
      return
    }
    const t = setTimeout(() => setClipPick(null), CLIP_PICK_MAX_MS)
    return () => clearTimeout(t)
  }, [clipPick, anim.clip?.name, anim.clipSeq])
  const pickClip = (action: string): void => {
    const target = anim.clips.find((c) => action === c.path || action === `${c.path}::${c.name}`)
    setClipPick({ name: target?.name ?? 'the clip', seq: anim.clipSeq, done: false })
    void send({ op: 'clip', clip: action }).then((ok) => setClipPick((p) => (p && ok ? { ...p, done: true } : null)))
  }

  useEffect(() => {
    if (anim.record && !canRecord) void send({ op: 'record', value: '0' })
  }, [anim.record, canRecord])

  useLayoutEffect(() => {
    const el = bodyRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setWidth(el.clientWidth))
    ro.observe(el)
    setWidth(el.clientWidth)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = rootRef.current?.parentElement
    if (!el) return
    const ro = new ResizeObserver(() => setAvailH(el.clientHeight))
    ro.observe(el)
    setAvailH(el.clientHeight)
    return () => ro.disconnect()
  }, [])

  useLayoutEffect(() => {
    const el = rootRef.current
    if (!el || !onHeight) return
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight))
    ro.observe(el)
    onHeight(el.offsetHeight)
    return () => {
      ro.disconnect()
      onHeight(0)
    }
  }, [onHeight])

  useEffect(() => {
    if (scrub == null || gestureRef.current?.kind === 'scrub') return
    if (anim.playing || Math.abs(anim.time - scrub) < 0.5 / fps) {
      setScrub(null)
      return
    }
    const id = setTimeout(() => setScrub(null), Math.max(0, scrubEnd + SCRUB_HOLD_MS - performance.now()))
    return () => clearTimeout(id)
  }, [anim.time, anim.playing, scrub, scrubEnd, fps])

  useEffect(() => {
    setScrub(null)
  }, [clip?.path, anim.owner?.path])

  useEffect(() => {
    setKeyDrag(null)
    setEvDrag(null)
    if (selEvent != null && (!clip || selEvent >= clip.events.length)) setSelEvent(null)
  }, [anim.rev, clip?.path])

  useEffect(() => {
    if (overlay || draggingRef.current) return
    setSel((prev) => (prev.size === 0 ? prev : pruneSelection(clip, prev, fps)))
  }, [anim.rev, clip?.path, overlay])

  useEffect(() => {
    if (overlay && anim.rev >= overlay.until) setOverlay(null)
  }, [anim.rev, overlay])

  useEffect(() => {
    if (!overlay || !Number.isFinite(overlay.until)) return
    const id = setTimeout(() => setOverlay((o) => (o === overlay ? null : o)), 1500)
    return () => clearTimeout(id)
  }, [overlay])

  useEffect(() => {
    setView(null)
    setSel(new Set())
    setSelEvent(null)
    setPopover(null)
    setRowSel(new Set())
    setOverlay(null)
  }, [anim.clip?.path, anim.owner?.path])

  useEffect(() => {
    setRowSel((prev) => {
      if (prev.size === 0) return prev
      const next = new Set([...prev].filter((k) => k === 'summary' || channelsOfRowKey(clip, k).length > 0))
      return next.size === prev.size ? prev : next
    })
  }, [clip?.props])

  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onWheel = (e: WheelEvent): void => {
      if (e.target instanceof Element && e.target.closest('.bar-x-scroll')) {
        if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.preventDefault()
        return
      }
      e.stopPropagation()
      const sc = sRef.current
      const zel = rulerRef.current ?? trackRef.current ?? el
      const r = zel.getBoundingClientRect()
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault()
        const factor = Math.exp(Math.max(-1, Math.min(1, e.deltaY * k * 0.01)))
        setView(zoomView(sc, factor, (e.clientX - r.left) / zoomOf(zel)))
        return
      }
      const onBar = e.target instanceof Element && !!e.target.closest('[data-anim-hbar]')
      const dx = e.shiftKey || onBar ? (e.deltaX !== 0 ? e.deltaX : e.deltaY) * k : e.deltaX * k
      if (e.shiftKey || onBar || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        e.preventDefault()
        if (dx !== 0) setView(panView(sc, dx))
        return
      }
      const box = scrollRef.current
      if (!box || box.scrollHeight <= box.clientHeight) e.preventDefault()
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    el.setAttribute('data-drift-wheel', '')
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const barTotal = Math.max(s.length, s.start + s.span)
  const barNeeded = !!clip && (s.start > 0.5 / fps || s.start + s.span < s.length - 0.5 / fps)
  const barW = Math.max(1, trackW - HBAR_PAD * 2)
  const thumbW = Math.min(barW, Math.max(16, (s.span / barTotal) * barW))
  const thumbX = HBAR_PAD + Math.min(barW - thumbW, (s.start / barTotal) * barW)

  const onBarDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0 || !barNeeded) return
    e.preventDefault()
    e.stopPropagation()
    const el = e.currentTarget
    const zk = zoomOf(el)
    const x = (e.clientX - el.getBoundingClientRect().left) / zk
    const total = barTotal
    const minSpan = Math.min(s.length, MIN_SPAN_FRAMES / Math.max(1, fps))
    const mode = Math.abs(x - thumbX) <= HBAR_EDGE ? 'left' : Math.abs(x - (thumbX + thumbW)) <= HBAR_EDGE ? 'right' : x > thumbX && x < thumbX + thumbW ? 'pan' : 'jump'
    let start0 = s.start
    const span0 = s.span
    if (mode === 'jump') {
      start0 = Math.max(0, Math.min(total - span0, ((x - HBAR_PAD) / barW) * total - span0 / 2))
      setView({ start: start0, span: span0 })
    }
    const x0 = e.clientX
    const end0 = start0 + span0
    el.setPointerCapture(e.pointerId)
    setBarDrag(mode === 'jump' ? 'pan' : mode)
    const move = (m: PointerEvent): void => {
      const dt = ((m.clientX - x0) / zk / barW) * total
      if (mode === 'left') {
        const start = Math.max(0, Math.min(end0 - minSpan, start0 + dt))
        setView({ start, span: end0 - start })
      } else if (mode === 'right') setView({ start: start0, span: Math.max(minSpan, Math.min(total - start0, span0 + dt)) })
      else setView({ start: Math.max(0, Math.min(Math.max(0, total - span0), start0 + dt)), span: span0 })
    }
    const up = (): void => {
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      setBarDrag(null)
    }
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
  }

  const onBarHover = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (!barNeeded || barDrag) return
    const x = (e.clientX - e.currentTarget.getBoundingClientRect().left) / zoomOf(e.currentTarget)
    const edge = Math.abs(x - thumbX) <= HBAR_EDGE || Math.abs(x - (thumbX + thumbW)) <= HBAR_EDGE
    e.currentTarget.style.cursor = edge ? 'ew-resize' : 'default'
  }

  const maxBody = (): number => Math.max(TIMELINE_BODY_MIN, (rootRef.current?.parentElement?.clientHeight ?? 600) - CHROME_H - VIEWPORT_KEEP)
  const fillH = expandedFill(rootRef.current, availH, CHROME_H)
  const bodyMax = fillH || (bodyHeight > 0 ? Math.max(TIMELINE_BODY_MIN, bodyHeight) : autoBodyHeight(bodyH, availH))
  const curvesH = fillH || (bodyHeight > 0 ? Math.max(TIMELINE_BODY_MIN, bodyHeight) : autoBodyHeight(1e6, availH))

  const focusRoot = (): void => {
    const el = rootRef.current
    if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true })
  }

  const trackXY = (e: { clientX: number; clientY: number }): [number, number] => {
    const el = trackRef.current
    if (!el) return [0, 0]
    const r = el.getBoundingClientRect()
    const k = zoomOf(el)
    return [(e.clientX - r.left) / k, (e.clientY - r.top) / k]
  }

  const rulerX = (e: { clientX: number }): number => {
    const el = rulerRef.current ?? trackRef.current
    return el ? (e.clientX - el.getBoundingClientRect().left) / zoomOf(el) : 0
  }

  const pumpLive = (): void => {
    const L = liveRef.current
    if (L.busy || !L.next) return
    const req = L.next
    L.next = null
    L.busy = window.api.tuner
      .animator(projectPath, session, req)
      .then(
        () => undefined,
        () => undefined
      )
      .then(() => {
        L.busy = null
        pumpLive()
      })
  }

  const sendLive = (req: TunerAnimatorRequest): void => {
    draggingRef.current = true
    liveRef.current.next = req
    pumpLive()
  }

  const commitDrag = async (req: TunerAnimatorRequest, over: Map<string, TunerAnimKey[]>): Promise<boolean> => {
    const L = liveRef.current
    L.next = null
    draggingRef.current = false
    const token = { map: over, until: Infinity }
    setOverlay(token)
    while (L.busy) await L.busy
    const r = await window.api.tuner.animator(projectPath, session, req)
    if (!r.ok) {
      onError(r.error)
      setOverlay((o) => (o === token ? null : o))
      return false
    }
    const rev = r.data?.rev ?? 0
    setOverlay((o) => (o === token ? { map: over, until: rev } : o))
    return true
  }

  const segKeysArgs = (seg: EaseSeg, end: 'a' | 'b'): { id: string; t: number }[] => seg.targets.map((t: EaseTarget) => ({ id: t.id, t: (end === 'a' ? t.fa : t.fb) / fps }))

  const easeOverlay = (seg: EaseSeg, b: TunerBezier): Map<string, TunerAnimKey[]> => {
    const idx = channelIndex(anim.clip)
    const over = new Map<string, TunerAnimKey[]>()
    for (const t of seg.targets) {
      const ch = idx.get(t.id)
      const sk = segKeys(ch, t.fa, t.fb, fps)
      if (!ch || !sk) continue
      const keys = ch.keys.map(cloneKey)
      applyEaseLocal(keys, sk[2], b)
      updateTangents(keys)
      over.set(t.id, keys)
    }
    return over
  }

  const onEaseDrag = (seg: EaseSeg, b: TunerBezier, final: boolean): void => {
    if (readOnly) return
    const over = easeOverlay(seg, b)
    const req: TunerAnimatorRequest = { op: 'tangent', keys: segKeysArgs(seg, 'a'), mode: bezierMode(b) }
    if (final) {
      void commitDrag(req, over)
      return
    }
    setOverlay({ map: over, until: Infinity })
    sendLive({ ...req, live: true })
  }

  const onEasePreset = (seg: EaseSeg, kind: string, b?: TunerBezier): void => {
    if (readOnly) return
    const a = segKeysArgs(seg, 'a')
    if (kind === 'auto') void send({ op: 'tangent', keys: [...a, ...segKeysArgs(seg, 'b')], mode: 'clampedAuto' })
    else if (kind === 'step' || kind === 'linear' || kind === 'ease' || kind === 'easeIn' || kind === 'easeOut' || kind === 'easeInOut') void send({ op: 'tangent', keys: a, mode: kind })
    else if (b) void send({ op: 'tangent', keys: a, mode: bezierMode(b) })
  }

  const openEase = (seg: EaseSeg, clientX: number, clientY: number, below: number): void => {
    const root = rootRef.current?.getBoundingClientRect()
    if (!root) return
    const k = zoomOf(rootRef.current)
    const left = Math.max(4, Math.min(root.width / k - EASE_POP_W - 4, (clientX - root.left) / k - EASE_POP_W / 2))
    let top = (below - root.top) / k + 6
    const room = Math.min(window.innerHeight, root.bottom) - 8
    if (below + (6 + EASE_POP_H) * k > room && clientY - (EASE_POP_H + 10) * k >= 8) top = (clientY - root.top) / k - EASE_POP_H - 10
    else if (below + (6 + EASE_POP_H) * k > window.innerHeight - 8) top = (clientY - root.top) / k - EASE_POP_H - 10
    const ids = new Set<string>()
    for (const t of seg.targets) {
      ids.add(selId(t.id, t.fa))
      ids.add(selId(t.id, t.fb))
    }
    setSel(ids)
    setSelEvent(null)
    setMenu(null)
    setPopover({ kind: 'ease', seg, left, top })
  }

  const segLabel = (ids: string[]): string => {
    if (ids.length === 1) return names.get(ids[0]) ?? ids[0]
    const props = new Set(ids.map((id) => clip?.props.find((p) => p.channels.some((c) => c.id === id))?.label ?? ''))
    return props.size === 1 ? [...props][0] : `${ids.length} curves`
  }

  const segFromIds = (ids: Iterable<string>): EaseSeg | null => {
    const idx = channelIndex(clip)
    const parsed = [...ids].map(parseSelId).filter((p): p is { channel: string; frame: number } => !!p && !!idx.get(p.channel))
    if (parsed.length === 0) return null
    const f0 = Math.min(...parsed.map((p) => p.frame))
    const chans = [...new Set(parsed.filter((p) => p.frame === f0).map((p) => p.channel))]
    const frameList = (id: string): number[] => (idx.get(id)?.keys ?? []).map((k) => frameOf(k.t, fps))
    let fa = f0
    let fb = Infinity
    for (const id of chans) {
      const fs = frameList(id)
      const i = fs.indexOf(f0)
      if (i >= 0 && i < fs.length - 1) fb = Math.min(fb, fs[i + 1])
    }
    if (!Number.isFinite(fb)) {
      fb = f0
      fa = -Infinity
      for (const id of chans) {
        const fs = frameList(id)
        const i = fs.indexOf(f0)
        if (i > 0) fa = Math.max(fa, fs[i - 1])
      }
      if (!Number.isFinite(fa)) return null
    }
    const targets = chans.filter((id) => segKeys(idx.get(id), fa, fb, fps)).map((id) => ({ id, fa, fb }))
    if (targets.length === 0) return null
    return { row: chans.length === 1 ? `ch:${chans[0]}` : `sel:${f0}`, label: segLabel(targets.map((t) => t.id)), fa, fb, targets }
  }

  const rowSegs = (r: DopeRow): EaseSeg[] => {
    const label = r.kind === 'channel' && r.prop && r.channel ? channelName(r.prop, r.channel) : r.channel && r.prop ? channelName(r.prop, r.channel) : r.label
    return rowSegments(r.channels, fps, r.key, label)
  }

  const pillOf = (seg: EaseSeg): { x: number; w: number } | null => {
    const xa = xOf(s, seg.fa / fps) + 7
    const xb = xOf(s, seg.fb / fps) - 7
    const gap = xb - xa
    if (gap < 20 || xb < 0 || xa > trackW) return null
    const w = Math.min(gap - 2, 40)
    return { x: (xa + xb) / 2 - w / 2, w }
  }

  const pillAt = (x: number, y: number): EaseSeg | null => {
    if (!easing) return null
    const row = rowAt(rows, y)
    if (!row || (row.kind !== 'group' && row.kind !== 'channel') || !selRows.has(row.key)) return null
    const cy = row.y + row.h / 2
    if (Math.abs(y - cy) > 7) return null
    for (const seg of rowSegs(row)) {
      const p = pillOf(seg)
      if (p && x >= p.x - 1 && x <= p.x + p.w + 1) return seg
    }
    return null
  }

  const gapAt = (x: number, y: number): EaseSeg | null => {
    const row = rowAt(rows, y)
    if (!row || (row.kind !== 'group' && row.kind !== 'channel')) return null
    for (const seg of rowSegs(row)) if (x > xOf(s, seg.fa / fps) + 6 && x < xOf(s, seg.fb / fps) - 6) return seg
    return null
  }

  const scrubTo = (x: number, final: boolean): void => {
    const t = snapTime(Math.max(0, Math.min(clip?.length ?? 0, tOf(sRef.current, x))), fps)
    setScrub(t)
    if (final) throttled.flush(projectPath, session, { op: 'time', time: t })
    else throttled.call(projectPath, session, { op: 'time', time: t })
  }

  const onRulerDown = (e: React.PointerEvent): void => {
    if (e.button !== 0 || !clip) return
    e.preventDefault()
    focusRoot()
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    gestureRef.current = { kind: 'scrub' }
    scrubTo(rulerX(e), false)
  }

  const onRulerMove = (e: React.PointerEvent): void => {
    if (gestureRef.current?.kind === 'scrub') scrubTo(rulerX(e), false)
  }

  const onRulerUp = (e: React.PointerEvent): void => {
    if (gestureRef.current?.kind !== 'scrub') return
    gestureRef.current = null
    scrubTo(rulerX(e), true)
    setScrubEnd(performance.now())
  }

  const onResizeDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const y0 = e.clientY
    const zk = zoomOf(handle)
    const h0 = scrollRef.current?.clientHeight ?? bodyMax
    let last = h0
    setResizing(true)
    const move = (m: PointerEvent): void => {
      last = Math.round(Math.max(TIMELINE_BODY_MIN, Math.min(maxBody(), h0 + (y0 - m.clientY) / zk)))
      onBodyHeight?.(last, false)
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      setResizing(false)
      onBodyHeight?.(last, true)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const onLabelSplitDown = (e: React.PointerEvent<HTMLDivElement>): void => {
    if (e.button !== 0) return
    e.preventDefault()
    e.stopPropagation()
    const handle = e.currentTarget
    handle.setPointerCapture(e.pointerId)
    const x0 = e.clientX
    const zk = zoomOf(handle)
    const w0 = labelW
    let last = w0
    const move = (m: PointerEvent): void => {
      last = Math.round(Math.max(LABEL_MIN, Math.min(Math.min(LABEL_MAX, width - 120), w0 + (m.clientX - x0) / zk)))
      setLabelW(last)
    }
    const up = (): void => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
      handle.removeEventListener('pointercancel', up)
      save(LABEL_KEY, String(last))
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
    handle.addEventListener('pointercancel', up)
  }

  const deleteSel = (): boolean => {
    if (readOnly) return false
    if (sel.size > 0) {
      const keys = selectedKeyArgs(clip, sel, fps)
      if (keys.length === 0) return false
      void send({ op: 'deleteKeys', keys })
      setSel(new Set())
      return true
    }
    if (selEvent != null) {
      void send({ op: 'deleteEvent', index: selEvent })
      setSelEvent(null)
      setPopover(null)
      return true
    }
    return false
  }

  const copySel = (): boolean => {
    const keys = copyKeys(clip, sel, fps)
    if (keys.length === 0) return false
    clipboard = keys
    return true
  }

  const paste = (at = time): void => {
    if (readOnly || clipboard.length === 0) return
    void send({ op: 'pasteKeys', keys: clipboard, time: snapTime(at, fps) })
  }

  const addKeysAt = (ids: string[], t: number): void => {
    if (readOnly) return
    void send({ op: 'addKey', ids, time: snapTime(t, fps) })
  }

  const frameSelection = (): void => {
    const range = selectionRange(clip, sel, fps)
    if (range) setView(frameView(range[0], range[1], fps))
    else setView(null)
  }

  const applyTangent = (mode: string): void => {
    const keys = selectedKeyArgs(clip, sel, fps)
    if (keys.length === 0 || readOnly) return
    const idx = channelIndex(clip)
    const first = parseSelId([...sel][0] ?? '')
    const k = first ? keyOf(idx.get(first.channel), first.frame, fps) : null
    const toggles = ['broken', 'weighted', 'leftWeighted', 'rightWeighted']
    let value: string | undefined
    if (toggles.includes(mode) && k) {
      const on = mode === 'broken' ? k.broken : mode === 'weighted' ? k.wm === 3 : mode === 'leftWeighted' ? (k.wm & 1) === 1 : (k.wm & 2) === 2
      value = on ? '0' : '1'
    }
    void send({ op: 'tangent', keys, mode, ...(value ? { value } : {}) })
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if ((e.target as HTMLElement).closest('input, select, textarea')) return
    const mod = e.metaKey || e.ctrlKey
    const key = e.key.toLowerCase()
    const stop = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    if (mod && !e.altKey && (key === 'z' || key === 'y')) {
      stop()
      void send({ op: key === 'y' || e.shiftKey ? 'redo' : 'undo' })
      return
    }
    if (mod && key === 'c') {
      if (copySel()) stop()
      return
    }
    if (mod && key === 'v') {
      if (clipboard.length > 0) {
        stop()
        paste()
      }
      return
    }
    if (mod && key === 'a') {
      stop()
      const all = new Set<string>()
      if (curves) {
        const idx = channelIndex(clip)
        for (const id of shown) for (const k of idx.get(id)?.keys ?? []) all.add(selId(id, frameOf(k.t, fps)))
      } else for (const k of rows[0] ? rowKeys(rows[0], fps) : []) for (const id of k.ids) all.add(id)
      setSel(all)
      return
    }
    if (!mod && (e.key === 'Delete' || e.key === 'Backspace')) {
      if (deleteSel()) stop()
      return
    }
    if (e.key === 'Escape') {
      if (menu || popover || sel.size > 0 || selEvent != null || (curves && rowSel.size > 0)) {
        e.stopPropagation()
        if (menu) setMenu(null)
        else if (popover) setPopover(null)
        else if (sel.size > 0 || selEvent != null) {
          setSel(new Set())
          setSelEvent(null)
        } else setRowSel(new Set())
      }
      return
    }
    if (!mod && !e.altKey && !e.shiftKey && e.code === 'KeyA') {
      stop()
      if (curves) curvesRef.current?.showAll()
      else setView(null)
      return
    }
    if (!mod && !e.altKey && !e.shiftKey && e.code === 'KeyF') {
      stop()
      if (curves) curvesRef.current?.frameSelection()
      else frameSelection()
      return
    }
    if (!mod && !e.altKey && !e.shiftKey && e.code === 'KeyC' && clip) {
      stop()
      switchTab(curves ? 'dopesheet' : 'curves')
      return
    }
    if (!mod && !e.altKey && e.code === 'KeyK' && clip) {
      stop()
      void send({ op: 'addKey', time })
      return
    }
    if (animatorKey(e, anim, projectPath, session)) stop()
  }

  const switchTab = (next: 'dopesheet' | 'curves'): void => {
    setTab(next)
    setMenu(null)
    setPopover((p) => (p?.kind === 'ease' ? null : p))
  }

  const onTrackDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!clip) return
    const [x, y] = trackXY(e)
    focusRoot()
    setMenu(null)
    if (e.button === 2) return
    if (e.button !== 0) return
    e.preventDefault()
    const now = performance.now()
    const last = lastDownRef.current
    const dbl = !!last && now - last.t < 400 && Math.hypot(x - last.x, y - last.y) < 5
    lastDownRef.current = dbl ? null : { t: now, x, y }
    const hit = hitKey(rows, s, fps, x, y)
    const toggle = e.metaKey || e.ctrlKey
    if (hit) {
      setSelEvent(null)
      const ids = hit.key.ids
      const state = selectionState(hit.key, sel)
      if (toggle) {
        const next = new Set(sel)
        if (state === 'all') for (const id of ids) next.delete(id)
        else for (const id of ids) next.add(id)
        setSel(next)
        return
      }
      if (e.shiftKey) {
        const next = new Set(sel)
        for (const id of ids) next.add(id)
        setSel(next)
      } else if (state !== 'all') setSel(new Set(ids))
      if (readOnly) return
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      gestureRef.current = { kind: 'keys', x0: x, moved: false, copy: e.altKey, df: 0 }
      return
    }
    const pill = pillAt(x, y)
    if (pill) {
      const r = (e.currentTarget as Element).getBoundingClientRect()
      const zk = zoomOf(e.currentTarget as Element)
      const p = pillOf(pill)
      const rr = rowAt(rows, y)
      ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
      gestureRef.current = {
        kind: 'seg',
        seg: pill,
        x0: x,
        y0: y,
        add: e.shiftKey || toggle,
        base: e.shiftKey || toggle ? new Set(sel) : new Set(),
        anchor: { x: r.left + (p ? p.x + p.w / 2 : x) * zk, y: r.top + (rr ? rr.y + rr.h / 2 + 7 : y) * zk }
      }
      return
    }
    const row = rowAt(rows, y)
    if (dbl && row && row.kind !== 'summary' && !readOnly) {
      addKeysAt(
        row.channels.map((c) => c.id),
        tOf(s, x)
      )
      return
    }
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    gestureRef.current = { kind: 'marquee', x0: x, y0: y, add: e.shiftKey || toggle, base: e.shiftKey || toggle ? new Set(sel) : new Set() }
  }

  const onTrackMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    let g = gestureRef.current
    if (!g) return
    const [x, y] = trackXY(e)
    if (g.kind === 'seg') {
      if (Math.hypot(x - g.x0, y - g.y0) < CLICK_PX) return
      g = { kind: 'marquee', x0: g.x0, y0: g.y0, add: g.add, base: g.base }
      gestureRef.current = g
    }
    if (g.kind === 'keys') {
      if (!g.moved && Math.abs(x - g.x0) < CLICK_PX) return
      g.moved = true
      g.copy = g.copy || e.altKey
      g.df = Math.round((tOf(s, x) - tOf(s, g.x0)) * fps)
      setKeyDrag({ df: g.df, copy: g.copy, x, y })
      return
    }
    if (g.kind === 'marquee') {
      if (Math.hypot(x - g.x0, y - g.y0) < CLICK_PX && !marquee) return
      setMarquee({ x0: g.x0, y0: g.y0, x1: x, y1: y })
      const ids = keysInRect(rows, s, fps, g.x0, g.y0, x, y)
      const next = new Set(g.base)
      for (const id of ids) next.add(id)
      setSel(next)
    }
  }

  const onTrackUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    const g = gestureRef.current
    gestureRef.current = null
    if (!g) return
    if (g.kind === 'seg') {
      lastDownRef.current = null
      openEase(g.seg, g.anchor.x, g.anchor.y - 14, g.anchor.y)
      return
    }
    if (g.kind === 'keys') {
      setKeyDrag(null)
      if (g.moved) lastDownRef.current = null
      if (!g.moved || g.df === 0) return
      const keys = selectedKeyArgs(clip, sel, fps)
      if (keys.length === 0) return
      setKeyDrag({ df: g.df, copy: g.copy })
      setSel(movedSelection(sel, g.df))
      void send({ op: 'moveKeys', keys, df: g.df, ...(g.copy ? { copy: true } : {}) }).then((ok) => {
        if (!ok) setKeyDrag(null)
      })
      return
    }
    if (g.kind === 'marquee') {
      const [x, y] = trackXY(e)
      if (marquee || Math.hypot(x - g.x0, y - g.y0) >= CLICK_PX) lastDownRef.current = null
      if (!marquee && Math.hypot(x - g.x0, y - g.y0) < CLICK_PX && !g.add) {
        setSel(new Set())
        setSelEvent(null)
      }
      setMarquee(null)
    }
  }

  const onTrackContext = (e: React.MouseEvent<SVGSVGElement>): void => {
    e.preventDefault()
    if (!clip) return
    const [x, y] = trackXY(e)
    const hit = hitKey(rows, s, fps, x, y)
    const row = rowAt(rows, y)
    let current = sel
    if (hit && selectionState(hit.key, sel) !== 'all') {
      current = new Set(hit.key.ids)
      setSel(current)
    }
    const t = tOf(s, x)
    if (hit) {
      const first = parseSelId([...current][0] ?? '')
      const k = first ? keyOf(channelIndex(clip).get(first.channel), first.frame, fps) : null
      const seg = segFromIds(hit.key.ids)
      setMenu({ x: e.clientX, y: e.clientY, entries: keyMenuEntries(current.size > 0, clipboard.length > 0, readOnly, k, !!seg), at: t, row, event: -1, seg })
      return
    }
    const gap = gapAt(x, y)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      at: t,
      row,
      event: -1,
      seg: gap,
      entries: [
        ...(gap ? [...segMenuEntries(readOnly, gap.label, gap.fa, gap.fb), 'sep' as const] : []),
        { action: 'addKeyHere', label: row && row.kind !== 'summary' ? `Add Key at frame ${frameOf(snapTime(t, fps), fps)}` : 'Add Key', disabled: readOnly || !row || row.kind === 'summary', tip: 'Key this row at the clicked frame' },
        { action: 'pasteHere', label: 'Paste', disabled: readOnly || clipboard.length === 0, tip: 'Paste copied keys at the clicked frame' },
        { action: 'delete', label: 'Delete Keys', disabled: readOnly || sel.size === 0 }
      ]
    })
  }

  const onRowContext = (e: React.MouseEvent, r: DopeRow): void => {
    if (!clip) return
    const keyed = r.channels.some((c) => c.keys.some((k) => frameOf(k.t, fps) === frame))
    setMenu({
      x: e.clientX,
      y: e.clientY,
      at: time,
      row: r,
      event: -1,
      entries: [
        { action: 'rowAddKey', label: 'Add Key', disabled: readOnly || r.kind === 'summary', tip: `Key ${r.label} at frame ${frame}` },
        { action: 'rowDeleteKey', label: 'Delete Key', disabled: readOnly || !keyed, tip: `Delete the keys of ${r.label} at frame ${frame}` },
        'sep',
        { action: 'rowRemove', label: r.kind === 'object' ? 'Remove Object Properties' : 'Remove Properties', disabled: readOnly || r.kind === 'summary', danger: true, tip: 'Remove these curves from the clip' }
      ]
    })
  }

  const onMenuPick = (action: string): void => {
    const m = menu
    if (!m) return
    switch (action) {
      case 'delete':
        deleteSel()
        return
      case 'copy':
        copySel()
        return
      case 'paste':
        paste()
        return
      case 'pasteHere':
        paste(m.at)
        return
      case 'addKeyHere':
        if (m.row) addKeysAt(m.row.channels.map((c) => c.id), m.at)
        return
      case 'rowAddKey':
        if (m.row) addKeysAt(m.row.channels.map((c) => c.id), time)
        return
      case 'rowDeleteKey':
        if (m.row) void send({ op: 'deleteKeys', keys: m.row.channels.filter((c) => c.keys.some((k) => frameOf(k.t, fps) === frame)).map((c) => ({ id: c.id, t: time })) })
        return
      case 'rowRemove':
        if (m.row) void send({ op: 'removeProp', ids: [...new Set(m.row.channels.map((c) => c.id))] })
        return
      case 'addEventHere':
        void send({ op: 'addEvent', time: snapTime(m.at, fps) })
        return
      case 'deleteEvent':
        if (m.event >= 0) void send({ op: 'deleteEvent', index: m.event })
        setSelEvent(null)
        return
      case 'editEasing':
        if (m.seg) openEase(m.seg, m.x, m.y, m.y + 4)
        return
      case 'curveAddKey':
        if (m.curve) void send({ op: 'setKey', keys: [{ id: m.curve.id, t: m.curve.t, hasV: true, v: m.curve.v }], time: m.curve.t })
        return
      case 'curvesAll':
        curvesRef.current?.showAll()
        return
      case 'curvesFrame':
        curvesRef.current?.frameSelection()
        return
      case 'curvesNormalize':
        setNormalize((v) => !v)
        return
    }
    if (action.startsWith('seg:')) {
      const kind = action.slice(4)
      if (m.seg) onEasePreset(m.seg, kind, EASE_PRESETS[kind])
      return
    }
    applyTangent(action)
  }

  const onCurvesContext = (e: { clientX: number; clientY: number }, ctx: CurvesContext): void => {
    if (!clip) return
    if (ctx.kind === 'key') {
      const first = parseSelId([...ctx.ids][0] ?? '')
      const k = first ? keyOf(channelIndex(clip).get(first.channel), first.frame, fps) : null
      const seg = segFromIds([ctx.clicked])
      setMenu({ x: e.clientX, y: e.clientY, entries: keyMenuEntries(ctx.ids.size > 0, clipboard.length > 0, readOnly, k, !!seg), at: time, row: null, event: -1, seg })
      return
    }
    if (ctx.kind === 'seg') {
      const seg: EaseSeg = { row: `ch:${ctx.id}`, label: ctx.name, fa: ctx.fa, fb: ctx.fb, targets: [{ id: ctx.id, fa: ctx.fa, fb: ctx.fb }] }
      setMenu({
        x: e.clientX,
        y: e.clientY,
        at: ctx.t,
        row: null,
        event: -1,
        seg,
        curve: { id: ctx.id, t: ctx.t, v: ctx.v },
        entries: [
          { action: 'curveAddKey', label: `Add Key at frame ${frameOf(ctx.t, fps)}`, disabled: readOnly, tip: 'Adds a key on this curve and keeps its shape close to what it was. Double-click does the same.' },
          'sep',
          ...segMenuEntries(readOnly, ctx.name, ctx.fa, ctx.fb)
        ]
      })
      return
    }
    setMenu({
      x: e.clientX,
      y: e.clientY,
      at: time,
      row: null,
      event: -1,
      entries: [
        { action: 'curvesAll', label: 'Show All (A)', tip: 'Fit every curve in view' },
        { action: 'curvesFrame', label: 'Frame Selection (F)', disabled: sel.size === 0, tip: 'Zoom to the selected keys' },
        'sep',
        { action: 'paste', label: 'Paste', disabled: readOnly || clipboard.length === 0, tip: 'Paste copied keys at the playhead (Cmd+V)' },
        { action: 'delete', label: 'Delete Keys', disabled: readOnly || sel.size === 0 },
        'sep',
        { action: 'curvesNormalize', label: 'Normalize', checked: normalize, tip: 'Scales each curve into -1 to 1. Unity has no such view, and the keys keep their real values.' }
      ]
    })
  }

  const onKeyToggle = (r: DopeRow, state: 'all' | 'some' | 'none'): void => {
    if (readOnly) return
    const ids = r.channels.map((c) => c.id)
    const pending = ids.some((id) => anim.pending[id] !== undefined)
    if (state === 'all' && !pending) void send({ op: 'deleteKeys', keys: ids.map((id) => ({ id, t: snapTime(time, fps) })) })
    else void send({ op: 'addKey', ids, time: snapTime(time, fps) })
  }

  const onSetValue = (channel: string, v: number): void => {
    void send({ op: 'setKey', keys: [{ id: channel, t: snapTime(time, fps), hasV: true, v }], time: snapTime(time, fps) })
  }

  const onRowClick = (e: React.MouseEvent, r: DopeRow): void => {
    if ((e.target as HTMLElement).closest('button, input')) return
    const add = e.shiftKey || e.metaKey || e.ctrlKey
    if (r.kind === 'summary') setRowSel(new Set())
    else
      setRowSel((prev) => {
        if (!add) return new Set([r.key])
        const next = new Set(prev)
        if (next.has(r.key) && (e.metaKey || e.ctrlKey)) next.delete(r.key)
        else next.add(r.key)
        return next
      })
    if (!curves) {
      const ids = new Set<string>()
      for (const k of rowKeys(r, fps)) for (const id of k.ids) ids.add(id)
      if (add) setSel((prev) => new Set([...prev, ...ids]))
      else setSel(ids)
    }
    focusRoot()
  }

  const toggle = (key: string): void =>
    setToggled((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })

  const evLocal = (e: { clientX: number }): number => rulerX(e)

  const onEventsDown = (e: React.PointerEvent<SVGSVGElement>): void => {
    if (!clip || e.button !== 0) return
    e.preventDefault()
    focusRoot()
    setMenu(null)
    const x = evLocal(e)
    const i = eventAt(clip, s, x, evDrag)
    const now = performance.now()
    const last = lastDownRef.current
    const dbl = !!last && now - last.t < 400 && Math.abs(x - last.x) < 5 && last.y === -1
    lastDownRef.current = dbl ? null : { t: now, x, y: -1 }
    if (i < 0) {
      setSelEvent(null)
      setPopover((p) => (p?.kind === 'event' ? null : p))
      if (dbl && !readOnly) void send({ op: 'addEvent', time: snapTime(tOf(s, x), fps) })
      return
    }
    setSel(new Set())
    setSelEvent(i)
    ;(e.currentTarget as Element).setPointerCapture(e.pointerId)
    gestureRef.current = { kind: 'event', index: i, x0: x, t0: clip.events[i].t, moved: false }
  }

  const onEventsMove = (e: React.PointerEvent<SVGSVGElement>): void => {
    const g = gestureRef.current
    if (!g || g.kind !== 'event' || readOnly) return
    const x = evLocal(e)
    if (!g.moved && Math.abs(x - g.x0) < CLICK_PX) return
    g.moved = true
    setPopover(null)
    setEvDrag({ index: g.index, t: snapTime(g.t0 + tOf(s, x) - tOf(s, g.x0), fps) })
  }

  const newEventRef = useRef<number | null>(null)
  useEffect(() => {
    const want = newEventRef.current
    if (want == null || !clip) return
    const i = clip.events.findIndex((ev) => Math.abs(ev.t - want) < 1e-4 && !ev.fn)
    if (i < 0) return
    newEventRef.current = null
    const x = eventMarkerXs(clip, s)[i] ?? xOf(s, clip.events[i].t)
    setPopover({ kind: 'event', index: i, left: Math.max(0, Math.min(labelW + x - 40, width - 296)), top: 30 + RULER_H + EVENTS_H + 2 })
  })

  const onEventsUp = (e: React.PointerEvent<SVGSVGElement>): void => {
    const g = gestureRef.current
    gestureRef.current = null
    if (!g || g.kind !== 'event' || !clip) return
    if (g.moved) lastDownRef.current = null
    if (!g.moved) {
      const x = eventMarkerXs(clip, s)[g.index] ?? xOf(s, clip.events[g.index].t)
      const left = Math.max(0, Math.min(labelW + x - 40, width - 296))
      setPopover({ kind: 'event', index: g.index, left, top: 30 + RULER_H + EVENTS_H + 2 })
      return
    }
    const t = snapTime(g.t0 + tOf(s, evLocal(e)) - tOf(s, g.x0), fps)
    void send({ op: 'moveEvent', index: g.index, time: t }).then(() => setEvDrag(null))
  }

  const onEventsContext = (e: React.MouseEvent<SVGSVGElement>): void => {
    e.preventDefault()
    if (!clip) return
    const x = evLocal(e)
    const i = eventAt(clip, s, x)
    if (i >= 0) setSelEvent(i)
    setMenu({
      x: e.clientX,
      y: e.clientY,
      at: tOf(s, x),
      row: null,
      event: i,
      entries: [
        { action: 'addEventHere', label: 'Add Animation Event', disabled: readOnly, tip: 'Add an event at the clicked frame' },
        { action: 'deleteEvent', label: 'Delete Event', disabled: readOnly || i < 0, danger: true }
      ]
    })
  }

  const patchEvent = (index: number, ev: TunerAnimEvent, patch: Partial<TunerAnimEvent>): void => {
    const next = { ...ev, ...patch }
    void send({ op: 'editEvent', index, ev: { fn: next.fn, f: next.f, i: next.i, s: next.s, o: next.o } })
  }

  const play = anim.mode === 'play'
  const owner = anim.owner
  const playLabel = anim.playing ? 'Pause (Space)' : 'Play (Space)'
  const timeLabel = frames ? String(frame) : formatTimelineTime(time)
  const lenLabel = clip ? (frames ? String(frameOf(clip.length, fps)) : formatTimelineTime(clip.length)) : '0'

  const compact = width > 0 && width < 1000
  const tight = width > 0 && width < 780
  const toolbar = (
    <div className="flex h-[30px] items-center border-b border-hairline">
    <BarXScroll wrapperClassName="relative min-w-0 flex-1" className="bar-x-scroll flex h-[30px] items-center gap-0.5 px-1.5">
      <span className="mr-1 shrink-0 font-medium text-ink" data-ti-tip={GESTURES}>
        {tight ? 'Anim' : 'Animation'}
      </span>
      <button
        type="button"
        data-anim-btn="lock"
        aria-pressed={anim.locked}
        disabled={!owner}
        onClick={() => void send({ op: 'lock', locked: anim.locked ? 0 : 1 })}
        data-ti-tip={anim.locked ? `Locked on ${owner?.name ?? 'this object'}: selecting other objects keeps this clip, so you can pick a child and key it here. Click to follow the selection again.` : "Lock the timeline to this object, like the lock in Unity's Animation window. Then select a child, such as the camera or a character, and key it into this clip."}
        className={`${iconBtn} ${anim.locked ? 'bg-accent/25 text-ink' : ''}`}
      >
        <Lock className="h-3 w-3" />
      </button>
      {play ? (
        anim.takenOver ? (
          <button type="button" data-anim-btn="resume" onClick={() => void send({ op: 'resume' })} className={`${textBtn} bg-accent/20 text-ink`} data-ti-tip="Give the object back to the game. It keeps playing from the playhead.">
            Resume
          </button>
        ) : (
          <span className="shrink-0 rounded bg-white/5 px-1.5 text-[10px] text-ink-3" data-anim-live data-ti-tip="The playhead follows the clip the game is playing. Scrub or step to take the object over.">
            Live
          </span>
        )
      ) : (
        <button
          type="button"
          data-anim-btn="preview"
          aria-pressed={anim.preview}
          disabled={!clip}
          onClick={() => void send({ op: 'preview', value: anim.preview ? '0' : '1' })}
          data-ti-tip={anim.preview ? 'The scene shows the pose at the playhead. Click to stop previewing and put the scene back.' : 'Pose the scene at the playhead without entering Play Mode. The scene is put back when the preview stops.'}
          className={`${textBtn} ${anim.preview ? 'bg-accent/25 text-ink' : ''}`}
        >
          Preview
        </button>
      )}
      {canRecord && (
        <button
          type="button"
          data-anim-btn="record"
          aria-pressed={anim.record}
          onClick={() => void send({ op: 'record', value: anim.record ? '0' : '1' })}
          data-ti-tip={
            anim.record
              ? 'Recording. Each change you make to the animated object becomes a key at the playhead. Click to stop.'
              : 'Turn on Record to key every change you make to the animated object, in the inspector or with the handles, at the playhead.'
          }
          className={`flex h-5 shrink-0 items-center gap-1 rounded px-1.5 transition-colors ${anim.record ? 'bg-red-500/25 text-ink' : 'text-ink-2 hover:bg-white/10 hover:text-ink'}`}
        >
          <Circle className={`h-2.5 w-2.5 ${anim.record ? 'fill-red-500 text-red-500' : 'text-red-400'}`} />
          {!tight && 'Record'}
        </button>
      )}
      <div className="mx-1 h-4 w-px shrink-0 bg-white/10" />
      <button type="button" className={iconBtn} disabled={!clip} data-anim-btn="first" aria-label="First frame" data-ti-tip="Go to the first frame (Shift+,)" onClick={() => void send({ op: 'first' })}>
        <SkipBack className="h-3.5 w-3.5" />
      </button>
      <button type="button" className={iconBtn} disabled={!clip} data-anim-btn="prevKey" aria-label="Previous key" data-ti-tip="Previous key (Alt+,)" onClick={() => void send({ op: 'prevKey' })}>
        <span className="text-[9px] leading-none">◆◀</span>
      </button>
      <button type="button" className={iconBtn} disabled={!clip} data-anim-btn="prevFrame" aria-label="Previous frame" data-ti-tip="Previous frame (,)" onClick={() => void send({ op: 'step', dir: -1 })}>
        <StepBack className="h-3.5 w-3.5" />
      </button>
      <button type="button" className={iconBtn} disabled={!clip} data-anim-btn="play" aria-label={anim.playing ? 'Pause' : 'Play'} data-ti-tip={playLabel} onClick={() => void send({ op: anim.playing ? 'pause' : 'play' })}>
        {anim.playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
      </button>
      <button type="button" className={iconBtn} disabled={!clip} data-anim-btn="nextFrame" aria-label="Next frame" data-ti-tip="Next frame (.)" onClick={() => void send({ op: 'step', dir: 1 })}>
        <StepForward className="h-3.5 w-3.5" />
      </button>
      <button type="button" className={iconBtn} disabled={!clip} data-anim-btn="nextKey" aria-label="Next key" data-ti-tip="Next key (Alt+.)" onClick={() => void send({ op: 'nextKey' })}>
        <span className="text-[9px] leading-none">▶◆</span>
      </button>
      <button type="button" className={iconBtn} disabled={!clip} data-anim-btn="last" aria-label="Last frame" data-ti-tip="Go to the last frame (Shift+.)" onClick={() => void send({ op: 'last' })}>
        <SkipForward className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        data-anim-btn="loop"
        aria-pressed={!!clip?.loop}
        disabled={readOnly}
        onClick={() => void send({ op: 'settings', loop: clip?.loop ? 0 : 1 })}
        data-ti-tip={clip?.loop ? 'The clip loops. Click to make it play once.' : 'The clip plays once. Click to loop it.'}
        className={`${iconBtn} ml-0.5 w-auto gap-1 px-1.5 ${clip?.loop ? 'bg-accent/20 text-ink' : ''}`}
      >
        <Repeat className="h-3.5 w-3.5" />
        {!compact && <span className="text-[10px]">Loop</span>}
      </button>
      <input
        data-anim-time-field
        disabled={!clip}
        key={`${timeLabel}|${frames}`}
        defaultValue={timeLabel}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key !== 'Enter') return
          const v = Number((e.target as HTMLInputElement).value)
          if (Number.isFinite(v)) void send({ op: 'time', time: frames ? v / fps : v })
          ;(e.target as HTMLInputElement).blur()
        }}
        data-ti-tip={frames ? 'Current frame. Type a frame and press Enter.' : 'Current time in seconds. Type a time and press Enter.'}
        className="ml-1 h-5 w-12 shrink-0 rounded border border-hairline bg-sunken px-1 text-right text-[11px] tabular-nums text-ink outline-none focus:border-accent disabled:opacity-40"
      />
      <button
        type="button"
        disabled={!clip}
        className="shrink-0 rounded px-0.5 tabular-nums text-ink-3 hover:bg-white/5 hover:text-ink disabled:hover:bg-transparent"
        data-anim-length
        data-ti-tip={clip ? 'Clip length. Click to change it.' : undefined}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const root = rootRef.current?.getBoundingClientRect()
          setPopover((p) => (p?.kind === 'settings' ? null : { kind: 'settings', left: (r.left - (root?.left ?? 0)) / zoomOf(rootRef.current), top: (r.bottom - (root?.top ?? 0)) / zoomOf(rootRef.current) + 2 }))
        }}
      >
        / {lenLabel}
        {frames ? '' : ' s'}
      </button>
      <div className="ml-1 flex shrink-0 overflow-hidden rounded border border-hairline" role="group" aria-label="Time units">
        {(['frames', 'seconds'] as const).map((u) => (
          <button
            key={u}
            type="button"
            data-anim-btn={u}
            aria-pressed={frames === (u === 'frames')}
            onClick={() => setFrames(u === 'frames')}
            data-ti-tip={u === 'frames' ? 'Show time in frames' : 'Show time in seconds and frames'}
            className={`h-[18px] px-1.5 text-[10px] transition-colors ${frames === (u === 'frames') ? 'bg-white/15 text-ink' : 'text-ink-3 hover:text-ink'}`}
          >
            {tight ? (u === 'frames' ? 'F' : 'S') : u === 'frames' ? 'Frames' : 'Seconds'}
          </button>
        ))}
      </div>
      <button
        type="button"
        data-anim-btn="easing"
        aria-pressed={easing}
        disabled={!clip}
        onClick={() => setEasing(!easing)}
        data-ti-tip={
          easing
            ? 'Easing shapes are on for the rows you select. Between keys they show how each move speeds up and slows down, and the row gets a thumbnail of its curve. Click a shape to edit it. Click here to hide them.'
            : "Show easing shapes between keys and a curve thumbnail on the rows you select. While they're hidden, right-click a key and choose Edit Easing."
        }
        className={`${iconBtn} ml-0.5 w-auto gap-1 px-1.5 ${easing ? 'bg-accent/20 text-ink' : ''}`}
      >
        <Spline className="h-3.5 w-3.5" />
        {!compact && <span className="text-[10px]">Easing</span>}
      </button>
      {anim.rootMotion && (
        <button
          type="button"
          data-anim-btn="root-motion"
          aria-pressed={anim.rootMotion.on}
          disabled={!clip}
          onClick={() => {
            const rm = anim.rootMotion
            if (!rm) return
            const want = !rm.on
            void send({ op: 'rootMotion', value: want === rm.animator ? 'auto' : want ? 'on' : 'off' })
          }}
          data-ti-tip={
            anim.rootMotion.on
              ? `Root motion is on, so the character moves through the scene as it would in the game with Apply Root Motion. Click to keep it in place.${anim.rootMotion.mode === 'auto' ? " Until you change it, this follows the Animator's Apply Root Motion setting." : ''}`
              : `In place: the character animates on the spot. Click to let it move through the scene as it would in the game with Apply Root Motion.${anim.rootMotion.mode === 'auto' ? " Until you change it, this follows the Animator's Apply Root Motion setting." : ''}`
          }
          className={`${iconBtn} ml-0.5 w-auto gap-1 px-1.5 ${anim.rootMotion.on ? 'bg-accent/20 text-ink' : ''}`}
        >
          <Footprints className="h-3.5 w-3.5" />
          {!compact && <span className="text-[10px]">{anim.rootMotion.on ? 'Root motion' : 'In place'}</span>}
        </button>
      )}
      <span className="min-w-0 flex-1" />
      {anim.error && (
        <span className="min-w-0 max-w-[28%] truncate text-amber-300/90" title={anim.error} data-anim-error>
          {anim.error}
        </span>
      )}
      {anim.status && !anim.error && (
        <span className="min-w-0 max-w-[28%] truncate text-ink-3" title={anim.status}>
          {anim.status}
        </span>
      )}
      <button type="button" data-anim-btn="fit" className={textBtn} disabled={!clip} data-ti-tip="Show the whole clip (A). F frames the selected keys here and the selection in the viewport." onClick={() => (curves ? curvesRef.current?.showAll() : setView(null))}>
        Fit
      </button>
    </BarXScroll>
    <div className="flex shrink-0 items-center gap-0.5 pr-1.5">
      <button
        type="button"
        data-anim-btn="fold"
        aria-pressed={folded}
        className={folded ? `${iconBtn} w-auto gap-1 bg-accent/20 px-1.5 text-ink` : iconBtn}
        aria-label={folded ? 'Show the timeline' : 'Fold the timeline'}
        data-ti-tip={folded ? 'Show the keys and tracks again' : 'Fold the timeline down to this bar to see more of the scene'}
        onClick={() => fold(!folded)}
      >
        {folded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        {folded && <span className="text-[10px]">Show keys</span>}
      </button>
      {onClose && (
        <button type="button" data-anim-btn="close" className={iconBtn} aria-label="Close the timeline" data-ti-tip="Close the timeline and stop the preview" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
    </div>
  )

  const clipBar = (
    <div className="flex h-full min-w-0 items-center gap-1 px-1.5">
      <button
        type="button"
        data-anim-clip-picker
        disabled={!owner || anim.clips.length === 0}
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const root = rootRef.current?.getBoundingClientRect()
          setPopover((p) => (p?.kind === 'clips' ? null : { kind: 'clips', left: (r.left - (root?.left ?? 0)) / zoomOf(rootRef.current), top: (r.bottom - (root?.top ?? 0)) / zoomOf(rootRef.current) + 2 }))
        }}
        data-ti-tip="Pick the clip to edit"
        className="flex h-5 min-w-0 flex-1 items-center gap-1 rounded border border-hairline bg-sunken px-1.5 text-left text-ink hover:border-strong disabled:opacity-40"
      >
        <span className="min-w-0 flex-1 truncate" data-anim-clip-name>
          {clip ? clip.name : owner || anim.target ? 'No clips yet' : 'No object selected'}
        </span>
        {clip?.readOnly && <Lock className="h-3 w-3 shrink-0 text-ink-3" aria-label="read-only" />}
        <ChevronDown className="h-3 w-3 shrink-0 text-ink-3" />
      </button>
      <button
        type="button"
        data-anim-btn="settings"
        disabled={!clip}
        className={iconBtn}
        aria-label="Clip settings"
        onClick={(e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
          const root = rootRef.current?.getBoundingClientRect()
          setPopover((p) => (p?.kind === 'settings' ? null : { kind: 'settings', left: (r.left - (root?.left ?? 0)) / zoomOf(rootRef.current), top: (r.bottom - (root?.top ?? 0)) / zoomOf(rootRef.current) + 2 }))
        }}
        data-ti-tip={clip ? `Sample rate ${fmtFps(fps)} fps, length ${formatTimelineTime(clip.length)} s. Click to change.` : 'Clip settings'}
      >
        <Settings2 className="h-3.5 w-3.5" />
      </button>
      {clip && (
        <span className="shrink-0 text-[10px] tabular-nums text-ink-3" data-anim-fps>
          {fmtFps(fps)} fps
        </span>
      )}
      <button type="button" data-anim-btn="addKey" disabled={readOnly} className={iconBtn} aria-label="Add key" onClick={() => void send({ op: 'addKey', time: snapTime(time, fps) })} data-ti-tip="Add Key (K): keys every property of the clip at the playhead, using the values you changed but have not keyed yet.">
        <span className="text-[10px] leading-none">◆+</span>
      </button>
      <button type="button" data-anim-btn="addEvent" disabled={readOnly} className={iconBtn} aria-label="Add event" onClick={() => {
        const t = snapTime(time, fps)
        newEventRef.current = t
        void send({ op: 'addEvent', time: t })
      }} data-ti-tip="Add Event: adds an event at the playhead that calls a method on the object">
        <Flag className="h-3 w-3" />
      </button>
    </div>
  )

  const keyColor = (state: 'all' | 'some' | 'none', summary: boolean): string => (state === 'all' ? 'var(--accent)' : summary ? 'var(--ink-3)' : 'var(--ink-2)')

  const chIdx = channelIndex(clip)

  const renderPills = (r: DopeRow) => {
    const cy = r.y + r.h / 2
    return rowSegs(r).map((seg) => {
      const p = pillOf(seg)
      if (!p) return null
      const shape = shapeOf(seg, chIdx, fps)
      const sk = segRep(seg, chIdx, fps)
      const name = sk ? easeName(sk[0], sk[1]) : ''
      const active = popover?.kind === 'ease' && popover.seg.fa === seg.fa && popover.seg.fb === seg.fb && popover.seg.targets.length === seg.targets.length && popover.seg.targets.every((t, i) => t.id === seg.targets[i].id)
      const n = seg.targets.length
      return (
        <g
          key={seg.fa}
          data-anim-seg={`${r.key}@${seg.fa}`}
          data-anim-seg-ease={name}
          className="group cursor-pointer"
          data-ti-tip={`${seg.label}, frames ${seg.fa} to ${seg.fb}: ${name}. Click to edit the easing${n > 1 ? ` of all ${n} curves` : ''}.`}
        >
          <rect x={p.x - 1} y={cy - 7} width={p.w + 2} height={14} rx={3} className={active ? 'fill-accent/25' : 'fill-ink/[0.07] group-hover:fill-ink/[0.16]'} />
          <path
            d={easeGlyphPath(shape, p.x + 3, cy - 5, p.w - 6, 10)}
            fill="none"
            strokeWidth={1.2}
            strokeDasharray={'flat' in shape ? '2 2' : undefined}
            className={active ? 'stroke-accent' : 'stroke-ink-3 group-hover:stroke-ink'}
            pointerEvents="none"
          />
        </g>
      )
    })
  }

  const headerCells = clip ? (
    <>
      {shownRows.map((r, i) =>
        <HeaderCell
          key={r.key}
          r={r}
          index={vis.from + i}
          anim={anim}
          frame={frame}
          fps={fps}
          readOnly={readOnly}
          selectedRow={curves ? rowSel.has(r.key) : selRows.has(r.key)}
          curves={curves}
          thumb={easing && !curves && selRows.has(r.key)}
          length={clip.length}
          time={time}
          onToggle={toggle}
          onKeyToggle={onKeyToggle}
          onSetValue={onSetValue}
          onSelectObject={(p) => onSelectObject?.(p)}
          onContext={onRowContext}
          onRowClick={onRowClick}
        />
      )}
      {clip.props.length === 0 && (
        <div data-anim-empty="noprops" className="pointer-events-none absolute left-0 right-0 px-2 py-1 text-[10px] leading-snug text-ink-3" style={{ top: rows.length > 1 ? rowsHeight(rows) : 22 }}>
          No properties yet. Use Add Property below, or turn on Record and move the object.
        </div>
      )}
    </>
  ) : null

  const renderRowKeys = (r: DopeRow) => {
    const cy = r.y + r.h / 2
    const summary = r.kind === 'summary'
    const rr = summary ? 4.5 : r.kind === 'object' || r.kind === 'component' ? 4 : 4.5
    return rowKeys(r, fps).map((k) => {
      const state = selectionState(k, sel)
      const moving = keyDrag && state !== 'none'
      const x = xOf(s, moving ? (k.frame + keyDrag.df) / fps : k.t)
      const pptr = r.prop?.pptr
      return (
        <g key={`${r.key}@${k.frame}`}>
          {moving && keyDrag.copy && <path d={diamond(xOf(s, k.t), cy, rr)} fill="var(--ink-3)" fillOpacity={0.4} />}
          {pptr ? (
            <rect
              data-anim-key={`${r.key}@${k.frame}`}
              data-anim-key-sel={state}
              x={x - rr}
              y={cy - rr}
              width={rr * 2}
              height={rr * 2}
              rx={1}
              fill={keyColor(state, summary)}
              stroke="var(--panel)"
            />
          ) : (
            <path
              data-anim-key={`${r.key}@${k.frame}`}
              data-anim-key-sel={state}
              data-anim-key-frame={k.frame}
              d={diamond(x, cy, rr + (state === 'all' ? 0.5 : 0))}
              fill={keyColor(state, summary)}
              stroke={state === 'some' ? 'var(--accent)' : 'var(--panel)'}
              strokeWidth={state === 'some' ? 1.5 : 1}
            />
          )}
        </g>
      )
    })
  }

  const keysLayer = useMemo(
    () => shownRows.map((r) => <g key={`k:${r.key}`}>{renderRowKeys(r)}</g>),
    [shownRows, s, sel, keyDrag, fps]
  )

  const emptyBody = (() => {
    if (owner && clip) return null
    if (!owner && !anim.target)
      return (
        <div data-anim-empty="select" className="flex h-16 items-center justify-center gap-3 px-4 text-center text-ink-3">
          <span>Select an animated object in the hierarchy or the viewport to see its clips.</span>
        </div>
      )
    const name = owner?.name ?? anim.target?.name ?? ''
    if (owner && anim.clips.length > 0)
      return (
        <div data-anim-empty="loading" className="flex h-16 items-center justify-center px-4">
          <PendingState tag="animator clip" label="Loading the clip…" />
        </div>
      )
    return (
      <div data-anim-empty="noclips" className="flex h-16 items-center justify-center gap-3 px-4 text-center text-ink-3">
        <span>{owner ? `${name} has no clips yet.` : `${name} isn't animated yet.`}</span>
      </div>
    )
  })()

  const popEvent = popover?.kind === 'event' && clip ? clip.events[popover.index] : undefined
  const stripOnly = !!emptyBody && !anim.locked
  const strip = stripOnly ? (
    <div data-anim-strip className="flex h-[30px] items-center gap-2 px-2">
      <span className="shrink-0 font-medium text-ink">{tight ? 'Anim' : 'Animation'}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2 text-ink-3 [&>div]:h-auto [&>div]:justify-start [&>div]:px-0">{emptyBody}</div>
      {onClose && (
        <button type="button" data-anim-btn="close" className={iconBtn} aria-label="Close the timeline" data-ti-tip="Close the timeline" onClick={onClose}>
          <X className="h-3.5 w-3.5" />
        </button>
      )}
    </div>
  ) : null

  return (
    <div
      ref={rootRef}
      data-viewport-ui
      data-tuner-timeline
      data-tuner-animator
      data-anim-mode={anim.mode}
      data-anim-preview={anim.preview ? 'on' : 'off'}
      data-anim-record={anim.record ? 'on' : 'off'}
      data-anim-playing={anim.playing ? 'yes' : 'no'}
      data-anim-playhead={frame}
      data-anim-time={anim.time.toFixed(4)}
      data-anim-frame={frameOf(anim.time, fps)}
      data-anim-clip={clip?.path ?? ''}
      data-anim-view-clip={clip?.path ?? ''}
      data-anim-owner={owner?.path ?? ''}
      data-anim-sel={sel.size}
      data-anim-sel-ids={[...sel].sort().join(' ')}
      data-anim-rev={anim.rev}
      data-anim-view={`${s.start.toFixed(4)}:${s.span.toFixed(4)}`}
      data-anim-fps={fps}
      data-anim-label-w={labelW}
      data-anim-tab={curves ? 'curves' : 'dopesheet'}
      data-anim-easing={easing ? 'on' : 'off'}
      data-anim-rowsel={[...rowSel].sort().join(' ')}
      data-anim-overlay={overlay ? 'yes' : 'no'}
      data-anim-rows-total={rows.length}
      data-anim-rows-drawn={shownRows.length}
      data-anim-root-motion={anim.rootMotion ? (anim.rootMotion.on ? 'on' : 'off') : 'none'}
      data-anim-clip-seq={anim.clipSeq}
      tabIndex={-1}
      onKeyDown={onKeyDown}
      className={`surface-overlay pointer-events-auto relative mx-2 mb-2 mt-1.5 shrink-0 rounded-lg text-[11px] text-ink-2 outline-none ${anim.record ? 'border-red-500/60' : ''}`}
    >
      {!stripOnly && !folded && <div
        role="separator"
        aria-orientation="horizontal"
        data-anim-resize
        data-ti-tip="Drag to resize the timeline. Double-click to reset."
        onPointerDown={onResizeDown}
        onDoubleClick={() => onBodyHeight?.(DEFAULT_TUNER_LAYOUT.timeline, true)}
        className="group absolute -top-1 left-3 right-3 z-20 h-2 cursor-row-resize"
      >
        <div className={`mx-auto mt-[3px] h-[3px] w-10 rounded-full transition-colors ${resizing ? 'bg-accent' : 'bg-ink-3/40 group-hover:bg-accent'}`} />
      </div>}
      {strip ?? toolbar}
      <div ref={bodyRef} className="relative" style={stripOnly || folded ? { display: 'none' } : undefined}>
        {clip?.readOnly && (
          <div data-anim-readonly className="flex h-7 items-center gap-2 border-b border-hairline bg-amber-500/10 px-2 text-amber-100/90">
            <span className="min-w-0 truncate">{clip.name} comes from {clip.path.split('/').pop()}, so it is read-only, as in Unity.</span>
          </div>
        )}
        <div className="flex border-b border-hairline" style={{ height: RULER_H }}>
          <div className="shrink-0 border-r border-hairline" style={{ width: labelW }}>
            {clipBar}
          </div>
          <svg
            ref={rulerRef}
            data-anim-ruler
            width={trackW}
            height={RULER_H}
            className={`block shrink-0 touch-none select-none text-ink-3 ${clip ? 'cursor-ew-resize' : ''}`}
            onPointerDown={onRulerDown}
            onPointerMove={onRulerMove}
            onPointerUp={onRulerUp}
            onPointerCancel={onRulerUp}
            onDoubleClick={() => setView(null)}
            data-ti-tip="Click or drag to move the playhead. Ctrl+wheel or pinch zooms, Shift+wheel scrolls in time. Double-click shows the whole clip."
          >
            {clip && (
              <>
                <rect x={xOf(s, clip.length)} y={0} width={Math.max(0, trackW - xOf(s, clip.length))} height={RULER_H} fill="rgb(0 0 0 / 0.18)" />
                {ticks.map((tk) => (
                  <g key={tk.t}>
                    <line x1={xOf(s, tk.t)} x2={xOf(s, tk.t)} y1={tk.major ? 9 : 15} y2={RULER_H} stroke="currentColor" strokeOpacity={tk.major ? 0.7 : 0.3} />
                    {tk.major && (
                      <text x={xOf(s, tk.t) + 3} y={10} fontSize={9} fill="currentColor">
                        {tk.label}
                      </text>
                    )}
                  </g>
                ))}
                <path d={`M ${playX - 5} 0 L ${playX + 5} 0 L ${playX + 5} 6 L ${playX} 11 L ${playX - 5} 6 Z`} fill="var(--accent)" />
                <text data-anim-playhead-label x={playX + 7} y={RULER_H - 3} fontSize={9} fill="var(--accent)">
                  {frames ? frame : formatTimelineTime(time)}
                </text>
              </>
            )}
          </svg>
        </div>
        <div className="flex border-b border-hairline" style={{ height: EVENTS_H }}>
          <div className="flex shrink-0 items-center border-r border-hairline px-2 text-[10px] text-ink-3" style={{ width: labelW }} data-ti-tip="Animation events call a method on the object when the clip reaches their frame">
            Events
          </div>
          <svg
            data-anim-events
            width={trackW}
            height={EVENTS_H}
            className="block shrink-0 touch-none select-none"
            onPointerDown={onEventsDown}
            onPointerMove={onEventsMove}
            onPointerUp={onEventsUp}
            onPointerCancel={onEventsUp}
            onContextMenu={onEventsContext}
            data-ti-tip={clip && clip.events.length === 0 ? 'Double-click or right-click here to add an animation event' : undefined}
          >
            {clip &&
              clip.events.map((ev, i) => {
                const t = evDrag && evDrag.index === i ? evDrag.t : ev.t
                const x = xOf(s, t)
                const mx = markerXs[i] ?? x
                const fanned = Math.abs(mx - x) > 0.5
                const tip = fanned ? EVENTS_H - 6 : EVENTS_H - 1
                const on = selEvent === i
                return (
                  <g
                    key={i}
                    data-anim-event={i}
                    data-anim-event-fn={ev.fn}
                    data-anim-event-frame={frameOf(t, fps)}
                    data-anim-event-sel={on ? 'yes' : undefined}
                    data-ti-tip={`${ev.fn || '(no function)'} at frame ${frameOf(ev.t, fps)}. Click to edit, drag to move, Delete removes.`}
                  >
                    <rect x={mx - 5} y={0} width={10} height={EVENTS_H} fill="transparent" />
                    {fanned && <line data-anim-event-leader x1={mx} y1={tip} x2={x} y2={EVENTS_H} stroke={on ? 'var(--accent)' : 'var(--ink)'} strokeOpacity={on ? 1 : 0.6} />}
                    <path d={`M ${mx - 4} 1 L ${mx + 4} 1 L ${mx + 4} ${tip - 6} L ${mx} ${tip} L ${mx - 4} ${tip - 6} Z`} fill={on ? 'var(--accent)' : 'var(--ink)'} fillOpacity={on ? 1 : 0.85} stroke="var(--panel)" />
                  </g>
                )
              })}
            {clip && <line x1={playX} x2={playX} y1={0} y2={EVENTS_H} stroke="var(--accent)" pointerEvents="none" />}
          </svg>
        </div>
        {!stripOnly && emptyBody}
        {owner && clip && curves && (
          <div className="relative flex" style={{ height: curvesH }}>
            <div
              ref={scrollRef}
              data-anim-scroll
              onScroll={onBodyScroll}
              className="relative shrink-0 overflow-y-auto overflow-x-hidden border-r border-hairline"
              style={{ width: labelW, height: curvesH }}
              onClick={(e) => {
                if (e.target === e.currentTarget) setRowSel(new Set())
              }}
            >
              <div className="relative" style={{ height: trackH }}>
                {headerCells}
              </div>
            </div>
            <CurvesView
              ref={curvesRef}
              clip={clip}
              fps={fps}
              s={s}
              width={trackW}
              height={curvesH}
              time={time}
              frames={frames}
              shown={shown}
              why={curveRowKeys.length > 0 ? 'rows' : 'all'}
              sel={sel}
              readOnly={readOnly}
              normalize={normalize}
              onNormalize={setNormalize}
              onSelect={(next) => {
                setSel(next)
                setSelEvent(null)
              }}
              onView={setView}
              onContext={onCurvesContext}
              onAddKey={(id, t, v) => void send({ op: 'setKey', keys: [{ id, t, hasV: true, v }], time: t })}
              onDragStart={() => {
                draggingRef.current = true
                setMenu(null)
              }}
              live={sendLive}
              commit={(req, over) => void commitDrag(req, over)}
              onFocus={() => {
                focusRoot()
                setMenu(null)
              }}
            />
          </div>
        )}
        {owner && clip && !curves && (
          <div ref={scrollRef} data-anim-scroll onScroll={onBodyScroll} className="relative overflow-y-auto overflow-x-hidden" style={{ maxHeight: bodyMax, height: fillH || undefined }}>
            <div className="relative flex" style={{ height: trackH }}>
              <div className="relative shrink-0 border-r border-hairline" style={{ width: labelW, height: trackH }}>
                {headerCells}
              </div>
              <svg
                ref={trackRef}
                data-anim-dope
                width={trackW}
                height={trackH}
                className="block shrink-0 touch-none select-none"
                onPointerDown={onTrackDown}
                onPointerMove={onTrackMove}
                onPointerUp={onTrackUp}
                onPointerCancel={onTrackUp}
                onContextMenu={onTrackContext}
              >
                <rect x={xOf(s, clip.length)} y={0} width={Math.max(0, trackW - xOf(s, clip.length))} height={trackH} fill="rgb(0 0 0 / 0.18)" />
                {shownRows.map((r, i) => (
                  <rect key={r.key} x={0} y={r.y} width={trackW} height={r.h} fill={rowFill(r, vis.from + i, selRows.has(r.key))} />
                ))}
                {ticks
                  .filter((tk) => tk.major)
                  .map((tk) => (
                    <line key={tk.t} x1={xOf(s, tk.t)} x2={xOf(s, tk.t)} y1={0} y2={trackH} stroke="rgb(255 255 255 / 0.05)" pointerEvents="none" />
                  ))}
                {easing && shownRows.map((r) => ((r.kind === 'group' || r.kind === 'channel') && selRows.has(r.key) ? <g key={`p:${r.key}`}>{renderPills(r)}</g> : null))}
                {keysLayer}
                {keyDrag && keyDrag.df !== 0 && (
                  <text x={Math.min(trackW - 70, (keyDrag.x ?? playX) + 10)} y={Math.max(11, (keyDrag.y ?? 0) - 8)} fontSize={10} fill="var(--ink)" pointerEvents="none">
                    {keyDrag.df > 0 ? '+' : ''}
                    {keyDrag.df} f{keyDrag.copy ? ' (copy)' : ''}
                  </text>
                )}
                {marquee && (
                  <rect
                    data-anim-marquee
                    x={Math.min(marquee.x0, marquee.x1)}
                    y={Math.min(marquee.y0, marquee.y1)}
                    width={Math.abs(marquee.x1 - marquee.x0)}
                    height={Math.abs(marquee.y1 - marquee.y0)}
                    fill="color-mix(in srgb, var(--accent) 15%, transparent)"
                    stroke="var(--accent)"
                    strokeDasharray="3 2"
                    pointerEvents="none"
                  />
                )}
                <line x1={playX} x2={playX} y1={0} y2={trackH} stroke="var(--accent)" pointerEvents="none" />
              </svg>
            </div>
          </div>
        )}
        {owner && clip && (
          <div className="flex" style={{ height: HBAR_H }}>
            <div className="shrink-0 border-r border-hairline" style={{ width: labelW }} />
            <div
              data-anim-hbar={barNeeded ? 'on' : 'off'}
              className="relative min-w-0 flex-1 touch-none select-none"
              onPointerDown={onBarDown}
              onPointerMove={onBarHover}
              onDoubleClick={() => setView(null)}
              data-ti-tip={barNeeded ? 'Drag to scroll through the clip, drag an end to zoom. Double-click shows the whole clip.' : undefined}
            >
              {barNeeded && (
                <>
                  <div className="pointer-events-none absolute bottom-[2px] top-[2px] rounded-full" style={{ left: HBAR_PAD, width: barW, background: 'color-mix(in srgb, var(--ink) 5%, transparent)' }} />
                  <div
                    data-anim-hbar-thumb
                    className="pointer-events-none absolute bottom-[2px] top-[2px] rounded-full transition-colors"
                    style={{
                      left: thumbX,
                      width: thumbW,
                      background: barDrag ? 'color-mix(in srgb, var(--accent) 70%, transparent)' : 'color-mix(in srgb, var(--ink) 30%, transparent)'
                    }}
                  />
                </>
              )}
            </div>
          </div>
        )}
        <div
          role="separator"
          aria-orientation="vertical"
          data-anim-label-split
          onPointerDown={onLabelSplitDown}
          onDoubleClick={() => {
            setLabelW(LABEL_W)
            save(LABEL_KEY, String(LABEL_W))
          }}
          data-ti-tip="Drag to resize the property column. Double-click to reset."
          className="absolute bottom-0 top-0 z-10 w-1.5 -translate-x-1/2 cursor-col-resize hover:bg-accent/40"
          style={{ left: labelW }}
        />
        <div className="flex border-t border-hairline" style={{ height: FOOTER_H }}>
          <div className="flex shrink-0 items-center gap-1 border-r border-hairline px-1.5" style={{ width: labelW }}>
            <>
              <div className="flex shrink-0 overflow-hidden rounded border border-hairline" role="tablist">
                <button type="button" role="tab" data-anim-tab="dopesheet" aria-selected={!curves} onClick={() => switchTab('dopesheet')} className={`h-[18px] px-2 text-[10px] ${!curves ? 'bg-white/15 text-ink' : 'text-ink-3 hover:text-ink'}`} data-ti-tip="Dopesheet: keys as diamonds on a row per property (C switches)">
                  Dopesheet
                </button>
                <button
                  type="button"
                  role="tab"
                  data-anim-tab="curves"
                  aria-selected={curves}
                  disabled={!clip}
                  onClick={() => switchTab('curves')}
                  className={`h-[18px] px-2 text-[10px] disabled:opacity-40 ${curves ? 'bg-white/15 text-ink' : 'text-ink-3 hover:text-ink'}`}
                  data-ti-tip="Curves: the same keys drawn as editable curves, as in Unity's Curves view. It shows the rows you select on the left, or every curve if none is selected. C switches views."
                >
                  Curves
                </button>
              </div>
              <span className="flex-1" />
              <button
                type="button"
                data-anim-addprop-btn
                disabled={readOnly || !owner}
                onClick={(e) => {
                  const root = rootRef.current?.getBoundingClientRect()
                  const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
                  setPopover((p) => (p?.kind === 'addprop' ? null : { kind: 'addprop', left: Math.max(4, r.left - (root?.left ?? 0) - 120), bottom: (root?.bottom ?? 0) - r.top + 2 }))
                }}
                className="flex h-5 shrink-0 items-center gap-1 rounded border border-hairline px-1.5 text-ink-2 hover:border-strong hover:text-ink disabled:opacity-40"
                data-ti-tip="Add Property: pick a property of the object or its children to animate"
              >
                <Plus className="h-3 w-3" />
                Add Property
              </button>
            </>
          </div>
          <div className="flex min-w-0 flex-1 items-center gap-2 px-2 text-[10px] text-ink-3">
            {owner && (
              <span className="min-w-0 truncate" data-anim-owner-label>
                {owner.name} · {owner.kind === 'animator' ? `Animator${owner.note === 'override' ? ' (override)' : ''}` : 'Animation (legacy)'}
                {clip?.path ? ` · ${clip.path}` : ''}
              </span>
            )}
            {Object.keys(anim.pending).length > 0 && (
              <span className="shrink-0 text-amber-300/90" data-anim-pending-note>
                {Object.keys(anim.pending).length} changed value{Object.keys(anim.pending).length === 1 ? ' is' : 's are'} not keyed yet. Press ◆+ to keep {Object.keys(anim.pending).length === 1 ? 'it' : 'them'}.
              </span>
            )}
          </div>
        </div>
        {popover?.kind === 'event' && popEvent && clip && (
          <EventEditor
            key={`${popover.index}:${anim.rev}`}
            ev={popEvent}
            index={popover.index}
            methods={anim.methods}
            frame={frameOf(popEvent.t, fps)}
            left={popover.left}
            top={popover.top}
            readOnly={readOnly}
            projectPath={projectPath}
            onChange={(patch) => patchEvent(popover.index, popEvent, patch)}
            onDelete={() => {
              void send({ op: 'deleteEvent', index: popover.index })
              setPopover(null)
              setSelEvent(null)
            }}
            onClose={() => setPopover(null)}
          />
        )}
        {popover?.kind === 'addprop' && (
          <AddPropertyPopover
            projectPath={projectPath}
            session={session}
            readOnly={readOnly}
            left={popover.left}
            bottom={popover.bottom}
            onAdd={(ids) => void send({ op: 'addProp', ids })}
            onClose={() => setPopover(null)}
          />
        )}
      </div>
      {popover?.kind === 'ease' && clip && (
        <EasingPopover
          key={`${popover.seg.row}@${popover.seg.fa}`}
          seg={popover.seg}
          idx={chIdx}
          names={names}
          fps={fps}
          left={popover.left}
          top={popover.top}
          readOnly={readOnly}
          onPreset={(kind, b) => onEasePreset(popover.seg, kind, b)}
          onDrag={(b, final) => onEaseDrag(popover.seg, b, final)}
          onClose={() => setPopover(null)}
        />
      )}
      {popover?.kind === 'settings' && clip && (
        <ClipSettings anim={anim} left={popover.left} top={popover.top} onSet={(patch) => void send({ op: 'settings', ...patch })} onClose={() => setPopover(null)} />
      )}
      {popover?.kind === 'clips' && owner && (
        <TimelineMenu
          x={(rootRef.current?.getBoundingClientRect().left ?? 0) + popover.left * zoomOf(rootRef.current)}
          y={(rootRef.current?.getBoundingClientRect().top ?? 0) + popover.top * zoomOf(rootRef.current)}
          onDismiss={() => setPopover(null)}
          onPick={pickClip}
          entries={anim.clips.map((c) => ({
            action: anim.clips.some((o) => o !== c && o.path === c.path) ? `${c.path}::${c.name}` : c.path,
            label: `${c.name}${c.state && c.state !== c.name ? ` (state ${c.state})` : ''}${c.readOnly ? ' · read-only' : ''}`,
            checked: c.path === clip?.path && c.name === clip?.name,
            tip: c.path
          }))}
        />
      )}
      {menu && <TimelineMenu x={menu.x} y={menu.y} entries={menu.entries} onPick={onMenuPick} onDismiss={() => setMenu(null)} />}
      {clipPick && (
        <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center" data-anim-clip-loading={clipPick.name}>
          <PendingState key={clipPick.name} tag="animator clip" label={`Loading ${clipPick.name}…`} className="rounded-full bg-black/55 px-3 py-1.5" />
        </div>
      )}
    </div>
  )
}

function fmtFps(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2)
}
