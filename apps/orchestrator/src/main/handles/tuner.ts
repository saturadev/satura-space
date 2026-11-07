import { webContents } from 'electron'
import { openTuner, scratchpadOf } from '../satura-exec'
import { tunerTabTarget } from '@shared/tuner-find'
import { tunerTabs } from '../agent-exec'
import { defineHandle, sleep, waitUntil } from './registry'
import { withDebugger } from './profile'
import { needPrimary } from './unity'
import { tunerService } from '../unity/tuner'
import { guardDialogs } from './dialogs'

defineHandle({
  name: 'tuner.open',
  side: 'main',
  long: true,
  description:
    "Opens a Tuner panel for the project, or for a scratchpad when scratchpad is its name or id: scene: true for the open scenes, scene: 'Assets/Scenes/X.unity' for a scene asset (the open scene Tuner is reused and the editor switches to that scene), prefab: 'Assets/X.prefab', or object: 'Root/Child' for one object. An open Tuner of that kind on another target switches to this one in the same tab. Waits up to timeout seconds for that editor to be ready and the hierarchy to have rows; a stopped or failed editor fails at once with its state. dock: 'right' docks it on the right at share of the width. Returns the view name, its tab and every Tuner tab in the workspace.",
  params: { scene: true, prefab: null, object: null, scratchpad: '', dock: 'right', share: 0.6, timeout: 60 },
  async run(p, ctx) {
    const pr = needPrimary(ctx)
    await guardDialogs(ctx, pr.project)
    const window = ctx.window
    const workspace = ctx.workspace
    if (window === null || !workspace) throw new Error('The project is not open in a Satura Space workspace. Open it in the app first.')
    const timeout = (Number(p.timeout) || 60) * 1000
    const tctx = { window, projectRoot: ctx.projectRoot, paneKey: ctx.paneKey, workspace }
    const pad = p.scratchpad ? await scratchpadOf({ ref: String(p.scratchpad) }, tctx) : ''
    const args: Record<string, unknown> = { wait: timeout / 1000, ...(pad ? { scratchpad: pad } : {}) }
    if (p.prefab) args.prefab = p.prefab
    else if (p.object) args.object = p.object
    else args.scene = p.scene
    const view = await openTuner(args, tctx)
    const target = pad || 'project'
    const tab = await waitUntil(`the Tuner tab ${view}`, async () => {
      await guardDialogs(ctx, pr.project)
      const tabs = (await tunerTabs(window, workspace))?.filter((t) => tunerTabTarget(t) === target)
      const sceneAsk = !p.prefab && !p.object
      return tabs?.find((t) => t.view === view) ?? (sceneAsk ? tabs?.find((t) => t.view === 'scene' || /\.unity$/i.test(t.view)) : undefined)
    }, timeout, ctx.signal)
    const wc = webContents.fromId(window)
    if (!wc || wc.isDestroyed()) throw new Error('The window is gone.')
    const rows = await waitUntil('Tuner hierarchy rows', async () => {
      await guardDialogs(ctx, pr.project)
      const n = (await wc.executeJavaScript(
        `document.querySelectorAll('[data-tuner-pane][data-tuner-target=${JSON.stringify(target)}] [data-scene-hierarchy] [data-row-key]').length`
      )) as number
      return n > 0 ? n : null
    }, timeout, ctx.signal)
    const panes = p.dock === 'right' ? await ctx.renderer('layout.dock', { tab: tab.tabId, share: Number(p.share) || 0.6 }) : null
    const reused = tab.view !== view ? { note: `A project has one scene Tuner, so ${view} opened in the existing one (${tab.view}).` } : {}
    return { view: tab.view, tab, rows, tabs: await tunerTabs(window, workspace), ...reused, ...(panes ? { panes } : {}) }
  }
})

interface ProbeReply {
  seq: number
  origin: [number, number]
  at: [number, number] | null
  [k: string]: unknown
}

defineHandle({
  name: 'tuner.drag',
  side: 'main',
  long: true,
  description:
    "Drags in the shown scene Tuner's view with real mouse input, step by step, and reads the view after every step. spot is where to press, as tuner.viewProbe takes it: 'gizmo:plane:2', 'gizmo:ring:2', 'gizmo:scale:3', 'rect:move', 'rect:resize:2,2', 'rect:rotate:2,2', 'rect:pivot' or 'x,y' in viewport px. by is the whole drag in px, split into steps moves; shift, alt and cmd are held from the first move to the release, the way a user presses them mid-drag (Alt held at the press would orbit the camera). After each move it waits until frames more Unity frames arrived (or 800 ms) and takes a tuner.viewProbe. Returns the press point and one sample before, per step and after the release: frame seq, mouse point, the rect frame, and per selected object its values, screen box, outline box and off.",
  params: { spot: 'rect:move', by: [40, 0], steps: 6, shift: false, alt: false, cmd: false, frames: 2 },
  async run(p, ctx) {
    const wc = ctx.window === null ? null : webContents.fromId(ctx.window)
    if (!wc || wc.isDestroyed()) throw new Error('No app window.')
    const probe = async (params: Record<string, unknown>): Promise<ProbeReply> => (await ctx.renderer('tuner.viewProbe', params)) as ProbeReply
    const settle = async (from: number, frames: number): Promise<void> => {
      const until = Date.now() + 800
      while (Date.now() < until) {
        const r = await probe({ seq: true })
        if (r.seq >= from + frames) return
        await sleep(25, ctx.signal)
      }
    }
    const spot = String(p.spot)
    const first = await probe({ spot })
    if (!first.at) throw new Error(`Nothing to press at ${spot} in the shown Tuner view. Select an object and pick the tool that draws it.`)
    const by = Array.isArray(p.by) ? p.by.map(Number) : [0, 0]
    const steps = Math.max(1, Math.min(60, Math.round(Number(p.steps) || 1)))
    const frames = Math.max(0, Math.round(Number(p.frames) || 0))
    const [ox, oy] = first.origin
    const sx = ox + first.at[0]
    const sy = oy + first.at[1]
    const modifiers = (p.alt ? 1 : 0) | (p.cmd ? (process.platform === 'darwin' ? 4 : 2) : 0) | (p.shift ? 8 : 0)
    const view = (r: ProbeReply): Record<string, unknown> => Object.fromEntries(Object.entries(r).filter(([k]) => k !== 'origin' && k !== 'at'))
    const samples: Record<string, unknown>[] = [{ step: 'before', mouse: first.at, ...view(first) }]
    await withDebugger(wc, async (send) => {
      const mouse = (type: string, x: number, y: number, buttons: number, mods = modifiers): Promise<unknown> =>
        send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: type === 'mouseMoved' ? 0 : 1, modifiers: mods })
      await mouse('mouseMoved', sx, sy, 0, 0)
      await mouse('mousePressed', sx, sy, 1, 0)
      for (let i = 1; i <= steps; i++) {
        const x = sx + (by[0] * i) / steps
        const y = sy + (by[1] * i) / steps
        const seq = (await probe({ seq: true })).seq
        await mouse('mouseMoved', x, y, 1)
        await settle(seq, frames)
        samples.push({ step: i, mouse: [Math.round((x - ox) * 10) / 10, Math.round((y - oy) * 10) / 10], ...view(await probe({})) })
      }
      await mouse('mouseReleased', sx + by[0], sy + by[1], 0)
    })
    const seq = (await probe({ seq: true })).seq
    await settle(seq, frames + 2)
    await sleep(250, ctx.signal)
    samples.push({ step: 'after', ...view(await probe({})) })
    return { spot, at: first.at, by, steps, modifiers, samples }
  }
})

defineHandle({
  name: 'tuner.sceneStats',
  side: 'main',
  description:
    'Reads what the scene view of every running Tuner of the project costs the editor since the last reset: frames and seconds, average and max ms for the render, selection outline and gizmos, objects shown and draws, animation ticks with their ms, pose samples, cache rebuilds and hierarchy changes. With SATURA_DEBUG=1 the editor also logs the same numbers as a [Tuner] frame cost line. reset: true starts a new count after reading. Returns one entry per Tuner session with its view name and stats, or the error for a session that did not answer.',
  params: { reset: false },
  async run(p, ctx) {
    const pr = needPrimary(ctx)
    const sessions = await tunerService.sceneStats(pr.project, p.reset === true)
    if (sessions.length === 0) throw new Error('No Tuner is running for the project. Open one with tuner.open first.')
    return { sessions }
  }
})
