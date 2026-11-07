import { Log, MP4BoxBuffer, createFile, type Movie } from 'mp4box'

export interface Coverage {
  ends: Float64Array
  times: Float64Array
}

const READ = 256 * 1024
const MOOV_LIMIT = 16 * 1024 * 1024

Log.setLogLevel(Log.error)

export function coverageOf(file: ReturnType<typeof createFile>, ids: number[]): Coverage[] {
  return ids.map((id) => {
    const samples = file.getTrackSamplesInfo(id)
    const ends = new Float64Array(samples.length)
    const times = new Float64Array(samples.length)
    let e = 0
    let t = 0
    samples.forEach((s, k) => {
      e = Math.max(e, s.offset + s.size)
      t = Math.max(t, (s.dts + s.duration) / s.timescale)
      ends[k] = e
      times[k] = t
    })
    return { ends, times }
  })
}

export function coveredBy(c: Coverage, bytes: number): number {
  let lo = 0
  let hi = c.ends.length - 1
  let best = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (c.ends[mid] <= bytes) {
      best = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return best < 0 ? 0 : c.times[best]
}

export async function videoCoverage(read: (start: number, end: number) => Promise<Uint8Array>, size: number): Promise<Coverage | null> {
  const file = createFile()
  let movie: Movie | null = null
  let failed = false
  file.onReady = (m: Movie) => {
    movie = m
  }
  file.onError = () => {
    failed = true
  }
  let pos = 0
  while (!movie && !failed && pos < size && pos < MOOV_LIMIT) {
    const end = Math.min(size, pos + READ)
    const data = await read(pos, end)
    if (!data.length) break
    const ab = data.byteOffset === 0 && data.byteLength === data.buffer.byteLength ? (data.buffer as ArrayBuffer) : (data.slice().buffer as ArrayBuffer)
    const next = file.appendBuffer(MP4BoxBuffer.fromArrayBuffer(ab, pos), false)
    pos = typeof next === 'number' && next > pos ? next : pos + data.length
    if (pos > MOOV_LIMIT) break
  }
  const found = movie as Movie | null
  const track = found?.tracks.find((t) => t.video)
  if (!found || !track) {
    file.stop()
    return null
  }
  const [c] = coverageOf(file, [track.id])
  file.stop()
  return c.ends.length ? c : null
}
