import type { CacheSnapshot } from 'virtua'
import type { ReportLocation } from '@shared/report-link'
import type { MediaInfo } from '../../lib/media-loader'

export interface BlockPlace {
  count: number
  index: number
  within: number
  cache: CacheSnapshot | null
}

export interface ReportView {
  file: string
  scrollTop: number
  frames: Map<string, number>
  states: Map<string, unknown>
  blocks: BlockPlace | null
}

const views = new Map<string, ReportView>()

export function reportView(key: string, file: string): ReportView {
  const id = `${key}\n${file}`
  let v = views.get(id)
  if (v) views.delete(id)
  else v = { file, scrollTop: 0, frames: new Map(), states: new Map(), blocks: null }
  views.set(id, v)
  while (views.size > 60) views.delete(views.keys().next().value as string)
  return v
}

const imageSizes = new Map<string, number>()

type CacheNote = { kind: 'aspect'; key: string; value: number } | { kind: 'info'; key: string; value: MediaInfo }

const cacheListeners = new Set<(note: CacheNote) => void>()

export function onViewCacheNote(cb: (note: CacheNote) => void): () => void {
  cacheListeners.add(cb)
  return () => cacheListeners.delete(cb)
}

export function viewCaches(): { aspects: [string, number][]; infos: [string, MediaInfo][] } {
  return { aspects: [...imageSizes], infos: [...mediaInfos] }
}

export function seedViewCaches(aspects: [string, number][], infos: [string, MediaInfo][]): void {
  for (const [k, v] of aspects) if (!imageSizes.has(k)) imageSizes.set(k, v)
  for (const [k, v] of infos) if (!mediaInfos.has(k)) mediaInfos.set(k, v)
}

export function imageAspect(key: string): number | undefined {
  return imageSizes.get(key)
}

export function noteImageAspect(key: string, w: number, h: number): void {
  if (!w || !h) return
  imageSizes.delete(key)
  imageSizes.set(key, w / h)
  while (imageSizes.size > 500) imageSizes.delete(imageSizes.keys().next().value as string)
  for (const cb of cacheListeners) cb({ kind: 'aspect', key, value: w / h })
}

const mediaInfos = new Map<string, MediaInfo>()

export function knownMediaInfo(key: string): MediaInfo | undefined {
  return mediaInfos.get(key)
}

export function noteMediaInfo(key: string, info: MediaInfo): void {
  mediaInfos.delete(key)
  mediaInfos.set(key, info)
  for (const cb of cacheListeners) cb({ kind: 'info', key, value: info })
  noteImageAspect(key, info.width, info.height)
  while (mediaInfos.size > 500) mediaInfos.delete(mediaInfos.keys().next().value as string)
}

const pendingLocs = new Map<string, ReportLocation>()

export function holdReportLocation(file: string, loc: ReportLocation): void {
  pendingLocs.set(file, loc)
}

export function takeReportLocation(file: string): ReportLocation | null {
  const loc = pendingLocs.get(file)
  if (!loc) return null
  pendingLocs.delete(file)
  return loc
}
