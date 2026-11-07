import type { TunerResult } from '@shared/tuner'
import { NO_HANDLES, type TunerHandleEvent, type TunerHandlesRequest, type TunerHandlesState } from '@shared/tuner-handles'

export type HandlesSend = (req: TunerHandlesRequest) => Promise<TunerResult<TunerHandlesState>>

export interface UnityHandles {
  readonly state: TunerHandlesState
  push: (ev: TunerHandleEvent) => void
  release: () => void
  refresh: () => void
  dispose: () => void
}

const IDLE_PROBE_MS = 250

export function createUnityHandles(send: HandlesSend, onChange: (s: TunerHandlesState) => void): UnityHandles {
  let state = NO_HANDLES
  let busy = false
  let dead = false
  let lastIdle = 0
  const queue: TunerHandlesRequest[] = []

  const apply = (next: TunerHandlesState): void => {
    if (next.tool === state.tool && next.editors === state.editors && next.near === state.near && next.hot === state.hot && next.name === state.name) {
      state = next
      return
    }
    state = next
    onChange(next)
  }

  const pump = (): void => {
    if (busy || dead) return
    const req = queue.shift()
    if (!req) return
    busy = true
    send(req)
      .then((r) => {
        if (!dead && r.ok) apply(r.data)
      })
      .catch(() => {})
      .finally(() => {
        busy = false
        pump()
      })
  }

  const lossy = (r: TunerHandlesRequest | undefined, type: string): boolean =>
    !!r && r.op === 'event' && r.type === type && (type === 'move' || type === 'drag')

  return {
    get state() {
      return state
    },
    push(ev) {
      if (dead) return
      if (ev.type === 'move' && !state.tool && !state.editors) {
        const now = performance.now()
        if (now - lastIdle < IDLE_PROBE_MS) return
        lastIdle = now
      }
      if (ev.type === 'leave' && !state.tool && !state.editors && !state.near) return
      const req: TunerHandlesRequest = { op: 'event', ...ev }
      if (lossy(queue[queue.length - 1], ev.type)) queue[queue.length - 1] = req
      else queue.push(req)
      pump()
    },
    release() {
      if (dead || !state.tool) return
      queue.push({ op: 'tool', tool: null })
      pump()
    },
    refresh() {
      if (dead || (!state.tool && !state.editors)) return
      queue.push({ op: 'state' })
      pump()
    },
    dispose() {
      dead = true
      queue.length = 0
    }
  }
}
