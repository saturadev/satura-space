import type { TiTexture } from '@shared/tuner-inspector'
import { parseHex, type Rgba } from './model'

export interface TexEntry {
  id: number
  w: number
  h: number
  sc: number
  name?: string
  checker?: boolean
  url?: string
  solid?: Rgba | null
}

function decode(b64: string): Uint8Array {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export const THEMED_CHECKER = 'conic-gradient(var(--elevated) 25%, var(--sunken) 0 50%, var(--elevated) 0 75%, var(--sunken) 0)'

export function isGrey(c: Rgba): boolean {
  return Math.abs(c.r - c.g) < 0.01 && Math.abs(c.g - c.b) < 0.01
}

export class TextureStore {
  private readonly map = new Map<number, TexEntry>()
  private readonly tints = new Map<string, string>()
  private readonly pending = new Set<string>()
  private readonly listeners = new Set<() => void>()
  private readonly urls = new Set<string>()
  private disposed = false
  private gen = 0
  version = 0

  subscribe = (cb: () => void): (() => void) => {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }

  getVersion = (): number => this.version

  private bump(): void {
    this.version++
    for (const l of this.listeners) l()
  }

  add(list: TiTexture[]): void {
    if (!list.length || this.disposed) return
    for (const t of list) {
      const prev = this.map.get(t.id)
      if (prev?.url) {
        URL.revokeObjectURL(prev.url)
        this.urls.delete(prev.url)
        this.dropTints(t.id)
      }
      const e: TexEntry = { id: t.id, w: t.w, h: t.h, sc: t.sc && t.sc > 0 ? t.sc : 1, name: t.n, checker: t.chk === 1 }
      if (t.solid) e.solid = parseHex(t.solid)
      else if (t.png) {
        const bytes = decode(t.png)
        e.url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'image/png' }))
        this.urls.add(e.url)
      }
      this.map.set(t.id, e)
    }
    this.bump()
  }

  private dropTints(id: number): void {
    const prefix = `${id}|`
    for (const [key, url] of this.tints) {
      if (!key.startsWith(prefix)) continue
      URL.revokeObjectURL(url)
      this.tints.delete(key)
    }
  }

  get(id: number | undefined): TexEntry | undefined {
    return id === undefined || id < 0 ? undefined : this.map.get(id)
  }

  clear(): void {
    for (const u of this.urls) URL.revokeObjectURL(u)
    for (const u of this.tints.values()) URL.revokeObjectURL(u)
    this.gen++
    this.urls.clear()
    this.map.clear()
    this.tints.clear()
    this.pending.clear()
    this.bump()
  }

  dispose(): void {
    this.disposed = true
    this.clear()
    this.listeners.clear()
  }

  tinted(tex: TexEntry, tint: Rgba): string | undefined {
    if (!tex.url) return undefined
    const key = `${tex.id}|${tint.r.toFixed(3)},${tint.g.toFixed(3)},${tint.b.toFixed(3)}`
    const hit = this.tints.get(key)
    if (hit) return hit
    if (!this.pending.has(key)) {
      this.pending.add(key)
      void this.makeTint(tex, tint, key)
    }
    return undefined
  }

  private async makeTint(tex: TexEntry, tint: Rgba, key: string): Promise<void> {
    const gen = this.gen
    try {
      const img = new Image()
      img.src = tex.url as string
      await img.decode()
      const canvas = document.createElement('canvas')
      canvas.width = img.naturalWidth
      canvas.height = img.naturalHeight
      const ctx = canvas.getContext('2d')
      if (!ctx) return
      ctx.drawImage(img, 0, 0)
      ctx.globalCompositeOperation = 'multiply'
      const k = (v: number): number => Math.round(Math.max(0, Math.min(1, v)) * 255)
      ctx.fillStyle = `rgb(${k(tint.r)},${k(tint.g)},${k(tint.b)})`
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.globalCompositeOperation = 'destination-in'
      ctx.drawImage(img, 0, 0)
      const blob = await new Promise<Blob | null>((r) => canvas.toBlob(r, 'image/png'))
      if (!blob || this.disposed || gen !== this.gen || this.map.get(tex.id) !== tex || this.tints.has(key)) return
      this.tints.set(key, URL.createObjectURL(blob))
      this.bump()
    } catch {
    } finally {
      if (gen === this.gen) this.pending.delete(key)
    }
  }
}

const loadedFontDirs = new Set<string>()

export function unityFontFamily(fontName: string | undefined): string {
  if (fontName && /mono/i.test(fontName)) return "'UnityMono', ui-monospace, Menlo, monospace"
  return "'UnityInter', Inter, system-ui, -apple-system, 'Segoe UI', sans-serif"
}

export function ensureUnityFonts(fontDir: string | undefined): void {
  if (!fontDir || loadedFontDirs.has(fontDir)) return
  loadedFontDirs.add(fontDir)
  void window.api.tunerInspector
    .fonts(fontDir)
    .then((fonts) => {
      for (const f of fonts) {
        const bold = /SemiBold|Bold/.test(f.name)
        const italic = /Italic/.test(f.name)
        const family = /RobotoMono/.test(f.name) ? 'UnityMono' : /Small/.test(f.name) ? 'UnityInterSmall' : 'UnityInter'
        try {
          const face = new FontFace(family, f.data.slice().buffer as ArrayBuffer, { weight: bold ? '600' : '400', style: italic ? 'italic' : 'normal' })
          document.fonts.add(face)
          void face.load().catch(() => {})
        } catch {
        }
      }
    })
    .catch(() => loadedFontDirs.delete(fontDir))
}
