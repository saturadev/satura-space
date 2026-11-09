import { webContents } from 'electron'
import { defineHandle, sleep } from './registry'
import { withDebugger } from './profile'

interface Rect {
  x: number
  y: number
  width?: number
  height?: number
}

const KEYS: Record<string, { code: string; keyCode: number; text?: string }> = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Escape: { code: 'Escape', keyCode: 27 },
  Tab: { code: 'Tab', keyCode: 9 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  '/': { code: 'Slash', keyCode: 191, text: '/' }
}

defineHandle({
  name: 'ui.mouse',
  side: 'main',
  long: true,
  description:
    "Drives this window with real mouse and keyboard input the way a person does, without Drift. at is a JavaScript expression run in the window that returns an element's DOMRect or an { x, y } point (like document.querySelector('[data-tuner-save]').getBoundingClientRect()); without it x, y are window CSS px. fx, fy pick the point inside a rect as fractions (default the centre). click: true clicks there; otherwise dx, dy drag from there in steps moves gapMs apart, holding the button holdMs before the first move. hover: true only moves the pointer there. text types those characters one by one gapMs apart into the focused element, and key presses Enter, Escape, Tab, Backspace or / after it. Returns the point it used.",
  params: { at: '', x: 0, y: 0, fx: 0.5, fy: 0.5, dx: 0, dy: 0, steps: 20, gapMs: 30, holdMs: 60, click: false, hover: false, text: '', key: '' },
  async run(p, ctx) {
    const wc = ctx.window === null ? null : webContents.fromId(ctx.window)
    if (!wc || wc.isDestroyed()) throw new Error('No app window.')
    let x = Number(p.x) || 0
    let y = Number(p.y) || 0
    if (p.at) {
      const r = (await wc.executeJavaScript(`(() => { const r = (${String(p.at)}); return r ? { x: r.x, y: r.y, width: r.width ?? 0, height: r.height ?? 0 } : null })()`)) as Rect | null
      if (!r) throw new Error(`Nothing found at ${String(p.at)}`)
      x = r.x + (r.width ?? 0) * Number(p.fx ?? 0.5)
      y = r.y + (r.height ?? 0) * Number(p.fy ?? 0.5)
    }
    const steps = Math.max(1, Math.min(400, Math.round(Number(p.steps) || 1)))
    const gap = Math.max(0, Number(p.gapMs) || 0)
    const dx = Number(p.dx) || 0
    const dy = Number(p.dy) || 0
    const text = String(p.text ?? '')
    const key = String(p.key ?? '')
    await withDebugger(wc, async (send) => {
      const mouse = (type: string, mx: number, my: number, buttons: number): Promise<unknown> =>
        send('Input.dispatchMouseEvent', { type, x: mx, y: my, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1 })
      const pointer = p.at || p.x || p.y
      if (pointer) await mouse('mouseMoved', x, y, 0)
      if (pointer && p.click === true) {
        await mouse('mousePressed', x, y, 1)
        await sleep(Number(p.holdMs) || 60, ctx.signal)
        await mouse('mouseReleased', x, y, 0)
      } else if (pointer && p.hover !== true && (dx || dy)) {
        await mouse('mousePressed', x, y, 1)
        await sleep(Number(p.holdMs) || 60, ctx.signal)
        for (let i = 1; i <= steps; i++) {
          await mouse('mouseMoved', x + (dx * i) / steps, y + (dy * i) / steps, 1)
          await sleep(gap, ctx.signal)
        }
        await mouse('mouseReleased', x + dx, y + dy, 0)
      }
      for (const ch of text) {
        await send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch })
        await sleep(gap, ctx.signal)
      }
      if (key) {
        const k = KEYS[key] ?? { code: key, keyCode: 0 }
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode, ...(k.text ? { text: k.text } : {}) })
        if (k.text) await send('Input.dispatchKeyEvent', { type: 'char', key, text: k.text })
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode })
      }
    })
    return { x, y, dx, dy, steps, typed: text.length, key }
  }
})
