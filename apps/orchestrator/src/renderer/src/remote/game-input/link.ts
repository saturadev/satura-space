import { GI_FAST, GI_RELIABLE, type GiEvent, type GiLive, type GiMacMsg, type GiPayload, type GiPhoneMsg } from '@shared/game-input'
import type { RcEffective, RcPatch } from '@shared/remote-controls'

export type GiTarget = { t: 'key'; key: string } | { t: 'mouse'; b: number } | { t: 'pad'; b: string } | { t: 'wheel'; dir: 1 | -1 }

export interface GiMacState {
  open: boolean
  source: string | null
  project: string | null
  clone: boolean
  live: GiLive | null
  controls: RcEffective | null
  controlsProject: string | null
  controlsError: string | null
  controlsAt: number
  cursor: { locked: boolean; visible: boolean } | null
}

const HEARTBEAT_MS = 250

const sid = 'phone:' + Math.random().toString(36).slice(2, 10)
let reliable: RTCDataChannel | null = null
let fast: RTCDataChannel | null = null
let mac: GiMacState = { open: false, source: null, project: null, clone: false, live: null, controls: null, controlsProject: null, controlsError: null, controlsAt: 0, cursor: null }
const listeners = new Set<() => void>()

const keys = new Map<string, number>()
const buttons = [0, 0, 0, 0, 0]
const pads = new Map<string, number>()
let active = false
let heartbeat: ReturnType<typeof setInterval> | null = null
let ax = 0
let ay = 0
let aw = 0
let useq = 0
let px = 0.5
let py = 0.5
let posKnown = false
let posDirty = false
let accDirty = false
let stick = { lx: 0, ly: 0, rx: 0, ry: 0 }
let stickDirty = false
let frame = 0

function notify(): void {
  for (const l of listeners) l()
}

function patch(p: Partial<GiMacState>): void {
  mac = { ...mac, ...p }
  notify()
}

export function gameInputState(): GiMacState {
  return mac
}

export function onGameInput(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

function sendMac(m: GiPhoneMsg): boolean {
  const ch = reliable
  if (!ch || ch.readyState !== 'open') return false
  try {
    ch.send(JSON.stringify(m))
    return true
  } catch {
    return false
  }
}

function onMac(m: GiMacMsg): void {
  if (m.t === 'target') {
    if (m.source !== mac.source) resetMotion()
    const moved = m.source !== mac.source
    patch({ source: m.source, project: m.project, clone: m.clone, ...(moved ? { live: null, cursor: null } : {}) })
    console.info(`[game-input] input goes to ${m.source ?? 'nothing'}${m.clone ? ' (a clone)' : ''}${moved && m.source ? ', play state unknown until the desktop sends it' : ''}`)
    return
  }
  if (m.t === 'live') {
    if (m.source !== mac.source) return
    const was = mac.live ? (mac.live.playing ? (mac.live.paused ? 'paused' : 'playing') : 'not playing') : 'unknown'
    const now = m.live.playing ? (m.live.paused ? 'paused' : 'playing') : 'not playing'
    if (was !== now) console.info(`[game-input] the desktop says ${m.source} is ${now} (was ${was})`)
    patch({ live: m.live })
    return
  }
  if (m.t === 'controls') {
    const shown = m.controls ? m.controls.maps.reduce((n, x) => n + x.controls.filter((c) => c.visible).length, 0) : 0
    console.info(`[game-input] controls for ${m.project}: ${m.controls ? `${m.controls.maps.length} maps, ${shown} shown, ${m.controls.issues.length} issues` : 'none'}${m.error ? `, refused: ${m.error}` : ''}`)
    patch({ controls: m.controls, controlsProject: m.project, controlsError: m.error ?? null, controlsAt: performance.now() })
    return
  }
  if (m.t === 'cursor') {
    if (m.source === mac.source) patch({ cursor: { locked: m.locked, visible: m.visible } })
  }
}

export function setGameChannel(ch: RTCDataChannel): void {
  if (ch.label === GI_RELIABLE) {
    reliable = ch
    const opened = (): void => {
      if (reliable !== ch) return
      patch({ open: true })
      sendMac({ t: 'hello', sid })
      if (active) sendState()
    }
    ch.onopen = opened
    ch.onclose = () => {
      if (reliable !== ch) return
      reliable = null
      resetMotion()
      patch({ open: false })
    }
    ch.onmessage = (e) => {
      try {
        onMac(JSON.parse(String(e.data)) as GiMacMsg)
      } catch {
      }
    }
    if (ch.readyState === 'open') opened()
    return
  }
  if (ch.label === GI_FAST) fast = ch
}

function resetMotion(): void {
  ax = 0
  ay = 0
  aw = 0
  accDirty = false
  stick = { lx: 0, ly: 0, rx: 0, ry: 0 }
  stickDirty = false
}

const r3 = (v: number): number => Math.round(v * 1000) / 1000
const r5 = (v: number): number => Math.round(v * 100000) / 100000

function heldKeys(): string[] {
  return [...keys.keys()]
}

function heldBtn(): number {
  let b = 0
  for (let i = 0; i < buttons.length; i++) if (buttons[i] > 0) b |= 1 << i
  return b
}

function base(): GiPayload {
  return { v: 3, sid, now: performance.now(), focus: active ? 1 : 0 }
}

function sendState(ev?: GiEvent[]): void {
  const p: GiPayload = { ...base(), ev: ev ?? [], keys: heldKeys(), btn: heldBtn(), pb: [...pads.keys()], ha: 1, ax: r3(ax), ay: r3(ay), aw: r3(aw) }
  sendMac({ t: 'in', p })
}

function flushMotion(): void {
  frame = 0
  if (!accDirty && !posDirty && !stickDirty) return
  const p: GiPayload = { ...base(), nr: 1, useq: ++useq }
  if (accDirty) Object.assign(p, { ha: 1, ax: r3(ax), ay: r3(ay), aw: r3(aw) })
  if (posDirty) Object.assign(p, { hp: 1, px: r5(px), py: r5(py) })
  if (stickDirty) Object.assign(p, { hpad: 1, lx: r3(stick.lx), ly: r3(stick.ly), rx: r3(stick.rx), ry: r3(stick.ry) })
  accDirty = posDirty = stickDirty = false
  const ch = fast
  if (ch && ch.readyState === 'open') {
    try {
      ch.send(JSON.stringify(p))
      return
    } catch {
    }
  }
  sendMac({ t: 'in', p })
}

function scheduleMotion(): void {
  if (!active || frame) return
  frame = requestAnimationFrame(flushMotion)
}

const owned = new Set<number>()

export function own(pointer: number, on: boolean): void {
  if (on) owned.add(pointer)
  else owned.delete(pointer)
}

export function ownedByControl(pointer: number): boolean {
  return owned.has(pointer)
}

export function setActive(on: boolean, why: string): void {
  if (on === active) return
  if (!on) {
    owned.clear()
    releaseAll()
    active = false
    if (heartbeat) clearInterval(heartbeat)
    heartbeat = null
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    sendMac({ t: 'bye' })
    resetMotion()
    console.info(`[game-input] phone input off: ${why}`)
    return
  }
  active = true
  resetMotion()
  sendState()
  heartbeat = setInterval(() => sendState(), HEARTBEAT_MS)
  console.info(`[game-input] phone input on: ${why}`)
}

export function isActive(): boolean {
  return active
}

export function pointer(): { x: number; y: number; known: boolean } {
  return { x: px, y: py, known: posKnown }
}

function now(): number {
  return performance.now()
}

export function press(t: GiTarget): void {
  if (!active) return
  if (t.t === 'key') {
    const n = keys.get(t.key) ?? 0
    keys.set(t.key, n + 1)
    if (n === 0) sendState([{ k: 'kd', t: now(), c: t.key, r: 0, m: 0 }])
    return
  }
  if (t.t === 'mouse') {
    const n = buttons[t.b] ?? 0
    buttons[t.b] = n + 1
    if (n === 0) {
      flushMotion()
      sendState([{ k: 'md', t: now(), b: t.b, x: r5(px), y: r5(py), n: 1, m: 0 }])
    }
    return
  }
  if (t.t === 'pad') {
    const n = pads.get(t.b) ?? 0
    pads.set(t.b, n + 1)
    if (n === 0) sendState()
    return
  }
  wheel(t.dir)
}

export function release(t: GiTarget): void {
  if (t.t === 'key') {
    const n = keys.get(t.key) ?? 0
    if (n <= 1) {
      if (!keys.delete(t.key)) return
      if (active) sendState([{ k: 'ku', t: now(), c: t.key, m: 0 }])
    } else keys.set(t.key, n - 1)
    return
  }
  if (t.t === 'mouse') {
    const n = buttons[t.b] ?? 0
    if (n <= 0) return
    buttons[t.b] = n - 1
    if (n === 1 && active) {
      flushMotion()
      sendState([{ k: 'mu', t: now(), b: t.b, x: r5(px), y: r5(py), n: 1, m: 0 }])
    }
    return
  }
  if (t.t === 'pad') {
    const n = pads.get(t.b) ?? 0
    if (n <= 1) {
      if (!pads.delete(t.b)) return
      if (active) sendState()
    } else pads.set(t.b, n - 1)
  }
}

export function pressMouse(b: number, count: number): void {
  if (!active) return
  const n = buttons[b] ?? 0
  buttons[b] = n + 1
  if (n === 0) {
    flushMotion()
    sendState([{ k: 'md', t: now(), b, x: r5(px), y: r5(py), n: count, m: 0 }])
  }
}

export function click(b: number, count = 1): void {
  if (!active) return
  flushMotion()
  sendState([
    { k: 'md', t: now(), b, x: r5(px), y: r5(py), n: count, m: 0 },
    { k: 'mu', t: now(), b, x: r5(px), y: r5(py), n: count, m: 0 }
  ])
}

export function releaseAll(): void {
  const had = keys.size > 0 || pads.size > 0 || heldBtn() !== 0 || stick.lx !== 0 || stick.ly !== 0 || stick.rx !== 0 || stick.ry !== 0
  const ev: GiEvent[] = []
  for (const k of keys.keys()) ev.push({ k: 'ku', t: now(), c: k, m: 0 })
  for (let i = 0; i < buttons.length; i++) if (buttons[i] > 0) ev.push({ k: 'mu', t: now(), b: i, x: r5(px), y: r5(py), n: 1, m: 0 })
  keys.clear()
  pads.clear()
  buttons.fill(0)
  if (stick.lx || stick.ly || stick.rx || stick.ry) {
    stick = { lx: 0, ly: 0, rx: 0, ry: 0 }
    stickDirty = true
    flushMotion()
  }
  if (active && had) sendState(ev)
}

export function moveBy(dx: number, dy: number): void {
  if (!active || (!dx && !dy)) return
  ax += dx
  ay += dy
  accDirty = true
  scheduleMotion()
}

export function wheel(notches: number): void {
  if (!active || !notches) return
  aw += notches
  accDirty = true
  scheduleMotion()
}

export function setPointer(x: number, y: number, dx = 0, dy = 0): void {
  px = Math.min(0.9999, Math.max(0, x))
  py = Math.min(0.9999, Math.max(0, y))
  posKnown = true
  if (!active) return
  posDirty = true
  if (dx || dy) {
    ax += dx
    ay += dy
    accDirty = true
  }
  scheduleMotion()
}

export function setStick(side: 'l' | 'r', x: number, y: number): void {
  if (!active) return
  const next = side === 'l' ? { ...stick, lx: x, ly: y } : { ...stick, rx: x, ry: y }
  if (next.lx === stick.lx && next.ly === stick.ly && next.rx === stick.rx && next.ry === stick.ry) return
  stick = next
  stickDirty = true
  scheduleMotion()
}

export function sendOverride(p: RcPatch): boolean {
  const ok = sendMac({ t: 'override', patch: p })
  console.info(`[game-input] override ${ok ? 'sent' : 'not sent'}: ${JSON.stringify(p).slice(0, 240)}`)
  return ok
}

export function stickState(): { lx: number; ly: number; rx: number; ry: number } {
  return { ...stick }
}

export function heldSummary(): { keys: string[]; btn: number; pads: string[] } {
  return { keys: heldKeys(), btn: heldBtn(), pads: [...pads.keys()] }
}
