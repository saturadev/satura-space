import { useEffect, useRef, useState } from 'react'
import type { ResourceSnapshot } from '@shared/api'

export function useResourceSnapshot(open: boolean): {
  snapshot: ResourceSnapshot | null
  refresh: () => void
} {
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const refresh = useRef(() => {})
  refresh.current = (): void => {
    void window.api.resources.getSnapshot().then((s) => {
      if (mounted.current) setSnapshot(s)
    })
  }

  useEffect(() => {
    if (open) refresh.current()
    const t = setInterval(
      () => {
        if (!document.hidden) refresh.current()
      },
      open ? 2000 : 8000
    )
    return () => clearInterval(t)
  }, [open])

  useEffect(() => {
    refresh.current()
    const onVisible = (): void => {
      if (!document.hidden) refresh.current()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [])

  return { snapshot, refresh: () => refresh.current() }
}
