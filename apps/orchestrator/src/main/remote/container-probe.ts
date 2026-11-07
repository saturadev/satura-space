import type { FileHandle } from 'node:fs/promises'
import type { VideoProbe } from './media-info'

const STATS_PACKETS = 120

export async function probeContainer(h: FileHandle, size: number): Promise<VideoProbe | null> {
  const { ALL_FORMATS, CustomSource, Input } = await import('mediabunny')
  const input = new Input({
    formats: ALL_FORMATS,
    source: new CustomSource({
      getSize: () => size,
      read: async (start, end) => {
        const buf = new Uint8Array(end - start)
        let got = 0
        while (got < buf.length) {
          const { bytesRead } = await h.read(buf, got, buf.length - got, start + got)
          if (!bytesRead) break
          got += bytesRead
        }
        return got === buf.length ? buf : buf.subarray(0, got)
      },
      prefetchProfile: 'fileSystem'
    })
  })
  try {
    const video = await input.getPrimaryVideoTrack()
    if (!video || !(video.displayWidth > 0) || !(video.displayHeight > 0)) return null
    const audio = await input.getPrimaryAudioTrack()
    const duration = await input.computeDuration()
    const stats = await video.computePacketStats(STATS_PACKETS)
    const fps = stats.averagePacketRate > 0 ? Math.round(stats.averagePacketRate * 1000) / 1000 : 0
    return {
      video: (await video.getCodecParameterString()) ?? video.codec ?? '',
      audio: audio ? ((await audio.getCodecParameterString()) ?? audio.codec ?? '') : '',
      width: video.displayWidth,
      height: video.displayHeight,
      duration,
      ...(fps ? { fps } : {}),
      bitrate: duration > 0 ? (size * 8) / duration : stats.averageBitrate,
      faststart: true
    }
  } finally {
    input.dispose()
  }
}
