export const INPUT_PROTOCOL = 2

export const MOD_SHIFT = 1
export const MOD_CTRL = 2
export const MOD_ALT = 4
export const MOD_META = 8
export const MOD_CAPS = 16
export const MOD_ALTGR = 32
export const MOD_NUM = 64

export type InputEvent =
  | { k: 'kd'; t: number; c: string; r: number; m: number }
  | { k: 'ku'; t: number; c: string; m: number }
  | { k: 'tx'; t: number; s: string; m: number }
  | { k: 'md' | 'mu'; t: number; b: number; x: number; y: number; n: number; m: number }
  | { k: 'mm'; t: number; x: number; y: number; dx: number; dy: number; m: number }
  | { k: 'wh'; t: number; x: number; y: number; dx: number; dy: number; wx: number; wy: number; m: number }
  | { k: 'fo'; t: number; v: number }

export interface InputState {
  keys: Set<string>
  mx: number
  my: number
  btn: number
  locked: boolean
  focus: boolean
  dx: number
  dy: number
  sx: number
  sy: number
  events: InputEvent[]
  push: (e: InputEvent) => void
  wake: () => void
}

export interface InputPayload {
  v: number
  sid: string
  seq: number
  now: number
  ev: InputEvent[]
  keys: string[]
  mx: number
  my: number
  btn: number
  dx: number
  dy: number
  locked: number
  sx: number
  sy: number
  focus: number
}

export function makeInputState(): InputState {
  const state: InputState = {
    keys: new Set(),
    mx: 0.5,
    my: 0.5,
    btn: 0,
    locked: false,
    focus: false,
    dx: 0,
    dy: 0,
    sx: 0,
    sy: 0,
    events: [],
    push: (e) => {
      state.events.push(e)
      state.wake()
    },
    wake: () => {}
  }
  return state
}

const HEARTBEAT_MS = 100
const IDLE_HEARTBEAT_MS = 500
const MAX_BATCH = 256

export function startInputLoop(send: (p: InputPayload) => void, state: InputState, sid: string): () => void {
  let seq = 0
  let scheduled = false
  let stopped = false
  let lastSentAt = 0

  const flush = (heartbeat = false): void => {
    scheduled = false
    if (stopped) return
    const now = performance.now()
    if (heartbeat && !state.focus && state.events.length === 0 && now - lastSentAt < IDLE_HEARTBEAT_MS) return
    lastSentAt = now
    do {
      const ev = state.events.length > MAX_BATCH ? state.events.splice(0, MAX_BATCH) : state.events.splice(0)
      const payload: InputPayload = {
        v: INPUT_PROTOCOL,
        sid,
        seq: ++seq,
        now: performance.now(),
        ev,
        keys: [...state.keys],
        mx: state.mx,
        my: state.my,
        btn: state.btn,
        dx: state.dx,
        dy: state.dy,
        locked: state.locked ? 1 : 0,
        sx: state.sx,
        sy: state.sy,
        focus: state.focus ? 1 : 0
      }
      state.dx = 0
      state.dy = 0
      state.sx = 0
      state.sy = 0
      send(payload)
    } while (state.events.length > 0)
  }

  state.wake = () => {
    if (scheduled || stopped) return
    scheduled = true
    queueMicrotask(() => flush())
  }
  const heartbeat = setInterval(() => flush(true), HEARTBEAT_MS)
  flush()

  return () => {
    stopped = true
    state.wake = () => {}
    clearInterval(heartbeat)
  }
}
