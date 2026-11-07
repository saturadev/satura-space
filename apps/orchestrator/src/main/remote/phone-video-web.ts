import { WebContentsView, app, ipcMain, type IpcMainEvent } from 'electron'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

interface Run {
  resolve: (d: Done) => void
  reject: (e: Error) => void
  progress: (p: number) => void
}

interface Done {
  width?: number
  height?: number
}

export interface WebCodecsSize {
  width: number
  height: number
  bitrate: number
}

const IDLE_CLOSE_MS = 60_000
const STALL_MS = 60_000
const runs = new Map<number, Run>()
let view: WebContentsView | null = null
let ready: Promise<void> | null = null
let listening = false
let nextId = 1
let idle: NodeJS.Timeout | null = null

function fromView(e: IpcMainEvent): boolean {
  return !!view && e.sender === view.webContents
}

function listen(): void {
  if (listening) return
  listening = true
  ipcMain.on('phone-convert:progress', (e, m: { id: number; progress: number }) => {
    if (fromView(e)) runs.get(m.id)?.progress(Number(m.progress) || 0)
  })
  ipcMain.on('phone-convert:done', (e, m: { id: number; error?: string } & Done) => {
    if (!fromView(e)) return
    const run = runs.get(m.id)
    if (!run) return
    runs.delete(m.id)
    if (m.error) run.reject(new Error(m.error))
    else run.resolve({ width: Number(m.width) || undefined, height: Number(m.height) || undefined })
    closeWhenIdle()
  })
}

function close(): void {
  const v = view
  view = null
  ready = null
  if (v && !v.webContents.isDestroyed()) v.webContents.close()
}

function closeWhenIdle(): void {
  if (idle) clearTimeout(idle)
  idle = runs.size ? null : setTimeout(close, IDLE_CLOSE_MS)
}

function ensure(): Promise<void> {
  if (ready && view && !view.webContents.isDestroyed()) return ready
  listen()
  const v = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/phone-video-convert.js'),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: false
    }
  })
  view = v
  const wc = v.webContents
  wc.on('console-message', (d) => console.log(`[phone-video] converter: ${d.message}`))
  wc.on('render-process-gone', (_e, d) => {
    if (view === v) {
      view = null
      ready = null
    }
    for (const run of runs.values()) run.reject(new Error(`the converter stopped (${d.reason})`))
    runs.clear()
  })
  const page = join(app.getPath('userData'), 'phone-video-convert.html')
  writeFileSync(page, '<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"><title>phone-video-convert</title>')
  ready = wc.loadFile(page).then(() => undefined)
  return ready
}

export async function convertWithWebCodecs(src: string, out: string, progress: (p: number) => void, size?: WebCodecsSize, fastStart: 'in-memory' | false = false): Promise<void> {
  await startRun('phone-convert:start', { src, out, fastStart, ...(size ? { width: size.width, height: size.height, bitrate: size.bitrate } : {}) }, progress)
}

export async function stillWithWebCodecs(src: string, out: string, max: number): Promise<{ width: number; height: number }> {
  const d = await startRun('phone-convert:still', { src, out, max }, () => {})
  if (!d.width || !d.height) throw new Error('the converter made no still')
  return { width: d.width, height: d.height }
}

async function startRun(channel: string, payload: Record<string, unknown>, progress: (p: number) => void): Promise<Done> {
  if (idle) clearTimeout(idle)
  idle = null
  await ensure()
  const wc = view?.webContents
  if (!wc || wc.isDestroyed()) throw new Error('the converter is not running')
  const id = nextId++
  return new Promise<Done>((resolve, reject) => {
    let timer: NodeJS.Timeout | null = null
    const stalled = (): void => {
      runs.delete(id)
      reject(new Error(`the converter made no progress in ${STALL_MS / 1000} s`))
      close()
    }
    const arm = (): void => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(stalled, STALL_MS)
    }
    const settle = (): void => {
      if (timer) clearTimeout(timer)
    }
    runs.set(id, {
      resolve: (d) => {
        settle()
        resolve(d)
      },
      reject: (e) => {
        settle()
        reject(e)
      },
      progress: (p) => {
        arm()
        progress(p)
      }
    })
    arm()
    wc.send(channel, { ...payload, id })
  })
}

export function stopConverter(): void {
  for (const run of runs.values()) run.reject(new Error('the app is quitting'))
  runs.clear()
  close()
}
