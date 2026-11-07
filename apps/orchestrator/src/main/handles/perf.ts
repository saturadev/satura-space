import { execFileSync } from 'node:child_process'
import { readFileSync, rmSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join } from 'node:path'
import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks'
import { setFlagsFromString, writeHeapSnapshot } from 'node:v8'
import { runInNewContext } from 'node:vm'
import { censusSizes } from '@shared/census'
import { rendererCall } from '../agent-exec'
import { defineHandle, sleep, type HandleCtx } from './registry'
import { systemLoad, systemLoadInfo } from '../resources/system-sampler'

type Group = 'orchestrator' | 'unity' | 'agents'
const GROUPS: Group[] = ['orchestrator', 'unity', 'agents']

interface Proc {
  pid: number
  ppid: number
  cpuSec: number
  rssMB: number
  args: string
}

interface Tick {
  cpu: Record<Group, number>
  rssMB: Record<Group, number>
  systemCpu: number
  gpu: number | null
}

function parseCpuTime(value: string): number {
  const [clock, days] = value.includes('-') ? value.split('-').reverse() : [value, '0']
  let sec = 0
  for (const part of clock.split(':').map(Number)) sec = sec * 60 + part
  return sec + Number(days) * 86400
}

function listProcesses(): Proc[] {
  const out = execFileSync('ps', ['-axo', 'pid=,ppid=,time=,rss=,args='], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 })
  const procs: Proc[] = []
  for (const line of out.split('\n')) {
    const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(\d+)\s+(.*)$/)
    if (m) procs.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuSec: parseCpuTime(m[3]), rssMB: Number(m[4]) / 1024, args: m[5] })
  }
  return procs
}

function classify(p: Proc, rootPid: number): Group {
  if (/Unity\.app\/Contents\/MacOS\/Unity|Unity\.exe/.test(p.args)) return 'unity'
  if (p.pid === rootPid || /Electron|daemon-entry\.js/.test(p.args)) return 'orchestrator'
  return 'agents'
}

function tree(rootPid: number): Map<number, { proc: Proc; group: Group }> {
  const procs = listProcesses()
  const children = new Map<number, Proc[]>()
  for (const p of procs) children.set(p.ppid, [...(children.get(p.ppid) ?? []), p])
  const out = new Map<number, { proc: Proc; group: Group }>()
  const root = procs.find((p) => p.pid === rootPid)
  if (!root) return out
  const stack = [root]
  while (stack.length) {
    const p = stack.pop() as Proc
    out.set(p.pid, { proc: p, group: classify(p, rootPid) })
    for (const c of children.get(p.pid) ?? []) stack.push(c)
  }
  return out
}

function systemTimes(): { busy: number; total: number } {
  let busy = 0
  let total = 0
  for (const c of cpus()) {
    const t = c.times
    busy += t.user + t.nice + t.sys + t.irq
    total += t.user + t.nice + t.sys + t.irq + t.idle
  }
  return { busy, total }
}

function gpuUtilization(): number | null {
  if (process.platform !== 'darwin') return null
  try {
    const m = execFileSync('ioreg', ['-r', '-d', '1', '-c', 'IOAccelerator'], { encoding: 'utf8' }).match(/"Device Utilization %"=(\d+)/)
    return m ? Number(m[1]) : null
  } catch {
    return null
  }
}

function footprintMB(pids: number[]): number | null {
  if (process.platform !== 'darwin' || pids.length === 0) return null
  let total = 0
  for (const pid of pids) {
    try {
      const m = execFileSync('footprint', [String(pid)], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).match(/Footprint: ([\d.]+) (KB|MB|GB)/)
      if (m) total += Number(m[1]) * (m[2] === 'GB' ? 1024 : m[2] === 'KB' ? 1 / 1024 : 1)
    } catch {
    }
  }
  return total
}

const avg = (v: number[]): number => (v.length ? v.reduce((a, b) => a + b, 0) / v.length : 0)
const p95 = (v: number[]): number => (v.length ? [...v].sort((a, b) => a - b)[Math.min(v.length - 1, Math.floor(v.length * 0.95))] : 0)
const round = (n: number): number => Math.round(n * 10) / 10

async function sample(seconds: number, signal: AbortSignal): Promise<Record<string, unknown>> {
  const rootPid = process.pid
  const ticks: Tick[] = []
  let prevTree = tree(rootPid)
  let prevSys = systemTimes()
  let prevAt = Date.now()
  const started = prevAt
  while (Date.now() - started < seconds * 1000 && !signal.aborted) {
    await sleep(1000, signal)
    const now = Date.now()
    const wall = (now - prevAt) / 1000
    const cur = tree(rootPid)
    const sys = systemTimes()
    const cpu = { orchestrator: 0, unity: 0, agents: 0 }
    const rssMB = { orchestrator: 0, unity: 0, agents: 0 }
    for (const [pid, { proc, group }] of cur) {
      const before = prevTree.get(pid)?.proc.cpuSec ?? proc.cpuSec
      cpu[group] += wall > 0 ? (Math.max(0, proc.cpuSec - before) / wall) * 100 : 0
      rssMB[group] += proc.rssMB
    }
    const dTotal = sys.total - prevSys.total
    ticks.push({ cpu, rssMB, systemCpu: dTotal > 0 ? ((sys.busy - prevSys.busy) / dTotal) * 100 : 0, gpu: gpuUtilization() })
    prevTree = cur
    prevSys = sys
    prevAt = now
  }
  const last = tree(rootPid)
  const groups: Record<string, unknown> = {}
  for (const g of GROUPS) {
    const pids = [...last].filter(([, v]) => v.group === g).map(([pid]) => pid)
    groups[g] = {
      cpuAvg: round(avg(ticks.map((t) => t.cpu[g]))),
      cpuP95: round(p95(ticks.map((t) => t.cpu[g]))),
      rssMaxMB: round(Math.max(0, ...ticks.map((t) => t.rssMB[g]))),
      footprintMB: g === 'orchestrator' ? round(footprintMB(pids) ?? 0) : null,
      processes: pids.length
    }
  }
  const gpus = ticks.map((t) => t.gpu).filter((v): v is number => v !== null)
  return {
    seconds: round((Date.now() - started) / 1000),
    groups,
    system: { cpuAvg: round(avg(ticks.map((t) => t.systemCpu))), cpuP95: round(p95(ticks.map((t) => t.systemCpu))), gpuAvg: gpus.length ? round(avg(gpus)) : null, cores: cpus().length }
  }
}

interface ProcessInternals {
  _getActiveHandles?: () => object[]
  _getActiveRequests?: () => object[]
}

let gc: (() => void) | null = null

export function collect(): void {
  if (!gc) {
    setFlagsFromString('--expose-gc')
    gc = runInNewContext('gc') as () => void
  }
  gc()
  gc()
}

let loop: IntervalHistogram | null = null

function loopLag(): Record<string, number> | null {
  if (!loop) {
    loop = monitorEventLoopDelay({ resolution: 20 })
    loop.enable()
    return null
  }
  const out = { p50: round(loop.percentile(50) / 1e6), p99: round(loop.percentile(99) / 1e6), max: round(loop.max / 1e6) }
  loop.reset()
  return out
}

function mainCensus(): Record<string, unknown> {
  const lagMs = loopLag()
  collect()
  const handles: Record<string, number> = {}
  for (const h of (process as unknown as ProcessInternals)._getActiveHandles?.() ?? []) {
    const name = h?.constructor?.name ?? 'unknown'
    handles[name] = (handles[name] ?? 0) + 1
  }
  const mem = process.memoryUsage()
  return {
    maps: censusSizes(),
    handles,
    requests: ((process as unknown as ProcessInternals)._getActiveRequests?.() ?? []).length,
    heapMB: round(mem.heapUsed / 1048576),
    rssMB: round(mem.rss / 1048576),
    lagMs
  }
}

async function windowCensus(ctx: HandleCtx, reset = false): Promise<Record<string, unknown> | null> {
  if (ctx.window === null) return null
  return ((await rendererCall(ctx.window, { kind: 'census', payload: { reset } }, 20_000)) as Record<string, unknown> | null) ?? null
}

function numericDelta(a: unknown, b: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  const x = (a ?? {}) as Record<string, number>
  const y = (b ?? {}) as Record<string, number>
  for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
    const d = (Number(y[k]) || 0) - (Number(x[k]) || 0)
    if (d !== 0) out[k] = round(d)
  }
  return out
}

const NAMED = new Set(['object', 'closure', 'native', 'regexp'])

function heapSummary(file: string): Map<string, { count: number; size: number }> {
  const snap = JSON.parse(readFileSync(file, 'utf8'))
  const fields: string[] = snap.snapshot.meta.node_fields
  const types: string[] = snap.snapshot.meta.node_types[0]
  const width = fields.length
  const iType = fields.indexOf('type')
  const iName = fields.indexOf('name')
  const iSize = fields.indexOf('self_size')
  const out = new Map<string, { count: number; size: number }>()
  for (let i = 0; i < snap.nodes.length; i += width) {
    const type = types[snap.nodes[i + iType]]
    const key = NAMED.has(type) ? `${type === 'closure' ? 'fn ' : ''}${snap.strings[snap.nodes[i + iName]]}` : `(${type})`
    const e = out.get(key) ?? { count: 0, size: 0 }
    e.count++
    e.size += snap.nodes[i + iSize]
    out.set(key, e)
  }
  return out
}

export function heapNow(tag: string): Map<string, { count: number; size: number }> {
  collect()
  const file = join(tmpdir(), `satura-handles-${process.pid}-${tag}.heapsnapshot`)
  writeHeapSnapshot(file)
  try {
    return heapSummary(file)
  } finally {
    rmSync(file, { force: true })
  }
}

defineHandle({
  name: 'perf.sample',
  side: 'main',
  long: true,
  description:
    'Samples CPU and memory for seconds, once a second, over the app process tree split into orchestrator (Electron), unity and agents, plus system CPU and GPU use. For reference, an idle orchestrator should average under about 15% CPU. Returns per-group cpuAvg, cpuP95, rssMaxMB, footprintMB and process count, and system cpu and gpu averages.',
  params: { seconds: 10 },
  async run(p, ctx) {
    return sample(Math.min(600, Math.max(1, Number(p.seconds) || 10)), ctx.signal)
  }
})

defineHandle({
  name: 'perf.census',
  side: 'main',
  description:
    'Takes a census of live objects after a garbage collection: the size of every tracked map in main and in the window, active Node handles by type, main heap and RSS, the window JS heap and DOM node count, and Tuner frame timings. Pass reset to clear the Tuner timings after reading them. Returns { main, window }.',
  params: { reset: false },
  async run(p, ctx) {
    return { main: mainCensus(), window: await windowCensus(ctx, p.reset === true) }
  }
})

defineHandle({
  name: 'perf.leak',
  side: 'main',
  long: true,
  description:
    "Checks for leaks by opening and closing a panel cycles times. A reused panel kind (console, git, unity, scratchpads) gets closed too, so an open one is gone afterwards. kind is any layout.open kind (tuner, git, terminal, console, unity, scratchpads). It takes a census before and after, waiting settleMs after each open and close. heap: true also diffs main heap snapshots by constructor, which is slow. Returns the growth in tracked maps, handles, heap and DOM nodes for main and the window, plus the top heap growth.",
  params: { kind: 'tuner', cycles: 5, settleMs: 1500, heap: false },
  async run(p, ctx) {
    const cycles = Math.min(50, Math.max(1, Number(p.cycles) || 5))
    const settle = Math.max(200, Number(p.settleMs) || 1500)
    const heap = p.heap === true
    const warm = (await ctx.renderer('layout.open', { kind: p.kind })) as { tab?: { id?: string } } | null
    await sleep(settle, ctx.signal)
    if (warm?.tab?.id) await ctx.renderer('layout.close', { tab: warm.tab.id })
    await sleep(settle, ctx.signal)
    const before = { main: mainCensus(), window: await windowCensus(ctx) }
    const heapBefore = heap ? heapNow('a') : null
    for (let i = 0; i < cycles && !ctx.signal.aborted; i++) {
      const opened = (await ctx.renderer('layout.open', { kind: p.kind })) as { tab?: { id?: string } } | null
      await sleep(settle, ctx.signal)
      if (opened?.tab?.id) await ctx.renderer('layout.close', { tab: opened.tab.id })
      await sleep(settle, ctx.signal)
    }
    const after = { main: mainCensus(), window: await windowCensus(ctx) }
    const out: Record<string, unknown> = {
      cycles,
      main: {
        maps: numericDelta(before.main.maps, after.main.maps),
        handles: numericDelta(before.main.handles, after.main.handles),
        heapMB: round(Number(after.main.heapMB) - Number(before.main.heapMB))
      },
      window: before.window && after.window ? {
        maps: numericDelta(before.window.maps, after.window.maps),
        heapMB: round(Number(after.window.heapMB) - Number(before.window.heapMB)),
        domNodes: Number(after.window.domNodes) - Number(before.window.domNodes)
      } : null
    }
    if (heapBefore) {
      const heapAfter = heapNow('b')
      const rows: { name: string; count: number; kb: number }[] = []
      for (const [name, e] of heapAfter) {
        const prev = heapBefore.get(name) ?? { count: 0, size: 0 }
        if (e.count > prev.count || e.size > prev.size) rows.push({ name, count: e.count - prev.count, kb: round((e.size - prev.size) / 1024) })
      }
      out.heapGrowth = rows.sort((a, b) => b.kb - a.kb || b.count - a.count).slice(0, 15)
    }
    return out
  }
})

defineHandle({
  name: 'system.load',
  side: 'main',
  description:
    'Reads the Mac-wide load sampler that feeds the phone and the desktop resource popover: the latest sample (cpu % of all cores, mem = used bytes counted like Activity Monitor), how many samples the history holds and the seconds they span, total memory and the disk of the projects volume (total and free bytes). watch: true counts as a viewer, so sampling switches to every 2 s for a few seconds. Returns that summary.',
  params: { watch: false },
  async run(p) {
    if (p.watch) systemLoad()
    return systemLoadInfo()
  }
})
