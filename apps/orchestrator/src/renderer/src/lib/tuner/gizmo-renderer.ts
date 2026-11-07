import { WebGLRenderer, type Camera, type Scene } from 'three'
import { noteLive } from './perf'

interface Shared {
  renderer: WebGLRenderer
  sized: string
  disposed: boolean
}

let shared: Shared | null = null
let users = 0
let failed = false

function drop(entry: Shared, lose: boolean): void {
  if (shared === entry) shared = null
  if (entry.disposed) return
  entry.disposed = true
  noteLive('webgl', -1)
  if (lose) entry.renderer.forceContextLoss()
  entry.renderer.dispose()
}

function renderer(): Shared | null {
  if (shared || failed) return shared
  try {
    const r = new WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: true })
    r.setClearColor(0x000000, 0)
    const entry: Shared = { renderer: r, sized: '', disposed: false }
    noteLive('webgl', 1)
    r.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault()
      drop(entry, false)
    })
    shared = entry
    return entry
  } catch {
    failed = true
    return null
  }
}

export function gizmoRenderAvailable(): boolean {
  return !failed
}

export function acquireGizmoRenderer(): void {
  users++
}

export function releaseGizmoRenderer(): void {
  users = Math.max(0, users - 1)
  if (users === 0 && shared) drop(shared, true)
}

export function renderGizmo(canvas: HTMLCanvasElement, scene: Scene, camera: Camera, under?: (ctx: CanvasRenderingContext2D) => void): void {
  if (users === 0) return
  const s = renderer()
  if (!s) return
  const r = s.renderer
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  if (w === 0 || h === 0) return
  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const pw = Math.round(w * dpr)
  const ph = Math.round(h * dpr)
  if (canvas.width !== pw || canvas.height !== ph) {
    canvas.width = pw
    canvas.height = ph
  }
  const key = `${w}x${h}@${dpr}`
  if (key !== s.sized) {
    s.sized = key
    r.setPixelRatio(dpr)
    r.setSize(w, h, false)
  }
  r.render(scene, camera)
  const ctx = canvas.getContext('2d')
  if (!ctx) return
  ctx.clearRect(0, 0, pw, ph)
  under?.(ctx)
  ctx.drawImage(r.domElement, 0, 0, pw, ph)
}
