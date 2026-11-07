import { BrowserWindow, app, nativeImage, webContents } from 'electron'
import { readdirSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { defineHandle, sleep } from './registry'
import { guardDialogs } from './dialogs'
import { primaryOf } from './unity'
import { captureActive } from '../capture-state'
import { allowedOutPath, prepareRecordDir } from './out-path'

export function mediaOutRoots(): string[] {
  return [tmpdir(), join(app.getPath('userData'), 'media'), process.env.LANDING_MEDIA_OUT ?? '']
}

const PRESETS: Record<string, { width: number; height: number; quality: number } | null> = {
  landing: { width: 1600, height: 900, quality: 92 },
  none: null
}
const MAX_SECONDS = 1800
const MAX_W = 1920
const MAX_H = 1080

defineHandle({
  name: 'media.record',
  side: 'main',
  long: true,
  description:
    "Records the app window as numbered JPEG frames, at most 1920x1080, plus times.json (a timestamp per frame; frames arrive only when the window repaints), the format the landing video tools read. Use it for landing recordings: start it, drive the UI with page and other handles, then call stop(run) or let seconds run out. preset 'landing' first sizes the window content to 1600x900; 'none' keeps the current size. Frames go to out, or $LANDING_MEDIA_OUT/<name>, or the temp folder; out must be inside the temp folder, $LANDING_MEDIA_OUT or the app's media folder, and an existing out is replaced only when media.record made it. raw: true writes uncompressed frames while recording and turns them into JPEGs after the stop, so the main thread keeps up with every repaint (the default in capture mode); false encodes each JPEG as it arrives. Returns the folder, the frame count, the length in seconds and the frame size.",
  params: { preset: 'landing', name: 'take', seconds: 0, out: '', raw: null },
  async run(p, ctx) {
    if (ctx.window === null) throw new Error('No window to record.')
    const wc = webContents.fromId(ctx.window)
    const win = wc ? BrowserWindow.fromWebContents(wc) : null
    if (!wc || wc.isDestroyed() || !win) throw new Error('The window is gone.')
    const preset = PRESETS[String(p.preset)]
    if (preset === undefined) throw new Error(`Unknown preset ${String(p.preset)}. Use ${Object.keys(PRESETS).join(' or ')}.`)
    const name = String(p.name ?? 'take').replace(/[^A-Za-z0-9._-]+/g, '-') || 'take'
    const dir = allowedOutPath(String(p.out ?? '').trim() || join(process.env.LANDING_MEDIA_OUT || join(tmpdir(), 'landing-media'), name), mediaOutRoots())
    prepareRecordDir(dir)
    const pr = primaryOf(ctx.projectRoot)
    if (pr) await guardDialogs(ctx, pr.project)
    if (preset && !captureActive()) {
      win.setContentSize(preset.width, preset.height)
      await sleep(500)
    }
    const quality = preset?.quality ?? 90
    const raw = p.raw === true || (p.raw !== false && !!captureActive())
    const times: number[] = []
    const pending = new Set<Promise<void>>()
    const keep = (job: Promise<void>): void => {
      pending.add(job)
      void job.finally(() => pending.delete(job))
    }
    const name5 = (i: number): string => String(i).padStart(5, '0')
    let size = { width: 0, height: 0 }
    let busyMs = 0
    let maxMs = 0
    wc.beginFrameSubscription(false, (frame) => {
      const began = performance.now()
      const index = times.length
      times.push(Date.now() / 1000)
      const full = frame.getSize()
      const scale = Math.min(1, MAX_W / full.width, MAX_H / full.height)
      const image = scale < 1 ? frame.resize({ width: Math.round(full.width * scale), height: Math.round(full.height * scale), quality: 'good' }) : frame
      size = image.getSize()
      if (raw) keep(writeFile(join(dir, `${name5(index)}-${size.width}x${size.height}.bgra`), image.toBitmap()).catch(() => {}))
      else keep(writeFile(join(dir, `${name5(index)}.jpg`), image.toJPEG(quality)).catch(() => {}))
      const spent = performance.now() - began
      busyMs += spent
      maxMs = Math.max(maxMs, spent)
    })
    wc.invalidate()
    ctx.log(`recording into ${dir}${raw ? ' (raw frames, JPEG after the stop)' : ''}`)
    const limit = Math.min(MAX_SECONDS, Number(p.seconds) > 0 ? Number(p.seconds) : MAX_SECONDS)
    await sleep(limit * 1000, ctx.signal)
    if (!wc.isDestroyed()) wc.endFrameSubscription()
    times.push(Date.now() / 1000)
    while (pending.size) await Promise.all([...pending])
    if (raw) {
      for (const file of readdirSync(dir).filter((f) => f.endsWith('.bgra')).sort()) {
        const m = /^(\d+)-(\d+)x(\d+)\.bgra$/.exec(file)
        if (!m) continue
        const bitmap = await readFile(join(dir, file))
        const image = nativeImage.createFromBitmap(bitmap, { width: Number(m[2]), height: Number(m[3]) })
        await writeFile(join(dir, `${m[1]}.jpg`), image.toJPEG(quality))
        rmSync(join(dir, file), { force: true })
      }
    }
    writeFileSync(join(dir, 'times.json'), JSON.stringify(times))
    const seconds = times.length > 1 ? Math.round((times[times.length - 1] - times[0]) * 10) / 10 : 0
    const frames = times.length - 1
    ctx.log(`recorded ${frames} frames in ${seconds} s, ${frames ? (busyMs / frames).toFixed(1) : 0} ms per frame on the main thread (max ${maxMs.toFixed(0)})`)
    return { dir, frames, seconds, size, fps: seconds ? Math.round((frames / seconds) * 10) / 10 : 0, msPerFrame: frames ? Math.round((busyMs / frames) * 10) / 10 : 0 }
  }
})

defineHandle({
  name: 'media.still',
  side: 'main',
  description: "Saves the app window as one PNG at its full rendered pixel size to out, which must be inside the temp folder, $LANDING_MEDIA_OUT or the app's media folder. Returns the path and size.",
  params: { out: '', chrome: false, x: null, y: null },
  async run(p, ctx) {
    if (ctx.window === null) throw new Error('No window to capture.')
    const wc = webContents.fromId(ctx.window)
    if (!wc || wc.isDestroyed()) throw new Error('The window is gone.')
    const rawOut = String(p.out ?? '').trim()
    if (!rawOut) throw new Error('out is required.')
    const out = allowedOutPath(rawOut, mediaOutRoots())
    const win = BrowserWindow.fromWebContents(wc)
    if (p.chrome === true && win) {
      const id = /^window:(\d+):/.exec(win.getMediaSourceId())?.[1]
      if (!id) throw new Error('No native window id.')
      const before = win.getBounds()
      const opacity = win.getOpacity()
      if (p.x !== null && p.y !== null) win.setPosition(Math.round(Number(p.x)), Math.round(Number(p.y)))
      win.setOpacity(1)
      wc.invalidate()
      await sleep(700)
      const shot = spawnSync('/usr/sbin/screencapture', ['-x', `-l${id}`, out])
      win.setOpacity(opacity)
      win.setPosition(before.x, before.y)
      if (shot.status !== 0) throw new Error(`screencapture failed: ${String(shot.stderr ?? '')}`)
      const image = nativeImage.createFromPath(out)
      return { out, size: image.getSize(), moved: win.getBounds() }
    }
    wc.invalidate()
    await sleep(100)
    const image = await wc.capturePage(undefined, { stayHidden: true, stayAwake: true })
    writeFileSync(out, image.toPNG())
    return { out, size: image.getSize() }
  }
})
