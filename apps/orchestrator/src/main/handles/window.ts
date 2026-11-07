import { BrowserWindow, app, screen, webContents } from 'electron'
import { execFileSync } from 'node:child_process'
import { defineHandle, sleep } from './registry'
import { withDebugger } from './profile'

defineHandle({
  name: 'window.size',
  side: 'main',
  description:
    'Sizes the app window content to width x height CSS pixels (0 keeps that side), restoring it from maximized or fullscreen first. With neither set it only reads the size. Returns the content width and height, the window bounds and the display work area.',
  params: { width: 0, height: 0 },
  async run(p, ctx) {
    if (ctx.window === null) throw new Error('No window to size.')
    const wc = webContents.fromId(ctx.window)
    const win = wc ? BrowserWindow.fromWebContents(wc) : null
    if (!wc || wc.isDestroyed() || !win) throw new Error('The window is gone.')
    const w = Math.round(Number(p.width) || 0)
    const h = Math.round(Number(p.height) || 0)
    if (w > 0 || h > 0) {
      if (win.isFullScreen()) {
        win.setFullScreen(false)
        await sleep(800)
      }
      if (win.isMaximized()) win.unmaximize()
      const [cw, ch] = win.getContentSize()
      win.setContentSize(w > 0 ? w : cw, h > 0 ? h : ch)
      await sleep(400)
    }
    const [width, height] = win.getContentSize()
    return { width, height, bounds: win.getBounds(), workArea: screen.getDisplayMatching(win.getBounds()).workArea }
  }
})

defineHandle({
  name: 'window.dropFiles',
  side: 'main',
  description:
    'Drags files from the OS onto the app window and drops them at x, y window pixels (default: the window centre), the way a Finder or Explorer drag does. Pass files as absolute paths. Returns where it dropped.',
  params: { files: [], x: -1, y: -1 },
  async run(p, ctx) {
    const wc = ctx.window === null ? null : webContents.fromId(ctx.window)
    if (!wc || wc.isDestroyed()) throw new Error('No app window.')
    const files = (Array.isArray(p.files) ? p.files : [p.files]).map(String).filter(Boolean)
    if (!files.length) throw new Error('Pass files, absolute paths.')
    const [cw, ch] = BrowserWindow.fromWebContents(wc)?.getContentSize() ?? [0, 0]
    const x = Number(p.x) >= 0 ? Number(p.x) : Math.round(cw / 2)
    const y = Number(p.y) >= 0 ? Number(p.y) : Math.round(ch / 2)
    const data = { items: [], files, dragOperationsMask: 1 }
    await withDebugger(wc, async (send) => {
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await send('Input.dispatchDragEvent', { type, x, y, data })
        await sleep(50)
      }
    })
    await sleep(800)
    return { x, y, files }
  }
})

const PROBE_JS = `new Promise((done) => {
  let raf = 0
  let ticks = 0
  const t0 = performance.now()
  const frame = () => { raf++; if (performance.now() - t0 < 1000) requestAnimationFrame(frame) }
  requestAnimationFrame(frame)
  const tick = () => { ticks++; if (performance.now() - t0 < 1000) setTimeout(tick, 10) }
  setTimeout(tick, 10)
  setTimeout(() => done({ visibility: document.visibilityState, raf, timers: ticks, ms: Math.round(performance.now() - t0) }), 1200)
})`

function priorities(): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of app.getAppMetrics()) {
    if (m.type !== 'Tab') continue
    try {
      out[String(m.pid)] = execFileSync('ps', ['-o', 'pri=', '-p', String(m.pid)], { encoding: 'utf8' }).trim()
    } catch {
      out[String(m.pid)] = '?'
    }
  }
  return out
}

defineHandle({
  name: 'window.state',
  side: 'main',
  description:
    "Puts the app window in a background state and measures what that does to its renderer, to check that a minimized or hidden Mac window doesn't slow the phone. state: normal (restored and shown without focus), minimized, hidden (like Hide in the app menu) or offscreen (moved off every display, which macOS treats like a window covered by others); empty only reads. Returns the window flags, the page's visibility state, requestAnimationFrame callbacks and 10 ms timer fires counted over one second in the window, whether background throttling is on, the window renderer pid, and the scheduler priority of every renderer process (4 is macOS background priority).",
  params: { state: '' },
  async run(p, ctx) {
    if (ctx.window === null) throw new Error('No window.')
    const wc = webContents.fromId(ctx.window)
    const win = wc ? BrowserWindow.fromWebContents(wc) : null
    if (!wc || wc.isDestroyed() || !win) throw new Error('The window is gone.')
    const state = String(p.state ?? '')
    const home = screen.getDisplayMatching(win.getBounds()).workArea
    if (state === 'normal') {
      if (win.isMinimized()) win.restore()
      const b = win.getBounds()
      if (b.x < home.x - b.width || b.x > home.x + home.width) win.setPosition(home.x + 40, home.y + 40)
      win.showInactive()
    } else if (state === 'minimized') win.minimize()
    else if (state === 'hidden') win.hide()
    else if (state === 'offscreen') {
      if (win.isMinimized()) win.restore()
      win.showInactive()
      const all = screen.getAllDisplays().map((d) => d.bounds)
      const right = Math.max(...all.map((d) => d.x + d.width))
      win.setPosition(right + 4000, home.y)
    } else if (state) throw new Error('state is normal, minimized, hidden, offscreen or empty.')
    if (state) await sleep(1500)
    const page = (await wc.executeJavaScript(PROBE_JS)) as Record<string, unknown>
    ctx.log(`window ${state || 'read'}: ${page.visibility}, raf ${page.raf}/s, timers ${page.timers}/s`)
    return {
      minimized: win.isMinimized(),
      visible: win.isVisible(),
      bounds: win.getBounds(),
      throttling: wc.getBackgroundThrottling(),
      ...page,
      windowPid: wc.getOSProcessId(),
      priorities: priorities()
    }
  }
})
