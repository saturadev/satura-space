import { Component, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type ErrorInfo, type ReactNode } from 'react'
import type { FrameLoad } from '@shared/report-frame'
import { build, describe, evaluate, type Mapper } from '../components/report/report-eval'
import { ReportApi, ReportContext, ReportStore, type ReportBridge } from '../components/report/report-context'
import { LineMap, evalLineOffset, mapStack } from '../components/report/source-map'
import { HookRegistry, TileContext, dashboardModule, type TileCalls, type TileRuntime } from '../components/dashboard/runtime'
import { call, emit, notify, onWatch } from './channel'
import type { SaturaExecReply } from '@shared/satura-exec'

class TileBoundary extends Component<{ children: ReactNode; mapper: Mapper; onError: (text: string) => void }, { failed: boolean }> {
  state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.props.onError(describe(error, this.props.mapper, info.componentStack ?? undefined))
  }

  render(): ReactNode {
    return this.state.failed ? null : this.props.children
  }
}

function Rendered({ onRendered, children }: { onRendered: () => void; children: ReactNode }) {
  useEffect(() => {
    onRendered()
  }, [onRendered])
  return <>{children}</>
}

const tileCalls: TileCalls = {
  fetch: (req) => call('dash.fetch', [req]),
  abort: (id) => notify('dash.abort', [id]),
  handle: (req) => call('dash.handle', [req]),
  git: (req) => call('dash.git', [req]),
  logs: (req) => call('dash.logs', [req]),
  file: (path, as) => call('dash.file', [path, as]),
  watch: (path, cb) => {
    notify('dash.watch', [path])
    const off = onWatch((p) => {
      if (p === path) cb()
    })
    return () => {
      off()
      notify('dash.unwatch', [path])
    }
  },
  saveState: (key, value) => notify('dash.saveState', [key, value]),
  exec: async (plugin, fn, args) => {
    const code = `return await plugins[${JSON.stringify(plugin)}][${JSON.stringify(fn)}](...${JSON.stringify(args)})`
    const reply = await call<SaturaExecReply>('action', [code])
    if (!reply.ok) throw new Error(reply.failure?.message ?? reply.error ?? 'The script failed')
    return reply.result === undefined ? undefined : JSON.parse(reply.result)
  }
}

let currentHooks: HookRegistry | null = null

const ROLE_OF: Record<string, string> = { button: 'button', a: 'link', h1: 'heading', h2: 'heading', h3: 'heading', h4: 'heading', input: 'textbox', textarea: 'textbox', select: 'combobox' }

function clip(text: string): string {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 200 ? `${t.slice(0, 199)}…` : t
}

function outlineOf(root: Element | null): string {
  const lines: string[] = []
  const walk = (node: Node): void => {
    if (lines.length >= 300) return
    if (node.nodeType === Node.TEXT_NODE) {
      const t = clip(node.textContent ?? '')
      if (t) lines.push(`- text "${t}"`)
      return
    }
    if (!(node instanceof HTMLElement) || node.hidden || node.getAttribute('aria-hidden') === 'true') return
    const role = node.getAttribute('role') ?? ROLE_OF[node.tagName.toLowerCase()] ?? ''
    const off = (node as HTMLButtonElement).disabled ? ' [disabled]' : ''
    if (role === 'button' || role === 'link' || role === 'heading') {
      lines.push(`- ${role} "${clip(node.innerText || node.getAttribute('aria-label') || '')}"${off}`)
      return
    }
    if (role === 'textbox' || role === 'combobox') {
      const label = node.getAttribute('aria-label') || node.getAttribute('placeholder') || ''
      lines.push(`- ${role}${label ? ` "${clip(label)}"` : ''}: ${clip((node as HTMLInputElement).value ?? '')}${off}`)
      return
    }
    for (const child of Array.from(node.childNodes)) walk(child)
  }
  if (root) walk(root)
  return lines.join('\n').slice(0, 20000)
}

export function tileHookData(): unknown[] {
  return currentHooks?.snapshot() ?? []
}

class SeriesMap extends Map<string, number[]> {
  dirty = false
  set(key: string, value: number[]): this {
    this.dirty = true
    return super.set(key, value)
  }
}

export function FrameTile({ load, bridge, mediaUrl }: { load: FrameLoad; bridge: ReportBridge; mediaUrl?: (path: string) => string }) {
  const setup = load.tile ?? { widget: '', state: {}, series: [] }
  const [crash, setCrash] = useState<{ key: string; text: string } | null>(null)
  const [tick, setTick] = useState(0)
  const [rendered, setRendered] = useState('')
  const [empty, setEmpty] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  const url = useMemo(() => encodeURI(load.file), [load.file])
  const mapper = useMemo<Mapper>(() => {
    const lines = new LineMap(load.map)
    const offset = evalLineOffset(build)
    return { shown: load.shown, map: (text) => mapStack(text, url, load.shown, lines, offset) }
  }, [load.map, load.shown, url])
  const loaded = useMemo(
    () => evaluate({ ok: true, file: load.file, stamp: load.stamp, code: load.code, diagnostics: [], text: '', ms: 0 }, mapper, url, { modules: { '@satura/dashboard': dashboardModule }, returns: 'the tile content, like <Stat label="…" value={…} />' }),
    [load.file, load.stamp, load.code, mapper, url]
  )
  const renderKey = load.version
  const hooks = useMemo(() => {
    void renderKey
    return new HookRegistry()
  }, [renderKey])
  currentHooks = hooks
  const bump = useCallback(() => setTick((t) => t + 1), [])
  const state = useMemo<Record<string, unknown>>(() => ({ ...setup.state }), [load.file])
  const series = useMemo(() => new SeriesMap(setup.series), [load.file])
  useEffect(() => {
    const t = window.setInterval(() => {
      if (!series.dirty) return
      series.dirty = false
      emit({ e: 'series', series: [...series].slice(-500) })
    }, 1000)
    return () => window.clearInterval(t)
  }, [series])
  const runtime = useMemo<TileRuntime>(
    () => ({ calls: tileCalls, project: load.root, widget: setup.widget, hooks, state, series, tick, bump }),
    [load.root, setup.widget, hooks, state, series, tick, bump]
  )
  const api = useMemo(
    () =>
      new ReportApi({
        file: load.file,
        root: load.root,
        version: renderKey,
        store: new ReportStore(),
        initial: null,
        frames: new Map(),
        states: new Map(),
        bridge,
        mediaUrl,
        setTitle: () => {},
        openReport: () => {},
        openFile: (f: string, line?: number) => emit({ e: 'openFile', path: f, line }),
        showImage: () => {},
        showCode: (t: { ref: string; line?: number }) => emit({ e: 'showCode', ref: t.ref, line: t.line }),
        copyLink: (link: string) => emit({ e: 'copy', text: link, toast: false })
      }),
    [load.file, load.root, renderKey, bridge, mediaUrl]
  )
  const runtimeError = crash?.key === renderKey ? crash.text : ''
  const onCrash = useCallback((text: string) => setCrash({ key: renderKey, text }), [renderKey])
  const title = typeof loaded.exports?.title === 'string' && loaded.exports.title.trim() ? loaded.exports.title.trim() : ''
  const error = loaded.error ?? runtimeError
  const status = error ? 'error' : !loaded.Component ? 'loading' : 'ok'
  const hookSnap = useSyncExternalStore(hooks.subscribe, hooks.get)
  const element = useMemo(() => {
    const C = loaded.Component
    return C ? <C /> : null
  }, [loaded])
  const onRendered = useCallback(() => setRendered(renderKey), [renderKey])
  useLayoutEffect(() => {
    const el = contentRef.current
    setEmpty(status === 'ok' && rendered === renderKey && el && !el.childElementCount && !el.textContent?.trim() ? renderKey : '')
  })
  const statusKey = JSON.stringify([renderKey, status, error, title, rendered === renderKey, empty === renderKey, hookSnap.list, hookSnap.pending])
  useEffect(() => {
    emit({
      e: 'tile',
      tile: { version: renderKey, status, error: error.slice(0, 60000), title: title.slice(0, 512), rendered: rendered === renderKey, empty: empty === renderKey, hooks: hookSnap.list.slice(0, 200), pending: hookSnap.pending, outline: outlineOf(contentRef.current) }
    })
  }, [statusKey])

  if (error) return null
  return (
    <div className="dk-tile-body" style={{ position: 'absolute', inset: 0 }}>
      <div className="sr-scope rk-report dk-tile-content" ref={contentRef}>
        <ReportContext.Provider value={api}>
          <TileContext.Provider value={runtime}>
            <Rendered key={renderKey} onRendered={onRendered}>
              <TileBoundary key={renderKey} mapper={mapper} onError={onCrash}>
                {element}
              </TileBoundary>
            </Rendered>
          </TileContext.Provider>
        </ReportContext.Provider>
      </div>
    </div>
  )
}
