import { app, BrowserWindow, session, type Session } from 'electron'
import { pathToFileURL } from 'node:url'
import type { PluginPage, PluginPageMessage, PluginPageOptions } from './api'

const LOAD_MS = 30_000
const EVAL_MS = 120_000
const IDLE_MS = 15 * 60_000
const LOCAL = /^(file|data|blob|devtools|chrome-extension):/i

const open = new Set<BrowserWindow>()
const watched = new WeakSet<Session>()
const routes = new Map<number, (url: string) => boolean>()
let orphanCheck: NodeJS.Timeout | null = null

function watchOrphans(): void {
  if (orphanCheck) return
  app.once('before-quit', closePluginPages)
  orphanCheck = setInterval(() => {
    if (!open.size) {
      clearInterval(orphanCheck!)
      orphanCheck = null
    } else if (BrowserWindow.getAllWindows().every((w) => open.has(w))) closePluginPages()
  }, 2000)
}

function within<T>(what: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} took longer than ${Math.round(ms / 1000)}s`)), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

function watchSession(ses: Session): void {
  if (watched.has(ses)) return
  watched.add(ses)
  ses.setPermissionRequestHandler((_wc, _permission, done) => done(false))
  ses.webRequest.onBeforeRequest((details, done) => {
    const allow = details.webContentsId === undefined ? undefined : routes.get(details.webContentsId)
    done({ cancel: allow ? !allow(details.url) : false })
  })
}

export async function openPluginPage(plugin: string, options: PluginPageOptions = {}): Promise<PluginPage> {
  const width = Math.max(16, Math.round(options.width ?? 540))
  const height = Math.max(16, Math.round(options.height ?? 960))
  const scale = Math.min(4, Math.max(1, options.scale ?? 1))
  const ses = session.fromPartition(`plugin-page-${plugin}`)
  watchSession(ses)
  const win = new BrowserWindow({
    show: false,
    width,
    height,
    useContentSize: true,
    frame: false,
    skipTaskbar: true,
    focusable: false,
    webPreferences: { offscreen: { deviceScaleFactor: scale }, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, session: ses, spellcheck: false }
  })
  open.add(win)
  watchOrphans()
  const wc = win.webContents
  const messages: PluginPageMessage[] = []
  const requests: string[] = []
  const opened: string[] = []
  let base = ''
  let painted: Electron.NativeImage | null = null
  const waiters: ((image: Electron.NativeImage) => void)[] = []
  wc.setFrameRate(options.frameRate ?? 30)
  wc.on('paint', (_e, _dirty, image) => {
    painted = image
    for (const w of waiters.splice(0)) w(image)
  })
  wc.on('console-message', (e: Electron.Event & { level?: string; message?: string }) => {
    if (messages.length < 2000) messages.push({ type: String(e.level ?? 'info'), text: String(e.message ?? '') })
  })
  wc.on('render-process-gone', (_e, d) => messages.push({ type: 'error', text: `page renderer ${d.reason} (exit ${d.exitCode})` }))
  wc.setWindowOpenHandler(({ url }) => {
    opened.push(url)
    return { action: 'deny' }
  })
  wc.on('will-navigate', (e) => {
    if (e.url.split(/[?#]/)[0] === base) return
    e.preventDefault()
    opened.push(e.url)
  })
  routes.set(wc.id, (url) => {
    const local = LOCAL.test(url)
    if (!local) requests.push(url)
    return local || (options.allowNetwork?.(url) ?? false)
  })
  let idle = setTimeout(() => close(), IDLE_MS)
  const touch = (): void => {
    clearTimeout(idle)
    idle = setTimeout(() => close(), IDLE_MS)
  }
  const close = (): void => {
    clearTimeout(idle)
    routes.delete(wc.id)
    open.delete(win)
    if (!win.isDestroyed()) win.destroy()
  }
  const alive = (): void => {
    if (win.isDestroyed()) throw new Error('The page is closed.')
    touch()
  }

  return {
    messages,
    requests,
    opened,
    async load(target, query) {
      alive()
      const href = /^[a-z]+:/i.test(target) && !/^[a-z]:[\\/]/i.test(target) ? target : pathToFileURL(target).href
      base = href.split(/[?#]/)[0]
      const q = query ? new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)])).toString() : ''
      await within('Loading the page', options.loadTimeoutMs ?? LOAD_MS, wc.loadURL(q ? `${href}?${q}` : href))
    },
    async evaluate<T = unknown>(code: string, timeoutMs?: number): Promise<T> {
      alive()
      return within('The page script', timeoutMs ?? EVAL_MS, wc.executeJavaScript(code, true) as Promise<T>)
    },
    async screenshot() {
      alive()
      const next = new Promise<Electron.NativeImage>((resolve) => waiters.push(resolve))
      wc.invalidate()
      const image = await within('A page paint', 5_000, next).catch(() => painted)
      if (!image || image.isEmpty()) throw new Error('The page has not painted anything yet.')
      return image.toPNG()
    },
    async resize(w, h) {
      alive()
      win.setContentSize(Math.max(16, Math.round(w)), Math.max(16, Math.round(h)))
    },
    close
  }
}

export function closePluginPages(): void {
  for (const win of [...open]) if (!win.isDestroyed()) win.destroy()
  open.clear()
}
