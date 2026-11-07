import { BrowserWindow, webContents, type Rectangle } from 'electron'
import { setCaptureState } from '../capture-state'
import { defineHandle, sleep } from './registry'

const OUT_W = 1920
const OUT_H = 1080

const PRESETS: Record<string, { sidebar: boolean; layout: string }> = {
  none: { sidebar: true, layout: '' },
  tuner: { sidebar: false, layout: 'tuner' },
  drift: { sidebar: false, layout: 'terminal+tuner' },
  game: { sidebar: false, layout: 'unity+terminal' }
}

interface Saved {
  wcId: number
  bounds: Rectangle
  maximized: boolean
  zoom: number
  opacity: number
}

let saved: Saved | null = null

function windowOf(id: number | null): { wc: Electron.WebContents; win: BrowserWindow } {
  if (id === null) throw new Error('No window to capture.')
  const wc = webContents.fromId(id)
  const win = wc ? BrowserWindow.fromWebContents(wc) : null
  if (!wc || wc.isDestroyed() || !win) throw new Error('The window is gone.')
  return { wc, win }
}

defineHandle({
  name: 'capture.mode',
  side: 'main',
  description:
    "Puts the window in the state landing videos are recorded in, or takes it out again. on: true sizes the content to width x height CSS pixels and renders it at the pixel ratio that makes every frame exactly 1920x1080, zoom 1, dark theme, no background throttling; hidden makes the window fully transparent and click-through so nothing shows on screen and it never takes focus (media.record still gets every frame). The window hides the bottom status bar, the sidebar with its notices, toasts and Drift's highlight frame, shows name instead of the project folder name, and replace maps text to show instead in terminal output (like {'MyGame': 'demo'}). preset arranges the panes: tuner makes the Tuner fill the window, drift puts the terminal left of the Tuner, game puts the Unity Player left of the terminal, none leaves the layout. on: false restores the size, position, zoom, opacity and layout state exactly. Returns the state.",
  params: { on: true, preset: 'none', width: 1600, height: 900, hidden: true, name: 'demo-project', replace: {}, out: 1920 },
  async run(p, ctx) {
    const { wc, win } = windowOf(ctx.window)
    if (p.on === false) {
      const back = saved
      saved = null
      setCaptureState(null)
      wc.disableDeviceEmulation()
      wc.setBackgroundThrottling(true)
      if (back && back.wcId === wc.id) {
        win.setIgnoreMouseEvents(false)
        win.setOpacity(back.opacity)
        wc.setZoomFactor(back.zoom)
        win.setBounds(back.bounds)
        if (back.maximized) win.maximize()
      }
      await sleep(300)
      await ctx.renderer('capture.apply', { on: false })
      ctx.log('capture mode off')
      return { on: false, bounds: win.getBounds() }
    }
    const preset = PRESETS[String(p.preset)]
    if (!preset) throw new Error(`Unknown preset ${String(p.preset)}. Use ${Object.keys(PRESETS).join(', ')}.`)
    const width = Math.round(Number(p.width) || 1600)
    const height = Math.round(width * (OUT_H / OUT_W))
    if (Math.abs(height - (Number(p.height) || height)) > 1) throw new Error(`width x height must be 16:9 (${width} x ${height}).`)
    const scale = (Number(p.out) || OUT_W) / width
    if (!saved || saved.wcId !== wc.id) {
      saved = { wcId: wc.id, bounds: win.getBounds(), maximized: win.isMaximized(), zoom: wc.getZoomFactor(), opacity: win.getOpacity() }
    }
    if (win.isFullScreen()) {
      win.setFullScreen(false)
      await sleep(800)
    }
    if (win.isMaximized()) win.unmaximize()
    const hidden = p.hidden !== false
    if (hidden) {
      win.setIgnoreMouseEvents(true)
      win.setOpacity(0)
    } else {
      win.setIgnoreMouseEvents(false)
      win.setOpacity(saved.opacity)
    }
    win.setContentSize(width, height)
    wc.setZoomFactor(1)
    wc.setBackgroundThrottling(false)
    wc.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: { width, height },
      viewPosition: { x: 0, y: 0 },
      deviceScaleFactor: scale,
      viewSize: { width, height },
      scale: 1
    })
    setCaptureState({ width, height, scale, hidden, preset: String(p.preset) })
    await sleep(300)
    const replace: Record<string, string> = {}
    for (const [k, v] of Object.entries((p.replace as Record<string, unknown>) ?? {})) if (k) replace[k] = String(v ?? '')
    const applied = await ctx.renderer('capture.apply', { on: true, name: String(p.name ?? ''), replace, sidebar: preset.sidebar, layout: preset.layout })
    wc.invalidate()
    ctx.log(`capture mode on: ${width}x${height} css at ${scale.toFixed(3)}x, preset ${String(p.preset)}${hidden ? ', hidden' : ''}`)
    const [cw, ch] = win.getContentSize()
    return { on: true, content: { width: cw, height: ch }, frame: { width: Math.round(cw * scale), height: Math.round(ch * scale) }, hidden, preset: String(p.preset), window: applied }
  }
})
