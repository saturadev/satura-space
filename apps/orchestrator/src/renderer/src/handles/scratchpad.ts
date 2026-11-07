import type { Tab } from '@shared/types'
import { useAppStore } from '../store'
import { useWorldStore } from '../lib/unity/world-store'
import { primaryWorldId } from '../lib/unity/instance-ids'
import { getSessionStatus } from '../lib/unity/session-status'
import { getMetrics } from '../lib/unity/unity-metrics'
import { scratchpadCacheSnapshot, scratchpadGridSnapshot } from '../lib/unity/scratchpads'
import { gridSessionId } from '../lib/unity/instance-ids'
import { useConfirmStore } from '../lib/confirm/confirm-store'
import { defineHandle, type RendererCtx } from './registry'
import { settle } from './layout'

const KINDS = new Set(['unity-scratchpad', 'unity-console', 'tuner'])

function text(el: Element | null | undefined): string {
  return (el?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 160)
}

function worktreePath(ws: string, tab: Tab): string {
  return (useAppStore.getState().worktreesByWorkspace[ws] ?? []).find((w) => w.id === tab.worktreeId)?.path ?? ''
}

function scratchTab(ctx: RendererCtx, ref: unknown): Tab {
  const tabs = useAppStore.getState().tabsByWorkspace[ctx.workspaceId] ?? []
  const want = String(ref ?? '')
  const tab = want
    ? tabs.find((t) => t.id === want || t.ptyId === want)
    : tabs.find((t) => t.contentType === 'unity-scratchpad')
  if (!tab) throw new Error(want ? `There is no tab ${want}.` : 'No Scratchpads tab is open. layout.open kind scratchpads opens one.')
  return tab
}

function streamOf(sessionId: string, path: string): Record<string, unknown> {
  const w = useWorldStore.getState()
  const loc = w.framesLive[sessionId]
  const wid = path ? primaryWorldId(path) : ''
  const inst = path ? w.worlds[path]?.observed.instances[wid] : undefined
  return {
    framesLive: loc ? { projectPath: loc.projectPath, worldId: loc.worldId } : null,
    lifecycle: inst?.lifecycle ?? null,
    playing: w.worlds[path]?.desired.instances[wid]?.playing ?? null,
    muted: w.worlds[path]?.desired.instances[wid]?.muted ?? null,
    session: getSessionStatus(sessionId),
    metrics: getMetrics(sessionId)
  }
}

async function countFrames(ms: number): Promise<Record<string, number>> {
  if (ms <= 0) return {}
  const out: Record<string, number> = {}
  const off = window.api.unity.onSharedFrame((id) => {
    out[id] = (out[id] ?? 0) + 1
  })
  await new Promise((r) => setTimeout(r, ms))
  off()
  return out
}

function describe(ws: string, tab: Tab): Record<string, unknown> {
  const s = useAppStore.getState()
  const root = worktreePath(ws, tab)
  const cache = scratchpadCacheSnapshot().find((e) => e.path === root)
  const sel = cache?.list.find((x) => x.id === tab.scratchpadId) ?? (tab.contentType === 'unity-scratchpad' ? cache?.list[0] : undefined) ?? null
  const group = (s.groupsByWorkspace[ws] ?? []).find((g) => g.id === tab.groupId)
  const base: Record<string, unknown> = {
    tab: tab.id,
    ptyId: tab.ptyId,
    kind: tab.contentType,
    shown: group?.activeTabId === tab.id && !group?.hidden,
    storeScratchpadId: tab.scratchpadId ?? null,
    cached: sel ? { id: sel.id, name: sel.name, status: sel.status, play: sel.play, path: sel.path } : null
  }
  if (tab.contentType === 'unity-scratchpad') {
    const panel = document.querySelector(`[data-scratchpad-panel="${CSS.escape(tab.ptyId)}"]`)
    const header = panel?.querySelector('[data-scratchpad-selector]')
    const body = panel?.lastElementChild
    const canvas = body?.querySelector('canvas[data-unity-session]') as HTMLCanvasElement | null
    return {
      ...base,
      mounted: !!panel,
      header: text(header),
      buttons: [...(panel?.firstElementChild?.querySelectorAll('button[title]') ?? [])]
        .filter((b) => !b.hasAttribute('data-scratchpad-selector'))
        .map((b) => `${b.getAttribute('title')}${(b as HTMLButtonElement).disabled ? ' (disabled)' : ''}`),
      body: text(body),
      playback: [...(body?.querySelectorAll('[data-unity-playback] button[title]') ?? [])].map((b) => `${(b.getAttribute('title') ?? '').split(' — ')[0]}${(b as HTMLButtonElement).disabled ? ' (disabled)' : ''}`),
      mute: body?.querySelector('button[title="Mute"], button[title="Unmute"]')?.getAttribute('title') ?? null,
      streamStatus: text(body?.querySelector('button[title="Stream status & settings"]')),
      canvas: canvas ? { session: canvas.dataset.unitySession, width: canvas.width, height: canvas.height, paintSid: canvas.dataset.paintSid ?? null, paintAgeMs: canvas.dataset.paintAt ? Math.round(performance.now() - Number(canvas.dataset.paintAt)) : null } : null,
      stream: streamOf(tab.ptyId, sel?.path ?? '')
    }
  }
  const pane = findPane(tab)
  const chip = pane?.querySelector('[data-unity-target]')
  return {
    ...base,
    mounted: !!pane,
    chip: chip ? { target: chip.getAttribute('data-unity-target'), text: text(chip) } : null,
    body: text(pane).slice(0, 160)
  }
}

function findPane(tab: Tab): Element | null {
  for (const groups of Object.values(useAppStore.getState().groupsByWorkspace)) {
    const g = groups.find((x) => x.id === tab.groupId)
    if (g) return g.activeTabId === tab.id ? document.querySelector(`[data-group-id="${CSS.escape(g.id)}"]`) : null
  }
  return null
}

defineHandle({
  name: 'scratchpad.state',
  side: 'renderer',
  description:
    "Reads every Scratchpads, Unity Console and Tuner tab of the project workspace as drawn: the tab's stored scratchpad, the cached list entry it resolves to, and for a Scratchpads tab its header text, toolbar buttons, body text, the video canvas (with the surface it last painted and how many ms ago) and its stream state (framesLive, lifecycle, playing, muted, session status, fps). frames counts the shared video frames per session id for that many ms. Also returns the scratchpad list cache per project and the window's imported video textures (sessions, slots, early frames). Returns { tabs, cache, frames, sharedView }.",
  params: { frames: 0 },
  async run(p, ctx: RendererCtx) {
    const ws = ctx.workspaceId
    const frames = await countFrames(Math.min(10000, Number(p.frames) || 0))
    const tabs = (useAppStore.getState().tabsByWorkspace[ws] ?? []).filter((t) => KINDS.has(t.contentType))
    return {
      tabs: tabs.map((t) => describe(ws, t)),
      cache: scratchpadCacheSnapshot().map((e) => ({
        path: e.path,
        watchers: e.watchers,
        loaded: e.loaded,
        polling: e.polling,
        list: e.list.map((x) => `${x.id} ${x.name} ${x.status}${x.play ? ` ${x.play}` : ''}`),
        actions: e.actions
      })),
      frames,
      sharedView: window.api.unity.sharedStats()
    }
  }
})

function click(el: Element | null | undefined, what: string): void {
  if (!el) throw new Error(`Couldn't find ${what} on screen.`)
  ;(el as HTMLElement).click()
}

async function waitFor<T>(fn: () => T | null | undefined, ms: number, what: string): Promise<T> {
  const until = performance.now() + ms
  for (;;) {
    const v = fn()
    if (v) return v
    if (performance.now() > until) throw new Error(`Timed out waiting for ${what}.`)
    await new Promise((r) => setTimeout(r, 50))
  }
}

function setInput(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  setter?.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

defineHandle({
  name: 'scratchpad.do',
  side: 'renderer',
  description:
    "Clicks through a Scratchpads tab (tab, or the first one) the way a user does. op: select picks the scratchpad id from the header menu; mode picks mode (normal, headless-graphics, headless-nographics) in the stopped scratchpad's mode list, or in the running one's Editor menu; create opens the menu, clicks New scratchpad, types name and submits (which also starts it); start, stop, restart click those toolbar buttons; delete clicks Delete and confirms; play toggles Play/Stop, pause toggles Pause and mute toggles Mute in the streamed player; menu opens the header menu (or a Console/Tuner tab's target chip menu) and returns its rows with their hover titles, left open. target: for a Unity Console or Tuner tab, picks id (or 'project') from its target chip. Returns scratchpad.state for that tab right after. trace records every change of the drawn header, spinner, error, body and menu rows for that many ms from the click, as { ms, ui } with startedAt in epoch ms.",
  params: { op: 'select', id: '', name: '', mode: '', tab: '', trace: 0 },
  async run(p, ctx: RendererCtx) {
    const op = String(p.op)
    const tab = op === 'target' || (op === 'menu' && p.tab) ? scratchTabAny(ctx, p.tab) : scratchTab(ctx, p.tab)
    const traceMs = Math.min(120000, Number(p.trace) || 0)
    const t0 = performance.now()
    const startedAt = Date.now()
    const stopTrace = traceMs > 0 ? startTrace(tab, t0) : null
    if (op === 'menu') {
      const chip = tab.contentType !== 'unity-scratchpad'
      const opener = chip ? findPane(tab)?.querySelector('[data-unity-target]') : document.querySelector(`[data-scratchpad-panel="${CSS.escape(tab.ptyId)}"] [data-scratchpad-selector]`)
      const rowSel = chip ? '[data-unity-target-option]' : '[data-menu-layer] [data-scratchpad-option]'
      if (!document.querySelector(rowSel)) click(opener, 'the scratchpad menu')
      await settle()
      const rows = [...document.querySelectorAll(rowSel)].map((r) => ({
        id: r.getAttribute('data-scratchpad-option') ?? r.getAttribute('data-unity-target-option'),
        text: text(r),
        title: r.getAttribute('title')
      }))
      if (traceMs > 0) await new Promise((r) => setTimeout(r, traceMs))
      return { rows, trace: stopTrace?.() ?? null, startedAt }
    }
    if (op === 'target') {
      const pane = await waitFor(() => findPane(tab), 3000, 'the target chip')
      click(pane.querySelector('[data-unity-target]'), 'the target chip')
      await settle()
      click(await waitFor(() => document.querySelector(`[data-unity-target-option="${CSS.escape(String(p.id || 'project'))}"]`), 2000, 'the target option'), 'the target option')
    } else {
      const panel = await waitFor(() => document.querySelector(`[data-scratchpad-panel="${CSS.escape(tab.ptyId)}"]`), 3000, 'the Scratchpads panel')
      const button = (title: string): Element | null =>
        [...panel.querySelectorAll('button[title]')].find((b) => b.getAttribute('title') === title) ?? null
      if (op === 'select' || op === 'create') {
        const menuOpen = (): boolean => !!document.querySelector('[data-menu-layer] [data-scratchpad-option], [data-menu-layer] input')
        if (!menuOpen() && panel.querySelector('[data-scratchpad-selector]')) click(panel.querySelector('[data-scratchpad-selector]'), 'the scratchpad menu')
        await settle()
        if (op === 'select') {
          click(await waitFor(() => document.querySelector(`[data-scratchpad-option="${CSS.escape(String(p.id))}"]`), 2000, `scratchpad ${String(p.id)} in the menu`), 'the option')
        } else {
          const newBtn = [...document.querySelectorAll('[data-menu-layer] button')].find((b) => text(b) === 'New scratchpad')
          if (newBtn) click(newBtn, 'New scratchpad')
          await settle()
          const input = await waitFor(() => (document.querySelector('[data-menu-layer] input[placeholder="Name (optional)"]') ?? panel.querySelector('input[placeholder="Name (optional)"]')) as HTMLInputElement | null, 2000, 'the name field')
          setInput(input, String(p.name ?? ''))
          await settle()
          ;(input.form as HTMLFormElement).requestSubmit()
        }
      } else if (op === 'play' || op === 'pause' || op === 'mute') {
        const sel = op === 'play' ? '[data-unity-playback] button' : op === 'pause' ? '[data-unity-playback] button:nth-of-type(2)' : 'button[title="Mute"], button[title="Unmute"]'
        click(panel.querySelector(sel), `the ${op} button`)
      } else if (op === 'mode') {
        const label = MODE_LABELS[String(p.mode)]
        if (!label) throw new Error(`Unknown mode ${String(p.mode)}: use normal, headless-graphics or headless-nographics.`)
        const rowOf = (root: ParentNode | null | undefined): Element | null =>
          [...(root?.querySelectorAll('button') ?? [])].find((b) => text(b.querySelector('span')).replace(/Active$/, '').trim() === label) ?? null
        const picker = panel.querySelector('[data-scratchpad-mode-picker]')
        if (picker) click(rowOf(picker), `the ${label} row`)
        else {
          click(panel.querySelector('button[title="Unity mode & live editor options"]'), 'the Editor menu')
          await settle()
          const row = await waitFor(() => rowOf(document.body.querySelector('.surface-overlay')), 2000, `the ${label} row`)
          if ((row as HTMLButtonElement).disabled) throw new Error(`${label} is disabled: ${text(document.body.querySelector('.surface-overlay p'))}`)
          click(row, `the ${label} row`)
        }
      } else if (op === 'start' || op === 'stop' || op === 'restart') {
        const title = `${op[0].toUpperCase()}${op.slice(1)} scratchpad`
        click(button(title), `the ${title} button`)
      } else if (op === 'delete') {
        click(button('Delete scratchpad'), 'the Delete button')
        await waitFor(() => useConfirmStore.getState().request, 2000, 'the delete confirm')
        useConfirmStore.getState().respond(true)
      } else throw new Error(`Unknown op ${op}.`)
    }
    await settle()
    if (traceMs > 0) await new Promise((r) => setTimeout(r, Math.max(0, traceMs - (performance.now() - t0))))
    const state = describe(ctx.workspaceId, (useAppStore.getState().tabsByWorkspace[ctx.workspaceId] ?? []).find((t) => t.id === tab.id) ?? tab)
    return stopTrace ? { ...state, startedAt, trace: stopTrace() } : state
  }
})

const MODE_LABELS: Record<string, string> = {
  normal: 'Normal',
  'headless-graphics': 'Headless Graphics',
  'headless-nographics': 'Headless NoGraphics'
}

function gridCells(tab: Tab): Record<string, unknown>[] {
  const panel = document.querySelector(`[data-scratchpad-panel="${CSS.escape(tab.ptyId)}"]`)
  return [...(panel?.querySelectorAll('[data-scratchpad-cell]') ?? [])].map((cell) => {
    const id = cell.getAttribute('data-scratchpad-cell') ?? ''
    const sid = gridSessionId(tab.ptyId, id)
    const canvas = cell.querySelector('canvas[data-unity-session]') as HTMLCanvasElement | null
    const rect = cell.getBoundingClientRect()
    return {
      id,
      head: text(cell.firstElementChild),
      state: cell.querySelector('[data-scratchpad-state]')?.getAttribute('data-scratchpad-state') ?? null,
      mode: cell.querySelector('[data-scratchpad-mode]')?.getAttribute('data-scratchpad-mode') ?? 'normal',
      body: text(cell.children[1]),
      size: `${Math.round(rect.width)}x${Math.round(rect.height)}`,
      canvas: canvas ? { session: canvas.dataset.unitySession, width: canvas.width, height: canvas.height, paintAgeMs: canvas.dataset.paintAt ? Math.round(performance.now() - Number(canvas.dataset.paintAt)) : null } : null,
      framesLive: !!useWorldStore.getState().framesLive[sid],
      observedMode: Object.values(useWorldStore.getState().worlds).flatMap((w) => Object.values(w.observed.instances)).find((i) => i.id === primaryWorldId(cell.getAttribute('data-scratchpad-path') ?? ''))?.unityMode ?? null,
      metrics: getMetrics(sid)
    }
  })
}

defineHandle({
  name: 'scratchpad.grid',
  side: 'renderer',
  description:
    "Shows or hides the grid of every running scratchpad in a Scratchpads tab (tab, or the first one) by clicking its All button, the way a user does. on: true shows it, false hides it, 'toggle' flips it, '' leaves it. toggles clicks the button that many more times (an even count ends where it started). open: a scratchpad id whose cell to click, which opens it on its own. frames counts the video frames per grid session for that many ms. Returns { grid, cells (id, header, state, mode, body text, size, canvas, framesLive, fps), frames, sharedView, gridOn }.",
  params: { on: '', toggles: 0, open: '', tab: '', frames: 0 },
  async run(p, ctx: RendererCtx) {
    const tab = scratchTab(ctx, p.tab)
    const panel = await waitFor(() => document.querySelector(`[data-scratchpad-panel="${CSS.escape(tab.ptyId)}"]`), 3000, 'the Scratchpads panel')
    const toggle = (): void => click(panel.querySelector('[data-scratchpad-grid-toggle]'), 'the All button')
    const isOn = (): boolean => panel.querySelector('[data-scratchpad-grid-toggle]')?.getAttribute('aria-pressed') === 'true'
    const want = p.on === true || p.on === 'true' ? true : p.on === false || p.on === 'false' ? false : p.on === 'toggle' ? !isOn() : null
    if (want !== null && want !== isOn()) {
      toggle()
      await settle()
    }
    const n = Math.min(100, Math.max(0, Number(p.toggles) || 0))
    for (let i = 0; i < n; i++) {
      toggle()
      await settle()
      await new Promise((r) => setTimeout(r, 150))
    }
    if (p.open) {
      click(await waitFor(() => panel.querySelector(`[data-scratchpad-cell="${CSS.escape(String(p.open))}"] > button`), 3000, `the cell of ${String(p.open)}`), 'the cell')
      await settle()
    }
    const frames = await countFrames(Math.min(10000, Number(p.frames) || 0))
    return {
      grid: isOn(),
      gridAttr: panel.querySelector('[data-scratchpad-grid]')?.getAttribute('data-scratchpad-grid') ?? null,
      cells: gridCells(tab),
      frames,
      sharedView: window.api.unity.sharedStats(),
      gridOn: scratchpadGridSnapshot(),
      header: text(panel.querySelector('[data-scratchpad-selector]'))
    }
  }
})

function snap(tab: Tab): string {
  if (tab.contentType === 'unity-scratchpad') {
    const panel = document.querySelector(`[data-scratchpad-panel="${CSS.escape(tab.ptyId)}"]`)
    const head = panel?.firstElementChild
    const err = panel?.querySelector('[data-scratchpad-error]')
    const rows = [...document.querySelectorAll('[data-menu-layer] [data-scratchpad-option]')].map((r) => text(r))
    return [
      text(head?.querySelector('[data-scratchpad-selector]')),
      head?.querySelector('.animate-spin') ? 'busy' : 'idle',
      err ? `error: ${text(err)}` : '',
      text(panel?.lastElementChild).slice(0, 40),
      rows.length ? `menu: ${rows.join(' | ')}` : ''
    ].filter(Boolean).join(' · ')
  }
  const pane = findPane(tab)
  const rows = [...document.querySelectorAll('[data-unity-target-option]')].map((r) => text(r))
  return [text(pane?.querySelector('[data-unity-target]')), rows.length ? `menu: ${rows.join(' | ')}` : ''].filter(Boolean).join(' · ')
}

function startTrace(tab: Tab, t0: number): () => { ms: number; ui: string }[] {
  const out: { ms: number; ui: string }[] = []
  let last = ''
  const take = (): void => {
    const s = snap(tab)
    if (s === last) return
    last = s
    out.push({ ms: Math.round(performance.now() - t0), ui: s })
  }
  take()
  const mo = new MutationObserver(take)
  mo.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class', 'title'] })
  return () => {
    mo.disconnect()
    take()
    return out
  }
}

function scratchTabAny(ctx: RendererCtx, ref: unknown): Tab {
  const tabs = useAppStore.getState().tabsByWorkspace[ctx.workspaceId] ?? []
  const want = String(ref ?? '')
  const tab = tabs.find((t) => t.id === want || t.ptyId === want)
  if (!tab) throw new Error(`There is no tab ${want}. scratchpad.state lists them.`)
  return tab
}

function probeCode(px: Uint8ClampedArray): number {
  const n = (v: number): number => Math.max(0, Math.min(15, Math.round(v / 17)))
  return (n(px[0]) << 8) | (n(px[1]) << 4) | n(px[2])
}

defineHandle({
  name: 'stream.probe',
  side: 'renderer',
  description:
    "Watches the video canvases of the given session ids (default: every canvas on screen) for ms and, on every paint, reads the frame counter a FrameProbe scene stamps into the picture as a solid color (12 bits, mod 4096) at the top, middle and bottom of the canvas, plus the notice seq the paint came from. Per session it counts paints, regressions (an older counter after a newer one), duplicates, gaps (skipped counters), torn paints (top, middle and bottom disagree) and seq regressions. Returns { sessions: { [id]: { paints, regress, dup, gaps, torn, seqRegress, first, last, sample } }, sharedView }.",
  params: { sessions: [], ms: 5000 },
  async run(p) {
    const want = Array.isArray(p.sessions) ? (p.sessions as unknown[]).map(String) : []
    const canvases = [...document.querySelectorAll('canvas[data-unity-session]')] as HTMLCanvasElement[]
    const picked = canvases.filter((c) => !want.length || want.includes(c.dataset.unitySession ?? ''))
    const out: Record<string, { paints: number; regress: number; dup: number; gaps: number; torn: number; seqRegress: number; first: number; last: number; sample: string[] }> = {}
    const offs: (() => void)[] = []
    const probe = document.createElement('canvas')
    probe.width = 3
    probe.height = 1
    const pctx = probe.getContext('2d', { willReadFrequently: true })
    for (const c of picked) {
      const id = c.dataset.unitySession ?? ''
      const st = { paints: 0, regress: 0, dup: 0, gaps: 0, torn: 0, seqRegress: 0, first: -1, last: -1, sample: [] as string[] }
      out[id] = st
      let lastSeq = -1
      const onPaint = (): void => {
        if (!pctx || c.width < 4 || c.height < 4) return
        const x = Math.floor(c.width / 2)
        pctx.drawImage(c, x, Math.floor(c.height * 0.1), 1, 1, 0, 0, 1, 1)
        pctx.drawImage(c, x, Math.floor(c.height * 0.5), 1, 1, 1, 0, 1, 1)
        pctx.drawImage(c, x, Math.floor(c.height * 0.9), 1, 1, 2, 0, 1, 1)
        const px = pctx.getImageData(0, 0, 3, 1).data
        const top = probeCode(px.subarray(0, 4))
        const mid = probeCode(px.subarray(4, 8))
        const bot = probeCode(px.subarray(8, 12))
        const seq = Number(c.dataset.paintSeq ?? -1)
        st.paints++
        if (top !== mid || mid !== bot) st.torn++
        if (seq >= 0 && lastSeq >= 0 && seq <= lastSeq) st.seqRegress++
        if (seq >= 0) lastSeq = seq
        if (st.last >= 0) {
          const d = (mid - st.last + 4096) % 4096
          if (d === 0) st.dup++
          else if (d > 2048) st.regress++
          else if (d > 1) st.gaps += d - 1
        } else st.first = mid
        if (st.sample.length < 40 && (st.last < 0 || (mid - st.last + 4096) % 4096 > 2048 || top !== bot)) st.sample.push(`${seq}:${st.last}->${top}/${mid}/${bot}`)
        st.last = mid
      }
      c.addEventListener('unitypaint', onPaint)
      offs.push(() => c.removeEventListener('unitypaint', onPaint))
    }
    await new Promise((r) => setTimeout(r, Math.min(120000, Number(p.ms) || 5000)))
    for (const off of offs) off()
    return { sessions: out, sharedView: window.api.unity.sharedStats() }
  }
})
