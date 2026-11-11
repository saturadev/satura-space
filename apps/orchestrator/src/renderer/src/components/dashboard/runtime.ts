import { createContext, useContext, useEffect, useRef, useState } from 'react'
import {
  DASHBOARD_MIN_EVERY_S,
  type DashboardFetchRequest,
  type DashboardFetchResult,
  type DashboardFileResult,
  type DashboardGitRequest,
  type DashboardGitResult,
  type DashboardHandleRequest,
  type DashboardHandleResult,
  type DashboardLogsRequest,
  type DashboardLogsResult
} from '@shared/dashboard'
import { kit } from '../report/kit'

export interface HookEntry {
  hook: string
  target: string
  status: 'loading' | 'ok' | 'error'
  error?: string
  http?: number
  at?: number
  ms?: number
  every?: number
}

export class HookRegistry {
  private entries = new Map<number, HookEntry>()
  private seq = 0
  private listeners = new Set<() => void>()
  private snap: { list: HookEntry[]; pending: number } = { list: [], pending: 0 }
  data = new Map<number, unknown>()

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  get = (): { list: HookEntry[]; pending: number } => this.snap

  private emit(): void {
    const list = [...this.entries.values()]
    this.snap = { list, pending: list.filter((e) => e.status === 'loading' && !e.at).length }
    for (const cb of [...this.listeners]) cb()
  }

  add(entry: HookEntry): { set: (patch: Partial<HookEntry>, data?: unknown) => void; remove: () => void } {
    const id = ++this.seq
    this.entries.set(id, entry)
    this.emit()
    return {
      set: (patch, data) => {
        const cur = this.entries.get(id)
        if (!cur) return
        this.entries.set(id, { ...cur, ...patch })
        if (data !== undefined) this.data.set(id, data)
        this.emit()
      },
      remove: () => {
        this.data.delete(id)
        if (this.entries.delete(id)) this.emit()
      }
    }
  }

  snapshot(): unknown[] {
    return [...this.data.values()]
  }
}

export interface TileCalls {
  fetch: (req: DashboardFetchRequest & { id: string }) => Promise<DashboardFetchResult>
  abort: (id: string) => void
  handle: (req: DashboardHandleRequest) => Promise<DashboardHandleResult>
  git: (req: DashboardGitRequest) => Promise<DashboardGitResult>
  logs: (req: DashboardLogsRequest) => Promise<DashboardLogsResult>
  file: (path: string, as?: 'json' | 'text') => Promise<DashboardFileResult>
  watch: (path: string, cb: () => void) => () => void
  saveState: (key: string, value: unknown) => void
  exec: (plugin: string, fn: string, args: unknown[]) => Promise<unknown>
}

export interface TileRuntime {
  calls: TileCalls
  project: string
  widget: string
  hooks: HookRegistry
  state: Record<string, unknown>
  series: Map<string, number[]>
  tick: number
  bump: () => void
}

export const TileContext = createContext<TileRuntime | null>(null)

function useTile(name: string): TileRuntime {
  const rt = useContext(TileContext)
  if (!rt) throw new Error(`${name} works only inside a dashboard widget.`)
  return rt
}

function everyOf(every: unknown): number {
  const n = Number(every)
  return Number.isFinite(n) && n > 0 ? Math.max(DASHBOARD_MIN_EVERY_S, n) : 0
}

let fetchSeq = 0

type Poll<R> = { data: R | undefined; error: string | undefined; loading: boolean; at: number | undefined }

function usePoll<R>(
  name: string,
  target: string,
  key: string,
  every: number,
  enabled: boolean,
  load: (id: string) => Promise<{ ok: boolean; error?: string; at: number; ms?: number; http?: number; data?: R }>,
  abort?: (id: string) => void
): Poll<R> & { refresh: () => void; extra: { http?: number } } {
  const rt = useTile(name)
  const [st, setSt] = useState<Poll<R> & { http?: number }>({ data: undefined, error: undefined, loading: enabled, at: undefined })
  const [nonce, setNonce] = useState(0)
  const loadRef = useRef(load)
  loadRef.current = load
  const { hooks, bump, widget } = rt
  useEffect(() => {
    if (!enabled) {
      setSt((s) => ({ ...s, loading: false }))
      return
    }
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const id = `${widget}:${++fetchSeq}`
    const slot = hooks.add({ hook: name, target, status: 'loading', ...(every ? { every } : {}) })
    const run = async (): Promise<void> => {
      setSt((s) => ({ ...s, loading: true }))
      let r: Awaited<ReturnType<typeof load>>
      try {
        r = await loadRef.current(id)
      } catch (e) {
        r = { ok: false, error: e instanceof Error ? e.message : String(e), at: Date.now() }
      }
      if (!alive) return
      setSt((s) => ({ data: r.ok ? r.data : s.data, error: r.ok ? undefined : r.error, loading: false, at: r.at, http: r.http }))
      slot.set({ status: r.ok ? 'ok' : 'error', error: r.ok ? undefined : r.error, at: r.at, ms: r.ms, http: r.http }, r.ok ? r.data : undefined)
      bump()
      if (every && alive) timer = setTimeout(() => void run(), every * 1000)
    }
    void run()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
      abort?.(id)
      slot.remove()
    }
  }, [hooks, bump, widget, name, target, key, every, enabled, nonce])
  return { data: st.data, error: st.error, loading: st.loading, at: st.at, refresh: () => setNonce((n) => n + 1), extra: { http: st.http } }
}

function useFetch(url: string, options: Record<string, unknown> = {}) {
  const rt = useTile('useFetch')
  const body = options.body
  const headers: Record<string, string> = { ...((options.headers as Record<string, string>) ?? {}) }
  let bodyText: string | undefined
  if (body !== undefined && body !== null) {
    if (typeof body === 'string') bodyText = body
    else {
      bodyText = JSON.stringify(body)
      if (!Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json'
    }
  }
  const req = { url: String(url ?? ''), method: typeof options.method === 'string' ? options.method : undefined, headers, body: bodyText, as: options.as === 'json' || options.as === 'text' ? (options.as as 'json' | 'text') : undefined }
  const key = JSON.stringify(req)
  const r = usePoll<unknown>(
    'useFetch',
    req.url,
    key,
    everyOf(options.every),
    options.enabled !== false && !!req.url,
    async (id) => {
      const res = await rt.calls.fetch({ id, ...req })
      return { ok: res.ok, error: res.error, at: res.at, ms: res.ms, http: res.status, data: res.data }
    },
    (id) => rt.calls.abort(id)
  )
  return { data: r.data, error: r.error, loading: r.loading, status: r.extra.http ?? 0, at: r.at, refresh: r.refresh }
}

function useHandle(name: string, args: unknown[] = [], options: Record<string, unknown> = {}) {
  const rt = useTile('useHandle')
  const req = { name: String(name ?? ''), args: Array.isArray(args) ? args : [], player: typeof options.player === 'string' ? options.player : undefined }
  const logs = useRef<string[]>([])
  const r = usePoll<unknown>('useHandle', req.name, JSON.stringify(req), everyOf(options.every), !!req.name, async () => {
    const res = await rt.calls.handle(req)
    logs.current = res.logs ?? []
    return { ok: res.ok, error: res.error, at: res.at, ms: res.ms, data: res.value }
  })
  return { value: r.data, logs: logs.current, error: r.error, loading: r.loading, at: r.at, refresh: r.refresh }
}

function useGit(options: Record<string, unknown> = {}) {
  const rt = useTile('useGit')
  const req = { log: Number(options.log ?? 0) || 0, status: options.status !== false }
  const r = usePoll<DashboardGitResult>('useGit', `log ${req.log}${req.status ? ' + status' : ''}`, JSON.stringify(req), everyOf(options.every), true, async () => {
    const res = await rt.calls.git(req)
    return { ok: res.ok, error: res.error, at: res.at, data: res }
  })
  const d = r.data
  return {
    branch: d?.branch ?? null,
    ahead: d?.ahead ?? 0,
    behind: d?.behind ?? 0,
    changes: d?.changes ?? [],
    log: d?.log ?? [],
    error: r.error,
    loading: r.loading,
    at: r.at,
    refresh: r.refresh
  }
}

function useLogs(options: Record<string, unknown> = {}) {
  const rt = useTile('useLogs')
  const req = {
    source: options.source === 'app' ? ('app' as const) : ('unity' as const),
    grep: typeof options.grep === 'string' ? options.grep : undefined,
    tail: Number(options.tail ?? 100) || 100
  }
  const r = usePoll<string[]>('useLogs', `${req.source}${req.grep ? ` /${req.grep}/` : ''}`, JSON.stringify(req), everyOf(options.every), true, async () => {
    const res = await rt.calls.logs(req)
    return { ok: res.ok, error: res.error, at: res.at, data: res.lines }
  })
  return { lines: r.data ?? [], error: r.error, loading: r.loading, at: r.at, refresh: r.refresh }
}

function useFile(path: string, options: Record<string, unknown> = {}) {
  const rt = useTile('useFile')
  const as = options.as === 'json' || options.as === 'text' ? options.as : undefined
  const [version, setVersion] = useState(0)
  const [abs, setAbs] = useState('')
  const r = usePoll<unknown>('useFile', String(path ?? ''), `${path}\n${as ?? ''}\n${version}`, 0, !!path, async () => {
    const res = await rt.calls.file(String(path), as)
    setAbs(res.path)
    return { ok: res.ok, error: res.error, at: res.at, data: res.data }
  })
  useEffect(() => {
    if (!abs) return
    return rt.calls.watch(abs, () => setVersion((v) => v + 1))
  }, [abs, rt.calls])
  return { data: r.data, error: r.error, loading: r.loading, at: r.at }
}

function useSeries(key: string, value: number | null | undefined, options: { keep?: number } = {}): number[] {
  const rt = useTile('useSeries')
  const keep = Math.max(2, Math.min(10000, Math.round(Number(options.keep ?? 300)) || 300))
  const k = `${rt.widget}\n${key}`
  const [list, setList] = useState<number[]>(() => rt.series.get(k) ?? [])
  const last = useRef<{ tick: number; value: unknown }>({ tick: -1, value: undefined })
  useEffect(() => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return
    if (last.current.tick === rt.tick && last.current.value === value) return
    last.current = { tick: rt.tick, value }
    const next = [...(rt.series.get(k) ?? []), value].slice(-keep)
    rt.series.set(k, next)
    setList(next)
  }, [value, rt.tick, rt.series, k, keep])
  return list
}

function useStore<T>(key: string, initial: T): [T, (v: T | ((p: T) => T)) => void] {
  const rt = useTile('useStore')
  const [value, setValue] = useState<T>(() => (Object.prototype.hasOwnProperty.call(rt.state, key) ? (rt.state[key] as T) : initial))
  const set = (v: T | ((p: T) => T)): void =>
    setValue((prev) => {
      const next = typeof v === 'function' ? (v as (p: T) => T)(prev) : v
      rt.state[key] = next
      rt.calls.saveState(key, next)
      return next
    })
  return [value, set]
}

function useExec<T>(fn: string) {
  const rt = useTile('useExec')
  const plugin = rt.widget.startsWith('plugin.') ? rt.widget.slice(7) : ''
  const name = String(fn ?? '')
  const [st, setSt] = useState<{ value: T | undefined; error: string | undefined; running: boolean; at: number | undefined }>({ value: undefined, error: undefined, running: false, at: undefined })
  const slot = useRef<ReturnType<HookRegistry['add']> | null>(null)
  const { hooks, bump } = rt
  useEffect(() => {
    const s = hooks.add({ hook: 'useExec', target: name, status: 'ok' })
    slot.current = s
    return () => {
      s.remove()
      if (slot.current === s) slot.current = null
    }
  }, [hooks, name])
  const run = async (...args: unknown[]): Promise<T | undefined> => {
    const t0 = Date.now()
    setSt((s) => ({ ...s, running: true }))
    slot.current?.set({ status: 'loading' })
    try {
      if (!plugin) throw new Error('useExec works only in a plugin panel: it calls the functions in its exec.ts.')
      const value = (await rt.calls.exec(plugin, name, args)) as T
      const at = Date.now()
      setSt({ value, error: undefined, running: false, at })
      slot.current?.set({ status: 'ok', error: undefined, at, ms: at - t0 }, value)
      bump()
      return value
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e)
      const at = Date.now()
      setSt((s) => ({ ...s, error, running: false, at }))
      slot.current?.set({ status: 'error', error, at, ms: at - t0 })
      bump()
      return undefined
    }
  }
  return { run, value: st.value, error: st.error, running: st.running, at: st.at }
}

export const dashboardModule = Object.freeze({
  ...kit,
  useFetch,
  useSeries,
  useStore,
  useHandle,
  useGit,
  useLogs,
  useFile,
  useExec
})
