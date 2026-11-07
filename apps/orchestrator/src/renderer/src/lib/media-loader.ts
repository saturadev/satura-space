import type { RemoteMediaReport, RemoteRenditionId, RemoteVideoPlan, RemoteVideoStill } from '@shared/remote-protocol'

export interface MediaProgress {
  got: number
  total: number
}

export interface MediaInfo {
  width: number
  height: number
  fps?: number
  duration?: number
  audio?: boolean
  codec?: string
}

export type MediaTier = 'best' | '1080' | '720' | '480' | 'phone'

export const MEDIA_TIERS: MediaTier[] = ['best', '1080', '720', '480', 'phone']

export interface MediaTag {
  of: string
  q: MediaTier
}

export interface MediaHeld {
  path: string
  q: MediaTier
  bytes: number
  size: number
}

export interface MediaSaveAsk {
  path: string
  name: string
  kind: 'video' | 'image'
  tag?: MediaTag
}

export interface MediaSaved {
  saved: boolean
  how?: 'share' | 'download' | 'file'
  file?: string
  bytes?: number
}

export interface MediaScope {
  report?: RemoteMediaReport
  signal?: AbortSignal
  ahead?: number
  progress?: (got: number, total: number) => void
  tag?: MediaTag
}

export interface MediaRange {
  size: number
  type: string
  data: Uint8Array
}

export interface MediaDownloaded {
  size: number
  type: string
}

export interface MediaLoader {
  cached(path: string): string | null
  load(path: string, onProgress?: (p: MediaProgress) => void, scope?: MediaScope): Promise<string>
  acquire(path: string): () => void
  info?(path: string, scope?: MediaScope): Promise<MediaInfo | null>
  read?(path: string, offset: number, length: number, scope?: MediaScope): Promise<MediaRange>
  download?(path: string, onProgress?: (p: MediaProgress) => void, scope?: MediaScope): Promise<MediaDownloaded>
  saved?(path: string, scope?: MediaScope): Promise<MediaProgress | null>
  stop?(path: string, why: string): void
  note?(line: string): void
  stream?(path: string): string | null
  onStreamChange?(cb: () => void): () => void
  plan?(path: string, prepare: boolean, want?: { rendition?: RemoteRenditionId; urgent?: boolean; drop?: boolean }, scope?: MediaScope): Promise<RemoteVideoPlan>
  still?(path: string, scope?: MediaScope): Promise<RemoteVideoStill>
  onStreamError?(cb: (path: string, error: string) => void): () => void
  held?(of: string, scope?: MediaScope): Promise<MediaHeld[]>
  save?(ask: MediaSaveAsk, onProgress?: (p: MediaProgress) => void, scope?: MediaScope): Promise<MediaSaved>
}

let current: MediaLoader | null = null
const heldListeners = new Set<() => void>()

export function noteHeldChange(): void {
  for (const l of [...heldListeners]) l()
}

export function onHeldChange(cb: () => void): () => void {
  heldListeners.add(cb)
  return () => heldListeners.delete(cb)
}

export function setMediaLoader(loader: MediaLoader | null): void {
  current = loader
}

export function mediaLoader(): MediaLoader | null {
  return current
}
