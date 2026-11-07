import { encodeValue, exportsOf, findModule, fnSpec, FN_ARGS_HELP, globKeyPath, moduleName, purityGraph, runFnCall } from '@shared/fn-call'
import { defineHandle } from './registry'

type Loader = () => Promise<unknown>

const rawLoaders: Record<string, Loader> = import.meta.env.DEV
  ? import.meta.glob(
      [
        '../**/*.{ts,tsx}',
        '../../../shared/**/*.ts',
        '!../**/*.d.ts',
        '!../../../shared/**/*.d.ts',
        '!./**',
        '!../main.tsx',
        '!../remote/**',
        '!../report-frame/**',
        '!../**/offline/**',
        '!../**/monaco-chunk.ts',
        '!../**/*-sw.ts',
        '!../**/*worker*.ts'
      ],
      { query: '?raw', import: 'default' }
    )
  : {}

const moduleLoaders: Record<string, Loader> = import.meta.env.DEV
  ? import.meta.glob([
      '../**/*.{ts,tsx}',
      '../../../shared/**/*.ts',
      '!../**/*.d.ts',
      '!../../../shared/**/*.d.ts',
      '!./**',
      '!../main.tsx',
      '!../remote/**',
      '!../report-frame/**',
      '!../**/offline/**',
      '!../**/monaco-chunk.ts',
      '!../**/*-sw.ts',
      '!../**/*worker*.ts'
    ])
  : {}

const KEY_BASE = 'src/renderer/src/handles'

function ioSource(text: string): string | null {
  const m = /\bwindow\.(api|electron)\b|\bfetch\s*\(|\bnavigator\.clipboard\b|\bipcRenderer\b|\blocalStorage\b|\bnew\s+(Worker|WebSocket)\b/.exec(text)
  return m ? `uses ${m[0].replace(/\s*\($/, '')}` : null
}

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
      const io = purityGraph(sources, { ioPackage: (s) => /^electron\b|^node:/.test(s), ioSource, alias: { '@shared': 'src/shared', '@renderer': 'src/renderer/src' } })
      return { names: Object.keys(sources).sort(), io, byName }
    })()
    graph.catch(() => (graph = null))
  }
  return graph
}

function pickModule(names: string[], want: string): string {
  const hits = findModule(names, want)
  if (hits.length === 1) return hits[0]
  if (!hits.length) throw new Error(`No window module matches ${want}. fn.window.list shows them; use a path like lib/tuner/curves.`)
  throw new Error(`${want} matches ${hits.length} window modules: ${hits.slice(0, 8).map(moduleName).join(', ')}. Use a longer path.`)
}

defineHandle({
  name: 'fn.window.list',
  side: 'renderer',
  agentOnly: true,
  description:
    'Lists the window (renderer) and shared modules fn.window.call can reach, from a registry built by the dev server (src/renderer/src/** and src/shared/**, minus entries, workers, the phone app and the report frame). filter matches module paths. io is null for a pure module, or why it reaches outside the page (window.api IPC, fetch, clipboard, localStorage, workers). With module set to one exact match it also lists its exports with their parameters.',
  params: { filter: '', module: '' },
  async run(p) {
    if (!import.meta.env.DEV) throw new Error('The window module registry exists only on the dev server.')
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
  name: 'fn.window.call',
  side: 'renderer',
  agentOnly: true,
  description: `Calls one export of a pure window or shared module in the page, for checking UI math without a test file: tuner curves (lib/tuner/curves), rotation (lib/tuner/rotation-math), rect tools, scene gizmo, pane plans (@shared/pane-plan). module is a path from fn.window.list, fn the export or Export.member, new: true constructs a class and then lists {call, args} method calls on the result. Only modules with io null run; the rest are refused. The first import of a module whose npm dependency the dev server hasn't optimized yet makes Vite reload the window once; call it again after the reload. ${FN_ARGS_HELP} Returns module, value, steps, fakes and ms; a throw comes back as ok: false with the error.`,
  params: { module: '', fn: '', args: [] as unknown[], new: false, then: [] as unknown[], timeoutMs: 10_000 },
  async run(p) {
    if (!import.meta.env.DEV) throw new Error('The window module registry exists only on the dev server.')
    const spec = fnSpec(p)
    const reg = await registry()
    const name = pickModule(reg.names, spec.module)
    const io = reg.io.get(name) ?? null
    if (io) throw new Error(`${moduleName(name)} is not pure (${io}), so fn.window.call won't run it.`)
    const mod = (await moduleLoaders[reg.byName.get(name) ?? '']()) as Record<string, unknown>
    const t0 = performance.now()
    try {
      const out = await runFnCall(mod, { ...spec, module: moduleName(name) }, Math.max(100, Math.min(120_000, Number(p.timeoutMs) || 10_000)))
      return { module: moduleName(name), fn: spec.fn, ok: true, value: encodeValue(out.value), ...(out.steps.length ? { steps: out.steps } : {}), ...(out.fakes.length ? { fakes: out.fakes } : {}), ms: Math.round(performance.now() - t0) }
    } catch (e) {
      const err = e as Error
      return { module: moduleName(name), fn: spec.fn, ok: false, error: { name: err?.name ?? 'Error', message: err?.message ?? String(e), stack: String(err?.stack ?? '').split('\n').slice(0, 8).join('\n') }, ms: Math.round(performance.now() - t0) }
    }
  }
})
