import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { handle } from '../mock/api'
import interRegular from '../fixtures/fonts/Inter-Regular.woff2?url'
import interSemiBold from '../fixtures/fonts/Inter-SemiBold.woff2?url'
import robotoMono from '../fixtures/fonts/RobotoMono-Regular.woff2?url'

let fontsInstalled = false

export function serveUnityFonts(): void {
  if (fontsInstalled) return
  fontsInstalled = true
  const files: [string, string][] = [
    ['Inter-Regular', interRegular],
    ['Inter-SemiBold', interSemiBold],
    ['Inter-Small', interRegular],
    ['RobotoMono-Regular', robotoMono]
  ]
  handle('tunerInspector', 'fonts', () =>
    Promise.all(
      files.map(async ([name, url]) => ({ name, data: new Uint8Array(await (await fetch(url)).arrayBuffer()) }))
    )
  )
}

export interface FitBox {
  zoom: number
  width: number
  height: number
}

export function Fit({
  minWidth,
  minHeight,
  maxZoom = 1.3,
  children,
  className = ''
}: {
  minWidth: number
  minHeight: number
  maxZoom?: number
  children: (box: FitBox) => ReactNode
  className?: string
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [size, setSize] = useState<{ w: number; h: number } | null>(null)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const read = (): void => setSize({ w: el.offsetWidth, h: el.offsetHeight })
    read()
    const ro = new ResizeObserver(read)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])
  const zoom = size ? Math.min(maxZoom, size.w / minWidth, size.h / minHeight) : 1
  const box = size ? { zoom, width: Math.floor(size.w / zoom), height: Math.floor(size.h / zoom) } : null
  return (
    <div ref={ref} className={`absolute inset-0 overflow-hidden ${className}`}>
      {box && (
        <div className="relative origin-top-left" style={{ width: box.width, height: box.height, zoom: box.zoom }}>
          {children(box)}
        </div>
      )}
    </div>
  )
}
