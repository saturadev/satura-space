import type { ReportBridge, ReportGit } from '../components/report/report-context'
import type { MediaDownloaded, MediaHeld, MediaLoader, MediaInfo, MediaProgress, MediaSaved } from '../lib/media-loader'
import type { RemoteVideoPlan, RemoteVideoStill } from '@shared/remote-protocol'
import { call, notify } from './channel'

export function frameBridge(opts: { canAct: boolean; recording: boolean }): ReportBridge {
  const git = {
    getState: () => call('git.getState', []),
    getCommit: (_root: string, ref: string) => call('git.getCommit', [ref]),
    diffBetweenWithStats: (_root: string, ref1: string | undefined, ref2: string) => call('git.diffBetweenWithStats', [ref1, ref2]),
    show: (_root: string, path: string, ref: string) => call('git.show', [path, ref]),
    patch: (_root: string, path: string, oldPath: string, ref1: string, ref2: string) => call('git.patch', [path, oldPath, ref1, ref2])
  } as unknown as ReportGit
  return {
    statPath: (p) => call('statPath', [p]),
    codeRefs: (_file, _root, refs) => call('codeRefs', [refs]),
    readCode: (_file, _root, rel) => call('readCode', [rel]),
    git,
    action: opts.canAct ? (_file, code) => call('action', [code]) : undefined,
    fileInfo: () => call('fileInfo', []),
    diag: (line) => notify('diag', [line]),
    mediaInfo: (_file, _root, path) => call<MediaInfo | null>('media.info', [path]),
    mediaRead: (_file, _root, path, offset, length) => call<{ data: ArrayBuffer; size: number }>('media.read', [path, offset, length]).then((r) => ({ size: r.size, data: new Uint8Array(r.data) })),
    saveMedia: (_file, _root, ask, onProgress) => call<MediaSaved>('media.save', [ask], (got, total) => onProgress?.({ got, total })),
    recording: opts.recording
  }
}

const KEEP_IDLE_MS = 60_000

interface Held {
  url: string | null
  refs: number
  idleAt: number
}

export function proxyMediaLoader(): MediaLoader {
  const held = new Map<string, Held>()
  const loading = new Map<string, Promise<string>>()
  let sweep = 0
  const schedule = (): void => {
    if (sweep) return
    sweep = window.setTimeout(() => {
      sweep = 0
      const now = Date.now()
      for (const [p, h] of held) {
        if (h.refs > 0 || now - h.idleAt < KEEP_IDLE_MS) continue
        if (h.url) URL.revokeObjectURL(h.url)
        held.delete(p)
      }
      if ([...held.values()].some((h) => h.refs === 0)) schedule()
    }, KEEP_IDLE_MS)
  }
  return {
    cached: (p) => held.get(p)?.url ?? null,
    load(p, onProgress) {
      const hit = held.get(p)?.url
      if (hit) return Promise.resolve(hit)
      let job = loading.get(p)
      if (!job) {
        job = call<{ data: ArrayBuffer; type: string }>('media.load', [p], (got, total) => onProgress?.({ got, total }))
          .then(({ data, type }) => {
            const url = URL.createObjectURL(new Blob([data], { type }))
            const cur = held.get(p)
            if (cur) {
              if (cur.url) URL.revokeObjectURL(cur.url)
              cur.url = url
              cur.idleAt = Date.now()
            } else held.set(p, { url, refs: 0, idleAt: Date.now() })
            schedule()
            return url
          })
          .finally(() => loading.delete(p))
        loading.set(p, job)
      }
      return job
    },
    acquire(p) {
      const h = held.get(p) ?? { url: null, refs: 0, idleAt: Date.now() }
      held.set(p, h)
      h.refs++
      let done = false
      return () => {
        if (done) return
        done = true
        const cur = held.get(p)
        if (!cur) return
        cur.refs = Math.max(0, cur.refs - 1)
        cur.idleAt = Date.now()
        schedule()
      }
    },
    read: (p, offset, length) => call<{ data: ArrayBuffer; size: number; type: string }>('media.read', [p, offset, length]).then((r) => ({ size: r.size, type: r.type, data: new Uint8Array(r.data) })),
    download: (p, onProgress, scope) => call<MediaDownloaded>('media.download', scope?.tag ? [p, scope.tag] : [p], (got, total) => onProgress?.({ got, total })),
    held: (of) => call<MediaHeld[]>('media.held', [of]),
    saved: (p) => call<MediaProgress | null>('media.saved', [p]),
    stop: (p, why) => notify('media.stop', [p, why]),
    note: (line) => notify('diag', [line]),
    info: (p) => call<MediaInfo | null>('media.info', [p]),
    plan: (p, prepare, want) => call<RemoteVideoPlan>('media.plan', [p, prepare, want]),
    still: (p) => call<RemoteVideoStill>('media.still', [p])
  }
}
