import type { RemoteRenditionId } from '@shared/remote-protocol'

export type VideoQuality = 'auto' | 'original' | RemoteRenditionId

export const qualityName = (q: VideoQuality): string => (q === 'auto' ? 'Auto' : q === 'original' ? 'Best' : `${q}p`)
