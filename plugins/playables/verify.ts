import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { MainPlugin } from '@satura/plugin'
import { inside, layout, PlayableError, rel, type Layout } from './project'

export interface VerifyScript {
  runs: { scene: string; scenePath?: string; seed: number; steps?: unknown[] }[]
  probes?: { type: string; members?: string[]; inactive?: boolean }[]
  settle?: { type: string; member: string; equals: string; frames?: number } | { type: string; member: string; equals: string; frames?: number }[]
  settleMax?: number
  finalWait?: number
  fps?: number
  deadline?: number
}

interface SideResult {
  side: string
  exit: number
  error: string | null
  rng: unknown
  runs: { scene: string; seed: number; states: { step: number; frame: number; settleTimeout?: boolean; probes: Record<string, { found: boolean; rows: string[] }> }[] }[]
  input?: unknown[]
}

export interface Mismatch {
  run: number
  seed: number
  state: number
  step: number
  probe: string
  unity: string[]
  html: string[]
}

const POLL_MS = 1000

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

export async function loadScript(lay: Layout, scriptRel: string): Promise<{ script: VerifyScript; name: string; hash: string }> {
  const file = inside(lay.dir, scriptRel)
  const text = await readFile(file, 'utf8').catch(() => null)
  if (text === null) throw new PlayableError(`Playable/${scriptRel} is missing.`, 'no-script')
  let script: VerifyScript
  try {
    script = JSON.parse(text)
  } catch (e) {
    throw new PlayableError(`Playable/${scriptRel} is not valid JSON: ${(e as Error).message}`, 'script')
  }
  if (!Array.isArray(script.runs) || !script.runs.length) throw new PlayableError(`Playable/${scriptRel} has no runs.`, 'script')
  for (const run of script.runs) {
    if (!run.scenePath) run.scenePath = lay.config.scenes.find((s) => basename(s, '.unity') === run.scene)
    if (!run.scenePath) throw new PlayableError(`Run scene ${run.scene} is not one of the exported scenes.`, 'script')
    run.steps ??= []
  }
  if (script.settle && !Array.isArray(script.settle)) script.settle = [script.settle]
  const hash = createHash('sha256').update(JSON.stringify(script)).digest('hex').slice(0, 12)
  return { script, name: basename(scriptRel).replace(/\.json$/, ''), hash }
}

export async function runHtml(p: MainPlugin, html: string, script: VerifyScript, log: (line: string) => void): Promise<SideResult & { errors: string[]; requests: string[] }> {
  if (!existsSync(html)) throw new PlayableError('The packed playable is missing. Run playables.pack() first.', 'no-pack')
  const page = await p.page({ width: 540, height: 960 })
  try {
    await page.load(html)
    const ready = await page.evaluate<boolean>(`new Promise((r) => { const t0 = Date.now(); const k = () => window.__playable && window.__playable.started ? r(true) : Date.now() - t0 > 10000 ? r(false) : setTimeout(k, 50); k(); })`, 20_000)
    if (!ready) throw new PlayableError(`The playable did not start in the page. ${page.messages.filter((m) => m.type === 'error').map((m) => m.text).slice(0, 3).join(' ')}`, 'html-start')
    const t0 = Date.now()
    const result = await page.evaluate<SideResult>(`window.__playable.harness.run(${JSON.stringify(script)})`, ((script.deadline ?? 600) + 30) * 1000)
    log(`html side: ${result.runs.length} runs in ${Date.now() - t0}ms${result.error ? `, error ${result.error.split('\n')[0]}` : ''}`)
    return { ...result, errors: page.messages.filter((m) => m.type === 'error').map((m) => m.text), requests: page.requests.slice() }
  } finally {
    page.close()
  }
}

export async function runUnity(p: MainPlugin, lay: Layout, script: VerifyScript, name: string, hash: string, log: (line: string) => void, signal?: AbortSignal): Promise<SideResult> {
  await mkdir(lay.runs, { recursive: true })
  const scriptPath = join(lay.runs, `${name}.script.json`)
  const outPath = join(lay.runs, `${name}.unity.json`)
  await writeFile(scriptPath, JSON.stringify(script))
  await rm(outPath, { force: true })
  await p.unity(lay.root, 'verify', { script: rel(lay.root, scriptPath), outPath: rel(lay.root, outPath) }, 60_000)
  log(`unity side: play mode started for ${script.runs.length} runs`)
  const deadline = Date.now() + ((script.deadline ?? 600) + 90) * 1000
  for (;;) {
    if (signal?.aborted) {
      await p.unity(lay.root, 'verifyStop', {}, 30_000).catch(() => null)
      throw new PlayableError('Cancelled.', 'cancelled')
    }
    if (existsSync(outPath)) break
    if (Date.now() > deadline) {
      await p.unity(lay.root, 'verifyStop', {}, 30_000).catch(() => null)
      throw new PlayableError('Unity did not finish the verify run before its deadline; play mode was stopped.', 'unity-deadline')
    }
    await sleep(POLL_MS)
  }
  const result = JSON.parse(await readFile(outPath, 'utf8')) as SideResult
  await writeFile(join(lay.runs, `${name}.unity.hash`), hash)
  log(`unity side: ${result.runs.length} runs, exit ${result.exit}${result.error ? `, ${String(result.error).split('\n')[0]}` : ''}`)
  return result
}

function parseRow(row: string): Record<string, unknown> {
  try {
    return JSON.parse(row)
  } catch {
    return { raw: row }
  }
}

function close(a: unknown, b: unknown, tolerance: number): boolean {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= tolerance * Math.max(1, Math.abs(a), Math.abs(b))
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => close(v, b[i], tolerance))
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const ka = Object.keys(a as object)
    return ka.length === Object.keys(b as object).length && ka.every((k) => close((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k], tolerance))
  }
  return a === b
}

function rowsEqual(u: string[], h: string[], tolerance: number): boolean {
  if (u.length !== h.length) return false
  for (let i = 0; i < u.length; i++) if (u[i] !== h[i] && !close(parseRow(u[i]), parseRow(h[i]), tolerance)) return false
  return true
}

function diffRows(u: string[], h: string[]): { unity: string[]; html: string[] } {
  const hs = new Set(h)
  const us = new Set(u)
  return { unity: u.filter((r) => !hs.has(r)).slice(0, 8), html: h.filter((r) => !us.has(r)).slice(0, 8) }
}

export function compare(unity: SideResult, html: SideResult, tolerance = 0.002): Record<string, unknown> {
  let states = 0
  let equal = 0
  const mismatches: Mismatch[] = []
  const runs = Math.max(unity.runs.length, html.runs.length)
  const perRun: unknown[] = []
  for (let r = 0; r < runs; r++) {
    const ur = unity.runs[r]
    const hr = html.runs[r]
    if (!ur || !hr) {
      perRun.push({ run: r, missing: !ur ? 'unity' : 'html' })
      continue
    }
    const n = Math.max(ur.states.length, hr.states.length)
    let runEqual = 0
    let firstBad: number | null = null
    for (let s = 0; s < n; s++) {
      states++
      const us = ur.states[s]
      const hs = hr.states[s]
      if (!us || !hs) {
        if (firstBad === null) firstBad = s
        continue
      }
      let same = true
      for (const probe of new Set([...Object.keys(us.probes), ...Object.keys(hs.probes)])) {
        const a = us.probes[probe]?.rows ?? []
        const b = hs.probes[probe]?.rows ?? []
        if (!rowsEqual(a, b, tolerance)) {
          same = false
          if (mismatches.length < 12) mismatches.push({ run: r, seed: ur.seed, state: s, step: us.step, probe, ...diffRows(a, b) })
        }
      }
      if (same) {
        equal++
        runEqual++
      } else if (firstBad === null) firstBad = s
    }
    perRun.push({ run: r, scene: ur.scene, seed: ur.seed, states: n, equal: runEqual, firstMismatch: firstBad, unityFrames: ur.states.map((x) => x.frame), htmlFrames: hr.states.map((x) => x.frame), settleTimeouts: { unity: ur.states.filter((x) => x.settleTimeout).length, html: hr.states.filter((x) => x.settleTimeout).length } })
  }
  const rngEqual = JSON.stringify(unity.rng) === JSON.stringify(html.rng)
  const probesFound = Object.fromEntries(Object.entries(unity.runs[0]?.states[0]?.probes ?? {}).map(([k, v]) => [k, { unity: v.found, html: html.runs[0]?.states[0]?.probes[k]?.found ?? false }]))
  return { ok: rngEqual && states > 0 && equal === states && unity.exit === 0 && html.exit === 0, states, equal, rngEqual, probesFound, runs: perRun, mismatches, unityExit: unity.exit, htmlExit: html.exit, unityError: unity.error, htmlError: html.error }
}

export async function verify(p: MainPlugin, root: string, options: { script: string; unity?: string | boolean; html?: string; tolerance?: number }, log: (line: string) => void, signal?: AbortSignal): Promise<Record<string, unknown>> {
  const lay = await layout(root)
  const { script, name, hash } = await loadScript(lay, options.script || 'verify/smoke.json')
  const html = options.html ? inside(root, options.html) : join(lay.out, `${lay.config.name}.html`)
  const h = await runHtml(p, html, script, log)
  const mode = options.unity === undefined ? 'auto' : String(options.unity)
  const cached = join(lay.runs, `${name}.unity.json`)
  let unity: SideResult | null = null
  const cacheOk = existsSync(cached) && (await readFile(join(lay.runs, `${name}.unity.hash`), 'utf8').catch(() => '')) === hash
  if (mode === 'false') unity = null
  else if ((mode === 'auto' || mode === 'cached') && cacheOk) {
    unity = JSON.parse(await readFile(cached, 'utf8'))
    log('unity side: reused the cached run for this script')
  } else if (mode === 'cached') throw new PlayableError('There is no cached Unity run for this exact script. Run with unity: true.', 'no-cache')
  else unity = await runUnity(p, lay, script, name, hash, log, signal)
  await mkdir(lay.runs, { recursive: true })
  await writeFile(join(lay.runs, `${name}.html.json`), JSON.stringify(h))
  const htmlSummary = { exit: h.exit, error: h.error, runs: h.runs.length, states: h.runs.reduce((n, r) => n + r.states.length, 0), errors: h.errors.slice(0, 5), requests: h.requests.slice(0, 5) }
  if (!unity) return { script: name, html: htmlSummary, unity: null, written: rel(root, join(lay.runs, `${name}.html.json`)) }
  const result = { script: name, ...compare(unity, h, options.tolerance), html: htmlSummary, unityVersion: (unity as unknown as { unityVersion?: string }).unityVersion }
  await writeFile(join(lay.runs, `${name}-report.json`), JSON.stringify(result, null, 2))
  return { ...result, report: rel(root, join(lay.runs, `${name}-report.json`)) }
}
