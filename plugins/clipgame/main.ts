import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MainPlugin, PluginCtx } from '@satura/plugin'
import { attachSource, fetchSource, parseUrl, SOURCE_DIR } from './source'
import { renderVideo, type RenderOptions } from './render'
import { ClipError, toolStatus } from './tools'

export default function setup(p: MainPlugin): void {
  const running = new Map<string, AbortController>()

  const reporter = (job: string) => (stage: string, text: string, percent?: number): void => {
    p.emit('progress', { job, stage, text, percent: percent ?? null })
  }

  async function fetchClip(ctx: PluginCtx, params: Record<string, unknown>): Promise<unknown> {
    const url = parseUrl(params.url)
    const job = typeof params.job === 'string' && params.job ? params.job : `job-${Date.now()}`
    if (running.has(job)) throw new ClipError('That video is already being prepared.', 'busy')
    const abort = new AbortController()
    running.set(job, abort)
    ctx.signal?.addEventListener('abort', () => abort.abort())
    try {
      const meta = await fetchSource(p, { url, job, signal: abort.signal, report: reporter(job) })
      const placed = ctx.projectRoot ? (await attachSource(p, job, ctx.projectRoot)).dir : null
      ctx.log(`${meta.site} ${meta.id}: ${meta.duration}s ${meta.width}x${meta.height}, ${meta.frames.length} frames, captions ${meta.captions ? meta.captions.lang : 'none'}`)
      return { job, title: meta.title, author: meta.author, credit: meta.credit, site: meta.site, duration: meta.duration, width: meta.width, height: meta.height, frames: meta.frames.length, captions: !!meta.captions, placed }
    } finally {
      running.delete(job)
    }
  }

  async function render(ctx: PluginCtx, options: RenderOptions): Promise<unknown> {
    const abort = new AbortController()
    ctx.signal?.addEventListener('abort', () => abort.abort())
    const r = await renderVideo(p, ctx.projectRoot, options ?? ({} as RenderOptions), reporter('render'), abort.signal)
    ctx.log(`rendered ${r.path}: ${r.seconds}s ${r.width}x${r.height}, ${r.bytes} bytes`)
    return r
  }

  async function info(ctx: PluginCtx): Promise<unknown> {
    const text = await readFile(join(ctx.projectRoot, SOURCE_DIR, 'meta.json'), 'utf8').catch(() => null)
    if (!text) throw new ClipError(`There is no source clip in this project (${SOURCE_DIR}/meta.json is missing).`, 'no-source')
    return JSON.parse(text)
  }

  p.exec('info', info)
  p.exec('render', (ctx, options) => render(ctx, options))

  p.handle({
    name: 'fetch',
    long: true,
    description: "Downloads a short video from a link with yt-dlp (TikTok, Instagram Reels, YouTube Shorts, X, Facebook, Reddit, Vimeo, a direct .mp4 link: anything yt-dlp reads), cuts it into evenly spaced frames and writes clip, frames, meta.json and brief.md. job names the run. With a project open they land in <project>/ClipToGame/source/; without one they wait in the plugin cache for clipgame.attach. The first run downloads yt-dlp and installs the Remotion tools (needs Node 18+ on the machine). Returns title, author, credit, site, duration, size, frame count, whether captions were found, and placed.",
    params: { url: '', job: '' },
    run: (params, ctx) => fetchClip(ctx, params)
  })
  p.handle({
    name: 'attach',
    description: "Moves a video prepared by clipgame.fetch (its job id) from the plugin cache into <project>/ClipToGame/source/ of the project, replacing what was there.",
    params: { job: '' },
    run: async (params, ctx) => attachSource(p, String(params.job), ctx.projectRoot)
  })
  p.handle({
    name: 'cancel',
    description: 'Stops a running clipgame.fetch by its job id. Returns whether one was running.',
    params: { job: '' },
    run: async (params) => {
      const abort = running.get(String(params.job))
      abort?.abort()
      return { cancelled: !!abort }
    }
  })
  p.handle({
    name: 'render',
    long: true,
    description: "Renders the project's source clip next to a gameplay video into <project>/ClipToGame/clip-vs-game.mp4 with Remotion, the way clipgame.render() does in satura_exec. gameplay is the recorded video's path in the project. Options: title (headline), credit (default 'Inspired by @author'), layout ('side' 1920x1080 or 'stack' 1080x1920), sound ('none', 'game' or 'clip'), endCard (default true), out. Returns path, seconds, width, height, bytes.",
    params: { gameplay: '', title: '', credit: '', layout: 'side', sound: 'none', endCard: true, out: '' },
    run: (params, ctx) =>
      render(ctx, { gameplay: String(params.gameplay), title: String(params.title || ''), credit: params.credit ? String(params.credit) : undefined, layout: String(params.layout), sound: String(params.sound), endCard: params.endCard !== false, out: params.out ? String(params.out) : undefined })
  })
  p.handle({
    name: 'info',
    description: "Returns the project's ClipToGame/source/meta.json: link, site, author, credit, duration, size, frame list and captions.",
    params: {},
    run: (_params, ctx) => info(ctx)
  })
  p.handle({
    name: 'tools',
    description: 'Shows what the plugin has installed: the Node version it found, the yt-dlp copy in the plugin cache and the Remotion tools folder.',
    params: {},
    run: () => toolStatus(p)
  })
}
