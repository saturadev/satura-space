export type TunerHandleEventType = 'move' | 'down' | 'drag' | 'up' | 'leave'

export interface TunerHandleEvent {
  type: TunerHandleEventType
  x: number
  y: number
  w: number
  h: number
  button?: number
  clicks?: number
  shift?: boolean
  ctrl?: boolean
  alt?: boolean
  cmd?: boolean
}

export type TunerHandlesRequest = ({ op: 'event' } & TunerHandleEvent) | { op: 'state' } | { op: 'tool'; tool: null }

export interface TunerHandlesState {
  tool: boolean
  editors: boolean
  name: string
  near: boolean
  hot: boolean
  used: boolean
}

export const NO_HANDLES: TunerHandlesState = { tool: false, editors: false, name: '', near: false, hot: false, used: false }

const TYPES: readonly string[] = ['move', 'down', 'drag', 'up', 'leave']

function num(v: unknown, lo: number, hi: number): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null
}

export function cleanTunerHandlesRequest(req: unknown): Record<string, unknown> | null {
  if (!req || typeof req !== 'object') return null
  const r = req as Record<string, unknown>
  if (r.op === 'state') return { op: 'state' }
  if (r.op === 'tool') return { op: 'tool' }
  if (r.op !== 'event' || typeof r.type !== 'string' || !TYPES.includes(r.type)) return null
  const x = num(r.x, -1e5, 1e5)
  const y = num(r.y, -1e5, 1e5)
  const w = num(r.w, 0, 1e5)
  const h = num(r.h, 0, 1e5)
  if (x === null || y === null || w === null || h === null) return null
  const out: Record<string, unknown> = { op: 'event', type: r.type, x, y, w, h }
  const button = num(r.button, 0, 4)
  if (button !== null) out.button = Math.round(button)
  const clicks = num(r.clicks, 0, 3)
  if (clicks !== null) out.clicks = Math.round(clicks)
  for (const k of ['shift', 'ctrl', 'alt', 'cmd'] as const) if (r[k] === true) out[k] = true
  return out
}

export function parseTunerHandlesState(v: unknown): TunerHandlesState {
  if (!v || typeof v !== 'object') return NO_HANDLES
  const o = v as Record<string, unknown>
  return {
    tool: o.tool === true,
    editors: o.editors === true,
    name: typeof o.name === 'string' ? o.name : '',
    near: o.near === true,
    hot: o.hot === true,
    used: o.used === true
  }
}
