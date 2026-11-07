import type { FileHandle } from 'node:fs/promises'
import type { RemoteMediaInfo } from '@shared/remote-protocol'
import { Log, MP4BoxBuffer, createFile, type Movie } from 'mp4box'
import { probeContainer } from './container-probe'

const PROBE_READ = 256 * 1024
const PROBE_LIMIT = 48 * 1024 * 1024
const IMAGE_HEAD = 512 * 1024

Log.setLogLevel(Log.error)

async function readAt(h: FileHandle, offset: number, length: number): Promise<Buffer> {
  const buf = Buffer.alloc(length)
  let got = 0
  while (got < length) {
    const { bytesRead } = await h.read(buf, got, length - got, offset + got)
    if (!bytesRead) break
    got += bytesRead
  }
  return got === length ? buf : buf.subarray(0, got)
}

export interface VideoProbe {
  video: string
  audio: string
  width: number
  height: number
  duration: number
  fps?: number
  bitrate: number
  faststart: boolean
}

const FPS_SAMPLES = 600

function frameRate(file: ReturnType<typeof createFile>, id: number, timescale: number): number | undefined {
  const samples = file.getTrackSamplesInfo(id)
  const n = Math.min(samples.length, FPS_SAMPLES)
  const steps: number[] = []
  for (let i = 1; i < n; i++) {
    const d = samples[i].dts - samples[i - 1].dts
    if (d > 0) steps.push(d)
  }
  if (!steps.length || !(timescale > 0)) return undefined
  steps.sort((a, b) => a - b)
  return Math.round((timescale / steps[Math.floor(steps.length / 2)]) * 1000) / 1000
}

async function readMovie(h: FileHandle, size: number): Promise<{ movie: Movie; file: ReturnType<typeof createFile> } | null> {
  const file = createFile()
  let movie: Movie | null = null
  let failed = false
  file.onReady = (m) => {
    movie = m
  }
  file.onError = () => {
    failed = true
  }
  let pos = 0
  let read = 0
  while (!movie && !failed && pos < size && read < PROBE_LIMIT) {
    const chunk = await readAt(h, pos, Math.min(PROBE_READ, size - pos))
    if (!chunk.length) break
    read += chunk.length
    const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.length), pos))
    pos = next > pos ? next : pos + chunk.length
  }
  if (!movie && !failed) file.flush()
  return movie ? { movie, file } : null
}

export async function probeVideo(h: FileHandle, size: number): Promise<VideoProbe | null> {
  const got = await readMovie(h, size)
  if (!got) return null
  const { movie, file } = got
  const track = movie.tracks.find((t) => !t.audio && t.track_width > 0 && t.track_height > 0)
  if (!track) return null
  const audio = movie.tracks.find((t) => t.audio)
  const duration = movie.timescale ? movie.duration / movie.timescale : track.timescale ? track.duration / track.timescale : 0
  const span = (track.samples_duration || track.duration) / (track.timescale || 1)
  const fps = frameRate(file, track.id, track.timescale) ?? (track.nb_samples > 1 && span > 0 ? Math.round((track.nb_samples / span) * 1000) / 1000 : undefined)
  return {
    video: track.codec,
    audio: audio?.codec ?? '',
    width: Math.round(track.track_width) || track.video?.width || 0,
    height: Math.round(track.track_height) || track.video?.height || 0,
    duration,
    ...(fps ? { fps } : {}),
    bitrate: duration > 0 ? (size * 8) / duration : 0,
    faststart: movie.isProgressive
  }
}

async function videoInfo(h: FileHandle, size: number, container = false): Promise<RemoteMediaInfo | null> {
  const p = container ? await probeContainer(h, size) : await probeVideo(h, size)
  if (!p || !p.width || !p.height) return null
  return { width: p.width, height: p.height, ...(p.fps ? { fps: p.fps } : {}), ...(p.duration ? { duration: p.duration } : {}), audio: !!p.audio, ...(p.video ? { codec: p.video } : {}) }
}

function tiffOrientation(b: Buffer, start: number, end: number): number {
  if (start + 8 > end) return 1
  const order = b.toString('latin1', start, start + 2)
  if (order !== 'II' && order !== 'MM') return 1
  const le = order === 'II'
  const u16 = (o: number): number => (le ? b.readUInt16LE(o) : b.readUInt16BE(o))
  const u32 = (o: number): number => (le ? b.readUInt32LE(o) : b.readUInt32BE(o))
  if (u16(start + 2) !== 42) return 1
  const ifd = start + u32(start + 4)
  if (ifd + 2 > end) return 1
  const count = u16(ifd)
  for (let i = 0; i < count; i++) {
    const e = ifd + 2 + i * 12
    if (e + 12 > end) break
    if (u16(e) !== 0x0112) continue
    const v = u16(e + 2) === 3 ? u16(e + 8) : 1
    return v >= 1 && v <= 8 ? v : 1
  }
  return 1
}

const EXIF_ID = 'Exif\0\0'

function oriented(info: RemoteMediaInfo, orientation: number): RemoteMediaInfo {
  return orientation >= 5 ? { width: info.height, height: info.width } : info
}

function jpegSize(b: Buffer): RemoteMediaInfo | null {
  let p = 2
  let size: RemoteMediaInfo | null = null
  let orientation = 0
  while (p + 3 < b.length) {
    if (b[p] !== 0xff) {
      p++
      continue
    }
    const m = b[p + 1]
    if (m === 0xff) {
      p++
      continue
    }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) {
      p += 2
      continue
    }
    if (m === 0xda || m === 0xd9) break
    const len = b.readUInt16BE(p + 2)
    if (!size && m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      if (p + 9 > b.length) break
      size = { width: b.readUInt16BE(p + 7), height: b.readUInt16BE(p + 5) }
    } else if (!orientation && m === 0xe1 && b.toString('latin1', p + 4, p + 10) === EXIF_ID) orientation = tiffOrientation(b, p + 10, Math.min(b.length, p + 2 + len))
    p += 2 + len
  }
  return size && oriented(size, orientation)
}

function pngOrientation(b: Buffer): number {
  let p = 8
  while (p + 8 <= b.length) {
    const len = b.readUInt32BE(p)
    const kind = b.toString('latin1', p + 4, p + 8)
    if (kind === 'IDAT' || kind === 'IEND') break
    if (kind === 'eXIf') return tiffOrientation(b, p + 8, Math.min(b.length, p + 8 + len))
    p += 12 + len
  }
  return 1
}

function imageSize(b: Buffer): RemoteMediaInfo | null {
  if (b.length >= 24 && b.readUInt32BE(0) === 0x89504e47) return oriented({ width: b.readUInt32BE(16), height: b.readUInt32BE(20) }, pngOrientation(b))
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'GIF') return { width: b.readUInt16LE(6), height: b.readUInt16LE(8) }
  if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8) return jpegSize(b)
  if (isWebp(b)) {
    const kind = b.toString('latin1', 12, 16)
    if (kind === 'VP8 ') return { width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff }
    if (kind === 'VP8L') {
      const bits = b.readUInt32LE(21)
      return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 }
    }
    if (kind === 'VP8X') return { width: b.readUIntLE(24, 3) + 1, height: b.readUIntLE(27, 3) + 1 }
  }
  if (isAvif(b)) return avifSize(b)
  return null
}

interface Box {
  type: string
  body: number
  end: number
}

function boxes(b: Buffer, start: number, end: number): Box[] {
  const out: Box[] = []
  let p = start
  while (p + 8 <= end) {
    let size = b.readUInt32BE(p)
    let body = p + 8
    if (size === 1) {
      if (p + 16 > end) break
      size = Number(b.readBigUInt64BE(p + 8))
      body = p + 16
    } else if (size === 0) size = end - p
    if (size < body - p || p + size > end) break
    out.push({ type: b.toString('latin1', p + 4, p + 8), body, end: p + size })
    p += size
  }
  return out
}

const AVIF_BRANDS = new Set(['avif', 'avis'])

function isAvif(b: Buffer): boolean {
  if (b.length < 16 || b.toString('latin1', 4, 8) !== 'ftyp') return false
  const end = Math.min(b.length, b.readUInt32BE(0))
  for (let p = 8; p + 4 <= end; p += 4) if (p !== 12 && AVIF_BRANDS.has(b.toString('latin1', p, p + 4))) return true
  return false
}

function avifProps(b: Buffer, ipma: Box, primary: number): number[] | null {
  const version = b[ipma.body]
  const wide = (b.readUIntBE(ipma.body + 1, 3) & 1) === 1
  let p = ipma.body + 4
  if (p + 4 > ipma.end) return null
  const count = b.readUInt32BE(p)
  p += 4
  for (let i = 0; i < count; i++) {
    const idLen = version < 1 ? 2 : 4
    if (p + idLen + 1 > ipma.end) return null
    const id = version < 1 ? b.readUInt16BE(p) : b.readUInt32BE(p)
    const n = b[p + idLen]
    p += idLen + 1
    if (p + n * (wide ? 2 : 1) > ipma.end) return null
    const list: number[] = []
    for (let k = 0; k < n; k++) list.push(wide ? b.readUInt16BE(p + k * 2) & 0x7fff : b[p + k] & 0x7f)
    p += n * (wide ? 2 : 1)
    if (primary < 0 || id === primary) return list
  }
  return null
}

function avifSize(b: Buffer): RemoteMediaInfo | null {
  const meta = boxes(b, 0, b.length).find((x) => x.type === 'meta')
  if (!meta) return null
  const kids = boxes(b, meta.body + 4, meta.end)
  const pitm = kids.find((x) => x.type === 'pitm')
  const iprp = kids.find((x) => x.type === 'iprp')
  if (!iprp) return null
  const parts = boxes(b, iprp.body, iprp.end)
  const ipco = parts.find((x) => x.type === 'ipco')
  const ipma = parts.find((x) => x.type === 'ipma')
  if (!ipco || !ipma) return null
  const idLen = pitm && b[pitm.body] < 1 ? 2 : 4
  const primary = pitm && pitm.body + 4 + idLen <= pitm.end ? b.readUIntBE(pitm.body + 4, idLen) : -1
  const props = boxes(b, ipco.body, ipco.end)
  let size: RemoteMediaInfo | null = null
  let turned = false
  for (const i of avifProps(b, ipma, primary) ?? []) {
    const prop = props[i - 1]
    if (prop?.type === 'ispe' && prop.body + 12 <= prop.end) size = { width: b.readUInt32BE(prop.body + 4), height: b.readUInt32BE(prop.body + 8) }
    else if (prop?.type === 'irot' && prop.body < prop.end) turned = (b[prop.body] & 1) === 1
  }
  return size && (turned ? { width: size.height, height: size.width } : size)
}

function isWebp(b: Buffer): boolean {
  return b.length >= 30 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'
}

const WEBP_EXIF_FLAG = 0x08
const WEBP_CHUNKS = 64
const EXIF_MAX = 64 * 1024

async function webpOrientation(h: FileHandle, size: number, head: Buffer): Promise<number> {
  if (head.toString('latin1', 12, 16) !== 'VP8X' || !(head[20] & WEBP_EXIF_FLAG)) return 1
  let p = 12
  for (let i = 0; i < WEBP_CHUNKS && p + 8 <= size; i++) {
    const chunk = await readAt(h, p, 8)
    if (chunk.length < 8) break
    const len = chunk.readUInt32LE(4)
    if (chunk.toString('latin1', 0, 4) === 'EXIF') {
      const data = await readAt(h, p + 8, Math.min(len, EXIF_MAX))
      const start = data.toString('latin1', 0, 6) === EXIF_ID ? 6 : 0
      return tiffOrientation(data, start, data.length)
    }
    p += 8 + len + (len & 1)
  }
  return 1
}

export async function mediaInfo(h: FileHandle, size: number, type: string): Promise<RemoteMediaInfo | null> {
  try {
    if (type === 'video/mp4' || type === 'video/quicktime') return await videoInfo(h, size)
    if (type === 'video/webm' || type === 'video/x-matroska') return await videoInfo(h, size, true)
    if (type.startsWith('image/') && type !== 'image/svg+xml') {
      const head = await readAt(h, 0, Math.min(size, IMAGE_HEAD))
      const info = imageSize(head)
      if (!info || !(info.width > 0 && info.height > 0)) return null
      if (!isWebp(head)) return info
      const turned = oriented(info, await webpOrientation(h, size, head))
      return turned === info ? info : { ...turned, exifTurned: true }
    }
  } catch {
    return null
  }
  return null
}
