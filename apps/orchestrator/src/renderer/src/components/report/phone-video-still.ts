import { useEffect, useState } from 'react'
import type { RemoteVideoStill } from '@shared/remote-protocol'
import { mediaLoader } from '../../lib/media-loader'

const STILLS_KEPT = 200
const asks = new Map<string, Promise<RemoteVideoStill>>()
const known = new Map<string, RemoteVideoStill>()

const nameOf = (path: string): string => path.split('/').pop() || 'the video'

function askStill(path: string): Promise<RemoteVideoStill> | null {
  const loader = mediaLoader()
  if (!loader?.still) return null
  let p = asks.get(path)
  if (!p) {
    p = loader.still(path).then(
      (s) => {
        known.set(path, s)
        if (known.size > STILLS_KEPT) known.delete(known.keys().next().value as string)
        return s
      },
      (e: unknown) => {
        asks.delete(path)
        throw e
      }
    )
    asks.set(path, p)
    if (asks.size > STILLS_KEPT) asks.delete(asks.keys().next().value as string)
  }
  return p
}

function cachedStill(path: string): string | null {
  const s = known.get(path)
  return s ? (mediaLoader()?.cached(s.path) ?? null) : null
}

export function useVideoStill(path: string, near: boolean): string | null {
  const [url, setUrl] = useState<string | null>(() => cachedStill(path))
  useEffect(() => {
    setUrl(cachedStill(path))
    const loader = mediaLoader()
    const ask = near ? askStill(path) : null
    if (!ask || !loader) return
    let alive = true
    let release: (() => void) | null = null
    ask
      .then((s) => {
        if (!alive) return
        release = loader.acquire(s.path)
        const hit = loader.cached(s.path)
        if (hit) return setUrl(hit)
        const started = performance.now()
        return loader.load(s.path).then((u) => {
          if (!alive) return
          console.info(`[media] ${nameOf(path)} shows its first frame until play (${s.width}x${s.height}, ${Math.round(s.bytes / 1024)} KB in ${Math.round(performance.now() - started)} ms)`)
          setUrl(u)
        })
      })
      .catch((e: unknown) => console.info(`[media] ${nameOf(path)} has no first frame still: ${e instanceof Error ? e.message : String(e)}`))
    return () => {
      alive = false
      release?.()
    }
  }, [path, near])
  return url
}
