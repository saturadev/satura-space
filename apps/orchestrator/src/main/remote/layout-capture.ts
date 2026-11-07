import { createHash } from 'node:crypto'
import type { NativeImage, WebContents } from 'electron'
import type { RvLayout, RvLayoutGroup } from '@shared/remote-video'
import { remoteVideo } from '../remote-video'
import { frontmostWindow } from '../window/window-manager'
import { censusGauge, censusTrack } from '@shared/census'
import { debugLog } from '@shared/debug-log'

const PERIOD_MS = 5000
const SETTLE_MS = 700
const JPEG_QUALITY = 72
const MAX_TILE_SIDE = 1600

interface Rect {
  id: string
  tab: string | null
  x: number
  y: number
  w: number
  h: number
  cover: string | null
}

interface Probe {
  groups: Rect[]
  focused: string | null
}

const PROBE = `(() => {
  const groups = []
  let focused = null
  const related = (a, b) => a === b || a.contains(b) || b.contains(a)
  const overlayRoot = (hit, group) => {
    let n = hit
    while (n.parentElement && !n.parentElement.contains(group)) n = n.parentElement
    return n
  }
  const describe = (el) => {
    const cls = typeof el.className === 'string' ? el.className.trim().split(/\\s+/).filter(Boolean).slice(0, 4).join('.') : ''
    const named = el.getAttribute('aria-label') || el.getAttribute('role') || [...el.attributes].map((a) => a.name).find((n) => n.startsWith('data-')) || ''
    return (el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + (cls ? '.' + cls : '') + (named ? ' (' + named + ')' : '')).slice(0, 120)
  }
  const shown = (el) => {
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      const cs = getComputedStyle(n)
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false
    }
    return true
  }
  const layers = new Set()
  for (const el of document.body.children) if (el.id !== 'root' && el.tagName !== 'SCRIPT' && el.tagName !== 'STYLE') layers.add(el)
  for (const el of document.querySelectorAll('.fixed, [role="dialog"], [role="menu"], [role="listbox"], [role="tooltip"], [aria-modal="true"]')) layers.add(el)
  for (const el of document.querySelectorAll('[data-pane-group]')) {
    const body = el.querySelector('[data-group-id]') || el
    const r = body.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const id = el.getAttribute('data-pane-group')
    if (el.getAttribute('data-group-focused') === 'true') focused = id
    let cover = null
    for (let i = 0; i < 6 && !cover; i++) {
      for (let j = 0; j < 5 && !cover; j++) {
        const x = r.left + 2 + ((r.width - 4) * (i + 0.5)) / 6
        const y = r.top + 2 + ((r.height - 4) * (j + 0.5)) / 5
        const hit = document.elementFromPoint(x, y)
        if (hit && !related(el, hit)) cover = describe(overlayRoot(hit, el))
      }
    }
    if (!cover) {
      for (const layer of layers) {
        if (layer === el || layer.contains(el)) continue
        if (el.contains(layer) && !layer.classList.contains('fixed')) continue
        const lr = layer.getBoundingClientRect()
        if (lr.width < 1 || lr.height < 1 || lr.right <= r.left || lr.left >= r.right || lr.bottom <= r.top || lr.top >= r.bottom) continue
        if (!shown(layer)) continue
        cover = describe(overlayRoot(layer, el))
        break
      }
    }
    groups.push({ id, tab: el.getAttribute('data-active-tab'), x: r.left, y: r.top, w: r.width, h: r.height, cover })
  }
  return { groups, focused }
})()`

let on = false
let tile: { w: number; h: number } | null = null
let timer: NodeJS.Timeout | null = null
let running = false
let cycle = 0
let settleTimer: NodeJS.Timeout | null = null
const covers = new Map<string, string>()
const hashes = new Map<string, string>()
const tabFrames = new Map<string, Buffer>()
const sentTabFrames = new Set<string>()
const MAX_TAB_FRAMES = 40
censusTrack('remote-layout.covers', covers)
censusTrack('remote-layout.hashes', hashes)
censusTrack('remote-layout.tabFrames', tabFrames)
censusTrack('remote-layout.sentTabFrames', sentTabFrames)
censusGauge('remote-layout.on', () => (on ? 1 : 0))
censusGauge('remote-layout.timer', () => (timer ? 1 : 0))
censusGauge('remote-layout.cycles', () => cycle)

function log(line: string): void {
  console.log(`[remote-layout] ${line}`)
}

function target(): WebContents | null {
  const win = frontmostWindow()
  return win && !win.isDestroyed() ? win.webContents : null
}

function layoutOf(p: Probe): { layout: RvLayout; box: { x: number; y: number; w: number; h: number } } | null {
  if (!p.groups.length) return null
  const x0 = Math.min(...p.groups.map((g) => g.x))
  const y0 = Math.min(...p.groups.map((g) => g.y))
  const x1 = Math.max(...p.groups.map((g) => g.x + g.w))
  const y1 = Math.max(...p.groups.map((g) => g.y + g.h))
  const w = Math.max(1, x1 - x0)
  const h = Math.max(1, y1 - y0)
  const groups: RvLayoutGroup[] = p.groups.map((g) => ({ id: g.id, tab: g.tab, x: (g.x - x0) / w, y: (g.y - y0) / h, w: g.w / w, h: g.h / h }))
  return { layout: { workspaceId: null, width: Math.round(w), height: Math.round(h), groups, focused: p.focused }, box: { x: x0, y: y0, w, h } }
}

function settleSoon(): void {
  if (settleTimer) return
  settleTimer = setTimeout(() => {
    settleTimer = null
    void capture()
  }, SETTLE_MS)
}

function noteCovers(groups: Rect[]): Set<string> {
  const settling = new Set<string>()
  const seen = new Set<string>()
  for (const g of groups) {
    seen.add(g.id)
    const was = covers.get(g.id)
    if (g.cover) {
      if (was !== g.cover) log(`group ${g.id}${g.tab ? ` (tab ${g.tab})` : ''} is under ${g.cover}, the phone keeps its last clean tile`)
      covers.set(g.id, g.cover)
    } else if (was !== undefined) {
      covers.delete(g.id)
      settling.add(g.id)
      log(`group ${g.id}${g.tab ? ` (tab ${g.tab})` : ''} is clear of ${was} again, capturing it in ${SETTLE_MS} ms`)
    }
  }
  for (const id of [...covers.keys()]) if (!seen.has(id)) covers.delete(id)
  if (settling.size) settleSoon()
  return settling
}

function sameRect(a: Rect, b: Rect | undefined): boolean {
  return !!b && Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1 && Math.abs(a.w - b.w) < 1 && Math.abs(a.h - b.h) < 1
}

async function capture(): Promise<void> {
  if (running || !on) return
  const wc = target()
  if (!wc || !remoteVideo.hasTiles()) return
  running = true
  const t0 = performance.now()
  try {
    const probe = (await wc.executeJavaScript(PROBE, true)) as Probe
    if (!on) return
    const res = layoutOf(probe)
    if (!res) {
      debugLog(`[remote-layout] cycle ${++cycle}: no tab groups on screen`)
      return
    }
    remoteVideo.sendLayoutMsg({ t: 'layout', layout: res.layout })
    const settling = noteCovers(probe.groups)
    const shots: { g: Rect; img: NativeImage }[] = []
    for (const g of probe.groups) {
      if (g.cover || settling.has(g.id)) continue
      const img = await wc.capturePage({ x: Math.round(g.x), y: Math.round(g.y), width: Math.round(g.w), height: Math.round(g.h) })
      if (!on) return
      if (!img.isEmpty()) shots.push({ g, img })
    }
    const after = shots.length ? ((await wc.executeJavaScript(PROBE, true)) as Probe) : probe
    if (!on) return
    if (after !== probe) noteCovers(after.groups)
    let changed = 0
    let bytes = 0
    let dropped = 0
    for (const { g, img } of shots) {
      const now = after.groups.find((a) => a.id === g.id)
      if (!now || now.cover || now.tab !== g.tab || !sameRect(g, now)) {
        dropped++
        continue
      }
      const scale = tile ? tile.w / res.box.w : 0.5
      const full = img.getSize()
      const tw = Math.max(16, Math.min(MAX_TILE_SIDE, full.width, Math.round(g.w * scale)))
      const th = Math.max(16, Math.min(MAX_TILE_SIDE, full.height, Math.round(g.h * scale)))
      const small = tw === full.width && th === full.height ? img : img.resize({ width: tw, height: th, quality: 'good' })
      const hash = createHash('sha1').update(small.toBitmap()).digest('hex')
      if (hashes.get(g.id) === hash) continue
      const jpeg = small.toJPEG(JPEG_QUALITY)
      if (!remoteVideo.sendTile(g.id, jpeg)) break
      hashes.set(g.id, hash)
      if (g.tab) {
        tabFrames.delete(g.tab)
        tabFrames.set(g.tab, jpeg)
        sentTabFrames.add(g.tab)
        while (tabFrames.size > MAX_TAB_FRAMES) tabFrames.delete(tabFrames.keys().next().value as string)
      }
      changed++
      bytes += jpeg.byteLength
    }
    const shown = new Set(probe.groups.map((g) => g.tab).filter(Boolean))
    let seen = 0
    for (const [tab, jpeg] of tabFrames) {
      if (shown.has(tab) || sentTabFrames.has(tab)) continue
      if (!remoteVideo.sendTile(`tab:${tab}`, jpeg)) break
      sentTabFrames.add(tab)
      seen++
      bytes += jpeg.byteLength
    }
    const held = probe.groups.filter((g) => g.cover || settling.has(g.id)).length
    debugLog(`[remote-layout] cycle ${++cycle}: ${probe.groups.length} groups, ${changed} changed, ${held} under an overlay or settling, ${dropped} dropped because an overlay or move came during the capture, ${seen} last-seen tab frames, sent ${Math.round(bytes / 1024)} KB in ${Math.round(performance.now() - t0)} ms`)
  } catch (e) {
    log(`capture failed: ${(e as Error).message}`)
  } finally {
    running = false
  }
}

function forget(): void {
  covers.clear()
  hashes.clear()
  tabFrames.clear()
  sentTabFrames.clear()
  tile = null
}

function setOn(next: boolean, nextTile: { w: number; h: number } | null, ended = false): void {
  if (ended) forget()
  if (nextTile && (nextTile.w !== tile?.w || nextTile.h !== tile?.h)) {
    tile = nextTile
    hashes.clear()
  }
  if (next === on) {
    if (on) void capture()
    return
  }
  on = next
  if (timer) clearInterval(timer)
  timer = null
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = null
  if (!on) {
    log('off')
    return
  }
  hashes.clear()
  sentTabFrames.clear()
  cycle = 0
  log(`on, phone tile ${tile ? `${tile.w}x${tile.h}` : 'unknown'}`)
  timer = setInterval(() => void capture(), PERIOD_MS)
  void capture()
}

export function startLayoutCapture(): void {
  remoteVideo.setLayoutHandler((next, nextTile, ended) => setOn(next, nextTile, ended))
}
