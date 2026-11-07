import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactElement, type ReactNode } from 'react'
import { mediaLoader, type MediaInfo } from '../../lib/media-loader'
import { useRemoteLink } from '../../lib/remote-link'
import type { ReportApi } from './report-context'
import { knownMediaInfo, noteMediaInfo } from './report-view-state'
import { ProgressBar } from '../../remote/motion'

const mb = (n: number): string => (n / 1e6).toFixed(n < 1e7 ? 1 : 0)
export const percentOf = (p: { got: number; total: number }): number => (p.total > 0 ? Math.min(100, Math.floor((p.got / p.total) * 100)) : 0)

export function plainError(e: unknown): string {
  const text = (e instanceof Error ? e.message : String(e)).replace(/^E[A-Z]+:\s*/, '').replace(/,\s*\w+\s+'[^']*'$/, '').trim()
  return text ? `${text[0].toUpperCase()}${text.slice(1)}${/[.!?]$/.test(text) ? '' : '.'}` : ''
}

const nameOf = (paths: string[]): string => (paths.length > 1 ? `${paths.length} files` : paths[0]?.split('/').pop() ?? 'the file')

const PICTURE = /\.(png|jpe?g|gif|webp|avif|bmp|svg)$/i

function decoded(path: string, url: string): Promise<void> {
  if (!PICTURE.test(path) || typeof window.Image !== 'function') return Promise.resolve()
  const img = new window.Image()
  img.src = url
  return img.decode().catch(() => {})
}

export function MediaWait({
  style,
  label,
  progress,
  error,
  onRetry,
  setBox,
  state
}: {
  style?: CSSProperties
  label: string
  progress?: { got: number; total: number }
  error?: string
  onRetry?: () => void
  setBox?: (el: HTMLDivElement | null) => void
  state?: string
}): ReactElement {
  const link = useRemoteLink()
  const offline = link?.online === false
  let body: ReactNode
  if (offline) body = <span>Waiting for your desktop to reconnect</span>
  else if (error)
    body = (
      <>
        <span>{error}</span>
        {onRetry && (
          <button type="button" onClick={onRetry}>
            Try again
          </button>
        )}
      </>
    )
  else
    body = (
      <>
        <span>{label}</span>
        <ProgressBar value={progress && progress.total > 0 ? progress.got / progress.total : null} className="rk-media-bar" />
      </>
    )
  return (
    <div ref={setBox} className="rk-media-wait" style={style} data-media-wait={offline ? 'offline' : error ? 'error' : (state ?? 'load')} data-media-percent={progress && progress.total > 0 ? percentOf(progress) : undefined}>
      {body}
    </div>
  )
}

export interface MediaMeta {
  ready: boolean
  infos: (MediaInfo | null)[]
  error: string
  retry: () => void
}

function infoReader(api: ReportApi, video: boolean): ((path: string) => Promise<MediaInfo | null>) | null {
  const loader = api.host.mediaUrl ? null : mediaLoader()
  if (loader?.info) return (p) => loader.info!(p)
  const bridge = api.bridge
  if (video && !loader && bridge.mediaInfo) return (p) => bridge.mediaInfo!(api.host.file, api.host.root, p)
  return null
}

export function useMediaInfo(api: ReportApi, srcs: string[], video = false): MediaMeta {
  const read = useMemo(() => infoReader(api, video), [api, video])
  const key = srcs.join('\n')
  const paths = useMemo(() => (key ? key.split('\n').map((s) => api.path(s)) : []), [api, key])
  const cached = (): { ready: boolean; infos: (MediaInfo | null)[]; error: string } => {
    const infos = paths.map((p) => knownMediaInfo(p) ?? null)
    return { ready: !read || infos.every(Boolean), infos, error: '' }
  }
  const [state, setState] = useState(() => ({ key, ...cached() }))
  const [attempt, setAttempt] = useState(0)
  const link = useRemoteLink()
  const online = link?.online !== false
  useEffect(() => {
    if (!read || !paths.length) {
      setState({ key, ready: true, infos: paths.map(() => null), error: '' })
      return
    }
    setState((s) => (s.key === key && !s.error ? s : { key, ...cached() }))
    if (!online) return
    let alive = true
    const done = api.host.store.begin()
    let failed = ''
    void Promise.all(
      paths.map((p) =>
        read(p).then(
          (i) => {
            if (i) noteMediaInfo(p, i)
            return i
          },
          (e: unknown) => {
            failed ||= `Couldn't read ${p.split('/').pop()} on your desktop. ${plainError(e)}`
            return null
          }
        )
      )
    )
      .then((infos) => {
        if (alive) setState({ key, ready: !failed, infos, error: failed })
      })
      .finally(done)
    return () => {
      alive = false
      done()
    }
  }, [api, read, key, online, attempt])
  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { ...(state.key === key ? state : { key, ...cached() }), retry }
}

export function useStreamUrls(api: ReportApi, srcs: string[]): string[] | null {
  const loader = api.host.mediaUrl ? null : mediaLoader()
  const [, bump] = useState(0)
  useEffect(() => loader?.onStreamChange?.(() => bump((n) => n + 1)), [loader])
  if (!loader?.stream || !srcs.length) return null
  const urls = srcs.map((s) => api.streamUrl(s))
  return urls.every(Boolean) ? (urls as string[]) : null
}

export function useMediaGate(api: ReportApi, srcs: string[], box?: number | CSSProperties): ReactElement | null {
  const loader = api.host.mediaUrl ? null : mediaLoader()
  const paths = useMemo(() => (loader ? [...new Set(srcs.map((s) => api.path(s)))] : []), [api, loader, srcs.join('\n')])
  const allCached = (): boolean => !loader || paths.every((p) => !!loader.cached(p))
  const [state, setState] = useState<'wait' | 'load' | 'ready' | 'error'>(() => (allCached() ? 'ready' : 'wait'))
  const [progress, setProgress] = useState({ got: 0, total: 0 })
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [boxEl, setBoxEl] = useState<HTMLDivElement | null>(null)
  const link = useRemoteLink()
  const online = link?.online !== false

  useEffect(() => {
    if (online && state === 'error') setAttempt((n) => n + 1)
  }, [online])

  useEffect(() => {
    if (!loader) return
    const releases = paths.map((p) => loader.acquire(p))
    return () => releases.forEach((r) => r())
  }, [loader, paths])

  useEffect(() => {
    if (!loader) return
    if (allCached()) {
      setState('ready')
      return
    }
    setState((s) => (s === 'ready' ? 'wait' : s))
    if (!boxEl) return
    let alive = true
    let started = false
    const start = (): void => {
      if (started) return
      started = true
      setState('load')
      setProgress({ got: 0, total: 0 })
      const per = new Map<string, { got: number; total: number }>()
      const sum = (): void => {
        let got = 0
        let total = 0
        for (const v of per.values()) {
          got += v.got
          total += v.total
        }
        if (alive) setProgress({ got, total })
      }
      void Promise.all(
        paths.map((p) =>
          loader
            .load(p, (pr) => {
              per.set(p, pr)
              sum()
            })
            .then((url) => decoded(p, url))
        )
      ).then(
        () => alive && setState('ready'),
        (e: unknown) => {
          if (!alive) return
          setError(plainError(e))
          setState('error')
        }
      )
    }
    const root = boxEl.closest('.rk-host')
    let near = false
    let recheck = 0
    const hiddenBehindExpanded = (): boolean => !!boxEl.closest('[data-phone-expanding]') && !boxEl.closest('[data-phone-expanded]')
    const consider = (): void => {
      window.clearTimeout(recheck)
      if (!near || !alive) return
      if (hiddenBehindExpanded()) recheck = window.setTimeout(consider, 800)
      else start()
    }
    const io = new IntersectionObserver(
      (list) => {
        near = list[list.length - 1].isIntersecting
        consider()
      },
      { root: root instanceof HTMLElement ? root : null, rootMargin: '800px 0px' }
    )
    io.observe(boxEl)
    return () => {
      alive = false
      window.clearTimeout(recheck)
      io.disconnect()
    }
  }, [loader, paths, attempt, boxEl])

  if (!loader || state === 'ready') return null
  const name = nameOf(paths)
  const style = typeof box === 'object' ? box : { height: Math.max(120, Math.min(box ?? 240, 420)) }
  return (
    <MediaWait
      setBox={setBoxEl}
      style={style}
      state={state}
      label={state === 'load' && progress.total ? `Loading ${name} · ${percentOf(progress)}% of ${progress.total >= 1e6 ? `${mb(progress.total)} MB` : `${Math.max(1, Math.round(progress.total / 1024))} KB`}` : `Loading ${name}`}
      progress={state === 'load' ? progress : undefined}
      error={state === 'error' ? `Couldn't load ${name} from your desktop. ${error}` : undefined}
      onRetry={() => setAttempt((n) => n + 1)}
    />
  )
}
