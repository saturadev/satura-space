import { ipcRenderer } from 'electron'
import { open, writeFile, type FileHandle } from 'node:fs/promises'
import { ALL_FORMATS, CanvasSink, Conversion, CustomSource, Input, Mp4OutputFormat, Output, StreamTarget, canEncodeAudio, type StreamTargetChunk } from 'mediabunny'

interface Start {
  id: number
  src: string
  out: string
  width?: number
  height?: number
  bitrate?: number
  fastStart?: 'in-memory' | false
}

interface Still {
  id: number
  src: string
  out: string
  max: number
}

const STILL_QUALITY = 0.82

const MAX_W = 1920
const MAX_H = 1080
const FULL_HD_BITRATE = 8e6
const MIN_BITRATE = 1.5e6
const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

function fileSource(h: FileHandle, size: number): CustomSource {
  return new CustomSource({
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
}

function fileTarget(h: FileHandle): StreamTarget {
  return new StreamTarget(
    new WritableStream<StreamTargetChunk>({
      write: async (chunk) => {
        await h.write(chunk.data, 0, chunk.data.length, chunk.position)
      }
    }),
    { chunked: true }
  )
}

async function convert({ id, src, out, fastStart = false, ...size }: Start): Promise<void> {
  let input: Input | null = null
  const handles: FileHandle[] = []
  try {
    const reader = await open(src, 'r')
    handles.push(reader)
    const writer = await open(out, 'w')
    handles.push(writer)
    input = new Input({ source: fileSource(reader, (await reader.stat()).size), formats: ALL_FORMATS })
    const audioCodec = (await canEncodeAudio('aac')) ? 'aac' : (await canEncodeAudio('opus')) ? 'opus' : null
    const output = new Output({ format: new Mp4OutputFormat({ fastStart }), target: fileTarget(writer) })
    const conversion = await Conversion.init({
      input,
      output,
      video: (track) => {
        const scale = Math.min(1, MAX_W / track.displayWidth, MAX_H / track.displayHeight)
        const width = size.width ?? even(track.displayWidth * scale)
        const height = size.height ?? even(track.displayHeight * scale)
        return {
          codec: 'avc',
          width,
          height,
          fit: 'fill',
          bitrate: size.bitrate ?? Math.round(Math.max(MIN_BITRATE, (FULL_HD_BITRATE * width * height) / (MAX_W * MAX_H))),
          hardwareAcceleration: 'prefer-hardware',
          forceTranscode: true
        }
      },
      audio: audioCodec ? { codec: audioCodec, bitrate: 128e3 } : { discard: true },
      showWarnings: false
    })
    const lost = conversion.discardedTracks.find((t) => t.track.type === 'video')
    if (lost) throw new Error(`video track: ${lost.reason.replace(/_/g, ' ')}`)
    if (!conversion.isValid) throw new Error(conversion.discardedTracks.map((t) => `${t.track.type} track: ${t.reason.replace(/_/g, ' ')}`).join(', ') || 'nothing to convert')
    let last = 0
    conversion.onProgress = (progress) => {
      if (progress - last < 0.01 && progress < 1) return
      last = progress
      ipcRenderer.send('phone-convert:progress', { id, progress })
    }
    await conversion.execute()
    ipcRenderer.send('phone-convert:done', { id, audio: audioCodec })
  } catch (e) {
    ipcRenderer.send('phone-convert:done', { id, error: e instanceof Error ? e.message : String(e) })
  } finally {
    input?.dispose()
    for (const h of handles) await h.close().catch(() => {})
  }
}

async function still({ id, src, out, max }: Still): Promise<void> {
  let input: Input | null = null
  let reader: FileHandle | null = null
  try {
    reader = await open(src, 'r')
    input = new Input({ source: fileSource(reader, (await reader.stat()).size), formats: ALL_FORMATS })
    const track = await input.getPrimaryVideoTrack()
    if (!track) throw new Error('no video track')
    if (!(await track.canDecode())) throw new Error(`WebCodecs can't decode ${track.codec ?? 'the video'} on this computer`)
    const scale = Math.min(1, max / Math.max(track.displayWidth, track.displayHeight))
    const width = Math.max(2, Math.round(track.displayWidth * scale))
    const height = Math.max(2, Math.round(track.displayHeight * scale))
    const frame = await new CanvasSink(track, { width, height, fit: 'fill' }).getCanvas(await track.getFirstTimestamp())
    if (!frame) throw new Error('no first frame')
    const c = frame.canvas
    const blob =
      c instanceof HTMLCanvasElement
        ? await new Promise<Blob | null>((resolve) => c.toBlob(resolve, 'image/jpeg', STILL_QUALITY))
        : await c.convertToBlob({ type: 'image/jpeg', quality: STILL_QUALITY })
    if (!blob) throw new Error('the still did not encode')
    await writeFile(out, new Uint8Array(await blob.arrayBuffer()))
    ipcRenderer.send('phone-convert:done', { id, width, height })
  } catch (e) {
    ipcRenderer.send('phone-convert:done', { id, error: e instanceof Error ? e.message : String(e) })
  } finally {
    input?.dispose()
    await reader?.close().catch(() => {})
  }
}

ipcRenderer.on('phone-convert:start', (_e, m: Start) => void convert(m))
ipcRenderer.on('phone-convert:still', (_e, m: Still) => void still(m))
