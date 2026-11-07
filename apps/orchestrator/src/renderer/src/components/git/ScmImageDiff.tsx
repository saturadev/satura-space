import { useEffect, useRef, useState, type CSSProperties } from 'react'
import type { ScmImageContent, ScmResult } from '@shared/git-scm'
import type { GitSide } from '../../lib/git/scm-resource'
import type { DiffRequest } from './ScmDiffEditor'
import { gitScmApi } from './use-scm-repository'

type Pane =
  | { readonly kind: 'image'; readonly url: string; readonly size: number }
  | { readonly kind: 'missing' }
  | { readonly kind: 'tooLarge'; readonly size: number }
  | { readonly kind: 'error'; readonly message: string; readonly detail?: string }

interface Loaded {
  readonly key: string
  readonly original: Pane
  readonly modified: Pane
}

const CHECKER_TILE = 'color-mix(in srgb, var(--ink) 7%, transparent)'

const CHECKERBOARD: CSSProperties = {
  backgroundImage: `conic-gradient(${CHECKER_TILE} 25%, transparent 0 50%, ${CHECKER_TILE} 0 75%, transparent 0)`,
  backgroundSize: '16px 16px'
}

export function formatSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / 1024 / 1024).toFixed(1)} MB`
}

async function loadPane(root: string, side: GitSide | undefined): Promise<Pane> {
  if (!side) return { kind: 'missing' }
  let result: ScmResult<ScmImageContent>
  try {
    result = await gitScmApi().showImage(root, side.path, side.ref)
  } catch (err) {
    return { kind: 'error', message: err instanceof Error ? err.message : String(err) }
  }
  if (!result.ok) {
    const detail = result.error.stderr?.trim()
    return detail ? { kind: 'error', message: result.error.message, detail } : { kind: 'error', message: result.error.message }
  }
  const content = result.value
  if (content.kind !== 'image') return content
  return { kind: 'image', url: `data:${content.mime};base64,${content.base64}`, size: content.size }
}

function samePane(a: Pane, b: Pane): boolean {
  if (a.kind === 'image' || b.kind === 'image') return a.kind === 'image' && b.kind === 'image' && a.url === b.url
  return JSON.stringify(a) === JSON.stringify(b)
}

function isShrunk(img: HTMLImageElement): boolean {
  return img.naturalWidth > 0 && img.clientWidth < img.naturalWidth
}

function ImagePane({ label, pane, missingText }: { label: string; pane: Pane | undefined; missingText: string }) {
  const imgRef = useRef<HTMLImageElement>(null)
  const [natural, setNatural] = useState<{ url: string; width: number; height: number } | null>(null)
  const [brokenUrl, setBrokenUrl] = useState<string | null>(null)
  const [shrunk, setShrunk] = useState(false)
  const image = pane?.kind === 'image' && pane.url !== brokenUrl ? pane : null
  const url = image?.url

  useEffect(() => {
    const img = imgRef.current
    if (!img) return
    const observer = new ResizeObserver(() => setShrunk(isShrunk(img)))
    observer.observe(img)
    return () => observer.disconnect()
  }, [url])

  const dims = natural && natural.url === url && natural.width > 0 ? natural : null
  const size = pane?.kind === 'image' || pane?.kind === 'tooLarge' ? pane.size : undefined

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <div className="flex h-[26px] shrink-0 items-center gap-3 border-b border-hairline bg-canvas px-3 text-xs">
        <span className="font-medium text-ink-2">{label}</span>
        {dims && <span className="tabular-nums text-ink-3">{dims.width}×{dims.height}</span>}
        {size !== undefined && <span className="tabular-nums text-ink-3">{formatSize(size)}</span>}
      </div>
      <div className="relative min-h-0 flex-1 bg-editor-surface" style={image ? CHECKERBOARD : undefined}>
        {image ? (
          <div className="absolute inset-3">
            <img
              ref={imgRef}
              src={image.url}
              alt=""
              draggable={false}
              className="absolute inset-0 m-auto max-h-full max-w-full object-contain"
              style={{ imageRendering: shrunk ? 'auto' : 'pixelated' }}
              onLoad={(e) => {
                const img = e.currentTarget
                setNatural({ url: image.url, width: img.naturalWidth, height: img.naturalHeight })
                setShrunk(isShrunk(img))
              }}
              onError={() => setBrokenUrl(image.url)}
            />
          </div>
        ) : pane ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-6 text-center text-sm text-ink-3">
            {pane.kind === 'missing' ? (
              <span className="text-ink-4">{missingText}</span>
            ) : pane.kind === 'tooLarge' ? (
              <span>Too large to preview ({formatSize(pane.size)})</span>
            ) : pane.kind === 'error' ? (
              <>
                <span>{pane.message}</span>
                {pane.detail && (
                  <span className="line-clamp-6 max-w-full whitespace-pre-wrap break-words font-mono text-[11px] text-ink-4">
                    {pane.detail}
                  </span>
                )}
              </>
            ) : (
              <span>Couldn't decode this image.</span>
            )}
          </div>
        ) : null}
      </div>
    </div>
  )
}

export function ScmImageDiff({ root, request, version }: { root: string; request: DiffRequest; version: number }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let cancelled = false
    const key = request.key
    void Promise.all([loadPane(root, request.sides.original), loadPane(root, request.sides.modified)]).then(
      ([original, modified]) => {
        if (cancelled) return
        setLoaded((prev) => {
          if (!prev || prev.key !== key) return { key, original, modified }
          const next = {
            key,
            original: samePane(prev.original, original) ? prev.original : original,
            modified: samePane(prev.modified, modified) ? prev.modified : modified
          }
          return next.original === prev.original && next.modified === prev.modified ? prev : next
        })
      }
    )
    return () => {
      cancelled = true
    }
  }, [root, request, version])

  const current = loaded?.key === request.key ? loaded : null

  return (
    <div className="flex h-full min-h-0">
      <ImagePane label="Before" pane={current?.original} missingText="Added" />
      <div className="w-px shrink-0 bg-hairline" />
      <ImagePane label="After" pane={current?.modified} missingText="Deleted" />
    </div>
  )
}
