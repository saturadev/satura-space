import { webContents, type WebContents } from 'electron'
import { Session } from 'node:inspector'
import { writeFileSync } from 'node:fs'
import { defineHandle, sleep, type HandleCtx } from './registry'
import { allowedOutPath } from './out-path'
import { mediaOutRoots } from './media'

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  children?: number[]
}

interface Profile {
  nodes: ProfileNode[]
  samples?: number[]
  timeDeltas?: number[]
  startTime: number
  endTime: number
}

const round = (n: number): number => Math.round(n * 10) / 10

function shortUrl(url: string): string {
  const clean = url.replace(/\?.*$/, '')
  const i = clean.indexOf('/src/')
  if (i >= 0) return clean.slice(i + 1)
  const m = clean.match(/node_modules\/(?:\.pnpm\/[^/]+\/node_modules\/)?((?:@[^/]+\/)?[^/]+)/)
  if (m) return `npm:${m[1]}`
  return clean.split('/').slice(-2).join('/')
}

function summarize(profile: Profile, top: number): Record<string, unknown> {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const self = new Map<number, number>()
  const samples = profile.samples ?? []
  const deltas = profile.timeDeltas ?? []
  for (let i = 0; i < samples.length; i++) self.set(samples[i], (self.get(samples[i]) ?? 0) + (deltas[i + 1] ?? deltas[i] ?? 0))
  const parent = new Map<number, number>()
  for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id)
  const frame = (n: ProfileNode): string => {
    const f = n.callFrame
    return `${f.functionName || '(anonymous)'} ${f.url ? shortUrl(f.url) : `(${f.functionName || 'native'})`}:${f.lineNumber + 1}`
  }
  const stacks = new Map<string, Map<string, number>>()
  const fns = new Map<string, number>()
  const files = new Map<string, number>()
  let idle = 0
  let total = 0
  for (const [id, us] of self) {
    const n = byId.get(id)
    if (!n) continue
    total += us
    const f = n.callFrame
    if (f.functionName === '(idle)') {
      idle += us
      continue
    }
    const file = f.url ? shortUrl(f.url) : `(${f.functionName || 'native'})`
    const key = frame(n)
    fns.set(key, (fns.get(key) ?? 0) + us)
    const chain: string[] = []
    for (let p = parent.get(id); p !== undefined && chain.length < 6; p = parent.get(p)) {
      const pn = byId.get(p)
      if (!pn || pn.callFrame.functionName === '(root)') break
      chain.push(frame(pn))
    }
    const byStack = stacks.get(key) ?? new Map<string, number>()
    const stack = chain.join(' < ')
    byStack.set(stack, (byStack.get(stack) ?? 0) + us)
    stacks.set(key, byStack)
    files.set(file, (files.get(file) ?? 0) + us)
  }
  const ms = (us: number): number => round(us / 1000)
  const wall = (profile.endTime - profile.startTime) / 1000
  const rank = (m: Map<string, number>): { name: string; ms: number }[] =>
    [...m].sort((a, b) => b[1] - a[1]).slice(0, top).map(([name, us]) => ({ name, ms: ms(us) }))
  return {
    wallMs: round(wall),
    busyMs: ms(total - idle),
    busyPct: wall > 0 ? round(((total - idle) / 1000 / wall) * 100) : 0,
    functions: rank(fns).map((f, i) => (i < 8 ? { ...f, via: [...(stacks.get(f.name) ?? [])].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '' } : f)),
    files: rank(files)
  }
}

function target(ctx: HandleCtx): WebContents {
  const wc = ctx.window === null ? null : webContents.fromId(ctx.window)
  if (!wc || wc.isDestroyed()) throw new Error('No app window.')
  return wc
}

export async function withDebugger<T>(wc: WebContents, run: (send: (m: string, p?: object) => Promise<any>) => Promise<T>): Promise<T> {
  const dbg = wc.debugger
  const mine = !dbg.isAttached()
  if (mine) dbg.attach('1.3')
  try {
    return await run((m, p) => dbg.sendCommand(m, p ?? {}))
  } finally {
    if (mine && dbg.isAttached() && dbg.listenerCount('message') === 0) {
      try {
        dbg.detach()
      } catch {
      }
    }
  }
}

function metricMap(list: { name: string; value: number }[]): Record<string, number> {
  return Object.fromEntries(list.map((m) => [m.name, m.value]))
}

async function profileWindow(ctx: HandleCtx, seconds: number, top: number): Promise<Record<string, unknown>> {
  return withDebugger(target(ctx), async (send) => {
    await send('Performance.enable')
    const before = metricMap((await send('Performance.getMetrics')).metrics)
    await send('Profiler.enable')
    await send('Profiler.setSamplingInterval', { interval: 500 })
    await send('Profiler.start')
    await sleep(seconds * 1000, ctx.signal)
    const { profile } = await send('Profiler.stop')
    await send('Profiler.disable')
    const after = metricMap((await send('Performance.getMetrics')).metrics)
    await send('Performance.disable')
    const span = (after.Timestamp ?? 0) - (before.Timestamp ?? 0) || seconds
    const rate = (k: string): number => round(((after[k] ?? 0) - (before[k] ?? 0)) / span)
    return {
      ...summarize(profile as Profile, top),
      perSecond: {
        layouts: rate('LayoutCount'),
        styleRecalcs: rate('RecalcStyleCount')
      },
      counts: {
        nodes: after.Nodes,
        listeners: after.JSEventListeners,
        documents: after.Documents,
        frames: after.Frames,
        heapMB: round((after.JSHeapUsedSize ?? 0) / 1048576)
      }
    }
  })
}

async function profileMain(ctx: HandleCtx, seconds: number, top: number): Promise<Record<string, unknown>> {
  const session = new Session()
  session.connect()
  const post = (m: string, p?: object): Promise<any> =>
    new Promise((done, fail) => session.post(m, p ?? {}, (err, res) => (err ? fail(err) : done(res))))
  try {
    await post('Profiler.enable')
    await post('Profiler.setSamplingInterval', { interval: 500 })
    await post('Profiler.start')
    const lagStart = Date.now()
    let lagMax = 0
    let lagSum = 0
    let lagN = 0
    while (Date.now() - lagStart < seconds * 1000 && !ctx.signal.aborted) {
      const t = Date.now()
      await new Promise((r) => setTimeout(r, 50))
      const lag = Date.now() - t - 50
      lagMax = Math.max(lagMax, lag)
      lagSum += lag
      lagN++
    }
    const { profile } = await post('Profiler.stop')
    await post('Profiler.disable')
    return { ...summarize(profile as Profile, top), eventLoopLagMs: { avg: round(lagSum / Math.max(1, lagN)), max: lagMax } }
  } finally {
    session.disconnect()
  }
}

const NAMED = new Set(['object', 'closure', 'native', 'regexp'])

type HeapRows = Map<string, { count: number; size: number }>

const heapTags = new Map<string, HeapRows>()

async function windowHeap(ctx: HandleCtx, file = ''): Promise<HeapRows> {
  const wc = target(ctx)
  return withDebugger(wc, async (send) => {
    const chunks: string[] = []
    const onMessage = (_e: unknown, method: string, params: { chunk?: string }): void => {
      if (method === 'HeapProfiler.addHeapSnapshotChunk' && params.chunk) chunks.push(params.chunk)
    }
    wc.debugger.on('message', onMessage)
    try {
      await send('HeapProfiler.enable')
      await send('HeapProfiler.collectGarbage')
      await send('HeapProfiler.takeHeapSnapshot', { reportProgress: false })
      await send('HeapProfiler.disable')
    } finally {
      wc.debugger.removeListener('message', onMessage)
    }
    const raw = chunks.join('')
    if (file) writeFileSync(allowedOutPath(file, mediaOutRoots(), 'file'), raw)
    const snap = JSON.parse(raw)
    const fields: string[] = snap.snapshot.meta.node_fields
    const types: string[] = snap.snapshot.meta.node_types[0]
    const width = fields.length
    const iType = fields.indexOf('type')
    const iName = fields.indexOf('name')
    const iSize = fields.indexOf('self_size')
    const out: HeapRows = new Map()
    for (let i = 0; i < snap.nodes.length; i += width) {
      const type = types[snap.nodes[i + iType]]
      const name = String(snap.strings[snap.nodes[i + iName]])
      const key = NAMED.has(type) ? `${type === 'closure' ? 'fn ' : ''}${name.slice(0, 80)}` : `(${type})`
      const e = out.get(key) ?? { count: 0, size: 0 }
      e.count++
      e.size += snap.nodes[i + iSize]
      out.set(key, e)
    }
    return out
  })
}

defineHandle({
  name: 'perf.profile',
  side: 'main',
  long: true,
  description:
    'Records a CPU profile of the window renderer or the main process for seconds and ranks where the time went. target is window or main. Returns busyPct, the top functions and files by self time (the eight busiest with their heaviest caller chain in via), and for the window layouts and style recalcs per second plus DOM node, listener and heap counts; for main the event-loop lag.',
  params: { target: 'window', seconds: 10, top: 25 },
  async run(p, ctx) {
    const seconds = Math.min(120, Math.max(1, Number(p.seconds) || 10))
    const top = Math.min(100, Math.max(5, Number(p.top) || 25))
    return p.target === 'main' ? profileMain(ctx, seconds, top) : profileWindow(ctx, seconds, top)
  }
})

defineHandle({
  name: 'perf.heap',
  side: 'main',
  long: true,
  description:
    'Takes a window heap snapshot after a garbage collection and groups it by constructor. save stores it under that tag; base diffs it against a stored tag; file also writes the raw .heapsnapshot to that path (inside the temp folder, $LANDING_MEDIA_OUT or the app media folder) for retainer analysis. Returns total MB, the largest groups, and with base the groups that grew most.',
  params: { save: '', base: '', top: 25, file: '' },
  async run(p, ctx) {
    const top = Math.min(100, Math.max(5, Number(p.top) || 25))
    const rows = await windowHeap(ctx, typeof p.file === 'string' ? p.file : '')
    let total = 0
    for (const e of rows.values()) total += e.size
    const out: Record<string, unknown> = {
      totalMB: round(total / 1048576),
      largest: [...rows].sort((a, b) => b[1].size - a[1].size).slice(0, top).map(([name, e]) => ({ name, count: e.count, kb: round(e.size / 1024) }))
    }
    const base = typeof p.base === 'string' && p.base ? heapTags.get(p.base) : undefined
    if (base) {
      const grew: { name: string; count: number; kb: number }[] = []
      for (const [name, e] of rows) {
        const prev = base.get(name) ?? { count: 0, size: 0 }
        if (e.count !== prev.count || e.size !== prev.size) grew.push({ name, count: e.count - prev.count, kb: round((e.size - prev.size) / 1024) })
      }
      out.growth = grew.sort((a, b) => b.kb - a.kb || b.count - a.count).slice(0, top)
    }
    if (typeof p.save === 'string' && p.save) heapTags.set(p.save, rows)
    return out
  }
})
