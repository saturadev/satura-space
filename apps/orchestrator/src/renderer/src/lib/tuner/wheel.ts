export type WheelDevice = 'trackpad' | 'mouse' | 'unsure'
export type WheelMode = 'orbit' | 'pan' | 'zoom' | 'pinch'

interface WheelLike {
  deltaX: number
  deltaY: number
  deltaMode: number
  wheelDeltaX?: number
  wheelDeltaY?: number
  ctrlKey: boolean
  shiftKey: boolean
}

export interface WheelStream {
  at: number
  device: WheelDevice
  mode: WheelMode
  ctrl: boolean
  shift: boolean
  blocked: boolean
}

export const WHEEL_GAP_MS = 140
export const PINCH_PER_UNIT = 0.01

function nearTick(d: number): boolean {
  const a = Math.abs(d)
  return a >= 39.5 && Math.abs(a - 40 * Math.round(a / 40)) <= 0.4
}

function wheelDevice(e: WheelLike): WheelDevice {
  if (e.deltaMode !== 0) return 'mouse'
  const wx = e.wheelDeltaX ?? 0
  const wy = e.wheelDeltaY ?? 0
  if (wx === 0 && wy === 0) return 'mouse'
  if (Math.abs(wy + 3 * e.deltaY) >= 1 || Math.abs(wx + 3 * e.deltaX) >= 1) return 'mouse'
  if ((e.deltaX === 0 && nearTick(e.deltaY)) || (e.deltaY === 0 && nearTick(e.deltaX))) return 'unsure'
  return 'trackpad'
}

export function wheelMode(device: WheelDevice, ctrl: boolean, shift: boolean, planar: boolean): WheelMode {
  if (ctrl) return 'pinch'
  if (device !== 'trackpad') return 'zoom'
  return planar || shift ? 'pan' : 'orbit'
}

export function wheelStream(prev: WheelStream | null, e: WheelLike, now: number, planar: boolean): WheelStream {
  const fresh = !prev || now - prev.at > WHEEL_GAP_MS
  const seen = wheelDevice(e)
  const device: WheelDevice = fresh || !prev || prev.ctrl !== e.ctrlKey ? seen : prev.device === 'unsure' && seen === 'trackpad' ? 'trackpad' : prev.device
  const blocked = !fresh && !!prev?.blocked
  return { at: now, device, mode: wheelMode(device, e.ctrlKey, e.shiftKey, planar), ctrl: e.ctrlKey, shift: e.shiftKey, blocked }
}

export function blockWheel(s: WheelStream | null): WheelStream | null {
  return s ? { ...s, blocked: true } : null
}

export function wheelPixels(e: WheelLike): [number, number] {
  const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1
  return [e.deltaX * k, e.deltaY * k]
}

export function pinchFactor(deltaY: number): number {
  return Math.exp(Math.max(-0.5, Math.min(0.5, deltaY * PINCH_PER_UNIT)))
}
