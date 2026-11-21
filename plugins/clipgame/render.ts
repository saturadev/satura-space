import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'
import type { MainPlugin } from '@satura/plugin'
import { CLIP_DIR, SOURCE_DIR, type SourceMeta } from './source'
import { ClipError, ensureRemotion, run, type Remotion, type Report } from './tools'

export interface RenderOptions {
  gameplay: string
  title?: string
  credit?: string
  layout?: string
  sound?: string
  endCard?: boolean
  out?: string
}

export interface RenderResult {
  path: string
  absolute: string
  seconds: number
  width: number
  height: number
  bytes: number
}

function inside(root: string, path: string): string {
  const abs = resolve(root, path)
  const rel = relative(root, abs)
  if (rel.startsWith('..') || isAbsolute(rel)) throw new ClipError(`${path} is outside the project.`, 'bad-path')
  return abs
}

async function probe(rem: Remotion, file: string): Promise<{ seconds: number; width: number; height: number }> {
  const r = await run(rem.ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { cwd: rem.ffmpegDir, env: rem.env })
  if (r.code !== 0) throw new ClipError(`${basename(file)} is not a video that can be read.`, 'probe')
  const j = JSON.parse(r.out) as { format?: { duration?: string }; streams?: { codec_type?: string; width?: number; height?: number }[] }
  const v = j.streams?.find((s) => s.codec_type === 'video')
  if (!v?.width || !v.height) throw new ClipError(`${basename(file)} has no picture.`, 'probe')
  return { seconds: Number(j.format?.duration ?? 0), width: v.width, height: v.height }
}

export async function renderVideo(p: MainPlugin, projectRoot: string, o: RenderOptions, report: Report, signal?: AbortSignal): Promise<RenderResult> {
  if (!projectRoot) throw new ClipError('There is no project to render in.', 'no-project')
  if (typeof o.gameplay !== 'string' || !o.gameplay.trim()) throw new ClipError('Pass gameplay: the path of the gameplay video you recorded.', 'bad-args')
  const layout = o.layout === 'stack' ? 'stack' : 'side'
  const sound = o.sound === 'clip' || o.sound === 'game' ? o.sound : 'none'
  const metaText = await readFile(join(projectRoot, SOURCE_DIR, 'meta.json'), 'utf8').catch(() => null)
  if (!metaText) throw new ClipError(`${SOURCE_DIR}/meta.json is missing, so there is no source clip to put next to the game.`, 'no-source')
  const meta = JSON.parse(metaText) as SourceMeta
  const clipAbs = join(projectRoot, SOURCE_DIR, meta.file)
  const gameAbs = inside(projectRoot, o.gameplay.trim())
  if (!existsSync(clipAbs)) throw new ClipError(`${SOURCE_DIR}/${meta.file} is missing.`, 'no-source')
  if (!existsSync(gameAbs)) throw new ClipError(`${o.gameplay} does not exist. Record the gameplay with video.record first.`, 'no-gameplay')
  const outAbs = inside(projectRoot, o.out?.trim() || `${CLIP_DIR}/clip-vs-game.mp4`)
  const rem = await ensureRemotion(p, report, signal)
  const [clip, game] = await Promise.all([probe(rem, clipAbs), probe(rem, gameAbs)])
  const pub = join(p.cacheDir, 'render', `${Date.now()}`)
  await mkdir(pub, { recursive: true })
  try {
    const clipFile = `clip${extname(clipAbs)}`
    const gameFile = `gameplay${extname(gameAbs)}`
    await Promise.all([copyFile(clipAbs, join(pub, clipFile)), copyFile(gameAbs, join(pub, gameFile))])
    const props = {
      clipFile,
      gameFile,
      clipSeconds: clip.seconds || meta.duration,
      clipWidth: clip.width,
      clipHeight: clip.height,
      gameSeconds: game.seconds,
      gameWidth: game.width,
      gameHeight: game.height,
      layout,
      title: o.title ?? '',
      credit: o.credit ?? meta.credit,
      sound,
      endCard: o.endCard !== false
    }
    const propsFile = join(pub, 'props.json')
    await writeFile(propsFile, JSON.stringify(props))
    await mkdir(dirname(outAbs), { recursive: true })
    report('render', 'Rendering the video…', 0)
    const tail: string[] = []
    const r = await run(rem.node, [rem.cli, 'render', 'src/index.ts', 'ClipVsGame', outAbs, `--props=${propsFile}`, `--public-dir=${pub}`, '--codec=h264', '--log=error', '--overwrite'], {
      cwd: rem.dir,
      signal,
      onLine: (line) => {
        const m = /Rendered (\d+)\/(\d+)/.exec(line)
        if (m) report('render', 'Rendering the video…', Math.round((Number(m[1]) / Number(m[2])) * 100))
        else {
          tail.push(line)
          if (tail.length > 10) tail.shift()
        }
      }
    })
    if (r.code !== 0 || !existsSync(outAbs)) throw new ClipError(`Rendering failed. ${tail.slice(-3).join(' ')}`.trim(), 'render')
    const out = await probe(rem, outAbs)
    report('done', 'Video ready.', 100)
    return { path: relative(projectRoot, outAbs).split('\\').join('/'), absolute: outAbs, seconds: Math.round(out.seconds * 10) / 10, width: out.width, height: out.height, bytes: (await stat(outAbs)).size }
  } finally {
    await rm(pub, { recursive: true, force: true })
  }
}
