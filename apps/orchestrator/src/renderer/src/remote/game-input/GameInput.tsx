import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Check, EyeOff, Gamepad2, LayoutGrid, Play, RotateCcw } from 'lucide-react'
import { visibleMaps, type RcBehavior, type RcControl, type RcPlace, type RcTrackpadEff } from '@shared/remote-controls'
import { centerVideo, cluster, frame, layoutControls, overlaps, type FrInsets, type FrItem, type FrRect } from '@shared/remote-frame'
import { gameInputState, onGameInput, sendOverride, setActive } from './link'
import { Controls, down, targetsOf, up } from './controls'
import { Trackpad } from './trackpad'
import { QualityControls, statsLine, type StreamQuality } from './StreamMenu'
import { Cluster, IconButton, Panel, Stepper, Toggle } from './chrome'
import { capture } from './geometry'
import { openStreamDetails } from '../video/StreamBadge'
import { ProgressBar, useStageProgress } from '../motion'
import { section, usePanelActions } from '../../lib/actions/action-tree'
import { postToShell } from '../shell-bus'
import './game-input.css'

const BEHAVIORS: RcBehavior[] = ['press', 'hold', 'toggle', 'tap']
const BEHAVIOR_LABEL: Record<RcBehavior, string> = { press: 'Press', hold: 'Hold', toggle: 'Toggle', tap: 'Tap', multiTap: 'Taps' }
const DEFAULT_TP: RcTrackpadEff = { speed: 1, lookSpeed: 1, acceleration: 1, invertY: false, naturalScroll: true }
const NO_INSETS: FrInsets = { t: 0, r: 0, b: 0, l: 0 }
const BLOCK = ['selectstart', 'contextmenu', 'gesturestart', 'gesturechange', 'dblclick']
const PAD_HINT = 'gi.padHint'
const ASPECT = 'gi.aspect.'

function aspect(source: string, w: number, h: number): [number, number] {
  try {
    if (w > 0 && h > 0) localStorage.setItem(ASPECT + source, `${w}x${h}`)
    else [w, h] = (localStorage.getItem(ASPECT + source) ?? '0x0').split('x').map(Number)
  } catch {
  }
  return [w || 0, h || 0]
}

export interface GamePlay {
  mode: 'play' | 'edit' | 'busy'
  onPlay?: () => void
  blocked?: string
  busy?: string
  pct?: number
}

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState === 'visible')
  useEffect(() => {
    const on = (): void => setVisible(document.visibilityState === 'visible')
    const hide = (): void => setVisible(false)
    document.addEventListener('visibilitychange', on)
    window.addEventListener('pagehide', hide)
    window.addEventListener('pageshow', on)
    return () => {
      document.removeEventListener('visibilitychange', on)
      window.removeEventListener('pagehide', hide)
      window.removeEventListener('pageshow', on)
    }
  }, [])
  return visible
}

function useBox(el: HTMLElement | null): { w: number; h: number; safe: FrInsets } {
  const [box, setBox] = useState<{ w: number; h: number; safe: FrInsets }>({ w: 0, h: 0, safe: NO_INSETS })
  useLayoutEffect(() => {
    if (!el) return
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)'
    document.body.appendChild(probe)
    let late = 0 as ReturnType<typeof setTimeout> | 0
    const measure = (): void => {
      const r = el.getBoundingClientRect()
      const w = el.offsetWidth
      const h = el.offsetHeight
      const k = w > 0 && r.width > 0 ? r.width / w : 1
      const cs = getComputedStyle(probe)
      const px = (v: string): number => Number.parseFloat(v) || 0
      const safe: FrInsets = {
        t: Math.max(0, px(cs.paddingTop) - r.top) / k,
        r: Math.max(0, px(cs.paddingRight) - (window.innerWidth - r.right)) / k,
        b: Math.max(0, px(cs.paddingBottom) - (window.innerHeight - r.bottom)) / k,
        l: Math.max(0, px(cs.paddingLeft) - r.left) / k
      }
      setBox((b) => (b.w === w && b.h === h && JSON.stringify(b.safe) === JSON.stringify(safe) ? b : { w, h, safe }))
    }
    const settle = (): void => {
      measure()
      if (late) clearTimeout(late)
      late = setTimeout(measure, 400)
    }
    measure()
    const ro = new ResizeObserver(settle)
    ro.observe(el)
    const events = ['orientationchange', 'resize']
    const ends = ['animationend', 'transitionend']
    for (const t of events) window.addEventListener(t, settle)
    for (const t of ends) document.addEventListener(t, measure, true)
    return () => {
      ro.disconnect()
      if (late) clearTimeout(late)
      for (const t of events) window.removeEventListener(t, settle)
      for (const t of ends) document.removeEventListener(t, measure, true)
      probe.remove()
    }
  }, [el])
  return box
}

function useNoLoupe(el: HTMLElement | null): void {
  useEffect(() => {
    const host = el?.parentElement
    if (!host) return
    const stop = (e: Event): void => {
      if (e.type === 'selectstart' || e.type === 'contextmenu') console.info(`[game-input] blocked ${e.type}`)
      e.preventDefault()
    }
    const touch = (e: TouchEvent): void => {
      if (!(e.target as Element).closest?.('[data-gi-chrome], [data-gi-play]')) e.preventDefault()
    }
    for (const t of BLOCK) host.addEventListener(t, stop)
    host.addEventListener('touchstart', touch, { passive: false })
    host.addEventListener('touchmove', touch, { passive: false })
    return () => {
      for (const t of BLOCK) host.removeEventListener(t, stop)
      host.removeEventListener('touchstart', touch)
      host.removeEventListener('touchmove', touch)
    }
  }, [el])
}

function sig(c: RcControl): string {
  return JSON.stringify(c.output)
}

function readHint(): boolean {
  try {
    return localStorage.getItem(PAD_HINT) !== 'seen'
  } catch {
    return true
  }
}

function PressRow({ c, editing, onShow }: { c: RcControl; editing: boolean; onShow: () => void }): React.JSX.Element {
  const [on, setOn] = useState(false)
  const held = useRef<ReturnType<typeof targetsOf> | null>(null)
  const canPress = !editing && !!c.output && c.kind === 'button'
  const release = (): void => {
    if (held.current) up(held.current)
    held.current = null
    setOn(false)
  }
  useEffect(() => release, [])
  return (
    <div className="flex items-center gap-2" data-gi-more-item={c.id}>
      <div
        className={`gi-row flex min-w-0 flex-1 flex-col justify-center ${on ? 'gi-on' : ''}`}
        onPointerDown={(e) => {
          if (!canPress) return
          capture(e.currentTarget, e.pointerId)
          held.current = targetsOf(c.output!)
          down(held.current)
          setOn(true)
          console.info(`[game-input] more: ${c.label} down`)
        }}
        onPointerUp={release}
        onPointerCancel={release}
      >
        <span className="truncate text-[13.5px] text-ink">{c.label}</span>
        <span className="truncate text-[11.5px] text-ink-3">{[c.output ? c.hint : '', c.note || (c.output ? '' : 'nothing to press on keyboard or mouse')].filter(Boolean).join(' · ')}</span>
      </div>
      {editing && !c.visible && (c.output || c.gamepad) ? (
        <button type="button" tabIndex={-1} className="gi-chip shrink-0" onClick={onShow} data-gi-show={c.id}>
          Show
        </button>
      ) : null}
    </div>
  )
}

type PanelKind = 'menu' | 'more' | null

export function GameInput({ source, quality, onFrame, play, scope, status, streaming }: { source: string; canvas: HTMLCanvasElement | null; quality: StreamQuality; onFrame?: (r: FrRect | null) => void; play: GamePlay; scope?: string; status?: ReactNode; streaming: boolean }): React.JSX.Element {
  const st = useSyncExternalStore(onGameInput, gameInputState)
  const visible = usePageVisible()
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const box = useBox(root)
  useNoLoupe(root)
  const [panel, setPanel] = useState<PanelKind>(null)
  const [editing, setEditing] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  const [drafts, setDrafts] = useState<Record<string, RcPlace>>({})
  const [padHint, setPadHint] = useState(readHint)
  const [starting, setStarting] = useState(false)
  const startTimer = useRef(0)
  const committed = useRef(new Set<string>())
  const mine = st.open && st.source === source
  const live = mine && !!st.live?.playing && !st.live.paused
  const eff = mine && st.controls && st.controlsProject === st.project ? st.controls : null
  const [vw, vh] = useMemo(() => aspect(source, quality.stats?.width || 0, quality.stats?.height || 0), [source, quality.stats?.width, quality.stats?.height])
  const picture = (quality.stats?.painted ?? 0) > 0
  const idle = play.mode === 'edit'
  const busy = play.mode === 'busy' ? play.busy ?? null : idle && starting ? 'Entering Play Mode…' : null
  const shows = !!busy || !!status
  const base = useMemo(() => frame({ w: box.w, h: box.h, vw, vh, safe: box.safe, panel: panel !== null, chrome: editing }), [box, vw, vh, panel, editing])
  const orientation = base.orientation
  const placeKey = orientation === 'portrait' ? 'portrait' : 'landscape'
  const tp = eff?.trackpad ?? DEFAULT_TP
  const maps = useMemo(() => (eff ? visibleMaps(eff, st.live?.maps ?? null) : []), [eff, st.live])
  const all = useMemo(() => maps.flatMap((m) => m.controls), [maps])
  const shown = useMemo(() => {
    const seen = new Set<string>()
    return all.filter((c) => {
      if (!c.visible || !c.output || c.kind === 'pointer' || seen.has(sig(c))) return false
      seen.add(sig(c))
      return true
    })
  }, [all])
  const look = all.some((c) => c.kind === 'pointer' && c.output?.type === 'mouseDelta')
  const on = live && visible && streaming && play.mode === 'play'
  const issues = eff ? eff.issues.filter((i) => i.level !== 'warn') : []
  const icons = 6
  const items = useMemo<FrItem[]>(
    () => shown.map((c) => ({ id: c.id, kind: c.kind as FrItem['kind'], place: { ...(c[placeKey] ?? {}), ...drafts[c.id] }, pin: !!drafts[c.id] })),
    [shown, placeKey, drafts]
  )
  const lay = useMemo(() => {
    const cl = cluster(base, icons)
    return layoutControls(items, base.area, editing && overlaps(cl, base.area) ? [cl] : [])
  }, [items, base, editing])
  const pixel = quality.stats?.settings?.filter === 'pixel'
  const fr = useMemo(() => centerVideo(base, lay.top), [base, lay.top])
  const placed = shown.filter((c) => lay.spots[c.id])
  const more = [...shown.filter((c) => lay.overflow.includes(c.id)), ...all.filter((c) => c.kind !== 'pointer' && !shown.includes(c) && !(c.joined && !c.visible) && !(c.visible && c.output))]
  const sel = selected ? placed.find((c) => c.id === selected) ?? null : null
  const fixed = useMemo(() => new Set(placed.filter((c) => c[placeKey]?.x !== undefined && c[placeKey]?.y !== undefined).map((c) => c.id)), [placed, placeKey])
  const busyAt = useStageProgress(busy ?? '', 0.08, 0.92, play.mode === 'busy' ? play.pct ?? -1 : -1)

  useLayoutEffect(() => {
    onFrame?.(box.w > 0 ? fr.video : null)
  }, [fr.video.x, fr.video.y, fr.video.w, fr.video.h, box.w])

  useEffect(() => () => onFrame?.(null), [])

  useEffect(() => {
    const why = on ? `controls and trackpad on ${source}` : !st.open ? 'no input channel' : !mine ? `the desktop sends input to ${st.source ?? 'nothing'}, the panel shows ${source}` : !live ? (st.live ? 'the game is not playing' : 'the desktop has not said the game plays yet') : play.mode !== 'play' ? `the panel shows Unity ${play.mode}` : !visible ? 'page hidden' : 'the game stream is not live'
    setActive(on, why)
  }, [on, source, live, mine, st.open, st.source, visible, streaming, play.mode])

  useEffect(() => () => setActive(false, 'panel closed'), [])

  useEffect(() => () => window.clearTimeout(startTimer.current), [])

  useEffect(() => {
    if (play.mode !== 'edit') {
      window.clearTimeout(startTimer.current)
      setStarting(false)
    }
    console.info(`[game-input] unity ${play.mode}${play.blocked ? ` (${play.blocked})` : ''}, picture=${picture}`)
  }, [play.mode, play.blocked])

  useEffect(() => {
    if (!committed.current.size) return
    setDrafts((d) => {
      const n = { ...d }
      for (const id of committed.current) delete n[id]
      committed.current.clear()
      return n
    })
  }, [st.controlsAt])

  useEffect(() => {
    if (!box.w) return
    const r = (x: FrRect | null): string => (x ? `${Math.round(x.x)},${Math.round(x.y)} ${Math.round(x.w)}x${Math.round(x.h)}` : '-')
    console.info(`[game-input] frame ${orientation}/${fr.mode} box=${Math.round(box.w)}x${Math.round(box.h)} video=${r(fr.video)} chrome=${r(fr.chrome)} area=${r(fr.area)} pad=${r(fr.pad)} panel=${r(fr.panel)}${fr.gaps ? ` gap above video=${fr.gaps[0]} below chrome=${fr.gaps[1]}` : ''}`)
  }, [fr, box.w, box.h])

  useEffect(() => {
    if (!box.w || !shown.length) return
    console.info(`[game-input] layout ${orientation} D=${Math.round(lay.D)} R=${Math.round(lay.R)} on screen ${placed.map((c) => `${c.label}@${Math.round(lay.spots[c.id].cx)},${Math.round(lay.spots[c.id].cy)}x${lay.spots[c.id].size}`).join(' ')}; more ${more.map((c) => c.label).join(', ') || 'none'}`)
  }, [lay, box.w])

  const patchControl = (c: RcControl, set: Record<string, unknown>): void => {
    sendOverride({ kind: 'control', id: c.id, action: c.path || undefined, set })
  }

  const onPlace = (c: RcControl, place: RcPlace, commit: boolean): void => {
    setDrafts((d) => ({ ...d, [c.id]: { ...d[c.id], ...place } }))
    if (!commit) return
    committed.current.add(c.id)
    patchControl(c, { [placeKey]: place })
    for (const o of placed) {
      const saved = o[placeKey]
      const s = lay.spots[o.id]
      if (o.id === c.id || saved?.x === undefined || saved?.y === undefined || !s) continue
      if (Math.abs(saved.x - s.x) < 0.005 && Math.abs(saved.y - s.y) < 0.005) continue
      committed.current.add(o.id)
      patchControl(o, { [placeKey]: { x: s.x, y: s.y, size: s.size } })
      console.info(`[game-input] ${o.label} pushed aside to ${s.x},${s.y}`)
    }
    console.info(`[game-input] placed ${c.label} ${JSON.stringify(place)}`)
  }

  const setTp = (set: Partial<RcTrackpadEff>): void => {
    sendOverride({ kind: 'trackpad', set })
  }

  const stopEditing = (): void => {
    setEditing(false)
    setSelected(null)
    if (panel === 'more') setPanel(null)
    console.info('[game-input] layout edit done')
  }

  const startPlay = (): void => {
    if (!play.onPlay || play.blocked) return
    setStarting(true)
    console.info('[game-input] Play from the game view')
    play.onPlay()
    window.clearTimeout(startTimer.current)
    startTimer.current = window.setTimeout(() => {
      setStarting(false)
      console.warn("[game-input] Unity didn't enter Play Mode in 30 s after Play from the game view")
      postToShell({ type: 'toast', text: "Unity didn't enter Play Mode in 30 s", retryId: null })
    }, 30_000)
  }

  const noteFor = (): string => {
    if (!st.open) return 'Connecting the input channel.'
    if (!eff) return 'Waiting for the game’s controls from the desktop.'
    if (!eff.ok) return eff.issues[0]?.message ?? 'No controls file yet.'
    if (!eff.inputSystem) return 'The project has no Input System, so only the trackpad works.'
    if (!eff.maps.length) return 'The project has no Input System actions, so only the trackpad works.'
    if (!shown.length) return 'This action map has nothing to press on keyboard or mouse; the trackpad still works.'
    return ''
  }

  const startEditing = (): void => {
    setEditing(true)
    setPanel(null)
    console.info('[game-input] layout edit start')
  }

  usePanelActions(scope, [
    section(
      'game',
      [
        { id: 'game.stream', label: issues.length ? `Stream and input (${issues.length} to check)` : 'Stream and input', icon: issues.length ? 'exclamationmark.triangle' : 'slider.horizontal.3', run: () => setPanel('menu') },
        { id: 'game.pixel', label: 'Pixel art', icon: 'square.grid.2x2', checked: pixel, run: () => quality.pick({ filter: pixel ? 'smooth' : 'pixel' }) },
        !!eff && (shown.length > 0 || more.length > 0) && { id: 'game.edit', label: 'Edit layout', icon: 'pencil', run: startEditing },
        more.length > 0 && { id: 'game.more', label: `More controls (${more.length})`, icon: 'square.stack', run: () => setPanel('more') },
        { id: 'game.details', label: 'Connection details', icon: 'wifi', run: openStreamDetails }
      ],
      'Game'
    )
  ])

  const clusterItems = (): React.JSX.Element[] => {
    if (!editing) return []
    const out: React.JSX.Element[] = [
      <IconButton key="done" testid="done" label="Done" on onClick={stopEditing}>
        <Check size={17} />
      </IconButton>
    ]
    if (sel) {
      if (sel.kind === 'button')
        out.push(
          <IconButton key="behavior" testid="behavior" label={`Behavior: ${BEHAVIOR_LABEL[sel.behavior]}`} onClick={() => patchControl(sel, { behavior: BEHAVIORS[(BEHAVIORS.indexOf(sel.behavior) + 1) % BEHAVIORS.length] })}>
            <span className="text-[9.5px] font-semibold leading-none">{BEHAVIOR_LABEL[sel.behavior]}</span>
          </IconButton>
        )
      if (sel.gamepad && eff?.gamepadModule)
        out.push(
          <IconButton key="drive" testid="drive" label={sel.drive === 'gamepad' ? 'Drive with keyboard and mouse' : 'Drive with the virtual gamepad'} on={sel.drive === 'gamepad'} onClick={() => patchControl(sel, { drive: sel.drive === 'gamepad' ? 'keyboard' : 'gamepad' })}>
            <Gamepad2 size={16} />
          </IconButton>
        )
      out.push(
        <IconButton
          key="hide"
          testid="hide"
          label="Hide"
          onClick={() => {
            patchControl(sel, { visible: false })
            setSelected(null)
          }}
        >
          <EyeOff size={16} />
        </IconButton>,
        <IconButton key="reset" testid="reset-one" label="Reset this control" onClick={() => patchControl(sel, { visible: null, landscape: null, portrait: null, behavior: null, drive: null })}>
          <RotateCcw size={15} />
        </IconButton>
      )
      return out
    }
    out.push(
      <IconButton key="more" testid="more" label="Hidden controls" on={panel === 'more'} badge={more.length || undefined} onClick={() => setPanel(panel === 'more' ? null : 'more')}>
        <LayoutGrid size={16} />
      </IconButton>,
      <IconButton
        key="resetall"
        testid="reset-all"
        label="Reset layout"
        onClick={() => {
          setDrafts({})
          sendOverride({ kind: 'resetLayout' })
        }}
      >
        <RotateCcw size={15} />
      </IconButton>
    )
    return out
  }

  const mapLine = maps.map((m) => m.name).join(', ')
  const note = noteFor()
  const kids = clusterItems()
  const cl = cluster(fr, kids.length)
  const hintRect = fr.mode === 'below' ? (editing ? { left: fr.chrome.x + 14, top: fr.chrome.y, width: Math.max(0, cl.x - fr.chrome.x - 22), height: fr.chrome.h } : { left: fr.pad.x + 14, top: fr.pad.y, width: Math.max(0, fr.pad.w - 28), height: 32 }) : null
  const hint = shows ? '' : editing ? 'Drag to move, pinch to resize' : on && padHint ? 'Drag to move the cursor, tap to click' : !on && !idle && note ? note : ''
  const statusRect = shows ? fr.video : null
  const ctlMode = editing ? 'edit' : on ? 'play' : 'preview'

  return (
    <div
      ref={setRoot}
      className="gi-root absolute inset-0"
      data-gi-root
      data-gi-source={source}
      data-gi-orientation={orientation}
      data-gi-mode={fr.mode}
      data-gi-live={live ? '1' : '0'}
      data-gi-unity={play.mode}
      data-gi-editing={editing ? '1' : undefined}
    >
      {box.w > 0 && (
        <>
          {on && (
            <Trackpad
              video={fr.video}
              vw={vw || 1280}
              vh={vh || 720}
              locked={!!st.cursor?.locked}
              tp={tp}
              onUse={() => {
                if (!padHint) return
                setPadHint(false)
                try {
                  localStorage.setItem(PAD_HINT, 'seen')
                } catch {
                }
              }}
            />
          )}
          {busy ? (
            <div className="gi-idle absolute" style={{ left: fr.video.x, top: fr.video.y, width: fr.video.w, height: fr.video.h }} data-gi-busy={busy} />
          ) : idle && (
            <div className="gi-idle absolute" style={{ left: fr.video.x, top: fr.video.y, width: fr.video.w, height: fr.video.h }} data-gi-idle={picture ? 'frame' : 'placeholder'}>
              <button type="button" tabIndex={-1} className={`gi-play ${starting ? 'gi-play-busy' : ''}`} disabled={!!play.blocked || !play.onPlay} onClick={startPlay} data-gi-play aria-label="Play">
                <Play size={Math.round(Math.min(34, fr.video.h * 0.16))} fill="currentColor" />
              </button>
              <span className="gi-idle-note">{play.blocked ?? (starting ? 'Entering Play Mode…' : 'Edit Mode')}</span>
            </div>
          )}
          <Controls controls={placed} spots={lay.spots} area={fr.area} R={lay.R} mode={ctlMode} selected={selected} onSelect={setSelected} onPlace={onPlace} fixed={fixed} look={look} tp={tp} />
          {statusRect && (
            <div className="pointer-events-none absolute z-[7] flex items-center justify-center" style={{ left: statusRect.x, top: statusRect.y, width: statusRect.w, height: statusRect.h }} data-gi-status={busy ?? 'stream'}>
              {busy ? (
                <div className="flex w-[220px] max-w-[80%] flex-col items-center gap-1.5">
                  <ProgressBar value={busyAt} className="h-[3px] w-full" />
                  <span className="text-center text-[11.5px] leading-snug text-zinc-300">{busy}</span>
                </div>
              ) : (
                status
              )}
            </div>
          )}
          {hintRect && hint && (
            <div className="gi-hint pointer-events-none absolute flex items-center" style={hintRect} data-gi-hint>
              {hint}
            </div>
          )}
          {editing && (
            <Cluster rect={cl} axis={fr.chromeAxis}>
              {kids}
            </Cluster>
          )}
          {fr.panel && panel === 'menu' && (
            <Panel rect={fr.panel} title="Stream and input" onClose={() => setPanel(null)}>
              {quality.showStats && (
                <div className="truncate px-0.5 font-mono text-[11px] text-ink-3" data-rv-stats>
                  {statsLine(quality.stats)}
                </div>
              )}
              <QualityControls quality={quality} />
              <section className="flex flex-col gap-1.5" data-gi-controls-info>
                <span className="px-0.5 text-[11px] text-ink-3">Controls</span>
                {note ? <span className="px-0.5 text-[12.5px] leading-snug text-ink-2">{note}</span> : null}
                {eff && eff.ok && (
                  <span className="px-0.5 text-[12.5px] leading-snug text-ink-2">
                    {mapLine ? `Map ${mapLine}` : 'No map'}
                    {eff.defaultMapReason && maps.some((m) => m.id === eff.defaultMap) ? ` (${eff.defaultMapReason})` : ''}. {placed.length} on screen, {more.length} under More. Keyboard and mouse{eff.gamepadModule ? ', gamepad module on' : ''}.
                  </span>
                )}
                {eff && !eff.gamepadModule && all.some((c) => c.gamepad) && (
                  <span className="px-0.5 text-[12px] leading-snug text-ink-3" data-gi-module-note>
                    Real analog sticks need the Satura Remote gamepad module in the project. Ask the agent to turn it on (remote.controls.gamepadModule).
                  </span>
                )}
                {st.controlsError && <span className="px-0.5 text-[12px] leading-snug text-err" data-gi-refused>{st.controlsError}</span>}
                {issues.map((i, k) => (
                  <span key={k} className="px-0.5 text-[12px] leading-snug text-warn" data-gi-issue={i.level}>
                    {i.level === 'stale' ? 'Stale override' : 'Override error'} {i.where}: {i.message}
                  </span>
                ))}
              </section>
              <section className="flex flex-col gap-1.5" data-gi-trackpad-settings>
                <span className="px-0.5 text-[11px] text-ink-3">Trackpad</span>
                <Stepper testid="speed" label="Pointer speed" value={tp.speed} step={0.1} min={0.1} max={8} onChange={(v) => setTp({ speed: v })} />
                <Stepper testid="lookSpeed" label="Look speed" value={tp.lookSpeed} step={0.1} min={0.1} max={8} onChange={(v) => setTp({ lookSpeed: v })} />
                <Stepper testid="acceleration" label="Acceleration" value={tp.acceleration} step={0.1} min={0} max={3} onChange={(v) => setTp({ acceleration: v })} />
                <Toggle testid="naturalScroll" label="Natural scrolling" value={tp.naturalScroll} onChange={(v) => setTp({ naturalScroll: v })} />
                <Toggle testid="invertY" label="Invert look Y" value={tp.invertY} onChange={(v) => setTp({ invertY: v })} />
                <span className="px-0.5 text-[11.5px] leading-snug text-ink-3">Tap to click, two-finger tap for right click, two-finger drag to scroll, hold or double-tap and drag to drag.</span>
              </section>
            </Panel>
          )}
          {fr.panel && panel === 'more' && (
            <Panel rect={fr.panel} title={editing ? 'Hidden controls' : 'More controls'} onClose={() => setPanel(null)}>
              {more.length === 0 && <span className="px-1 py-2 text-[13px] text-ink-2">Every control of {mapLine || 'this map'} is on screen.</span>}
              {!editing && more.length > 0 && <span className="px-1 text-[11.5px] text-ink-3">Hold a row to press it.</span>}
              {more.map((c) => (
                <PressRow key={c.id} c={c} editing={editing} onShow={() => patchControl(c, c.output ? { visible: true } : { drive: 'gamepad', visible: true })} />
              ))}
            </Panel>
          )}
        </>
      )}
    </div>
  )
}
