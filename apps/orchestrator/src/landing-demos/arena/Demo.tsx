import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Clapperboard, Compass, MousePointerClick, Play, RotateCcw, SlidersHorizontal, Sparkles } from 'lucide-react'
import { PaneTunerSlot } from '@renderer/components/tuner/PaneTunerSlot'
import { setAskDriftSuggestions } from '@renderer/components/tuner/AskDrift'
import { ConfirmDialog } from '@renderer/components/ui/ConfirmDialog'
import { forgetTuner, handlePrefs, tunerMemory } from '@renderer/lib/tuner/session-memory'
import { addDemoTabs, demoTab, WORKSPACE } from '../mock/store'
import { handle, PASS } from '../mock/api'
import { Fit, serveUnityFonts } from './kit'
import { ArenaSim, type ArenaFixture } from './sim'
import { Guide, SCOPE } from './guide'
import { Handoff, OPEN_PHASES, type HandoffCard, type HandoffKind, type Phase, type StartCase } from './handoff'
import { installInert } from './inert'
import { AgentCard } from './AgentCard'
import { DesktopPanels, RemoteChrome } from './Chrome'
import { useAppStore } from '@renderer/store'
import { isPhoneView } from '@renderer/lib/tuner/view-mirror'
import { tunerLabel } from '@renderer/lib/tuner/open-tuner'
import fixture from '../fixtures/arena.json'
import { onDemoCopy } from '../mock/clipboard'
import { frames, reduced } from './fade'
import { cursor, onCursor, type Cursor } from './cursor'

const fx = fixture as unknown as ArenaFixture
const VIEW = 'landing-arena'
const TAB = 'arena-tab'
const AGENT = 'arena-agent'
const TAB_GROUP = 'arena-g'
const AGENT_GROUP = 'arena-agent-g'
const GROUPS = [AGENT_GROUP, TAB_GROUP]
const AGENT_LABEL = 'Claude Code'
const TASK = { tune: 'Motes and lights', anim: 'Slower monolith rise' }

serveUnityFonts()
addDemoTabs([demoTab(TAB, TAB_GROUP, 'tuner', tunerLabel(VIEW), { ptyId: fx.session, tuner: { kind: 'view', id: VIEW } }), demoTab(AGENT, AGENT_GROUP, 'terminal', AGENT_LABEL, { agentId: 'claude' })])
useAppStore.setState((s) => ({
  sidebarOpen: true,
  groupsByWorkspace: { ...s.groupsByWorkspace, [WORKSPACE]: [{ id: AGENT_GROUP, activeTabId: AGENT, tabOrder: [AGENT] }, { id: TAB_GROUP, activeTabId: TAB, tabOrder: [TAB] }] },
  layoutByWorkspace: { ...s.layoutByWorkspace, [WORKSPACE]: { type: 'split', direction: 'horizontal', ratio: 0.3, first: { type: 'leaf', groupId: AGENT_GROUP }, second: { type: 'leaf', groupId: TAB_GROUP } } },
  activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [WORKSPACE]: TAB_GROUP }
}))

function setAgentTitle(title: string | undefined): void {
  useAppStore.setState((s) => {
    const tabs = s.tabsByWorkspace[WORKSPACE] ?? []
    const cur = tabs.find((t) => t.id === AGENT)
    if (!cur || cur.generatedLabel === title) return s
    return { tabsByWorkspace: { ...s.tabsByWorkspace, [WORKSPACE]: tabs.map((t) => (t.id === AGENT ? { ...t, generatedLabel: title } : t)) } }
  })
}

function focusGroup(groupId: string): void {
  useAppStore.setState((s) => (s.activeGroupIdByWorkspace[WORKSPACE] === groupId ? s : { activeGroupIdByWorkspace: { ...s.activeGroupIdByWorkspace, [WORKSPACE]: groupId } }))
}

const STAGES: HandoffCard['stage'][] = ['idle', 'ask', 'agent', 'tool', 'tuning', 'yours', 'drift', 'sent']

const TAB_GESTURES = ['pointerdown', 'dblclick', 'contextmenu', 'auxclick', 'dragstart'] as const

function installTabGuard(): () => void {
  const stop = (e: Event): void => {
    const t = e.target as Element | null
    if (!t?.closest?.('[data-tabbar-tab]') || t.closest('button')) return
    if (e.type === 'pointerdown' && (e as PointerEvent).button === 0) {
      e.stopPropagation()
      return
    }
    e.preventDefault()
    e.stopPropagation()
  }
  for (const t of TAB_GESTURES) window.addEventListener(t, stop, true)
  return () => {
    for (const t of TAB_GESTURES) window.removeEventListener(t, stop, true)
  }
}

const PHONE_ZOOM = 0.85

function phoneInspectorWidth(): number {
  const w = typeof window !== 'undefined' ? window.innerWidth : 390
  return Math.max(fx.inspectorWidth, w / PHONE_ZOOM)
}

function agentWidth(): number {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1440
  return Math.round(Math.max(300, Math.min(w * 0.3, w - 1004)))
}

const BLOCK = [
  'pointerdown',
  'pointerup',
  'pointermove',
  'pointerover',
  'pointerout',
  'pointerenter',
  'pointerleave',
  'pointercancel',
  'mousedown',
  'mouseup',
  'mousemove',
  'mouseover',
  'mouseout',
  'mouseenter',
  'mouseleave',
  'click',
  'dblclick',
  'auxclick',
  'contextmenu',
  'wheel',
  'keydown',
  'keyup',
  'keypress',
  'touchstart',
  'touchmove',
  'touchend',
  'dragstart'
] as const

const capture = Element.prototype.setPointerCapture
Element.prototype.setPointerCapture = function (id: number): void {
  try {
    capture.call(this, id)
  } catch {
    return
  }
}

function clearMemory(): void {
  forgetTuner(TAB)
  useAppStore.getState().setTabTuner(TAB, { kind: 'view', id: VIEW }, tunerLabel(VIEW))
  handlePrefs.mode = 'move'
  handlePrefs.space = 'global'
  handlePrefs.pivot = 'pivot'
  try {
    for (const k of Object.keys(window.localStorage)) if (k.startsWith('satura.')) window.localStorage.removeItem(k)
  } catch {
    return
  }
}

function seed(s: ArenaSim, narrow: boolean, story: boolean): void {
  const memory = tunerMemory(TAB, VIEW, s.root)
  const mono = s.members.find((m) => m.name === 'Monolith')
  if (mono && !memory.selected && !story) {
    memory.selected = mono.id
    memory.selection = [mono.id]
  }
  if (memory.animOpen == null) memory.animOpen = false
  if (!memory.orbit)
    memory.orbit = story
      ? { target: [0, 1.4, 1.2], yaw: 38, pitch: 26, distance: narrow ? 19 : 15.5, fov: 50 }
      : { target: [0, 1.6, 0.6], yaw: 0, pitch: 11, distance: narrow ? 15 : 11.5, fov: 50 }
  try {
    window.localStorage.setItem(`satura.tuner.layout.${TAB}`, JSON.stringify({ sidebar: fx.inspectorWidth + 2, viewport: 0.5, hierarchy: story ? 0.42 : 0.34, timeline: narrow ? 0.26 : 0.34 }))
    window.localStorage.setItem(`satura.tuner.view.${TAB}`, JSON.stringify({ rest: true }))
    if (story) {
      const parents = new Set<string>()
      for (const o of fx.scene.objects) {
        const i = o.path.lastIndexOf('/')
        if (i > 0) parents.add(o.path.slice(0, i))
      }
      window.localStorage.setItem(`satura.tuner.hierarchyExpanded.${s.root}:${VIEW}@LandingArena`, JSON.stringify(['scene:LandingArena', ...[...parents].map((p) => `scene:LandingArena/${p}`)]))
    }
  } catch {
    return
  }
}

interface Ctl {
  sim: ArenaSim
  guide: Guide
  handoff: Handoff
}

function stepOf(phase: Phase, card: HandoffCard, startCase: StartCase): { step: number; free: boolean } {
  if (startCase === 'free' || phase === 'explore') return { step: 0, free: true }
  if (card.kind !== 'tune') return { step: 0, free: false }
  if (phase === 'sending' || phase === 'done') return { step: 3, free: false }
  if (phase === 'yours' || phase === 'showing' || phase === 'asking') return { step: 2, free: false }
  return { step: 1, free: false }
}

type EndPick = 'tune' | 'anim' | 'free'

const END = {
  tune: { title: 'The agent has your numbers', sub: 'It got every value you changed, before and after.' },
  anim: { title: 'The agent has the new timing', sub: 'Drift slowed the rise, and the agent will save the clip.' }
}

function EndCard({ kind, onPick }: { kind: HandoffKind; onPick: (p: EndPick) => void }) {
  const [on, setOn] = useState(false)
  useEffect(() => {
    const t = requestAnimationFrame(() => requestAnimationFrame(() => setOn(true)))
    return () => cancelAnimationFrame(t)
  }, [])
  const big = 'flex w-full items-center justify-center gap-2.5 whitespace-nowrap rounded-xl px-6 py-3.5 text-[15px] font-semibold transition-[background,transform] active:scale-[0.98]'
  const primary = `${big} bg-white text-[#16181d] hover:bg-zinc-200`
  const second = `${big} bg-white/[0.06] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.14)] hover:bg-white/[0.11]`
  const copy = END[kind === 'anim' ? 'anim' : 'tune']
  const items: { pick: EndPick; label: string; icon: ReactNode }[] =
    kind === 'anim'
      ? [
          { pick: 'anim', label: 'Watch it again', icon: <RotateCcw className="h-4 w-4" /> },
          { pick: 'tune', label: 'Replay the hand-off', icon: <Play className="h-4 w-4" /> },
          { pick: 'free', label: 'Explore the full scene', icon: <Compass className="h-4 w-4" /> }
        ]
      : [
          { pick: 'tune', label: 'Run it again', icon: <RotateCcw className="h-4 w-4" /> },
          { pick: 'free', label: 'Explore the full scene', icon: <Compass className="h-4 w-4" /> },
          { pick: 'anim', label: 'Watch Drift animate', icon: <Clapperboard className="h-4 w-4" /> }
        ]
  return (
    <div
      data-demo-end={on ? 'on' : 'in'}
      className={`absolute inset-0 z-[90] flex items-center justify-center bg-[#08090c]/80 px-4 backdrop-blur-md transition-opacity duration-700 ease-out ${on ? 'opacity-100' : 'opacity-0'}`}
    >
      <div className={`flex w-full max-w-[380px] flex-col items-center rounded-2xl bg-[#16171b] px-6 pb-6 pt-7 text-center shadow-[0_24px_64px_-12px_rgb(0_0_0/0.75)] ring-1 ring-white/10 transition-transform duration-700 ease-out ${on ? 'translate-y-0' : 'translate-y-2'}`}>
        <div className="text-[22px] font-semibold leading-tight tracking-[-0.01em] text-white">{copy.title}</div>
        <div className="mt-2 text-[14px] leading-snug text-zinc-400">{copy.sub}</div>
        <div className="mt-6 flex w-full flex-col gap-2.5">
          {items.map((it, i) => (
            <button key={it.pick} type="button" data-demo-end-pick={it.pick} onClick={() => onPick(it.pick)} className={i === 0 ? primary : second}>
              {it.icon}
              {it.label}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}

function useCursor(on: boolean): Cursor | null {
  const [c, setC] = useState<Cursor | null>(() => (on ? cursor() : null))
  useEffect(() => {
    if (!on) {
      setC(null)
      return
    }
    setC(cursor())
    let raf = 0
    const off = onCursor(() => {
      if (raf) return
      raf = requestAnimationFrame(() => {
        raf = 0
        setC(cursor())
      })
    })
    return () => {
      off()
      if (raf) cancelAnimationFrame(raf)
    }
  }, [on])
  return c
}

function TryChip({ on }: { on: boolean }) {
  const c = useCursor(on)
  const show = !!c && c.inside
  const w = typeof window !== 'undefined' ? window.innerWidth : 0
  const h = typeof window !== 'undefined' ? window.innerHeight : 0
  const x = c ? (c.x + 132 > w ? c.x - 124 : c.x + 16) : 0
  const y = c ? (c.y + 48 > h ? c.y - 36 : c.y + 20) : 0
  return (
    <div
      data-demo-try
      aria-hidden="true"
      className={`pointer-events-none fixed left-0 top-0 flex items-center gap-1.5 whitespace-nowrap rounded-full bg-[#16171b]/95 py-1 pl-2 pr-2.5 text-[12px] font-medium text-white shadow-[0_6px_18px_-4px_rgb(0_0_0/0.6)] ring-1 ring-white/15 transition-opacity duration-200 ${show ? 'opacity-100' : 'opacity-0'}`}
      style={{ zIndex: 2147483001, transform: `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)` }}
    >
      <MousePointerClick className="h-3.5 w-3.5 text-[#aab1ee]" />
      Click to try
    </div>
  )
}

const TRAIL_GAP = 22
const TRAIL_NEAR = 56

function Trail({ handoff, on }: { handoff: Handoff; on: boolean }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const cv = ref.current
    const ctx = cv?.getContext('2d')
    if (!on || !cv || !ctx) return
    let raf = 0
    let alpha = 0
    let shift = 0
    let last = performance.now()
    const samples: { x: number; y: number; d: number }[] = []
    const draw = (now: number): void => {
      raf = requestAnimationFrame(draw)
      const dt = Math.min(64, now - last)
      last = now
      const dpr = window.devicePixelRatio || 1
      const W = window.innerWidth
      const H = window.innerHeight
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
        cv.width = Math.round(W * dpr)
        cv.height = Math.round(H * dpr)
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.clearRect(0, 0, W, H)
      const c = cursor()
      const t = handoff.coachTarget()
      const hit = t && c.inside ? document.elementFromPoint(c.x, c.y) : null
      const over = !!t && !!hit && t.el.contains(hit)
      const len0 = t ? Math.hypot(t.x - c.x, t.y - c.y) : 0
      const want = !!t && c.inside && !c.down && !over && len0 > TRAIL_NEAR ? 1 : 0
      alpha += (want - alpha) * Math.min(1, dt / 160)
      if (alpha < 0.02 || !t) return
      const ax = c.x
      const ay = c.y
      const bx = t.x
      const by = t.y
      const nx = -(by - ay) / (len0 || 1)
      const ny = (bx - ax) / (len0 || 1)
      const bow = Math.min(70, len0 * 0.18) * (ny < 0 ? 1 : -1)
      const cx = (ax + bx) / 2 + nx * bow
      const cy = (ay + by) / 2 + ny * bow
      samples.length = 0
      let d = 0
      let px = ax
      let py = ay
      for (let i = 0; i <= 48; i++) {
        const u = i / 48
        const x = (1 - u) * (1 - u) * ax + 2 * (1 - u) * u * cx + u * u * bx
        const y = (1 - u) * (1 - u) * ay + 2 * (1 - u) * u * cy + u * u * by
        d += Math.hypot(x - px, y - py)
        samples.push({ x, y, d })
        px = x
        py = y
      }
      const L = d
      const at = (s: number): { x: number; y: number; a: number } => {
        let i = 1
        while (i < samples.length - 1 && samples[i].d < s) i++
        const p0 = samples[i - 1]
        const p1 = samples[i]
        const f = p1.d > p0.d ? (s - p0.d) / (p1.d - p0.d) : 0
        return { x: p0.x + (p1.x - p0.x) * f, y: p0.y + (p1.y - p0.y) * f, a: Math.atan2(p1.y - p0.y, p1.x - p0.x) }
      }
      const head = 18
      const tail = 16
      ctx.lineCap = 'round'
      ctx.lineJoin = 'round'
      ctx.beginPath()
      const s0 = at(head)
      ctx.moveTo(s0.x, s0.y)
      for (const p of samples) if (p.d > head && p.d < L - tail) ctx.lineTo(p.x, p.y)
      ctx.strokeStyle = `rgba(158,166,234,${0.16 * alpha})`
      ctx.lineWidth = 10
      ctx.stroke()
      shift = (shift + dt * 0.06) % TRAIL_GAP
      for (let s = head + shift; s < L - tail; s += TRAIL_GAP) {
        const p = at(s)
        const fade = Math.min(1, (s - head) / 26, (L - tail - s) / 26)
        if (fade <= 0) continue
        ctx.save()
        ctx.translate(p.x, p.y)
        ctx.rotate(p.a)
        ctx.beginPath()
        ctx.moveTo(-3.5, -5)
        ctx.lineTo(2.5, 0)
        ctx.lineTo(-3.5, 5)
        ctx.strokeStyle = `rgba(8,9,12,${0.55 * alpha * fade})`
        ctx.lineWidth = 5
        ctx.stroke()
        ctx.strokeStyle = `rgba(214,218,250,${alpha * fade})`
        ctx.lineWidth = 2.4
        ctx.stroke()
        ctx.restore()
      }
      const pulse = (now % 1400) / 1400
      ctx.beginPath()
      ctx.arc(bx, by, 6 + pulse * 12, 0, Math.PI * 2)
      ctx.strokeStyle = `rgba(170,177,238,${(1 - pulse) * 0.8 * alpha})`
      ctx.lineWidth = 2
      ctx.stroke()
    }
    raf = requestAnimationFrame(draw)
    return () => {
      cancelAnimationFrame(raf)
      ctx.clearRect(0, 0, cv.width, cv.height)
    }
  }, [on, handoff])
  return <canvas ref={ref} data-demo-trail aria-hidden="true" className="pointer-events-none fixed inset-0 h-full w-full" style={{ zIndex: 2147483001 }} />
}

type Then = 'explain'

function DemoRun({ onReset, startCase, then }: { onReset: (next?: StartCase, then?: Then) => void; startCase: StartCase; then?: Then }) {
  const [ctl, setCtl] = useState<Ctl | null>(null)
  const [phase, setPhase] = useState<Phase>('intro')
  const phaseRef = useRef<Phase>('intro')
  const [card, setCard] = useState<HandoffCard>({ kind: startCase === 'anim' ? 'anim' : 'tune', stage: startCase === 'free' ? 'idle' : startCase === 'anim' ? 'agent' : 'ask', prompt: '', beat: 0 })
  const [copied, setCopied] = useState<string | null>(null)
  const [wentFree, setWentFree] = useState(false)
  const hostRef = useRef<HTMLDivElement>(null)
  const narrow = typeof window !== 'undefined' && window.innerWidth < 860
  const phone = isPhoneView()
  const embedded = typeof window !== 'undefined' && window.parent !== window
  const locked = !OPEN_PHASES.includes(phase)
  const [inspectorWidth] = useState(() => (phone ? phoneInspectorWidth() : 0))

  useEffect(() => {
    const sim = new ArenaSim(fx, inspectorWidth)
    seed(sim, narrow, startCase === 'tune')
    const off = sim.install()
    const offInert = installInert()
    const tagPortals = (): void => {
      for (const el of document.body.children) if (el.tagName === 'DIV' && el.id !== 'root' && !el.hasAttribute('data-satura-drift') && !el.hasAttribute('data-workspace-view')) el.setAttribute('data-workspace-view', SCOPE)
    }
    tagPortals()
    const portals = new MutationObserver(tagPortals)
    portals.observe(document.body, { childList: true })
    const guide = new Guide()
    const handoff = new Handoff(sim, guide, TAB, setCard)
    const w = window as unknown as { __arena: ArenaSim; __handoff: Handoff; __demo: { phase: Phase; startCase: StartCase } }
    w.__arena = sim
    w.__handoff = handoff
    w.__demo = { phase: 'intro', startCase }
    handoff.onPhase = (p) => {
      if (!OPEN_PHASES.includes(p) && OPEN_PHASES.includes(phaseRef.current)) {
        const f = document.activeElement
        if (f instanceof HTMLElement && hostRef.current?.contains(f)) f.blur()
      }
      phaseRef.current = p
      w.__demo = { phase: p, startCase }
      setPhase(p)
      if (p === 'explore') setWentFree(true)
      if (p === 'done' || p === 'explore') guide.leave(true)
    }
    handoff.onIdle = () => onReset()
    const offPicks = setAskDriftSuggestions([
      { id: 'tune', label: 'Tune the Particle System', icon: <SlidersHorizontal className="h-4 w-4" />, run: () => onReset('tune') },
      { id: 'particles', label: 'Explain the Particle System', icon: <Sparkles className="h-4 w-4" />, run: () => onReset('free', 'explain') },
      { id: 'anim', label: 'Watch Drift animate', icon: <Clapperboard className="h-4 w-4" />, run: () => onReset('anim') }
    ])
    let told: ReturnType<typeof setTimeout> | null = null
    const offTell = handle('agentExec', 'tell', (pane) => {
      if (pane !== AGENT) return PASS
      if (told) clearTimeout(told)
      told = setTimeout(() => {
        told = null
        handoff.ask()
      }, 2000)
      return Promise.resolve('sent' as const)
    })
    let toast: ReturnType<typeof setTimeout> | null = null
    const offCopy = onDemoCopy((text) => {
      if (handoff.phase !== 'explore') return
      setCopied(text)
      if (toast) clearTimeout(toast)
      toast = setTimeout(() => setCopied(null), 4000)
    })
    setCtl({ sim, guide, handoff })
    let timer: ReturnType<typeof setTimeout> | null = null
    if (startCase === 'free') handoff.start('free')
    const explain = then === 'explain' ? setTimeout(() => handoff.askAbout('Motes', 'ParticleSystem'), 200) : null
    const whole = (x: IntersectionObserverEntry): boolean => x.isIntersecting && (x.intersectionRatio >= 0.96 || (!!x.rootBounds && x.intersectionRect.height >= x.rootBounds.height - 24))
    const io = new IntersectionObserver((e) => {
      sim.setVisible(e.some((x) => x.isIntersecting))
      const full = e.some(whole)
      if (full && handoff.phase === 'intro' && !timer) timer = setTimeout(() => handoff.start(startCase), 120)
      if (!full && handoff.phase === 'intro' && timer) {
        clearTimeout(timer)
        timer = null
      }
    }, { threshold: Array.from({ length: 51 }, (_, i) => i / 50) })
    if (hostRef.current) io.observe(hostRef.current)
    const visible = (): void => sim.setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', visible)
    return () => {
      if (timer) clearTimeout(timer)
      if (explain) clearTimeout(explain)
      document.removeEventListener('visibilitychange', visible)
      io.disconnect()
      offCopy()
      offInert()
      portals.disconnect()
      offTell()
      if (told) clearTimeout(told)
      if (toast) clearTimeout(toast)
      offPicks()
      handoff.dispose()
      guide.dispose()
      off()
    }
  }, [])

  useEffect(() => {
    const host = hostRef.current
    if (!phone || !host || !(inspectorWidth > 0)) return
    const fit = (): void => {
      const w = host.clientWidth
      if (w > 0) host.style.setProperty('--demo-inspector-zoom', String(w / inspectorWidth))
    }
    fit()
    const ro = new ResizeObserver(fit)
    ro.observe(host)
    return () => ro.disconnect()
  }, [phone])

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    let on = false
    const wheel = (e: WheelEvent): void => {
      if (!e.isTrusted || on) return
      if ((e.target as Element | null)?.closest?.('[data-tuner-inspector], [data-scene-hierarchy], [data-tuner-popup-depth], [data-ti-popup], [data-demo-agent]')) return
      e.stopImmediatePropagation()
    }
    const down = (e: PointerEvent): void => {
      if (e.isTrusted) on = true
    }
    const leave = (e: MouseEvent): void => {
      if (e.isTrusted && !e.relatedTarget) on = false
    }
    window.addEventListener('wheel', wheel, { capture: true, passive: true })
    window.addEventListener('pointerdown', down, { capture: true })
    document.documentElement.addEventListener('mouseleave', leave)
    return () => {
      if (timer) clearTimeout(timer)
      window.removeEventListener('wheel', wheel, { capture: true })
      window.removeEventListener('pointerdown', down, { capture: true })
      document.documentElement.removeEventListener('mouseleave', leave)
    }
  }, [])

  useEffect(() => {
    if (!ctl) return
    let touchAt: { x: number; y: number } | null = null
    const block = (e: Event): void => {
      const p = phaseRef.current
      if (!e.isTrusted || OPEN_PHASES.includes(p)) return
      const t = e.target as Element | null
      if (t?.closest?.('[data-demo-end], [data-satura-drift]')) return
      if (e.type === 'touchstart') {
        const pt = (e as TouchEvent).touches[0]
        touchAt = pt ? { x: pt.clientX, y: pt.clientY } : null
      }
      e.stopImmediatePropagation()
      if (p === 'done') {
        if (e.cancelable && e.type !== 'wheel' && e.type !== 'touchstart' && e.type !== 'touchmove') e.preventDefault()
        return
      }
      const away = (): void => {
        if (p === 'sending') ctl.handoff.poke()
        else ctl.handoff.free()
      }
      if (e.type === 'keydown') {
        const k = (e as KeyboardEvent).key
        if (k === 'Shift' || k === 'Control' || k === 'Alt' || k === 'Meta' || k === 'Tab') return
        e.preventDefault()
        away()
        return
      }
      const inside = !!t?.closest?.('[data-demo-shield], [data-workspace-view]')
      if (!inside) return
      if (e.type === 'click') {
        e.preventDefault()
        away()
        return
      }
      if (e.type === 'touchend') {
        const pt = (e as TouchEvent).changedTouches[0]
        const tap = !!touchAt && !!pt && Math.hypot(pt.clientX - touchAt.x, pt.clientY - touchAt.y) < 10
        touchAt = null
        if (tap) {
          if (e.cancelable) e.preventDefault()
          away()
          return
        }
      }
      if (e.cancelable && e.type !== 'wheel' && e.type !== 'touchstart' && e.type !== 'touchmove') e.preventDefault()
    }
    for (const t of BLOCK) window.addEventListener(t, block, { capture: true, passive: false })
    return () => {
      for (const t of BLOCK) window.removeEventListener(t, block, { capture: true })
    }
  }, [ctl])

  const { step, free: railFree } = stepOf(phase, card, startCase)
  useEffect(() => {
    if (embedded) window.parent.postMessage({ type: 'satura-demo-step', step, free: railFree, stage: card.stage, kind: card.kind, phase }, '*')
  }, [step, railFree, card.stage, card.kind, phase])

  const pickEnd = (p: EndPick): void => onReset(p)
  const free = startCase === 'free'
  const tune = card.kind === 'tune'
  const after = (st: HandoffCard['stage']): boolean => STAGES.indexOf(card.stage) >= STAGES.indexOf(st)
  const working = !free && !wentFree && ((tune && (card.stage === 'agent' || card.stage === 'tool')) || (card.stage === 'sent' && !card.replied))
  const opened = !free && card.stage === 'tool' && (!tune || card.beat >= 1)
  const wasWorking = useRef(false)
  useEffect(() => {
    const st = useAppStore.getState()
    st.setAgentHookStatus(AGENT, working ? 'working' : 'idle')
    if (wasWorking.current && !working && !free && !wentFree) st.pulseAgentPane(AGENT, 'finished')
    wasWorking.current = working
  }, [working])
  useEffect(() => {
    setAgentTitle(free || (tune && !after('agent')) ? undefined : TASK[card.kind === 'anim' ? 'anim' : 'tune'])
  }, [free, card.kind, card.stage])
  useEffect(() => {
    if (free) return
    if (tune && (card.stage === 'ask' || card.stage === 'agent')) focusGroup(AGENT_GROUP)
  }, [free, card.stage])
  useEffect(() => {
    if (!opened) return
    focusGroup(TAB_GROUP)
    useAppStore.getState().pulseAgentPane(fx.session, 'opened')
  }, [opened])
  useEffect(() => installTabGuard(), [])
  const auto = !free && ((tune && (card.stage === 'ask' || card.stage === 'agent')) || (card.stage === 'sent' && phase !== 'done')) ? AGENT : TAB
  const [pick, setPick] = useState<string | null>(null)
  useEffect(() => setPick(null), [auto])
  const shown = pick ?? auto
  const choose = (id: string): void => {
    setPick(id)
    useAppStore.getState().activateTab(id)
  }
  const [width, setWidth] = useState(agentWidth)
  useEffect(() => {
    const on = (): void => setWidth(agentWidth())
    window.addEventListener('resize', on)
    return () => window.removeEventListener('resize', on)
  }, [])
  const tuner = ctl ? <PaneTunerSlot tabId={TAB} ptyId={fx.session} projectPath={ctl.sim.root} staging={false} /> : null
  const toast =
    copied !== null ? (
      <div data-demo-copied className="pointer-events-none absolute bottom-10 left-1/2 z-[65] max-w-[80%] -translate-x-1/2 truncate rounded-md bg-black/80 px-3 py-1.5 text-[11.5px] text-ink shadow-lg">
        Copied inside the demo. Nothing went to your clipboard.
      </div>
    ) : null
  return (
    <>
    <div ref={hostRef} data-workspace-view={SCOPE} data-demo-phase={phase} data-demo-start={startCase} className="absolute inset-0 flex flex-col bg-window">
      <div data-workspace={SCOPE} data-active="true" className="relative flex min-h-0 flex-1 flex-col">
        {phone ? (
          <RemoteChrome groups={GROUPS} selected={shown} onSelect={choose}>
            <div className="remote-tuner absolute inset-0 isolate" data-tab-id={TAB}>
              {tuner}
            </div>
            {shown === AGENT && (
              <div className="absolute inset-0 z-10 isolate">
                <AgentCard card={card} free={free} phone />
              </div>
            )}
            {toast}
          </RemoteChrome>
        ) : (
          <DesktopPanels
            agentGroup={AGENT_GROUP}
            tunerGroup={TAB_GROUP}
            agentWidth={width}
            vertical={narrow}
            agent={<AgentCard card={card} free={free} />}
            tuner={
              <div className="absolute inset-0">
                {toast}
                <Fit minWidth={narrow ? (card.kind === 'anim' ? 660 : 560) : 1000} minHeight={narrow ? 700 : 600} maxZoom={1}>
                  {() => tuner}
                </Fit>
              </div>
            }
          />
        )}
      </div>
      <ConfirmDialog />
      {phase === 'done' && <EndCard kind={card.kind} onPick={pickEnd} />}
    </div>
    {locked && phase !== 'done' && <div data-demo-shield className="fixed inset-0" style={{ zIndex: 2147483000, touchAction: 'pan-y', cursor: 'pointer' }} />}
    {!phone && <TryChip on={locked && phase !== 'done' && phase !== 'sending'} />}
    {!phone && ctl && <Trail handoff={ctl.handoff} on={phase === 'yours'} />}
    </>
  )
}

function firstCase(): StartCase {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search).get('start') : null
  return q === 'free' || q === 'anim' ? q : 'tune'
}

export default function Demo() {
  const [run, setRun] = useState<{ gen: number; startCase: StartCase; then?: Then }>(() => ({ gen: 0, startCase: firstCase() }))
  const veil = useRef<HTMLDivElement>(null)
  const veiling = useRef(0)
  const reset = (next?: StartCase, then?: Then): void => {
    const swap = (): void => {
      clearMemory()
      setRun((r) => ({ gen: r.gen + 1, startCase: next ?? 'tune', then }))
    }
    const v = veil.current
    if (!v || reduced()) {
      swap()
      return
    }
    const g = ++veiling.current
    v.removeAttribute('data-out')
    v.setAttribute('data-on', '')
    setTimeout(() => {
      if (g !== veiling.current) return
      swap()
      const t0 = performance.now()
      const live = (): boolean => !!document.querySelector('[data-workspace-view] canvas') && !!document.querySelector('[data-workspace-view] [data-tuner-inspector], [data-workspace-view] [data-tuner-inspector-empty], [data-workspace-view] [data-scene-hierarchy]')
      const wait = (): void => {
        if (g !== veiling.current) return
        if (!live() && performance.now() - t0 < 1200) {
          requestAnimationFrame(wait)
          return
        }
        frames(2, () => {
          if (g !== veiling.current) return
          v.setAttribute('data-out', '')
          v.removeAttribute('data-on')
        })
      }
      frames(2, wait)
    }, 170)
  }
  useEffect(() => {
    const on = (e: MessageEvent): void => {
      if (e.source !== window.parent || (e.data as { type?: string } | null)?.type !== 'satura-demo-restart') return
      console.log('[demo] back on screen, the hand-off starts again')
      reset('tune')
    }
    window.addEventListener('message', on)
    return () => window.removeEventListener('message', on)
  }, [])
  return (
    <>
      <DemoRun key={run.gen} onReset={reset} startCase={run.startCase} then={run.then} />
      <div ref={veil} className="demo-veil" aria-hidden="true" />
    </>
  )
}
