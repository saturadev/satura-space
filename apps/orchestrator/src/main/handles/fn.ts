import { isAbsolute } from 'node:path'
import { encodeValue, exportsOf, findModule, fnSpec, FN_ARGS_HELP, globKeyPath, moduleName, purityGraph, runFnCall } from '@shared/fn-call'
import { defineHandle } from './registry'
import { inJail, jailRoot } from './scratch'

type Loader = () => Promise<unknown>

const rawLoaders: Record<string, Loader> = import.meta.env.DEV
  ? import.meta.glob(
      [
        '../**/*.ts',
        '../../shared/**/*.ts',
        '!../**/*.d.ts',
        '!../../shared/**/*.d.ts',
        '!./**',
        '!../index.ts',
        '!../daemon/daemon-entry.ts',
        '!../satura-exec/worker.ts',
        '!../satura-exec/sandbox/**',
        '!../satura-exec/playwright/**',
        '!../satura-exec/page/injected.ts',
        '!../unity/unity-log-worker.ts',
        '!../report/compile-worker.ts',
        '!../remote-video/encoder-preload.ts'
      ],
      { query: '?raw', import: 'default' }
    )
  : {}

const moduleLoaders: Record<string, Loader> = import.meta.env.DEV
  ? import.meta.glob([
      '../**/*.ts',
      '../../shared/**/*.ts',
      '!../**/*.d.ts',
      '!../../shared/**/*.d.ts',
      '!./**',
      '!../index.ts',
      '!../daemon/daemon-entry.ts',
      '!../satura-exec/worker.ts',
      '!../satura-exec/sandbox/**',
      '!../satura-exec/playwright/**',
      '!../satura-exec/page/injected.ts',
      '!../unity/unity-log-worker.ts',
      '!../report/compile-worker.ts',
      '!../remote-video/encoder-preload.ts'
    ])
  : {}

const IO_PACKAGES = new Set([
  'fs', 'fs/promises', 'child_process', 'net', 'http', 'https', 'http2', 'dgram', 'tls', 'cluster', 'worker_threads', 'v8', 'inspector', 'sqlite', 'repl', 'vm', 'electron', 'ws', 'node-pty', 'chokidar', 'fsevents'
])

function ioPackage(spec: string): boolean {
  const bare = spec.replace(/^node:/, '')
  return IO_PACKAGES.has(bare) || /^@?electron|pty|sqlite|keytar|undici/.test(bare)
}

function ioSource(text: string): string | null {
  const m = /\bprocess\.(kill|exit|chdir|abort|dlopen)\b|\b(fetch|XMLHttpRequest)\s*\(|\bnew\s+WebSocket\b|\brequire\s*\(/.exec(text)
  return m ? `uses ${m[0].replace(/\s*\($/, '')}` : null
}

const KEY_BASE = 'src/main/handles'

let graph: Promise<{ names: string[]; io: Map<string, string | null>; byName: Map<string, string> }> | null = null

function registry(): Promise<{ names: string[]; io: Map<string, string | null>; byName: Map<string, string> }> {
  if (!graph) {
    graph = (async () => {
      const byName = new Map<string, string>()
      const sources: Record<string, string> = {}
      await Promise.all(
        Object.entries(rawLoaders).map(async ([key, load]) => {
          const path = globKeyPath(KEY_BASE, key)
          byName.set(path, key)
          sources[path] = String(await load())
        })
      )
      const io = purityGraph(sources, { ioPackage, ioSource, alias: { '@shared': 'src/shared' } })
      return { names: Object.keys(sources).sort(), io, byName }
    })()
    graph.catch(() => (graph = null))
  }
  return graph
}

function noRegistry(): Error {
  return new Error('The module registry exists only in a dev build run by electron-vite dev (pnpm dev or a dev instance).')
}

function pathStrings(v: unknown, out: string[]): string[] {
  if (typeof v === 'string') {
    const head = v.split(/\{/)[0]
    if (!v.includes('\n') && v.length < 4096 && isAbsolute(head)) out.push(head)
  } else if (Array.isArray(v)) for (const x of v) pathStrings(x, out)
  else if (v && typeof v === 'object') for (const x of Object.values(v)) pathStrings(x, out)
  return out
}

function pickModule(names: string[], want: string): string {
  const hits = findModule(names, want)
  if (hits.length === 1) return hits[0]
  if (!hits.length) throw new Error(`No module matches ${want}. fn.list shows them; use a path like unity/editor-install or @shared/pane-plan.`)
  throw new Error(`${want} matches ${hits.length} modules: ${hits.slice(0, 8).map(moduleName).join(', ')}. Use a longer path.`)
}

defineHandle({
  name: 'fn.list',
  side: 'main',
  agentOnly: true,
  description:
    "Lists the main-process and shared modules fn.call can reach, from a registry built into the dev bundle (src/main/** and src/shared/**, minus entries and workers). filter matches module paths. Each row has module and io: null for a pure module (no fs, child_process, network, electron or process calls anywhere in its imports), or why it touches the outside world. With module set to one exact match, it also loads it and lists its exports (name, kind and parameter list). The window side is fn.window.list.",
  params: { filter: '', module: '' },
  async run(p) {
    if (!import.meta.env.DEV) throw noRegistry()
    const reg = await registry()
    const want = String(p.module ?? '').trim()
    if (want) {
      const name = pickModule(reg.names, want)
      const mod = (await moduleLoaders[reg.byName.get(name) ?? '']()) as Record<string, unknown>
      return { module: moduleName(name), io: reg.io.get(name) ?? null, exports: exportsOf(mod) }
    }
    const f = String(p.filter ?? '').trim().toLowerCase()
    const rows = reg.names.filter((n) => !f || n.toLowerCase().includes(f)).map((n) => ({ module: moduleName(n), io: reg.io.get(n) ?? null }))
    return { count: rows.length, pure: rows.filter((r) => !r.io).length, modules: rows }
  }
})

defineHandle({
  name: 'fn.call',
  side: 'main',
  agentOnly: true,
  description: `Calls one export of a main-process or shared module with JSON args and returns what it returned, for checking pure logic without a test file: module is a path from fn.list (unity/unity-process-parse, @shared/pane-plan, git/git-queue), fn the export, or Export.member. new: true constructs a class instead, and then is a list of {call, args} method calls made on the result in order (each step returns its value and the object after it). A pure module takes any args. A module that touches the disk runs only when its args name at least one absolute path inside the temp jail (a scratch.dir root) and no absolute path outside it, so it can't reach your real files; other calls into it are refused. ${FN_ARGS_HELP} Promises are awaited up to timeoutMs. Returns module, io, value, steps, fakes (each callback's calls) and ms; a throw comes back as error with name, message and stack.`,
  params: { module: '', fn: '', args: [] as unknown[], new: false, then: [] as unknown[], timeoutMs: 10_000 },
  async run(p, ctx) {
    if (!import.meta.env.DEV) throw noRegistry()
    const spec = fnSpec(p)
    const reg = await registry()
    const name = pickModule(reg.names, spec.module)
    const io = reg.io.get(name) ?? null
    if (io) {
      const paths = pathStrings([spec.args, spec.then.map((s) => s.args)], [])
      const outside = paths.filter((x) => !inJail(x))
      if (outside.length) throw new Error(`${moduleName(name)} touches the disk (${io}), so every absolute path it gets must be inside ${jailRoot()}. Outside: ${outside.slice(0, 5).join(', ')}.`)
      if (!paths.length) throw new Error(`${moduleName(name)} touches the disk (${io}), so fn.call runs it only with a scratch path among its args (scratch.dir makes one). Move the pure part to its own module if it needs none.`)
    }
    const mod = (await moduleLoaders[reg.byName.get(name) ?? '']()) as Record<string, unknown>
    const t0 = Date.now()
    ctx.log(`${moduleName(name)}.${spec.fn}${spec.construct ? ' (new)' : ''} with ${JSON.stringify(spec.args).slice(0, 300)}`)
    try {
      const out = await runFnCall(mod, { ...spec, module: moduleName(name) }, Math.max(100, Math.min(120_000, Number(p.timeoutMs) || 10_000)))
      return { module: moduleName(name), fn: spec.fn, io, ok: true, value: encodeValue(out.value), ...(out.steps.length ? { steps: out.steps } : {}), ...(out.fakes.length ? { fakes: out.fakes } : {}), ms: Date.now() - t0 }
    } catch (e) {
      const err = e as Error
      ctx.log(`${spec.fn} threw ${err?.name}: ${err?.message}`)
      return { module: moduleName(name), fn: spec.fn, io, ok: false, error: { name: err?.name ?? 'Error', message: err?.message ?? String(e), stack: String(err?.stack ?? '').split('\n').slice(0, 8).join('\n') }, ms: Date.now() - t0 }
    }
  }
})

