import { Suspense, lazy, useEffect, useState } from 'react'
import type { CodeFileResult } from '@shared/report-code'
import { mediaLoader } from '../../lib/media-loader'
import { ImagePanZoom } from '../workbench/ImagePanZoom'
import { Fullscreen } from './Fullscreen'
import { MediaWait, percentOf, plainError } from './media-gate'
import { SaveMedia, type SaveVia } from './save-media'

const CodeText = lazy(() => import('./code-text'))

export type ReadCode = (file: string, root: string | undefined, rel: string) => Promise<CodeFileResult>

const appReadCode: ReadCode = (file, root, rel) => window.api.app.reportReadCode(file, root, rel)

export interface ImageHint {
  path?: string
  size?: { w: number; h: number }
}

export type Overlay =
  | ({ kind: 'image'; url: string; alt: string; gallery?: ImageGallery } & ImageHint)
  | { kind: 'code'; ref: string; line?: number; endLine?: number }

export interface ImageGallery {
  items: ({ url: string; alt: string } & ImageHint)[]
  index: number
  onIndex?: (i: number) => void
}

function CodeView({
  file,
  root,
  target,
  read,
  onPick
}: {
  file: string
  root: string
  target: { ref: string; line?: number; endLine?: number }
  read: ReadCode
  onPick: (rel: string) => void
}) {
  const [res, setRes] = useState<CodeFileResult | null>(null)
  useEffect(() => {
    let alive = true
    setRes(null)
    void read(file, root || undefined, target.ref).then(
      (r) => alive && setRes(r),
      () => alive && setRes({ ok: false, error: 'missing' })
    )
    return () => {
      alive = false
    }
  }, [file, root, target.ref, read])
  if (!res) return <div className="rk-ov-empty">Opening {target.ref}…</div>
  if (!res.ok) {
    if (res.error === 'ambiguous')
      return (
        <div className="rk-ov-pick" data-code-candidates>
          <p>Several files match {target.ref}. Pick one:</p>
          {(res.candidates ?? []).map((c) => (
            <button key={c} type="button" className="rk-cref" onClick={() => onPick(c)}>
              {c}
            </button>
          ))}
        </div>
      )
    if (res.error === 'too-large') return <div className="rk-ov-empty">{res.rel} is too large to show here.</div>
    return <div className="rk-ov-empty">{target.ref} isn't in this project.</div>
  }
  return (
    <Suspense fallback={<div className="rk-ov-empty">Opening {res.rel}…</div>}>
      <div className="rk-ov-code" data-code-view={res.rel} data-code-line={target.line ?? ''}>
        <CodeText path={res.path} rel={res.rel} text={res.text} root={root} line={target.line} endLine={target.endLine} />
      </div>
    </Suspense>
  )
}

function OverlayImage({ url, path, size, alt, onSwipe }: { url: string; path?: string; size?: { w: number; h: number }; alt: string; onSwipe?: (dir: 1 | -1) => void }) {
  const loader = path ? mediaLoader() : null
  const known = (): string => url || (path ? (loader?.cached(path) ?? '') : '')
  const [state, setState] = useState(() => ({ url: known(), got: 0, total: 0, error: '' }))
  const [shown, setShown] = useState<'wait' | 'ok' | 'error'>(() => (size && known() ? 'ok' : 'wait'))
  const [attempt, setAttempt] = useState(0)
  useEffect(() => {
    const release = loader && path ? loader.acquire(path) : null
    const hit = known()
    if (hit) {
      setState({ url: hit, got: 0, total: 0, error: '' })
      return () => release?.()
    }
    if (!loader || !path) {
      setState({ url: '', got: 0, total: 0, error: 'The report gave no file for it.' })
      return () => release?.()
    }
    let alive = true
    setState({ url: '', got: 0, total: 0, error: '' })
    loader
      .load(path, (p) => alive && setState((s) => ({ ...s, got: p.got, total: p.total })))
      .then(
        (u) => alive && setState((s) => ({ ...s, url: u })),
        (e: unknown) => alive && setState((s) => ({ ...s, error: plainError(e) }))
      )
    return () => {
      alive = false
      release?.()
    }
  }, [url, path, attempt])
  const name = path?.split('/').pop() ?? alt ?? 'the image'
  const progress = { got: state.got, total: state.total }
  const retry = (): void => {
    setShown('wait')
    setAttempt((n) => n + 1)
  }
  const wait =
    state.error || shown === 'error' ? (
      <MediaWait
        style={{ position: 'absolute', inset: 0, borderRadius: 0 }}
        label=""
        error={state.error ? `Couldn't load ${name}${loader ? ' from your desktop' : ''}. ${state.error}` : `Couldn't show ${name}.`}
        onRetry={retry}
      />
    ) : !state.url || shown === 'wait' ? (
      <MediaWait
        style={{ position: 'absolute', inset: 0, borderRadius: 0, background: 'transparent' }}
        label={state.total ? `Loading ${name} · ${percentOf(progress)}%` : `Loading ${name}`}
        progress={state.total ? progress : undefined}
      />
    ) : null
  return (
    <>
      {state.url && !state.error && (
        <ImagePanZoom
          key={`${state.url}#${attempt}`}
          src={state.url}
          alt={alt}
          size={size}
          onSwipe={onSwipe}
          onShown={(ok) => {
            setShown(ok ? 'ok' : 'error')
            console.info(`[report] full screen ${name}: ${ok ? 'shown' : 'failed to show'}`)
          }}
        />
      )}
      {wait}
    </>
  )
}

export function ReportOverlay({
  overlay,
  file,
  root,
  onClose,
  onChange,
  read = appReadCode,
  save
}: {
  overlay: Overlay
  file: string
  root: string
  onClose: () => void
  onChange: (o: Overlay) => void
  read?: ReadCode
  save?: SaveVia
}) {
  const gallery = overlay.kind === 'image' && overlay.gallery && overlay.gallery.items.length > 1 ? overlay.gallery : null
  const step = (d: number): void => {
    if (!gallery) return
    const n = gallery.items.length
    const i = (((gallery.index + d) % n) + n) % n
    const item = gallery.items[i]
    gallery.onIndex?.(i)
    onChange({ kind: 'image', url: item.url, alt: item.alt, path: item.path, size: item.size, gallery: { ...gallery, index: i } })
  }
  const stepRef = { current: step }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (gallery && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
        e.preventDefault()
        e.stopPropagation()
        stepRef.current(e.key === 'ArrowRight' ? 1 : -1)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  })
  const title =
    overlay.kind === 'image'
      ? `${gallery ? `${gallery.index + 1} / ${gallery.items.length} · ` : ''}${overlay.alt}`
      : `${overlay.ref}${overlay.line ? `:${overlay.line}${overlay.endLine && overlay.endLine > overlay.line ? `-${overlay.endLine}` : ''}` : ''}`
  return (
    <Fullscreen
      kind={overlay.kind}
      title={<span title={title}>{title}</span>}
      tools={overlay.kind === 'image' && overlay.path ? <SaveMedia key={overlay.path} via={save} ask={{ path: overlay.path, name: overlay.path.split('/').pop() || 'picture', kind: 'image' }} /> : undefined}
      onClose={onClose}
    >
      {overlay.kind === 'image' ? (
        <>
          <OverlayImage key={overlay.path ?? overlay.url} url={overlay.url} path={overlay.path} size={overlay.size} alt={overlay.alt} onSwipe={gallery ? step : undefined} />
          {gallery && (
            <>
              <button type="button" className="rk-carousel-nav prev" aria-label="Previous image (←)" title="Previous (←)" onClick={() => step(-1)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M15 6l-6 6 6 6" /></svg>
              </button>
              <button type="button" className="rk-carousel-nav next" aria-label="Next image (→)" title="Next (→)" onClick={() => step(1)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.4} strokeLinecap="round" strokeLinejoin="round"><path d="M9 6l6 6-6 6" /></svg>
              </button>
            </>
          )}
        </>
      ) : (
        <CodeView
          file={file}
          root={root}
          target={overlay}
          read={read}
          onPick={(rel) => onChange({ kind: 'code', ref: rel, line: overlay.line, endLine: overlay.endLine })}
        />
      )}
    </Fullscreen>
  )
}
