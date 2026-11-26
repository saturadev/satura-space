import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MainPlugin, PluginCtx } from '@satura/plugin'
import { runtimeSources } from './bundle'
import { buildNetworks, NETWORKS } from './networks'
import { pack, playablePath, sizeReport } from './pack'
import { CONFIG, initProject, inside, layout, PlayableError, REFERENCE, rel } from './project'
import { loadScript, verify } from './verify'

type Opts = Record<string, unknown>

function opts(value: unknown): Opts {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Opts) : {}
}

function list(value: unknown): string[] | undefined {
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string' && value.trim()) return value.split(',').map((s) => s.trim()).filter(Boolean)
  return undefined
}

export default function setup(p: MainPlugin): void {
  const busy = new Set<string>()

  async function once<T>(root: string, what: string, work: () => Promise<T>): Promise<T> {
    if (!root) throw new PlayableError('There is no project open.', 'no-project')
    const key = `${root}|${what}`
    if (busy.has(key)) throw new PlayableError(`playables.${what} is already running for this project.`, 'busy')
    busy.add(key)
    try {
      return await work()
    } finally {
      busy.delete(key)
    }
  }

  async function writeReference(root: string): Promise<string> {
    const dir = join(root, REFERENCE)
    await mkdir(dir, { recursive: true })
    for (const [name, text] of Object.entries(await runtimeSources(p.sourceDir))) {
      const file = join(dir, name)
      if ((await readFile(file, 'utf8').catch(() => null)) !== text) await writeFile(file, text)
    }
    return REFERENCE
  }

  async function init(ctx: PluginCtx, o: Opts): Promise<unknown> {
    const r = await initProject(ctx.projectRoot, { name: o.name ? String(o.name) : undefined, scene: o.scene ? String(o.scene) : undefined, title: o.title ? String(o.title) : undefined })
    const reference = await writeReference(ctx.projectRoot)
    ctx.log(`init: created ${r.created.length}, kept ${r.kept.length}`)
    return { ...r, config: CONFIG, runtimeReference: reference }
  }

  async function scan(ctx: PluginCtx, scene: unknown): Promise<unknown> {
    return p.unity(ctx.projectRoot, 'scan', { scene: scene ? String(scene) : '' }, 120_000)
  }

  async function exportScenes(ctx: PluginCtx): Promise<unknown> {
    return once(ctx.projectRoot, 'export', async () => {
      const lay = await layout(ctx.projectRoot)
      await writeReference(ctx.projectRoot)
      const t0 = Date.now()
      const r = (await p.unity(ctx.projectRoot, 'export', { config: rel(lay.root, lay.configPath), outDir: rel(lay.root, lay.build) }, 300_000)) as Record<string, unknown>
      ctx.log(`export: ${JSON.stringify({ scenes: r.scenes, prefabs: r.prefabs, sprites: r.sprites, atlases: r.atlases, tables: r.tables, warnings: (r.warnings as unknown[])?.length })} in ${Date.now() - t0}ms`)
      return { ...r, build: rel(lay.root, lay.build) }
    })
  }

  async function packHandle(ctx: PluginCtx, o: Opts): Promise<unknown> {
    return once(ctx.projectRoot, 'pack', async () => {
      const r = await pack(p, ctx.projectRoot, ctx.log)
      const out: Record<string, unknown> = { path: rel(ctx.projectRoot, r.path), bytes: r.bytes, budget: r.budget, overBudget: r.overBudget, report: r.report, largest: r.rows.slice(0, 8).map((x) => ({ name: x.name, kind: x.kind, raw: x.raw, packed: x.packed, note: x.note })), warnings: r.warnings }
      const nets = o.networks === true ? undefined : list(o.networks)
      if (o.networks) out.networks = await buildNetworks(p, r.parts, r.layout, nets, ctx.log)
      return out
    })
  }

  async function networks(ctx: PluginCtx, o: Opts): Promise<unknown> {
    return once(ctx.projectRoot, 'pack', async () => {
      const r = await pack(p, ctx.projectRoot, ctx.log)
      return { base: rel(ctx.projectRoot, r.path), bytes: r.bytes, variants: await buildNetworks(p, r.parts, r.layout, list(o.only), ctx.log) }
    })
  }

  async function preview(ctx: PluginCtx, o: Opts): Promise<unknown> {
    const root = ctx.projectRoot
    const lay = await layout(root)
    const html = playablePath(root, lay, o.html ? String(o.html) : undefined)
    const [w, h] = String(o.size || '540x960').split('x').map(Number)
    const scale = Number(o.scale ?? 2)
    const times = (list(o.at) ?? ['0.5', '2', '5']).map(Number).filter((t) => t >= 0).sort((a, b) => a - b)
    const dir = join(lay.out, 'preview')
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    let script: unknown = { runs: [{ scene: lay.config.startScene, seed: Number(o.seed ?? lay.config.seed ?? 1), steps: [] }], probes: [], finalWait: 1e9, settleMax: 1 }
    if (o.script) script = (await loadScript(lay, String(o.script))).script
    const page = await p.page({ width: w || 540, height: h || 960, scale })
    try {
      await page.load(html)
      const ready = await page.evaluate<boolean>(`new Promise((r) => { const t0 = Date.now(); const k = () => window.__playable && window.__playable.started ? r(true) : Date.now() - t0 > 10000 ? r(false) : setTimeout(k, 50); k(); })`, 20_000)
      if (!ready) throw new PlayableError('The playable did not start in the page.', 'html-start')
      await page.evaluate(`window.__pv = window.__playable.harness.session(${JSON.stringify(script)}); 0`)
      const shots: { at: number; frame: number; file: string; phase: string }[] = []
      let frame = 0
      for (const t of times) {
        const target = Math.round(t * 60)
        const s = await page.evaluate<{ frame: number; phase: string; done: boolean }>(`window.__pv.advance(${Math.max(0, target - frame)})`, 120_000)
        frame = target
        await new Promise((r) => setTimeout(r, 120))
        const png = await page.screenshot()
        const file = join(dir, `t${String(t).replace('.', '_')}.png`)
        await writeFile(file, png)
        shots.push({ at: t, frame: s.frame, file: rel(root, file), phase: s.phase })
        if (s.done) break
      }
      const state = await page.evaluate<unknown>(`({ endCard: window.__playable.ad.endCardShown, errors: window.__playable.errors.slice(0, 5), scene: window.__playable.scenes.active })`)
      return { html: rel(root, html), size: `${w}x${h}@${scale}`, shots, state, consoleErrors: page.messages.filter((m) => m.type === 'error').map((m) => m.text).slice(0, 10), warnings: page.messages.filter((m) => m.type === 'warning').map((m) => m.text).filter((t) => !/Electron Security Warning/.test(t)).slice(0, 10), requests: page.requests.slice(0, 10) }
    } finally {
      page.close()
    }
  }

  async function status(ctx: PluginCtx): Promise<unknown> {
    const runtime = await runtimeSources(p.sourceDir)
    const out: Record<string, unknown> = { runtimeModules: Object.keys(runtime).length, runtimeBytes: Object.values(runtime).reduce((n, s) => n + Buffer.byteLength(s), 0), live: !!p.sourceDir, networks: NETWORKS.map((n) => ({ id: n.id, format: n.format, limit: n.limit, cta: n.cta })) }
    if (ctx.projectRoot) {
      out.config = await layout(ctx.projectRoot).then((l) => ({ name: l.config.name, scenes: l.config.scenes, startScene: l.config.startScene })).catch((e: Error) => ({ error: e.message }))
      out.unity = await p.unity(ctx.projectRoot, 'state', {}, 15_000).catch((e: Error) => ({ unavailable: e.message }))
    }
    return out
  }

  const verifyRun = (ctx: PluginCtx, o: Opts): Promise<unknown> =>
    once(ctx.projectRoot, 'verify', () => verify(p, ctx.projectRoot, { script: String(o.script || 'verify/smoke.json'), unity: o.unity as string | boolean | undefined, html: o.html ? String(o.html) : undefined, tolerance: o.tolerance !== undefined ? Number(o.tolerance) : undefined }, ctx.log, ctx.signal))

  p.exec('init', (ctx, o) => init(ctx, opts(o)))
  p.exec('scan', (ctx, scene) => scan(ctx, scene))
  p.exec('export', (ctx) => exportScenes(ctx))
  p.exec('pack', (ctx, o) => packHandle(ctx, opts(o)))
  p.exec('size', (ctx) => sizeReport(ctx.projectRoot))
  p.exec('networks', (ctx, o) => networks(ctx, opts(o)))
  p.exec('verify', (ctx, script, o) => verifyRun(ctx, { ...opts(o), script: typeof script === 'string' ? script : opts(script).script }))
  p.exec('preview', (ctx, o) => preview(ctx, opts(o)))
  p.exec('status', (ctx) => status(ctx))
  p.exec('build', async (ctx, o) => {
    const exported = await exportScenes(ctx)
    const packed = await packHandle(ctx, opts(o))
    return { exported, packed }
  })

  p.handle({
    name: 'init',
    description: `Creates the playable layout in the project the way playables.init() does: ${CONFIG} (scenes, start scene, stage, CTA, end card, networks, budget), Playable/game/main.js and index.js, Playable/verify/smoke.json, and a read-only copy of the JS runtime in ${REFERENCE}. Never overwrites a file. scene is the scene asset path. Returns created, kept.`,
    params: { scene: '', name: '', title: '' },
    run: (params, ctx) => init(ctx, params)
  })
  p.handle({
    name: 'scan',
    description: "Asks the project's editor what a scene uses, the way playables.scan(scene) does: the gameplay scripts with their line counts, the component types and how often each occurs, the input module, and every asset it depends on with its bytes, texture size, audio length or triangle count. Without scene it lists the project's scenes.",
    params: { scene: '' },
    run: (params, ctx) => scan(ctx, params.scene)
  })
  p.handle({
    name: 'export',
    long: true,
    description: `Exports the scenes in ${CONFIG} from the project's editor into Playable/build/: scene.json (every GameObject and component through SerializedObject, the prefabs, clips, controllers and ScriptableObjects they reference), sprite atlases at spriteScale, fonts and the asset tables of the mesh and audio exporters. Scenes that are not open are opened additively and closed again. Returns counts, files with their bytes and warnings.`,
    params: {},
    run: (_params, ctx) => exportScenes(ctx)
  })
  p.handle({
    name: 'pack',
    long: true,
    description: 'Bundles the runtime and Playable/game/*.js, encodes atlases to WebP and the other exported files with their encoders, and writes one self-contained HTML to Playable/out/<name>.html plus a size report. networks: true (or a list) also builds the ad network variants. Returns path, bytes, budget, overBudget, the largest parts and warnings.',
    params: { networks: false },
    run: (params, ctx) => packHandle(ctx, params)
  })
  p.handle({
    name: 'size',
    description: 'Reads the last pack report: total bytes against the budget, every packed part with raw and packed bytes, bytes per source asset, and hints on what to shrink first.',
    params: {},
    run: (_params, ctx) => sizeReport(ctx.projectRoot)
  })
  p.handle({
    name: 'networks',
    long: true,
    description: `Packs and writes one variant per ad network into Playable/out/networks/ (${NETWORKS.map((n) => n.id).join(', ')}), each with its CTA call, lifecycle and container, then checks every one: size limit, no external loads, the CTA reference in the code, and a run in a hidden page under a mock of the network API that must start, call the right CTA and make no requests. only limits the list. Returns one row per network with problems.`,
    params: { only: '' },
    run: (params, ctx) => networks(ctx, params)
  })
  p.handle({
    name: 'verify',
    long: true,
    description: "Plays a seeded input script (Playable/verify/<script>.json: runs with scene, seed and drag, tap, hold, wait steps in world coordinates or on object paths, probes of type and members, a settle condition) in the packed HTML in a hidden page and in the project's editor in play mode with a fixed 60 fps step, then compares the probe snapshots after every step. unity: true runs Unity, 'cached' or the default reuses the last Unity run of the identical script, false runs only the HTML. Returns states, equal, rngEqual, per-run frames and the first mismatches.",
    params: { script: 'verify/smoke.json', unity: '', tolerance: 0.002 },
    run: (params, ctx) => verifyRun(ctx, { ...params, unity: params.unity === '' ? undefined : params.unity })
  })
  p.handle({
    name: 'preview',
    long: true,
    description: 'Opens the packed playable in a hidden page at size (CSS pixels, default 540x960) and scale, steps it frame by frame on the game clock, optionally playing a verify script, and saves screenshots at the times in at (seconds) to Playable/out/preview/. Returns the shots, end card state, console errors and network requests.',
    params: { size: '540x960', scale: 2, at: '0.5,2,5', seed: '', script: '' },
    run: (params, ctx) => preview(ctx, params)
  })
  p.handle({
    name: 'status',
    description: "Shows the bundled runtime (modules and bytes), the supported ad networks with their limits, the project's playable config and whether its editor is playing or in a verify run.",
    params: {},
    run: (_params, ctx) => status(ctx)
  })
}
