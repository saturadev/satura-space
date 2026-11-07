import '../remote/remote.css'
import '../components/report/report-kit.css'
import '../components/dashboard/dashboard.css'
import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { FrameInsets, FrameLoad, FrameQuery, FrameSettings } from '@shared/report-frame'
import type { ReportView } from '../components/report/report-view-state'
import { onViewCacheNote, seedViewCaches } from '../components/report/report-view-state'
import { onFullscreenChange } from '../components/report/Fullscreen'
import { noteHeldChange, setMediaLoader } from '../lib/media-loader'
import { setRemoteLink } from '../lib/remote-link'
import { setClipboardWriter } from '../lib/clipboard'
import { setWindowChrome } from '../lib/window-insets'
import { goBackInPanel, onPanelBackChange, panelBackTitles } from '../lib/mobile/mobile-back'
import { emit, notify, onFrameBack, onFrameLoad, onFrameQuery, onFrameSet, startChannel } from './channel'
import { frameBridge, proxyMediaLoader } from './bridge'
import { FrameReport, makeView } from './FrameReport'
import { FrameTile, tileHookData } from './FrameTile'
import { collectPage } from './collect'
import { findOpen, findShow, findText, probeView } from './probe'
import { probeVideo } from './video-probe'
import { installFramePinch } from './phone'
import { setChunkBase } from './monaco-kit-frame'

let current: FrameLoad | null = null
let zoomNow = 1
let insetsShown = ''
let panelInsets: FrameInsets | undefined
let screenSafe: FrameInsets | undefined
let fullOpen = false

function showInsets(): void {
  applyInsets(fullOpen ? (screenSafe ?? panelInsets) : panelInsets)
}

function applyInsets(i: FrameInsets | undefined): void {
  const sides: [string, number | undefined][] = [['top', i?.t], ['right', i?.r], ['bottom', i?.b], ['left', i?.l]]
  const key = sides.map(([, v]) => Math.max(0, Math.round(Number(v) || 0))).join(',')
  if (key === insetsShown) return
  insetsShown = key
  const root = document.documentElement.style
  for (const [side, v] of sides) root.setProperty(`--safe-${side}`, `${Math.max(0, Math.round(Number(v) || 0))}px`)
}

const listeners = new Set<() => void>()

function encodePath(path: string): string {
  return path
    .replace(/\\/g, '/')
    .split('/')
    .map(encodeURIComponent)
    .join('/')
    .replace(/^\/+/, '')
}

function tokenUrl(load: FrameLoad): ((path: string) => string) | undefined {
  if (load.media.kind !== 'token') return undefined
  const base = load.media.base
  const version = encodeURIComponent(load.version)
  return (path) => `${base}${encodePath(path)}?r=${version}`
}

const bridges = new Map<string, ReturnType<typeof frameBridge>>()

function bridgeFor(load: FrameLoad): ReturnType<typeof frameBridge> {
  const key = `${load.canAct}|${load.mode}`
  let b = bridges.get(key)
  if (!b) bridges.set(key, (b = frameBridge({ canAct: load.canAct, recording: load.mode === 'collect' })))
  return b
}

const views = new Map<string, ReportView>()

function viewFor(load: FrameLoad): ReportView {
  let v = views.get(load.file)
  if (!v) views.set(load.file, (v = makeView(load)))
  return v
}

function FrameApp() {
  const [, setTick] = useState(0)
  const [settings, setSettings] = useState<FrameSettings>({})
  useEffect(() => {
    const on = (): void => setTick((n) => n + 1)
    listeners.add(on)
    return () => {
      listeners.delete(on)
    }
  }, [])
  useEffect(
    () =>
      onFrameSet((s) => {
        if (typeof s.online === 'boolean') setRemoteLink(s.online)
        if (s.insets) panelInsets = s.insets
        if (s.screen) screenSafe = s.screen
        if (s.insets || s.screen) showInsets()
        if (s.held !== undefined) noteHeldChange()
        setSettings((prev) => ({ ...prev, ...s }))
      }),
    []
  )
  const load = current
  const mediaUrl = useMemo(() => (load ? tokenUrl(load) : undefined), [load?.media, load?.version])
  if (!load || load.mode === 'collect') return null
  const zoom = settings.zoom ?? load.zoom
  zoomNow = zoom
  const phone = load.layout === 'mobile'
  const body =
    load.mode === 'tile' ? (
      <FrameTile key={load.file} load={load} bridge={bridgeFor(load)} mediaUrl={mediaUrl} />
    ) : (
      <FrameReport key={load.file} load={load} view={viewFor(load)} zoom={zoom} bridge={bridgeFor(load)} mediaUrl={mediaUrl} />
    )
  if (!phone) return body
  return (
    <div className="absolute inset-0" data-phone-panel={load.mode === 'tile' ? 'dashboard' : 'viewer'} data-tab-id="frame">
      <div className="absolute inset-0" data-viewer-report>
        {body}
      </div>
    </div>
  )
}

let rendered = false
let phoneReady = false

function applyEnv(load: FrameLoad): void {
  const root = document.documentElement
  root.dataset.theme = load.theme
  document.body.style.background = load.mode === 'tile' ? 'transparent' : ''
  if (load.layout === 'mobile') root.dataset.layout = 'mobile'
  else delete root.dataset.layout
  setWindowChrome(load.chrome)
  if (!insetsShown) applyInsets(undefined)
  setChunkBase(load.chunks)
  setRemoteLink(load.online)
  seedViewCaches(load.aspects, load.infos)
  if (load.media.kind === 'proxy') {
    if (!phoneReady) setMediaLoader(proxyMediaLoader())
  } else setMediaLoader(null)
  if (load.layout === 'mobile' && !phoneReady) {
    phoneReady = true
    installFramePinch(() => zoomNow)
    void import('../remote/expand').then((m) => m.installPhoneExpand())
    void import('../remote/popover-dismiss').then((m) => m.installPopoverDismiss())
  }
}

async function answer(q: FrameQuery): Promise<unknown> {
  switch (q.q) {
    case 'view':
      return probeView(q)
    case 'findOpen':
      return findOpen(q.open)
    case 'find':
      return findText(q.text)
    case 'findShow':
      return findShow(q.index, q.scroll)
    case 'hooks':
      return tileHookData()
    case 'video':
      return probeVideo(q)
    case 'probe':
      return {
        api: typeof (window as unknown as { api?: unknown }).api,
        parentDom: (() => {
          try {
            return typeof window.parent.document
          } catch (e) {
            return `blocked: ${e instanceof Error ? e.name : String(e)}`
          }
        })(),
        origin: window.origin,
        count: Object.fromEntries((q.count ?? []).slice(0, 40).map((sel) => [sel, document.querySelectorAll(sel).length])),
        rect: q.rect
          ? (() => {
              const el = document.querySelector(q.rect)
              if (!el) return null
              el.scrollIntoView({ block: 'center' })
              const r = el.getBoundingClientRect()
              return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }
            })()
          : undefined,
        text: q.text ? (document.querySelector(q.text)?.textContent ?? null)?.replace(/\s+/g, ' ').trim().slice(0, 400) : undefined
      }
    case 'select': {
      const el = document.querySelector(q.selector)
      if (!el) return { found: false }
      el.scrollIntoView({ block: 'center' })
      const range = document.createRange()
      range.selectNodeContents(el)
      const sel = window.getSelection()
      sel?.removeAllRanges()
      sel?.addRange(range)
      window.focus()
      const cs = getComputedStyle(el)
      return { found: true, text: (sel?.toString() ?? '').slice(0, 2000), userSelect: cs.userSelect || cs.webkitUserSelect }
    }
    case 'collect': {
      if (!current) throw new Error('Nothing to collect')
      const load = current
      const url = tokenUrl(load) ?? (() => 'data:,')
      return collectPage(load, bridgeFor(load), url)
    }
  }
}

function install(): void {
  setClipboardWriter((text) => emit({ e: 'copy', text: String(text).slice(0, 65536), toast: false }))
  onFullscreenChange((on) => {
    fullOpen = on
    showInsets()
    emit({ e: 'fullscreen', on })
  })
  onPanelBackChange(() => {
    const titles = panelBackTitles()
    emit({ e: 'back', depth: titles.length, title: (titles[titles.length - 1] ?? '').slice(0, 256) })
  })
  onFrameBack(() => {
    goBackInPanel()
  })
  onViewCacheNote((note) => {
    if (note.kind === 'aspect') emit({ e: 'view', view: {}, aspects: [[note.key, note.value]] })
    else emit({ e: 'view', view: {}, infos: [[note.key, note.value]] })
  })
  window.addEventListener('error', (e) => {
    if (String(e.message).startsWith('ResizeObserver loop')) e.preventDefault()
  })
  document.addEventListener('securitypolicyviolation', (e) => {
    notify('diag', [`report frame CSP blocked ${e.blockedURI || 'inline'} by ${e.violatedDirective}`])
  })
  const forward = (e: KeyboardEvent): void =>
    emit({ e: 'key', type: e.type === 'keyup' ? 'keyup' : 'keydown', key: e.key.slice(0, 64), code: e.code.slice(0, 64), meta: e.metaKey, ctrl: e.ctrlKey, alt: e.altKey, shift: e.shiftKey, repeat: e.repeat })
  window.addEventListener(
    'keydown',
    (e) => {
      if (!(e.metaKey || e.ctrlKey)) return
      if (e.key.toLowerCase() === 'r' && !e.altKey && !e.shiftKey) {
        e.preventDefault()
        e.stopPropagation()
        emit({ e: 'reload' })
        return
      }
      forward(e)
    },
    true
  )
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !e.defaultPrevented) forward(e)
    if (e.key === 'Shift' && !e.metaKey && !e.ctrlKey && !e.altKey) forward(e)
  })
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Shift') forward(e)
  })
  window.addEventListener('pointerdown', () => emit({ e: 'pointer' }), true)
  onFrameQuery(answer)
  onFrameLoad((load) => {
    current = load
    applyEnv(load)
    if (!rendered && load.mode !== 'collect') {
      rendered = true
      createRoot(document.getElementById('root') as HTMLElement).render(<FrameApp />)
    }
    for (const l of listeners) l()
  })
  startChannel()
}

install()
