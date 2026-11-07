export interface PixelSize {
  width: number
  height: number
}

export interface SavedStreamResolution {
  width: number
  height: number
  name: string
}

export interface StreamResolutionsFile {
  version: 1
  resolutions: SavedStreamResolution[]
}

export const MIN_STREAM_DIM = 64
export const MAX_STREAM_DIM = 3840
export const DEFAULT_STREAM_SIZE: PixelSize = { width: 1920, height: 1080 }
export const DEFAULT_PANE: PixelSize = { width: 960, height: 540 }

export const STREAM_RESOLUTIONS_FILE = 'stream-resolutions.json'
export const MAX_SAVED_RESOLUTIONS = 24
export const MAX_RESOLUTION_NAME = 40

const SIZE_RE = /^(\d+)\s*[x×]\s*(\d+)$/i

export function isStreamDim(n: number): boolean {
  return Number.isInteger(n) && n >= MIN_STREAM_DIM && n <= MAX_STREAM_DIM
}

export function parseSize(raw: string): PixelSize | null {
  const m = SIZE_RE.exec((raw ?? '').trim())
  if (!m) return null
  const width = Number(m[1])
  const height = Number(m[2])
  return isStreamDim(width) && isStreamDim(height) ? { width, height } : null
}

export function formatSize(size: PixelSize): string {
  return `${size.width}x${size.height}`
}

export const DEFAULT_STREAM_RES = formatSize(DEFAULT_STREAM_SIZE)

export function normalizeStreamRes(raw: string): string | null {
  const size = parseSize(raw)
  return size ? formatSize(size) : null
}

export function streamSizeFor(res: string): PixelSize {
  return parseSize(res) ?? DEFAULT_STREAM_SIZE
}

export function paneRenderSize(cssWidth: number, cssHeight: number, dpr: number): PixelSize {
  const f = dpr > 0 ? dpr : 1
  return {
    width: Math.max(1, Math.round(cssWidth * f)),
    height: Math.max(1, Math.round(cssHeight * f))
  }
}

export function sameSize(a: PixelSize, b: PixelSize): boolean {
  return a.width === b.width && a.height === b.height
}

export function normalizeSavedResolutions(raw: unknown): SavedStreamResolution[] {
  if (!Array.isArray(raw)) return []
  const out: SavedStreamResolution[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const o = item as Record<string, unknown>
    const width = Number(o.width)
    const height = Number(o.height)
    if (!isStreamDim(width) || !isStreamDim(height)) continue
    const key = formatSize({ width, height })
    if (seen.has(key)) continue
    seen.add(key)
    const name = typeof o.name === 'string' ? o.name.trim().replace(/\s+/g, ' ').slice(0, MAX_RESOLUTION_NAME) : ''
    out.push({ width, height, name })
    if (out.length >= MAX_SAVED_RESOLUTIONS) break
  }
  return out
}

export function parseStreamResolutionsFile(raw: string): SavedStreamResolution[] {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return []
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) return []
  return normalizeSavedResolutions((data as Record<string, unknown>).resolutions)
}

export function toStreamResolutionsFile(resolutions: readonly SavedStreamResolution[]): StreamResolutionsFile {
  return { version: 1, resolutions: normalizeSavedResolutions(resolutions) }
}
