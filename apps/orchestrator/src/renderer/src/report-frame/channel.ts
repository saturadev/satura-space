import { REPORT_FRAME_TAG, frameMessage, type FrameEvent, type FrameLoad, type FrameMethod, type FrameQuery, type FrameSettings } from '@shared/report-frame'

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; progress?: (got: number, total: number) => void }

const pending = new Map<number, Pending>()
let nextId = 1

type QueryHandler = (q: FrameQuery) => Promise<unknown> | unknown

let onLoad: ((load: FrameLoad) => void) | null = null
let onSet: ((s: FrameSettings) => void) | null = null
let onBack: (() => void) | null = null
let queryHandler: QueryHandler | null = null
const watchers = new Set<(path: string) => void>()
const early: { load?: FrameLoad; set: FrameSettings } = { set: {} }

function post(msg: Parameters<typeof frameMessage>[0], transfer?: Transferable[]): void {
  window.parent.postMessage(frameMessage(msg), '*', transfer ?? [])
}

export function call<T>(m: FrameMethod, a: unknown[], progress?: (got: number, total: number) => void): Promise<T> {
  const id = nextId++
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, progress })
    post({ t: 'call', id, m, a })
  })
}

export function notify(m: FrameMethod, a: unknown[]): void {
  void call(m, a).catch(() => {})
}

export function emit(ev: FrameEvent): void {
  try {
    post({ t: 'ev', ev })
  } catch {
    if (ev.e === 'view') post({ t: 'ev', ev: { e: 'view', view: { scrollTop: ev.view.scrollTop } } })
  }
}

export function onFrameLoad(cb: (load: FrameLoad) => void): void {
  onLoad = cb
  if (early.load) cb(early.load)
}

export function onFrameSet(cb: (s: FrameSettings) => void): void {
  onSet = cb
  if (Object.keys(early.set).length) cb(early.set)
}

export function onFrameBack(cb: () => void): void {
  onBack = cb
}

export function onFrameQuery(cb: QueryHandler): void {
  queryHandler = cb
}

export function onWatch(cb: (path: string) => void): () => void {
  watchers.add(cb)
  return () => watchers.delete(cb)
}

function answer(id: number, run: () => Promise<unknown> | unknown): void {
  Promise.resolve()
    .then(run)
    .then(
      (value) => post({ t: 'answer', id, ok: true, value }),
      (e: unknown) => post({ t: 'answer', id, ok: false, error: e instanceof Error ? e.message : String(e) })
    )
}

export function startChannel(): void {
  window.addEventListener('message', (e: MessageEvent) => {
    if (e.source !== window.parent) return
    const d = e.data as Record<string, unknown> | null
    if (!d || typeof d !== 'object' || d.$sf !== REPORT_FRAME_TAG) return
    switch (d.t) {
      case 'load':
        early.load = d.load as FrameLoad
        onLoad?.(d.load as FrameLoad)
        return
      case 'set':
        Object.assign(early.set, d.set as FrameSettings)
        onSet?.(d.set as FrameSettings)
        return
      case 'reply': {
        const p = pending.get(d.id as number)
        if (!p) return
        pending.delete(d.id as number)
        if (d.ok) p.resolve(d.value)
        else p.reject(new Error(String(d.error ?? 'The call failed')))
        return
      }
      case 'progress':
        pending.get(d.id as number)?.progress?.(Number(d.got), Number(d.total))
        return
      case 'query': {
        const q = d.query as FrameQuery
        answer(d.id as number, () => {
          if (!queryHandler) throw new Error('The report is still loading')
          return queryHandler(q)
        })
        return
      }
      case 'back':
        onBack?.()
        return
      case 'watch':
        for (const w of watchers) w(String(d.path))
        return
    }
  })
  post({ t: 'ready' })
}
