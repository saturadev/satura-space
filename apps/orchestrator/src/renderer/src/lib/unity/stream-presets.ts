import {
  DEFAULT_STREAM_SIZE,
  MAX_SAVED_RESOLUTIONS,
  sameSize,
  type PixelSize,
  type SavedStreamResolution
} from '@shared/unity/stream-size'

export interface ResolutionPreset extends PixelSize {
  name: string
}

export interface ResolutionGroup {
  title: string
  presets: readonly ResolutionPreset[]
}

const p = (width: number, height: number, name: string): ResolutionPreset => ({ width, height, name })

export const DEFAULT_PRESET: ResolutionPreset = { ...DEFAULT_STREAM_SIZE, name: '1080p' }

export const PRESET_GROUPS: readonly ResolutionGroup[] = [
  {
    title: 'Desktop',
    presets: [
      p(1280, 720, '720p'),
      p(1600, 900, 'HD+'),
      p(2560, 1440, '1440p'),
      p(3840, 2160, '4K'),
      p(2560, 1080, 'Ultrawide'),
      p(1920, 1200, 'WUXGA'),
      p(1024, 768, 'XGA')
    ]
  },
  {
    title: 'Phone & tablet',
    presets: [
      p(1170, 2532, 'iPhone 13–15'),
      p(1179, 2556, 'iPhone 15/16 Pro'),
      p(1080, 2400, 'Android'),
      p(1080, 1920, 'Older phones'),
      p(1640, 2360, 'iPad Air'),
      p(1536, 2048, 'iPad')
    ]
  }
]

const KNOWN_RATIOS: ReadonlyArray<readonly [number, number]> = [
  [16, 9],
  [16, 10],
  [4, 3],
  [21, 9],
  [19.5, 9],
  [20, 9],
  [3, 2],
  [1, 1]
]

const gcd = (a: number, b: number): number => {
  while (b) [a, b] = [b, a % b]
  return a
}

export function ratioLabel(size: PixelSize): string {
  const r = size.width / size.height
  for (const [x, y] of KNOWN_RATIOS) {
    if (Math.abs(r / (x / y) - 1) < 0.025) return `${x}:${y}`
    if (Math.abs(r / (y / x) - 1) < 0.025) return `${y}:${x}`
  }
  const g = gcd(size.width, size.height)
  const a = size.width / g
  const b = size.height / g
  if (a <= 32 && b <= 32) return `${a}:${b}`
  return r >= 1 ? `${r.toFixed(2)}:1` : `1:${(1 / r).toFixed(2)}`
}

export function findPreset(size: PixelSize): ResolutionPreset | null {
  if (sameSize(size, DEFAULT_PRESET)) return DEFAULT_PRESET
  for (const g of PRESET_GROUPS) {
    const hit = g.presets.find((q) => sameSize(q, size))
    if (hit) return hit
  }
  return null
}

export function findSaved(list: readonly SavedStreamResolution[], size: PixelSize): SavedStreamResolution | null {
  return list.find((c) => sameSize(c, size)) ?? null
}

export function upsertSaved(
  list: readonly SavedStreamResolution[],
  entry: SavedStreamResolution
): SavedStreamResolution[] {
  const at = list.findIndex((c) => sameSize(c, entry))
  if (at >= 0) {
    const next = [...list]
    next[at] = entry
    return next
  }
  return [...list, entry].slice(-MAX_SAVED_RESOLUTIONS)
}

export function removeSaved(list: readonly SavedStreamResolution[], size: PixelSize): SavedStreamResolution[] {
  return list.filter((c) => !sameSize(c, size))
}
