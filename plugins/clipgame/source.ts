import { cp, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { MainPlugin } from '@satura/plugin'
import { ClipError, ensureRemotion, ensureYtDlp, run, toolsPaths, type Remotion, type Report } from './tools'

export const CLIP_DIR = 'ClipToGame'
export const SOURCE_DIR = `${CLIP_DIR}/source`
export const GUIDE = 'Packages/com.saturaspace.engine/Documentation~/agent-guide/clipgame.md'

const MAX_SECONDS = 180
const FRAME_SIDE = 768
const JOB = /^[A-Za-z0-9-]{1,64}$/

export interface Frame {
  file: string
  at: number
}

export interface SourceMeta {
  url: string
  site: string
  id: string
  title: string
  description: string
  hashtags: string[]
  author: string
  credit: string
  duration: number
  width: number
  height: number
  file: string
  frames: Frame[]
  captions: { lang: string; cues: { at: number; text: string }[] } | null
  fetched: string
}

interface YtMeta {
  _type?: string
  entries?: YtMeta[]
  id?: string
  title?: string
  description?: string
  uploader?: string
  uploader_id?: string
  channel?: string
  extractor_key?: string
  webpage_url_domain?: string
  duration?: number
  language?: string
  tags?: string[]
  subtitles?: Record<string, { ext?: string; url?: string }[]>
  automatic_captions?: Record<string, { ext?: string; url?: string }[]>
}

export function jobDir(p: MainPlugin, job: string): string {
  if (!JOB.test(job)) throw new ClipError('That job id is not valid.', 'bad-job')
  return join(p.cacheDir, 'jobs', job)
}

export function parseUrl(raw: unknown): string {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) throw new ClipError('Paste a link to a video.', 'bad-link')
  let u: URL
  try {
    u = new URL(text)
  } catch {
    throw new ClipError('That is not a link. Paste the full address of the video, starting with https://.', 'bad-link')
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ClipError('Only http and https links work.', 'bad-link')
  return u.toString()
}

function explain(err: string): ClipError {
  const line = err.split('\n').map((l) => l.trim()).filter((l) => /^ERROR/i.test(l)).pop() ?? err.trim().split('\n').pop() ?? ''
  const short = line.replace(/^ERROR:\s*/i, '').replace(/\[[^\]]+\]\s*/, '').slice(0, 240)
  if (/unsupported url/i.test(line)) return new ClipError('That link is not a video page. Paste the link of the video post itself.', 'unsupported')
  if (/private|log ?in|sign in|cookies|authenticat|age-restricted|confirm your age|members|requested content is not available|rate-limit|login required/i.test(line)) {
    return new ClipError(`That video needs a login or is private, so it cannot be read. Try a public link. (${short})`, 'private')
  }
  if (/not available in your country|geo/i.test(line)) return new ClipError('That video is not available in your country.', 'geo')
  if (/404|not found|unavailable|removed|deleted|does not exist|no video|there is no video/i.test(line)) return new ClipError(`That video is gone or the link is wrong. (${short})`, 'gone')
  if (/unable to extract|nsig|403|unable to download webpage|extractor/i.test(line)) return new ClipError(`No video could be read from that link. Use the link of a single public video post. If it is one, the site may have changed, so try again later. (${short})`, 'extract')
  if (/temporary failure|name or service|timed out|connection|network/i.test(line)) return new ClipError('Could not reach the site. Check the internet connection and try again.', 'network')
  return new ClipError(`Could not read that video: ${short || 'the downloader gave no reason'}`, 'yt')
}

async function ytRun(p: MainPlugin, report: Report, signal: AbortSignal | undefined, rem: Remotion | null, args: string[], onLine?: (l: string) => void) {
  const attempt = async (refresh: boolean) => {
    const bin = await ensureYtDlp(p, report, signal, refresh)
    const common = ['--ignore-config', '--no-playlist', '--playlist-items', '1', '--no-warnings', '--socket-timeout', '20', '--retries', '3', '--cache-dir', toolsPaths(p).cache]
    const ff = rem ? ['--ffmpeg-location', rem.ytFfmpeg, '--js-runtimes', `node:${rem.node}`] : []
    return run(bin, [...common, ...ff, ...args], { signal, onLine, env: rem?.env })
  }
  let r = await attempt(false)
  if (r.code !== 0 && explain(r.err).code === 'extract') {
    p.log('yt-dlp failed with an extractor error, updating it and retrying once')
    r = await attempt(true)
  }
  if (r.code !== 0) throw explain(r.err)
  return r
}

function handleOf(meta: YtMeta): string {
  const id = (meta.uploader_id ?? '').replace(/^@/, '')
  if (id && /^[\w.-]+$/.test(id) && !/^\d+$/.test(id)) return `@${id}`
  const name = (meta.uploader ?? meta.channel ?? '').trim()
  return name ? (name.startsWith('@') ? name : `@${name.replace(/\s+/g, '')}`) : ''
}

function pickCaptions(meta: YtMeta): { lang: string; url: string } | null {
  const pools: [Record<string, { ext?: string; url?: string }[]> | undefined, boolean][] = [[meta.subtitles, true], [meta.automatic_captions, false]]
  for (const [pool, manual] of pools) {
    if (!pool) continue
    const keys = Object.keys(pool).filter((k) => k !== 'live_chat')
    const key = keys.find((k) => k === meta.language) ?? keys.find((k) => /^en($|-)/.test(k)) ?? keys.find((k) => k.endsWith('-orig')) ?? (manual ? keys[0] : undefined)
    if (!key) continue
    const entry = pool[key]?.find((e) => (e.ext === 'vtt' || e.ext === 'srt' || e.ext === 'webvtt') && e.url)
    if (entry?.url) return { lang: key, url: entry.url }
  }
  return null
}

function clock(text: string): number {
  const parts = text.replace(',', '.').split(':').map(Number)
  return parts.reduce((acc, n) => acc * 60 + n, 0)
}

function parseCues(text: string): { at: number; text: string }[] {
  const cues: { at: number; text: string }[] = []
  for (const block of text.replace(/\r/g, '').split(/\n\n+/)) {
    const lines = block.split('\n')
    const i = lines.findIndex((l) => l.includes('-->'))
    if (i < 0) continue
    const at = clock(lines[i].split('-->')[0].trim())
    const body = lines.slice(i + 1).map((l) => l.replace(/<[^>]+>/g, '').trim()).filter(Boolean).join(' ')
    if (!Number.isFinite(at) || !body) continue
    if (cues[cues.length - 1]?.text === body) continue
    cues.push({ at: Math.round(at * 10) / 10, text: body })
  }
  return cues.slice(0, 400)
}

async function fetchCaptions(meta: YtMeta, ua: string, signal: AbortSignal | undefined): Promise<SourceMeta['captions']> {
  const pick = pickCaptions(meta)
  if (!pick) return null
  try {
    const res = await fetch(pick.url, { headers: { 'User-Agent': ua }, signal })
    if (!res.ok) return null
    const cues = parseCues(await res.text())
    return cues.length ? { lang: pick.lang, cues } : null
  } catch {
    return null
  }
}

interface Probe {
  duration: number
  width: number
  height: number
}

async function probe(rem: Remotion, file: string): Promise<Probe> {
  const r = await run(rem.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { cwd: rem.ffmpegDir, env: rem.env })
  if (r.code !== 0) throw new ClipError('The downloaded file is not a video that can be read.', 'probe')
  const j = JSON.parse(r.out) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number; duration?: string; side_data_list?: { rotation?: number }[]; tags?: { rotate?: string } }[] }
  const v = j.streams?.find((s) => s.codec_type === 'video')
  if (!v?.width || !v.height) throw new ClipError('The downloaded file has no picture.', 'probe')
  const rot = Math.abs(Number(v.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation ?? v.tags?.rotate ?? 0)) % 180
  const duration = Number(j.format?.duration ?? v.duration ?? 0)
  return { duration, width: rot === 90 ? v.height : v.width, height: rot === 90 ? v.width : v.height }
}

async function extractFrames(rem: Remotion, file: string, dir: string, duration: number, report: Report, signal: AbortSignal | undefined): Promise<Frame[]> {
  const count = Math.max(8, Math.min(24, Math.round(duration * 1.5)))
  const frames: Frame[] = []
  for (let i = 0; i < count; i++) {
    const at = Math.round(duration * ((i + 0.5) / count) * 10) / 10
    frames.push({ file: `frames/frame-${String(i + 1).padStart(2, '0')}-at-${at.toFixed(1)}s.jpg`, at })
  }
  await mkdir(join(dir, 'frames'), { recursive: true })
  let done = 0
  const queue = [...frames]
  const worker = async (): Promise<void> => {
    for (let f = queue.shift(); f; f = queue.shift()) {
      const r = await run(rem.ffmpeg, ['-v', 'error', '-y', '-ss', String(f.at), '-i', file, '-frames:v', '1', '-vf', `scale='if(gt(iw,ih),${FRAME_SIDE},-2)':'if(gt(iw,ih),-2,${FRAME_SIDE})'`, '-q:v', '3', join(dir, f.file)], { cwd: rem.ffmpegDir, env: rem.env, signal })
      if (r.code !== 0 || !existsSync(join(dir, f.file))) throw new ClipError(`Could not cut a frame out of the video. ${r.err.trim().split('\n').pop() ?? ''}`.trim(), 'frames')
      done += 1
      report('frames', 'Cutting the video into frames…', Math.round((done / frames.length) * 100))
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()])
  return frames
}

function briefText(m: SourceMeta): string {
  const orient = m.height > m.width ? 'portrait' : m.height < m.width ? 'landscape' : 'square'
  const lines = [
    '# Source clip',
    '',
    `- Link: ${m.url}`,
    `- Site: ${m.site}`,
    `- Author: ${m.author || 'unknown'}`,
    `- Length: ${m.duration.toFixed(1)} s, ${m.width}x${m.height} (${orient})`,
    `- Video file: ${SOURCE_DIR}/${m.file}`,
    `- Title: ${m.title || '(none)'}`,
    `- Description: ${m.description.replace(/\s+/g, ' ').trim().slice(0, 600) || '(none)'}`,
    `- Hashtags: ${m.hashtags.length ? m.hashtags.map((t) => `#${t}`).join(' ') : '(none)'}`,
    '',
    '## Frames',
    '',
    `Open every frame in order with your image viewer. Each one is a moment of the clip, ${m.frames.length} in all, evenly spaced. They are in ${SOURCE_DIR}/.`,
    '',
    ...m.frames.map((f) => `- ${f.at.toFixed(1)} s: ${SOURCE_DIR}/${f.file}`),
    '',
    '## Speech and captions',
    ''
  ]
  if (m.captions) {
    lines.push(`Captions the site published (${m.captions.lang}):`, '', ...m.captions.cues.map((c) => `- ${c.at.toFixed(1)} s: ${c.text}`))
  } else {
    lines.push('The site published no captions. Nobody transcribed the audio, so read any on-screen text from the frames.')
  }
  lines.push('', '## Next', '', `Follow ${GUIDE}. Make a game that plays like this clip: the same camera, the same core action, the same threat and mood. Use your own names, characters and art, and never copy another game's assets, even if the clip shows one.`, '')
  return lines.join('\n')
}

export async function cleanOldJobs(p: MainPlugin): Promise<void> {
  const root = join(p.cacheDir, 'jobs')
  for (const name of await readdir(root).catch(() => [] as string[])) {
    const info = await stat(join(root, name)).catch(() => null)
    if (info && Date.now() - info.mtimeMs > 24 * 3600_000) await rm(join(root, name), { recursive: true, force: true })
  }
}

export async function fetchSource(p: MainPlugin, o: { url: string; job: string; signal?: AbortSignal; report: Report }): Promise<SourceMeta> {
  const { url, job, signal, report } = o
  const dir = join(jobDir(p, job), 'source')
  await cleanOldJobs(p)
  await rm(join(jobDir(p, job)), { recursive: true, force: true })
  await mkdir(dir, { recursive: true })
  report('meta', 'Reading the link…')
  const found = await ytRun(p, report, signal, null, ['-J', '--', url])
  let meta: YtMeta
  try {
    meta = JSON.parse(found.out) as YtMeta
  } catch {
    throw new ClipError('The downloader returned something unreadable for that link.', 'yt')
  }
  if (meta._type === 'playlist') meta = meta.entries?.find(Boolean) ?? meta
  if (typeof meta.duration === 'number' && meta.duration > MAX_SECONDS) throw new ClipError(`That video is ${Math.round(meta.duration)} s long. Clips up to ${MAX_SECONDS / 60} minutes work.`, 'too-long')
  const rem = await ensureRemotion(p, report, signal)
  report('download', 'Downloading the video…', 0)
  const format = 'bv*[height<=1080][vcodec^=avc1]+ba[acodec^=mp4a]/b[height<=1080][vcodec^=avc1]/bv*[height<=1080]+ba/b[height<=1080]/b'
  await ytRun(p, report, signal, rem, ['-f', format, '--merge-output-format', 'mp4', '--newline', '-o', join(dir, 'clip.%(ext)s'), '--', url], (line) => {
    const pct = /^\[download\]\s+(\d+(?:\.\d+)?)%/.exec(line)?.[1]
    if (pct) report('download', 'Downloading the video…', Math.round(Number(pct)))
  })
  const made = (await readdir(dir)).filter((n) => /^clip\.(mp4|mov|webm|mkv|m4v)$/i.test(n))
  const clip = made.find((n) => n.toLowerCase().endsWith('.mp4')) ?? made[0]
  if (!clip) throw new ClipError('The download finished but no video file came out.', 'yt')
  const file = join(dir, clip)
  const info = await probe(rem, file)
  if (info.duration > MAX_SECONDS + 5) throw new ClipError(`That video is ${Math.round(info.duration)} s long. Clips up to ${MAX_SECONDS / 60} minutes work.`, 'too-long')
  const frames = await extractFrames(rem, file, dir, info.duration, report, signal)
  const description = meta.description ?? ''
  const tags = [...new Set([...(meta.tags ?? []), ...(description.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((t) => t.slice(1))])].slice(0, 20)
  const author = handleOf(meta)
  const result: SourceMeta = {
    url,
    site: meta.extractor_key || meta.webpage_url_domain || new URL(url).hostname,
    id: meta.id ?? '',
    title: meta.title ?? '',
    description,
    hashtags: tags,
    author,
    credit: author ? `Inspired by ${author}` : '',
    duration: Math.round(info.duration * 10) / 10,
    width: info.width,
    height: info.height,
    file: clip,
    frames,
    captions: await fetchCaptions(meta, `SaturaSpace/${p.appVersion}`, signal),
    fetched: new Date().toISOString()
  }
  await writeFile(join(dir, 'meta.json'), JSON.stringify(result, null, 2))
  await writeFile(join(dir, 'brief.md'), briefText(result))
  report('done', 'Video ready.', 100)
  return result
}

export async function attachSource(p: MainPlugin, job: string, projectRoot: string): Promise<{ dir: string }> {
  const from = join(jobDir(p, job), 'source')
  if (!existsSync(join(from, 'meta.json'))) throw new ClipError('That video is no longer in the cache. Paste the link again.', 'gone')
  if (!projectRoot || !existsSync(projectRoot)) throw new ClipError('The project folder does not exist.', 'no-project')
  const to = join(projectRoot, CLIP_DIR, 'source')
  await rm(to, { recursive: true, force: true })
  await mkdir(join(projectRoot, CLIP_DIR), { recursive: true })
  await cp(from, to, { recursive: true })
  await rm(jobDir(p, job), { recursive: true, force: true })
  return { dir: to }
}
