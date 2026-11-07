import { useEffect, useRef } from 'react'
import type { RemoteRenditionId } from '@shared/remote-protocol'
import { mediaLoader } from '../../lib/media-loader'

const nameOf = (path: string): string => path.split('/').pop() || 'the video'

function drop(path: string, rendition: RemoteRenditionId, why: string): void {
  const loader = mediaLoader()
  if (!loader?.plan) return
  console.info(`[media] ${nameOf(path)} lets the Mac drop its queued ${rendition}p version: ${why} without playing`)
  loader.plan(path, false, { rendition, drop: true }).catch(() => {})
}

export function useDropWhenAway(el: HTMLElement | null, path: string, rendition: RemoteRenditionId | null, onAway: () => void): void {
  const live = useRef({ rendition, onAway })
  live.current = { rendition, onAway }
  useEffect(() => {
    if (!el || !rendition) return
    const root = el.closest('.rk-host')
    let seen = false
    const io = new IntersectionObserver(
      (list) => {
        if (list[list.length - 1].isIntersecting) {
          seen = true
          return
        }
        if (!seen) return
        drop(path, rendition, 'the card scrolled away')
        live.current.onAway()
      },
      { root: root instanceof HTMLElement ? root : null }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [el, path, rendition])
  useEffect(
    () => () => {
      const r = live.current.rendition
      if (r) drop(path, r, 'the report closed')
    },
    [path]
  )
}
