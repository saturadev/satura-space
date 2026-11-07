import { useEffect, useState } from 'react'

const listeners = new Set<() => void>()
let zoom = 1

export function viewerZoom(): number {
  return zoom
}

export function setViewerZoom(next: number): void {
  const z = Math.round(Math.min(3, Math.max(0.5, next)) * 100) / 100
  if (z === zoom) return
  zoom = z
  for (const l of listeners) l()
}

export function useViewerZoom(): number {
  const [z, setZ] = useState(zoom)
  useEffect(() => {
    const l = (): void => setZ(zoom)
    listeners.add(l)
    l()
    return () => {
      listeners.delete(l)
    }
  }, [])
  return z
}
