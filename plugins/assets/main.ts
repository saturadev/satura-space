import { appendFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { unzipSync, type MainPlugin, type PluginCtx } from '@satura/plugin'
import { RESOLUTIONS, SOURCE_LABEL, type AssetKind, type AssetRow, type AssetSource, type ImportOptions, type ImportProgress, type ImportResult, type ImportedAsset, type SearchOptions, type SearchResult } from './shared'

interface IndexRow {
  id: string
  name: string
  kind: AssetKind
  tags: string[]
  thumbnail: string
  rank: number
  authors?: string[]
}

interface IndexFile {
  fetched: number
  rows: IndexRow[]
}

interface MapSet {
  part: string
  color?: string
  normal?: string
  arm?: string
  rough?: string
  metal?: string
  ao?: string
  opacity?: string
}

interface Download {
  url: string
  to: string
  size: number
}

interface Plan {
  downloads: Download[]
  zip?: { url: string; size: number; keep: (name: string) => string | null }
  model?: string
  hdri?: string
  sets: MapSet[]
}

const PH_API = 'https://api.polyhaven.com'
const ACG_API = 'https://ambientcg.com/api/v3'
const DAY_MS = 24 * 60 * 60 * 1000
const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/
const SOURCE_DIR: Record<AssetSource, string> = { polyhaven: 'PolyHaven', ambientcg: 'ambientCG' }
const THIRD_PARTY = 'Assets/ThirdParty'
const CREDITS = `${THIRD_PARTY}/CREDITS.md`
const PH_KINDS: [string, AssetKind][] = [['models', 'model'], ['textures', 'material'], ['hdris', 'hdri']]
const ACG_KINDS: Record<string, AssetKind> = { material: 'material', hdri: 'hdri', '3d-model': 'model' }
const PH_MAP = /^(?:(.*)_)?(diffuse|diff|nor_gl|roughness|rough|metallic|metal|arm|ao|opacity)$/i
const ACG_MAP = /_(Color|NormalGL|Roughness|Metalness|AmbientOcclusion|Opacity)\.(jpe?g|png)$/i

export default function setup(p: MainPlugin): void {
  const ua = `SaturaSpace/${p.appVersion}`
  const indexes = new Map<AssetSource, Promise<IndexRow[]>>()
  const running = new Map<string, Promise<ImportResult>>()

  async function getJson<T>(url: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, { headers: { 'User-Agent': ua, Accept: 'application/json' } })
      if (res.status === 429 && attempt < 2) {
        const wait = Math.min(30, Number(res.headers.get('retry-after')) || 5)
        p.log(`${new URL(url).host} asked to wait ${wait}s`)
        await new Promise((r) => setTimeout(r, wait * 1000))
        continue
      }
      if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status} for ${new URL(url).pathname}`)
      return (await res.json()) as T
    }
  }

  async function fetchPolyHaven(): Promise<IndexRow[]> {
    const rows: IndexRow[] = []
    const lists = await Promise.all(PH_KINDS.map(([type]) => getJson<Record<string, Record<string, unknown>>>(`${PH_API}/assets?type=${type}`)))
    lists.forEach((list, i) => {
      for (const [id, v] of Object.entries(list)) {
        if (!ID.test(id)) continue
        const thumb = String(v.thumbnail_url ?? '').replace(/width=\d+/, 'width=512').replace(/height=\d+/, 'height=512')
        rows.push({
          id,
          name: String(v.name ?? id),
          kind: PH_KINDS[i][1],
          tags: [...(Array.isArray(v.tags) ? v.tags : []), ...(Array.isArray(v.categories) ? v.categories : [])].map(String),
          thumbnail: thumb,
          rank: Number(v.download_count) || 0,
          authors: v.authors && typeof v.authors === 'object' ? Object.keys(v.authors as object) : []
        })
      }
    })
    return rows
  }

  async function fetchAmbientCg(): Promise<IndexRow[]> {
    const rows: IndexRow[] = []
    for (let offset = 0; offset < 20000; offset += 500) {
      const page = await getJson<{ totalResults: number; assets: Record<string, unknown>[] }>(`${ACG_API}/assets?type=material,hdri,3d-model&sort=popular&limit=500&offset=${offset}&include=title,tags,thumbnails,type`)
      for (const a of page.assets ?? []) {
        const id = String(a.id ?? '')
        const kind = ACG_KINDS[String(a.type ?? '')]
        if (!ID.test(id) || !kind) continue
        const thumbs = (a.thumbnails ?? {}) as Record<string, string>
        rows.push({ id, name: String(a.title ?? id), kind, tags: (Array.isArray(a.tags) ? a.tags : []).map(String), thumbnail: thumbs['512-WEBP'] ?? thumbs['512-PNG'] ?? thumbs['256-PNG'] ?? '', rank: 1e6 - rows.length })
      }
      if (!page.assets?.length || offset + 500 >= page.totalResults) break
    }
    return rows
  }

  async function loadIndex(source: AssetSource, refresh = false): Promise<IndexRow[]> {
    const file = join(p.cacheDir, `index-${source}.json`)
    const cached = (await readFile(file, 'utf8').then((t) => JSON.parse(t) as IndexFile).catch(() => null))
    if (cached && !refresh && Date.now() - cached.fetched < DAY_MS && cached.rows.length) return cached.rows
    try {
      const t0 = Date.now()
      const rows = source === 'polyhaven' ? await fetchPolyHaven() : await fetchAmbientCg()
      await mkdir(p.cacheDir, { recursive: true })
      await writeFile(`${file}.tmp`, JSON.stringify({ fetched: Date.now(), rows } satisfies IndexFile))
      await rename(`${file}.tmp`, file)
      p.log(`${SOURCE_LABEL[source]} index: ${rows.length} assets in ${Date.now() - t0}ms`)
      return rows
    } catch (e) {
      if (cached?.rows.length) {
        p.log(`${SOURCE_LABEL[source]} index refresh failed, using the cached one: ${(e as Error).message}`)
        return cached.rows
      }
      throw e
    }
  }

  function index(source: AssetSource): Promise<IndexRow[]> {
    let got = indexes.get(source)
    if (!got) {
      got = loadIndex(source)
      indexes.set(source, got)
      got.catch(() => indexes.delete(source))
      got.then(() => setTimeout(() => indexes.delete(source), DAY_MS))
    }
    return got
  }

  function pageUrl(source: AssetSource, id: string): string {
    return source === 'polyhaven' ? `https://polyhaven.com/a/${id}` : `https://ambientcg.com/view?id=${id}`
  }

  function rowOut(source: AssetSource, r: IndexRow, imported: Set<string>): AssetRow {
    const key = `${source}:${r.id}`
    return { id: key, name: r.name, kind: r.kind, tags: r.tags.slice(0, 8), thumbnail: r.thumbnail, source, license: 'CC0', credit: SOURCE_LABEL[source], url: pageUrl(source, r.id), ...(imported.has(key) ? { imported: true } : {}) }
  }

  function sourcesOf(options: SearchOptions): AssetSource[] {
    const s = String(options.source ?? '').toLowerCase()
    if (!s) return ['polyhaven', 'ambientcg']
    if (s === 'polyhaven' || s === 'poly haven') return ['polyhaven']
    if (s === 'ambientcg') return ['ambientcg']
    throw new Error(`source is 'polyhaven' or 'ambientcg', got ${JSON.stringify(options.source)}`)
  }

  function kindOf(raw: unknown): AssetKind | '' {
    const k = String(raw ?? '').toLowerCase().replace(/s$/, '')
    if (!k) return ''
    if (k === 'model' || k === 'material' || k === 'hdri') return k
    if (k === 'texture') return 'material'
    throw new Error(`kind is 'model', 'material' or 'hdri', got ${JSON.stringify(raw)}`)
  }

  function score(r: IndexRow, words: string[]): number {
    if (!words.length) return 1
    const name = r.name.toLowerCase()
    const id = r.id.toLowerCase()
    const tags = r.tags.map((t) => t.toLowerCase())
    let total = 0
    for (const w of words) {
      let s = 0
      if (name.split(/[\s_-]+/).includes(w)) s = 6
      else if (name.includes(w) || id.includes(w)) s = 4
      else if (tags.includes(w)) s = 3
      else if (tags.some((t) => t.includes(w))) s = 1
      if (!s) return 0
      total += s
    }
    return total
  }

  async function search(ctx: PluginCtx, query: unknown, options: SearchOptions = {}): Promise<SearchResult> {
    const opts = options && typeof options === 'object' ? options : {}
    const kind = kindOf(opts.kind)
    const limit = Math.max(1, Math.min(200, Math.floor(Number(opts.limit) || 24)))
    const offset = Math.max(0, Math.floor(Number(opts.offset) || 0))
    const words = String(query ?? '').toLowerCase().split(/[\s,]+/).filter(Boolean)
    const sources = sourcesOf(opts)
    const lists = await Promise.allSettled(sources.map((s) => index(s)))
    const failed = lists.map((l, i) => (l.status === 'rejected' ? `${SOURCE_LABEL[sources[i]]}: ${(l.reason as Error)?.message}` : '')).filter(Boolean)
    if (failed.length === lists.length) throw new Error(`Could not load the asset index. ${failed.join('; ')}`)
    const imported = new Set((ctx.projectRoot ? await list(ctx).catch(() => []) : []).map((a) => a.id))
    const hits: { source: AssetSource; row: IndexRow; score: number }[] = []
    lists.forEach((l, i) => {
      if (l.status !== 'fulfilled') return
      for (const row of l.value) {
        if (kind && row.kind !== kind) continue
        const sc = score(row, words)
        if (sc > 0) hits.push({ source: sources[i], row, score: sc })
      }
    })
    const top = Math.max(1, ...hits.map((h) => (h.source === 'polyhaven' ? h.row.rank : 0)))
    const pop = (h: { source: AssetSource; row: IndexRow }): number => (h.source === 'polyhaven' ? h.row.rank / top : (h.row.rank - 1e6 + 3000) / 3000)
    hits.sort((a, b) => b.score - a.score || pop(b) - pop(a))
    const mixed = sources.length > 1 ? [...new Set(hits.map((h) => h.score))].flatMap((sc) => interleave(hits.filter((h) => h.score === sc))) : hits
    if (failed.length) ctx.log(`partial results: ${failed.join('; ')}`)
    return { rows: mixed.slice(offset, offset + limit).map((h) => rowOut(h.source, h.row, imported)), total: hits.length }
  }

  function interleave<T extends { source: AssetSource }>(hits: T[]): T[] {
    const a = hits.filter((h) => h.source === 'polyhaven')
    const b = hits.filter((h) => h.source !== 'polyhaven')
    const out: T[] = []
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) out.push(a[i])
      if (b[i]) out.push(b[i])
    }
    return out
  }

  function projectOf(ctx: PluginCtx): string {
    const root = ctx.projectRoot ? resolve(ctx.projectRoot) : ''
    if (!root || !existsSync(join(root, 'Assets')) || !existsSync(join(root, 'ProjectSettings'))) throw new Error(`${root || 'This call'} is not a Unity project, so there is nowhere to import to.`)
    return root
  }

  function parseRef(ref: unknown): { source: AssetSource; id: string } {
    const raw = typeof ref === 'object' && ref && 'id' in ref ? String((ref as { id: unknown }).id) : String(ref ?? '')
    const m = /^(polyhaven|ambientcg):(.+)$/i.exec(raw.trim())
    if (!m || !ID.test(m[2])) throw new Error(`Pass an id from assets.search(), like 'polyhaven:wooden_crate_02' or 'ambientcg:Wood096'. Got ${JSON.stringify(raw)}.`)
    return { source: m[1].toLowerCase() as AssetSource, id: m[2] }
  }

  function pickFormat(formats: Record<string, { url?: string; size?: number }> | undefined): { url: string; size: number; ext: string } | null {
    if (!formats) return null
    for (const ext of ['jpg', 'png', 'exr']) {
      const f = formats[ext]
      if (f?.url) return { url: f.url, size: Number(f.size) || 0, ext }
    }
    return null
  }

  function pickRes<T>(byRes: Record<string, T> | undefined, want: string): [string, T] | null {
    if (!byRes) return null
    if (byRes[want]) return [want, byRes[want]]
    const have = Object.keys(byRes).filter((r) => /^\d+k$/.test(r)).sort((a, b) => parseInt(a) - parseInt(b))
    const lower = have.filter((r) => parseInt(r) <= parseInt(want))
    const res = lower[lower.length - 1] ?? have[0]
    return res ? [res, byRes[res]] : null
  }

  async function planPolyHaven(id: string, kind: AssetKind, res: string, dirRel: string): Promise<Plan> {
    const files = await getJson<Record<string, Record<string, Record<string, unknown>>>>(`${PH_API}/files/${encodeURIComponent(id)}`)
    const plan: Plan = { downloads: [], sets: [] }
    if (kind === 'hdri') {
      const got = pickRes(files.hdri as Record<string, Record<string, { url: string; size: number }>>, res)
      const hdr = got?.[1].hdr ?? got?.[1].exr
      if (!hdr?.url) throw new Error(`Poly Haven has no HDR file for ${id}.`)
      const to = `${dirRel}/${basename(new URL(hdr.url).pathname)}`
      plan.downloads.push({ url: hdr.url, to, size: Number(hdr.size) || 0 })
      plan.hdri = to
      return plan
    }
    const used = new Set<string>()
    if (kind === 'model') {
      const fbx = pickRes(files.fbx as Record<string, { fbx?: { url: string; size: number; include?: Record<string, unknown> } }>, res)?.[1].fbx
      if (!fbx?.url) throw new Error(`Poly Haven has no FBX for ${id}.`)
      plan.model = `${dirRel}/${id}.fbx`
      plan.downloads.push({ url: fbx.url, to: plan.model, size: Number(fbx.size) || 0 })
      for (const file of Object.keys(fbx.include ?? {})) {
        const m = PH_MAP.exec(basename(file).replace(/\.\w+$/, '').replace(/_\d+k$/i, '').slice(id.length + 1))
        if (m && basename(file).toLowerCase().startsWith(`${id.toLowerCase()}_`)) used.add((m[1] ?? '').toLowerCase())
      }
    }
    const sets = new Map<string, MapSet>()
    for (const [key, byRes] of Object.entries(files)) {
      const m = PH_MAP.exec(key)
      if (!m) continue
      const got = pickFormat(pickRes(byRes as Record<string, Record<string, { url?: string; size?: number }>>, res)?.[1])
      if (!got) continue
      const part = (m[1] ?? '').toLowerCase()
      const slot = ({ diffuse: 'color', diff: 'color', nor_gl: 'normal', roughness: 'rough', rough: 'rough', metallic: 'metal', metal: 'metal', arm: 'arm', ao: 'ao', opacity: 'opacity' } as const)[m[2].toLowerCase() as 'diff']
      const to = `${dirRel}/textures/${basename(new URL(got.url).pathname)}`
      plan.downloads.push({ url: got.url, to, size: got.size })
      const set = sets.get(part) ?? { part }
      set[slot] = to
      sets.set(part, set)
    }
    for (const set of sets.values()) {
      if (set.arm) {
        for (const slot of ['rough', 'metal', 'ao'] as const) {
          const extra = set[slot]
          if (!extra) continue
          plan.downloads = plan.downloads.filter((d) => d.to !== extra)
          delete set[slot]
        }
      }
    }
    plan.sets = [...sets.values()].filter((s) => s.color || s.normal || s.arm || s.rough).sort((a, b) => Number(used.has(b.part)) - Number(used.has(a.part)))
    if (!plan.sets.length && kind === 'material') throw new Error(`Poly Haven lists no texture maps for ${id} at ${res}.`)
    return plan
  }

  async function planAmbientCg(id: string, kind: AssetKind, res: string, dirRel: string): Promise<Plan> {
    const found = await getJson<{ assets: { id: string; downloads?: { attributes: string; extension: string; url: string; size: number }[] }[] }>(`${ACG_API}/assets?id=${encodeURIComponent(id)}&include=downloads`)
    const downloads = (found.assets?.[0]?.downloads ?? []).filter((d) => d.extension === 'zip' && d.url && !/patreon|token/i.test(d.url))
    if (!downloads.length) throw new Error(`ambientCG has no free download for ${id}; some files need a Patreon token and are skipped.`)
    const R = res.toUpperCase()
    const wanted = kind === 'hdri' ? [R] : kind === 'model' ? [`LQ-${R}-JPG`, `HQ-${R}-JPG`, `LQ-${R}-PNG`] : [`${R}-JPG`, `${R}-PNG`]
    const fallback = downloads.filter((d) => (kind === 'hdri' ? /^\d+K$/ : /JPG|PNG/).test(d.attributes)).sort((a, b) => a.size - b.size)
    const pick = wanted.map((w) => downloads.find((d) => d.attributes === w)).find(Boolean) ?? fallback[0] ?? downloads[0]
    const plan: Plan = { downloads: [], sets: [] }
    const set: MapSet = { part: '' }
    plan.zip = {
      url: pick.url,
      size: pick.size,
      keep: (name) => {
        const file = basename(name)
        if (kind === 'hdri') {
          if (!/_HDR\.exr$|\.hdr$/i.test(file)) return null
          plan.hdri = `${dirRel}/${file}`
          return plan.hdri
        }
        if (kind === 'model' && /\.(obj|fbx)$/i.test(file)) {
          plan.model = `${dirRel}/${file}`
          return plan.model
        }
        if (kind === 'model' && /\.mtl$/i.test(file)) return `${dirRel}/${file}`
        const m = ACG_MAP.exec(file)
        if (!m) return null
        const to = `${dirRel}/textures/${file}`
        const slot = ({ color: 'color', normalgl: 'normal', roughness: 'rough', metalness: 'metal', ambientocclusion: 'ao', opacity: 'opacity' } as const)[m[1].toLowerCase() as 'color']
        set[slot] = to
        return to
      }
    }
    plan.sets = [set]
    return plan
  }

  async function download(url: string, onBytes: (n: number) => void): Promise<Buffer> {
    const res = await fetch(url, { headers: { 'User-Agent': ua } })
    if (!res.ok || !res.body) throw new Error(`${new URL(url).host} answered ${res.status} for ${basename(new URL(url).pathname)}`)
    if (/text\/html/i.test(res.headers.get('content-type') ?? '')) throw new Error(`${basename(new URL(url).pathname)} needs a sign-in or token, so it was skipped.`)
    const chunks: Buffer[] = []
    const reader = res.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(Buffer.from(value))
      onBytes(value.byteLength)
    }
    return Buffer.concat(chunks)
  }

  function inside(root: string, rel: string): string {
    const abs = resolve(root, rel)
    if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`${rel} is outside the project`)
    return abs
  }

  async function writeCredit(root: string, source: AssetSource, row: IndexRow): Promise<boolean> {
    const file = join(root, CREDITS)
    const key = `${source}:${row.id}`
    const have = await readFile(file, 'utf8').catch(() => null)
    if (have?.includes(`(${key})`)) return false
    const by = row.authors?.length ? ` by ${row.authors.join(', ')},` : ''
    const line = `- [${row.name}](${pageUrl(source, row.id)})${by} from ${SOURCE_LABEL[source]}, CC0 (${key})\n`
    await mkdir(dirname(file), { recursive: true })
    if (have === null) await writeFile(file, `# Third-party assets\n\nCC0 assets imported with Satura Space. No attribution is required; this list keeps the credit anyway.\n\n${line}`)
    else await appendFile(file, `${have.endsWith('\n') || !have ? '' : '\n'}${line}`)
    return true
  }

  async function importAsset(ctx: PluginCtx, ref: unknown, options: ImportOptions = {}): Promise<ImportResult> {
    const root = projectOf(ctx)
    const { source, id } = parseRef(ref)
    const key = `${source}:${id}`
    const runKey = `${root}|${key}`
    const already = running.get(runKey)
    if (already) return already
    const job = runImport(ctx, root, source, id, key, options && typeof options === 'object' ? options : {})
    running.set(runKey, job)
    try {
      return await job
    } finally {
      running.delete(runKey)
    }
  }

  async function runImport(ctx: PluginCtx, root: string, source: AssetSource, id: string, key: string, options: ImportOptions): Promise<ImportResult> {
    const res = String(options.res ?? '1k').toLowerCase()
    if (!RESOLUTIONS.includes(res)) throw new Error(`res is one of ${RESOLUTIONS.join(', ')}, got ${JSON.stringify(options.res)}`)
    const progress = (patch: Omit<ImportProgress, 'id' | 'project'>): void => p.emit('progress', { id: key, project: root, ...patch } satisfies ImportProgress)
    try {
      const row = (await index(source)).find((r) => r.id === id) ?? (await loadIndex(source, true)).find((r) => r.id === id)
      if (!row) throw new Error(`${SOURCE_LABEL[source]} has no asset ${id}. assets.search() lists the ids.`)
      const pipeline = (await p.unity(root, 'pipeline', {}, 30_000)) as { pipeline?: string } | null
      if (pipeline?.pipeline === 'hdrp') throw new Error('This project uses HDRP. Free Assets builds materials for URP and the Built-in pipeline only for now.')
      const dirRel = `${THIRD_PARTY}/${SOURCE_DIR[source]}/${id}`
      const dir = inside(root, dirRel)
      progress({ stage: 'download', done: 0, total: 0 })
      const plan = source === 'polyhaven' ? await planPolyHaven(id, row.kind, res, dirRel) : await planAmbientCg(id, row.kind, res, dirRel)
      const total = plan.downloads.reduce((n, d) => n + d.size, 0) + (plan.zip?.size ?? 0)
      let done = 0
      let last = 0
      const tick = (n: number, file: string): void => {
        done += n
        const now = Date.now()
        if (now - last < 120) return
        last = now
        progress({ stage: 'download', done, total, file })
      }
      ctx.log(`importing ${key} at ${res}: ${plan.downloads.length + (plan.zip ? 1 : 0)} downloads, ${(total / 1e6).toFixed(1)} MB`)
      const stage = join(dir, '..', `.${id}.download`)
      await rm(stage, { recursive: true, force: true })
      await mkdir(stage, { recursive: true })
      const written: string[] = []
      try {
        const put = async (rel: string, data: Uint8Array): Promise<void> => {
          const to = join(stage, relative(dirRel, rel))
          await mkdir(dirname(to), { recursive: true })
          await writeFile(to, data)
          written.push(rel)
        }
        let next = 0
        const worker = async (): Promise<void> => {
          while (next < plan.downloads.length) {
            const d = plan.downloads[next++]
            await put(d.to, await download(d.url, (n) => tick(n, basename(d.to))))
          }
        }
        await Promise.all([worker(), worker(), worker()])
        if (plan.zip) {
          const zip = await download(plan.zip.url, (n) => tick(n, basename(new URL(plan.zip!.url).pathname)))
          const keep = new Map<string, string>()
          const files = unzipSync(zip, { filter: (f) => { const to = plan.zip!.keep(f.name); if (to) keep.set(f.name, to); return !!to } })
          for (const [name, data] of Object.entries(files)) await put(keep.get(name)!, data)
        }
        if (plan.zip && !written.length) throw new Error(`The ${SOURCE_LABEL[source]} download for ${id} had no files Unity can use.`)
        await mkdir(dirname(dir), { recursive: true })
        await mkdir(dir, { recursive: true })
        for (const rel of written) {
          const to = inside(root, rel)
          await mkdir(dirname(to), { recursive: true })
          await rm(to, { force: true })
          await rename(join(stage, relative(dirRel, rel)), to)
        }
      } finally {
        await rm(stage, { recursive: true, force: true })
      }
      progress({ stage: 'unity', done: total, total })
      const built = (await p.unity(root, 'build', {
        kind: row.kind,
        dir: dirRel,
        id,
        name: row.name,
        model: plan.model ?? '',
        hdri: plan.hdri ?? '',
        skybox: options.skybox === true,
        sets: plan.sets.map((s) => ({ part: s.part, color: s.color ?? '', normal: s.normal ?? '', arm: s.arm ?? '', rough: s.rough ?? '', metal: s.metal ?? '', ao: s.ao ?? '', opacity: s.opacity ?? '' }))
      }, 180_000)) as Omit<ImportResult, 'id' | 'files' | 'bytes'>
      await writeCredit(root, source, row)
      const result: ImportResult = { id: key, ...built, files: written.length, bytes: done }
      ctx.log(`imported ${key}: ${result.path}${result.tris !== undefined ? `, ${result.tris} tris` : ''}`)
      progress({ stage: 'done', done: total, total, result })
      return result
    } catch (e) {
      progress({ stage: 'error', done: 0, total: 0, error: (e as Error).message })
      throw e
    }
  }

  async function list(ctx: PluginCtx): Promise<ImportedAsset[]> {
    const root = projectOf(ctx)
    const credits = await readFile(join(root, CREDITS), 'utf8').catch(() => '')
    const out: ImportedAsset[] = []
    for (const source of Object.keys(SOURCE_DIR) as AssetSource[]) {
      const base = join(root, THIRD_PARTY, SOURCE_DIR[source])
      for (const e of await readdir(base, { withFileTypes: true }).catch(() => [])) {
        if (!e.isDirectory() || e.name.startsWith('.')) continue
        const files = await readdir(join(base, e.name)).catch(() => [] as string[])
        const rel = `${THIRD_PARTY}/${SOURCE_DIR[source]}/${e.name}`
        const prefab = files.find((f) => f.endsWith('.prefab'))
        const sky = files.find((f) => f.endsWith('_Skybox.mat'))
        const mat = files.find((f) => f === `${e.name}.mat`)
        const kind: AssetKind | null = prefab ? 'model' : sky ? 'hdri' : mat ? 'material' : null
        if (!kind) continue
        const key = `${source}:${e.name}`
        const name = new RegExp(`- \\[([^\\]]+)\\]\\([^)]*\\)[^\\n]*\\(${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\)`).exec(credits)?.[1] ?? e.name
        out.push({ id: key, name, kind, path: `${rel}/${prefab ?? sky ?? mat}`, source })
      }
    }
    return out
  }

  async function status(ctx: PluginCtx): Promise<Record<string, unknown>> {
    const out: Record<string, unknown> = {}
    for (const source of ['polyhaven', 'ambientcg'] as AssetSource[]) {
      const file = join(p.cacheDir, `index-${source}.json`)
      const st = await stat(file).catch(() => null)
      out[source] = st ? { cached: true, ageMin: Math.round((Date.now() - st.mtimeMs) / 60000), bytes: st.size } : { cached: false }
    }
    if (ctx.projectRoot) out.pipeline = ((await p.unity(projectOf(ctx), 'pipeline', {}, 15_000).catch((e: Error) => ({ pipeline: `unavailable: ${e.message}` }))) as { pipeline: string }).pipeline
    return { cacheDir: p.cacheDir, ...out }
  }

  p.exec('search', async (ctx, query, options) => (await search(ctx, query, options)).rows)
  p.exec('import', importAsset)
  p.exec('list', list)

  p.handle({
    name: 'search',
    description: "Searches the cached Poly Haven and ambientCG index the way assets.search() does in satura_exec. kind is model, material or hdri, source polyhaven or ambientcg, both empty for all. Returns rows (id, name, kind, tags, thumbnail, source, license, credit, url, imported) and total.",
    params: { query: '', kind: '', source: '', limit: 24, offset: 0 },
    run: (params, ctx) => search(ctx, params.query, { kind: params.kind as AssetKind, source: params.source as AssetSource, limit: Number(params.limit), offset: Number(params.offset) })
  })
  p.handle({
    name: 'import',
    long: true,
    description: "Downloads one asset from assets.search() into Assets/ThirdParty/<Source>/<id>/ of the project and has Unity build its materials for the project's render pipeline: a prefab for a model, a material for a material, a Panoramic skybox material for an HDRI (skybox: true also sets it as the open scene's skybox, unsaved). Writes a line to Assets/ThirdParty/CREDITS.md. Returns kind, path, prefab, material or skybox, tris and size for models, pipeline, files and bytes.",
    params: { id: '', res: '1k', skybox: false },
    run: (params, ctx) => importAsset(ctx, params.id, { res: String(params.res), skybox: params.skybox === true })
  })
  p.handle({
    name: 'list',
    description: 'Lists the assets this project already imported from Poly Haven and ambientCG: id, name, kind, path of the prefab or material, source.',
    params: {},
    run: (_params, ctx) => list(ctx)
  })
  p.handle({
    name: 'status',
    description: "Shows the asset index cache (age and size per source) and the render pipeline Unity reports for the project.",
    params: {},
    run: (_params, ctx) => status(ctx)
  })
}
