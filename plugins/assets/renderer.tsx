import { useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Check, ExternalLink, Package, RotateCw, Search, X } from 'lucide-react'
import { Select, debugLog, type PanelProps, type RendererPlugin } from '@satura/plugin'
import { RESOLUTIONS, SOURCE_LABEL, type AssetKind, type AssetRow, type AssetSource, type ImportProgress, type ImportResult, type ImportedAsset, type SearchResult } from './shared'

interface ImportState {
  stage: 'pending' | 'download' | 'unity' | 'done' | 'error'
  done: number
  total: number
  error?: string
  result?: ImportResult
}

interface PanelState {
  query: string
  kind: AssetKind | ''
  source: AssetSource | ''
  rows: AssetRow[]
  total: number
  loading: boolean
  more: boolean
  error: string | null
  searched: number
  selected: string | null
  res: string
  skybox: boolean
  imports: Record<string, ImportState>
  imported: Record<string, string>
}

const PAGE = 60
const KINDS: { value: AssetKind | ''; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'model', label: 'Models' },
  { value: 'material', label: 'Materials' },
  { value: 'hdri', label: 'HDRIs' }
]
const KIND_WORD: Record<AssetKind, string> = { model: 'Model', material: 'Material', hdri: 'HDRI' }

let plugin: RendererPlugin
const states = new Map<string, { state: PanelState; listeners: Set<() => void>; seq: number; timer: ReturnType<typeof setTimeout> | null }>()

function keyOf(project: string): string {
  return project.replace(/\\/g, '/').replace(/\/+$/, '')
}

function entry(project: string) {
  const key = keyOf(project)
  let e = states.get(key)
  if (!e) {
    e = {
      state: { query: '', kind: '', source: '', rows: [], total: 0, loading: false, more: false, error: null, searched: 0, selected: null, res: '1k', skybox: false, imports: {}, imported: {} },
      listeners: new Set(),
      seq: 0,
      timer: null
    }
    states.set(key, e)
  }
  return e
}

function update(project: string, patch: Partial<PanelState> | ((s: PanelState) => Partial<PanelState>)): void {
  const e = entry(project)
  e.state = { ...e.state, ...(typeof patch === 'function' ? patch(e.state) : patch) }
  for (const l of e.listeners) l()
}

function usePanel(project: string): PanelState {
  const e = entry(project)
  return useSyncExternalStore(
    (cb) => {
      e.listeners.add(cb)
      return () => e.listeners.delete(cb)
    },
    () => e.state
  )
}

async function refreshImported(project: string): Promise<void> {
  const list = await plugin.call<ImportedAsset[]>('list', project).catch(() => [] as ImportedAsset[])
  update(project, { imported: Object.fromEntries(list.map((a) => [a.id, a.path])) })
}

async function runSearch(project: string, append = false): Promise<void> {
  const e = entry(project)
  const seq = ++e.seq
  const s = e.state
  update(project, append ? { more: true, error: null } : { loading: true, error: null })
  try {
    const r = await plugin.call<SearchResult>('search', project, { query: s.query, kind: s.kind, source: s.source, limit: PAGE, offset: append ? s.rows.length : 0 })
    if (seq !== e.seq) return
    update(project, (cur) => ({ rows: append ? [...cur.rows, ...r.rows] : r.rows, total: r.total, loading: false, more: false, searched: cur.searched + 1 }))
    debugLog(`[assets] search "${s.query}" kind=${s.kind || 'all'} source=${s.source || 'all'}: ${r.total} hits`)
  } catch (err) {
    if (seq !== e.seq) return
    update(project, { loading: false, more: false, error: (err as Error).message })
  }
}

function setFilters(project: string, patch: Partial<Pick<PanelState, 'query' | 'kind' | 'source'>>, debounce: boolean): void {
  const e = entry(project)
  update(project, { ...patch, loading: true })
  if (e.timer) clearTimeout(e.timer)
  e.timer = setTimeout(() => {
    e.timer = null
    void runSearch(project)
  }, debounce ? 200 : 0)
}

function startImport(project: string, id: string): Promise<ImportResult | null> {
  const s = entry(project).state
  if (s.imports[id] && s.imports[id].stage !== 'done' && s.imports[id].stage !== 'error') return Promise.resolve(null)
  update(project, (cur) => ({ imports: { ...cur.imports, [id]: { stage: 'pending', done: 0, total: 0 } } }))
  const row = s.rows.find((r) => r.id === id)
  return plugin.call<ImportResult>('import', project, { id, res: s.res, skybox: row?.kind === 'hdri' && s.skybox }).then(
    (result) => {
      update(project, (cur) => ({ imports: { ...cur.imports, [id]: { stage: 'done', done: 1, total: 1, result } }, imported: { ...cur.imported, [id]: result.path } }))
      return result
    },
    (err: Error) => {
      update(project, (cur) => ({ imports: { ...cur.imports, [id]: { stage: 'error', done: 0, total: 0, error: err.message } } }))
      return null
    }
  )
}

function onProgress(ev: ImportProgress): void {
  if (ev.stage !== 'download' && ev.stage !== 'unity') return
  for (const [key] of states) {
    if (key !== keyOf(ev.project)) continue
    update(key, (cur) => {
      const was = cur.imports[ev.id]
      if (!was || was.stage === 'done' || was.stage === 'error') return {}
      return { imports: { ...cur.imports, [ev.id]: { stage: ev.stage as 'download' | 'unity', done: ev.done, total: ev.total } } }
    })
  }
}

function mb(n: number): string {
  return n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`
}

function Bar({ value, thin = false, className = '' }: { value: number | null; thin?: boolean; className?: string }) {
  return (
    <div className={`relative ${thin ? 'h-[3px]' : 'h-1'} overflow-hidden rounded-full bg-white/[0.08] ${className}`} role="progressbar" aria-valuenow={value === null ? undefined : Math.round(value * 100)}>
      {value === null ? (
        <div className="absolute inset-y-0 w-1/3 animate-[assets-slide_1.1s_ease-in-out_infinite] rounded-full bg-accent" />
      ) : (
        <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-150" style={{ width: `${Math.max(3, Math.min(100, value * 100))}%` }} />
      )}
    </div>
  )
}

function importLabel(st: ImportState): string {
  if (st.stage === 'pending') return 'Starting…'
  if (st.stage === 'download') return st.total > 0 ? `Downloading ${mb(st.done)} of ${mb(st.total)}` : 'Downloading…'
  if (st.stage === 'unity') return 'Building materials in Unity…'
  return ''
}

function importValue(st: ImportState): number | null {
  if (st.stage === 'download' && st.total > 0) return st.done / st.total
  return null
}

function Segmented<T extends string>({ value, options, onChange, name }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; name: string }) {
  return (
    <div className="flex shrink-0 rounded-md bg-sunken p-0.5 ring-1 ring-inset ring-white/[0.08]" data-assets-segmented={name}>
      {options.map((o) => (
        <button
          key={o.value || 'all'}
          type="button"
          onClick={() => onChange(o.value)}
          data-value={o.value || 'all'}
          data-active={o.value === value ? '' : undefined}
          className={`h-6 whitespace-nowrap rounded-[5px] px-2.5 text-[11.5px] font-medium transition-colors ${o.value === value ? 'bg-elevated text-ink shadow-sm' : 'text-ink-3 hover:text-ink'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}

function Thumb({ row, large = false }: { row: AssetRow; large?: boolean }) {
  const [loaded, setLoaded] = useState(false)
  const [failed, setFailed] = useState(false)
  const contain = row.kind === 'model'
  return (
    <div className={`relative overflow-hidden ${large ? 'rounded-lg' : 'rounded-t-[7px]'} aspect-square bg-[radial-gradient(circle_at_50%_40%,#2b2f37,#1d2025_70%)]`}>
      {!loaded && !failed && <div className="absolute inset-0 animate-pulse bg-white/[0.03]" />}
      {row.thumbnail && !failed && (
        <img
          src={row.thumbnail}
          alt=""
          draggable={false}
          loading="lazy"
          decoding="async"
          onLoad={() => setLoaded(true)}
          onError={() => setFailed(true)}
          data-assets-thumb={loaded ? 'loaded' : 'loading'}
          className={`absolute inset-0 h-full w-full transition-opacity duration-300 ${contain ? 'object-contain p-[6%]' : 'object-cover'} ${loaded ? 'opacity-100' : 'opacity-0'}`}
        />
      )}
      {failed && <div className="absolute inset-0 flex items-center justify-center text-[11px] text-ink-4">No preview</div>}
    </div>
  )
}

function Card({ row, selected, imported, job, onPick }: { row: AssetRow; selected: boolean; imported: boolean; job?: ImportState; onPick: () => void }) {
  const busy = !!job && job.stage !== 'done' && job.stage !== 'error'
  return (
    <button
      type="button"
      onClick={onPick}
      data-assets-card={row.id}
      data-selected={selected ? '' : undefined}
      data-imported={imported ? '' : undefined}
      className={`group flex min-w-0 flex-col rounded-lg bg-panel text-left outline-none ring-1 transition-[box-shadow,transform] duration-100 active:scale-[0.985] ${selected ? 'ring-2 ring-accent' : 'ring-white/[0.06] hover:ring-white/[0.16]'}`}
    >
      <Thumb row={row} />
      <div className="h-[3px] px-2">{busy && <Bar value={importValue(job)} thin />}</div>
      <div className="flex min-w-0 flex-col gap-0.5 px-2.5 pb-2 pt-1">
        <div className="flex min-w-0 items-center gap-1.5">
          <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-ink">{row.name}</span>
          {imported && <Check className="h-3.5 w-3.5 shrink-0 text-accent" strokeWidth={2.5} aria-label="Imported" />}
        </div>
        <div className="flex min-w-0 items-center gap-1 text-[10.5px] text-ink-3">
          <span className="truncate" data-assets-credit>{SOURCE_LABEL[row.source]}</span>
          <span className="text-ink-4">·</span>
          <span className="shrink-0">{KIND_WORD[row.kind]}</span>
        </div>
      </div>
    </button>
  )
}

function SkeletonCard() {
  return (
    <div className="flex flex-col rounded-lg bg-panel ring-1 ring-white/[0.04]">
      <div className="aspect-square animate-pulse rounded-t-[7px] bg-white/[0.035]" />
      <div className="h-[3px]" />
      <div className="flex flex-col gap-1.5 px-2.5 pb-2.5 pt-1.5">
        <div className="h-2.5 w-3/4 animate-pulse rounded bg-white/[0.06]" />
        <div className="h-2 w-1/3 animate-pulse rounded bg-white/[0.04]" />
      </div>
    </div>
  )
}

function Toggle({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <button type="button" role="switch" aria-checked={checked} onClick={() => onChange(!checked)} data-assets-skybox={checked ? 'on' : 'off'} className="flex items-center gap-2 text-left text-[12px] text-ink-2 hover:text-ink">
      <span className={`relative h-4 w-7 shrink-0 rounded-full transition-colors ${checked ? 'bg-accent' : 'bg-white/[0.14]'}`}>
        <span className={`absolute top-0.5 h-3 w-3 rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-3.5' : 'translate-x-0.5'}`} />
      </span>
      {children}
    </button>
  )
}

function Details({ project, row, s }: { project: string; row: AssetRow; s: PanelState }) {
  const job = s.imports[row.id]
  const busy = !!job && job.stage !== 'done' && job.stage !== 'error'
  const importedPath = s.imported[row.id]
  const result = job?.stage === 'done' ? job.result : undefined
  return (
    <aside className="flex w-[300px] shrink-0 flex-col overflow-y-auto border-l border-white/[0.06] bg-canvas" data-assets-details={row.id}>
      <div className="flex items-center justify-between px-4 pb-2 pt-3">
        <span className="text-[10.5px] font-medium uppercase tracking-wider text-ink-3">{KIND_WORD[row.kind]}</span>
        <button type="button" onClick={() => update(project, { selected: null })} className="flex h-6 w-6 items-center justify-center rounded text-ink-3 hover:bg-white/10 hover:text-ink" aria-label="Close details">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="px-4">
        <div className="overflow-hidden rounded-lg ring-1 ring-white/[0.06]">
          <Thumb key={row.id} row={row} large />
        </div>
        <h2 className="mt-3 text-[15px] font-semibold leading-snug text-ink">{row.name}</h2>
        <button type="button" onClick={() => plugin.openExternal(row.url)} className="mt-1 flex items-center gap-1 text-[11.5px] text-ink-3 hover:text-ink" data-assets-source-link>
          {SOURCE_LABEL[row.source]} · CC0
          <ExternalLink className="h-3 w-3" />
        </button>
        {row.tags.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1">
            {row.tags.slice(0, 8).map((t) => (
              <span key={t} className="rounded bg-white/[0.06] px-1.5 py-0.5 text-[10.5px] text-ink-2">
                {t}
              </span>
            ))}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[12px] text-ink-2">Resolution</span>
          <Segmented name="res" value={s.res} options={RESOLUTIONS.slice(0, 3).map((r) => ({ value: r, label: r.toUpperCase() }))} onChange={(res) => update(project, { res })} />
        </div>
        {row.kind === 'hdri' && (
          <div className="mt-3">
            <Toggle checked={s.skybox} onChange={(skybox) => update(project, { skybox })}>
              Use as the open scene's skybox
            </Toggle>
          </div>
        )}
        <div className="mt-4 pb-4">
          {busy ? (
            <div className="flex flex-col gap-2 rounded-lg bg-white/[0.04] px-3 py-2.5" data-assets-import-state={job.stage}>
              <span className="text-[12px] tabular-nums text-ink-2">{importLabel(job)}</span>
              <Bar value={importValue(job)} />
            </div>
          ) : (
            <button
              type="button"
              onClick={() => void startImport(project, row.id)}
              data-assets-import={row.id}
              className="flex h-8 w-full items-center justify-center gap-1.5 rounded-md bg-accent text-[12.5px] font-semibold text-accent-fg transition-[filter,transform] hover:brightness-110 active:scale-[0.99]"
            >
              {importedPath ? <RotateCw className="h-3.5 w-3.5" strokeWidth={2.5} /> : null}
              {importedPath ? 'Import again' : 'Import'}
            </button>
          )}
          {job?.stage === 'error' && (
            <div className="mt-2 rounded-md border border-red-500/25 bg-red-500/10 px-2.5 py-2 text-[11.5px] leading-snug text-red-200" data-assets-import-state="error">
              {job.error}
            </div>
          )}
          {importedPath && !busy && (
            <div className="mt-2 flex flex-col gap-1 rounded-md bg-accent/[0.08] px-2.5 py-2 text-[11.5px] leading-snug text-ink-2" data-assets-import-state="done">
              <span className="flex items-center gap-1 font-medium text-ink">
                <Check className="h-3.5 w-3.5 text-accent" strokeWidth={2.5} />
                In the project
              </span>
              <span className="break-all font-mono text-[10.5px] text-ink-3">{importedPath}</span>
              {result?.tris !== undefined && result.size && (
                <span className="text-ink-3">
                  {result.tris.toLocaleString()} tris · {result.size.map((n) => n.toFixed(2)).join(' × ')} m
                </span>
              )}
            </div>
          )}
        </div>
      </div>
    </aside>
  )
}

function AssetsPanel({ projectPath }: PanelProps) {
  const s = usePanel(projectPath)
  const inputRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!s.searched && !s.loading) {
      void runSearch(projectPath)
      void refreshImported(projectPath)
    }
  }, [projectPath])
  const selected = s.selected ? s.rows.find((r) => r.id === s.selected) ?? null : null
  const first = !s.searched
  return (
    <div
      className="@container flex h-full min-h-0 flex-col bg-canvas text-ink"
      data-assets-panel={projectPath}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && s.selected) update(projectPath, { selected: null })
      }}
    >
      <style>{'@keyframes assets-slide{0%{left:-35%}100%{left:100%}}'}</style>
      <div className="flex h-11 shrink-0 items-center gap-2.5 border-b border-white/[0.06] px-3">
        <div className="hidden shrink-0 items-center gap-1.5 pr-1 @3xl:flex">
          <Package className="h-4 w-4 text-accent" strokeWidth={2} />
          <span className="text-[13px] font-semibold">Free Assets</span>
        </div>
        <label className="relative flex h-7 min-w-[170px] max-w-[380px] flex-1 items-center rounded-md bg-sunken ring-1 ring-inset ring-white/[0.08] focus-within:ring-accent/60">
          <Search className="pointer-events-none absolute left-2 h-3.5 w-3.5 text-ink-3" />
          <input
            ref={inputRef}
            value={s.query}
            onChange={(e) => setFilters(projectPath, { query: e.target.value }, true)}
            placeholder="Search models, materials, skies…"
            spellCheck={false}
            data-assets-search
            className="h-full w-full bg-transparent pl-7 pr-7 text-[12.5px] text-ink outline-none placeholder:text-ink-4"
          />
          {s.query && (
            <button type="button" onClick={() => setFilters(projectPath, { query: '' }, false)} className="absolute right-1.5 flex h-4 w-4 items-center justify-center rounded text-ink-3 hover:text-ink" aria-label="Clear search">
              <X className="h-3 w-3" />
            </button>
          )}
        </label>
        <Segmented name="kind" value={s.kind} options={KINDS} onChange={(kind) => setFilters(projectPath, { kind }, false)} />
        <Select<string>
          value={s.source || 'all'}
          options={[{ value: 'all', label: 'All sources' }, { value: 'polyhaven', label: 'Poly Haven' }, { value: 'ambientcg', label: 'ambientCG' }]}
          onChange={(v) => setFilters(projectPath, { source: v === 'all' ? '' : (v as AssetSource) }, false)}
          className="w-[132px] shrink-0"
          buttonClassName="h-7 !py-0"
        />
      </div>
      <div className="relative h-0.5 shrink-0 overflow-hidden">{s.loading && <div className="absolute inset-y-0 w-1/3 animate-[assets-slide_1.1s_ease-in-out_infinite] bg-accent" data-assets-loading />}</div>
      <div className="flex min-h-0 flex-1">
        <div className="min-h-0 min-w-0 flex-1 overflow-y-auto" data-assets-grid={s.rows.length}>
          {s.error ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 px-8 text-center">
              <p className="max-w-sm text-[13px] text-red-200" data-assets-error>
                {s.error}
              </p>
              <button type="button" onClick={() => void runSearch(projectPath)} className="rounded-md bg-white/[0.08] px-3 py-1.5 text-[12px] text-ink hover:bg-white/[0.12]">
                Try again
              </button>
            </div>
          ) : !first && s.rows.length === 0 && !s.loading ? (
            <div className="flex h-full items-center justify-center px-8 text-center text-[13px] text-ink-3" data-assets-empty>
              Nothing matches “{s.query}”. Try a broader word.
            </div>
          ) : (
            <div className="grid gap-3 p-3 [grid-template-columns:repeat(auto-fill,minmax(148px,1fr))]">
              {first
                ? Array.from({ length: 18 }, (_, i) => <SkeletonCard key={i} />)
                : s.rows.map((row) => (
                    <Card key={row.id} row={row} selected={row.id === s.selected} imported={!!s.imported[row.id] || !!row.imported} job={s.imports[row.id]} onPick={() => update(projectPath, { selected: row.id === s.selected ? null : row.id })} />
                  ))}
            </div>
          )}
          {!first && !s.error && s.rows.length < s.total && (
            <div className="flex justify-center pb-4">
              <button type="button" onClick={() => void runSearch(projectPath, true)} disabled={s.more} className="flex h-7 min-w-[120px] items-center justify-center rounded-md bg-white/[0.06] px-3 text-[12px] text-ink-2 hover:bg-white/[0.1] hover:text-ink disabled:opacity-60" data-assets-more>
                {s.more ? <Bar value={null} className="w-16" /> : `Show more (${s.total - s.rows.length})`}
              </button>
            </div>
          )}
        </div>
        {selected && <Details project={projectPath} row={selected} s={s} />}
      </div>
      <div className="flex h-7 shrink-0 items-center gap-2 border-t border-white/[0.06] px-3 text-[11px] text-ink-3">
        <span data-assets-attribution>Assets from Poly Haven and ambientCG, CC0</span>
        <span className="ml-auto tabular-nums">{s.searched ? `${s.total.toLocaleString()} ${s.total === 1 ? 'result' : 'results'}` : ''}</span>
      </div>
    </div>
  )
}

function summary(project: string): Record<string, unknown> {
  const s = entry(project).state
  const root = document.querySelector(`[data-assets-panel="${CSS.escape(project)}"]`) ?? document.querySelector('[data-assets-panel]')
  const thumbs = [...(root?.querySelectorAll('[data-assets-card] img') ?? [])] as HTMLImageElement[]
  return {
    open: !!root,
    query: s.query,
    kind: s.kind || 'all',
    source: s.source || 'all',
    loading: s.loading,
    error: s.error,
    total: s.total,
    shown: s.rows.length,
    ids: s.rows.slice(0, 8).map((r) => r.id),
    selected: s.selected,
    res: s.res,
    skybox: s.skybox,
    imports: Object.fromEntries(Object.entries(s.imports).map(([id, j]) => [id, { stage: j.stage, done: j.done, total: j.total, ...(j.error ? { error: j.error } : {}), ...(j.result ? { path: j.result.path } : {}) }])),
    imported: Object.keys(s.imported),
    dom: root
      ? {
          cards: root.querySelectorAll('[data-assets-card]').length,
          thumbsLoaded: thumbs.filter((i) => i.complete && i.naturalWidth > 0).length,
          details: root.querySelector('[data-assets-details]')?.getAttribute('data-assets-details') ?? null,
          importButton: !!root.querySelector('[data-assets-import]'),
          importState: root.querySelector('[data-assets-import-state]')?.getAttribute('data-assets-import-state') ?? null,
          credits: root.querySelectorAll('[data-assets-credit]').length,
          attribution: root.querySelector('[data-assets-attribution]')?.textContent ?? null
        }
      : null
  }
}

async function until(test: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (test()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return test()
}

export default function setup(p: RendererPlugin): void {
  plugin = p
  p.on<ImportProgress>('progress', onProgress)
  p.panel({ id: 'assets', title: 'Free Assets', icon: Package, component: AssetsPanel, symbol: 'shippingbox', unityOnly: true, hint: 'CC0 models, materials and HDRIs from Poly Haven and ambientCG, imported with materials for this project' })
  p.handle({
    name: 'panel',
    description: 'Opens the Free Assets panel for the project (or shows the open one) and returns what it shows: filters, results, selection, imports and DOM counts.',
    params: { waitMs: 15000 },
    async run(params, ctx) {
      const opened = p.openPanel('assets', ctx.projectRoot)
      if (!opened) throw new Error(`No workspace has ${ctx.projectRoot} open.`)
      await until(() => !!document.querySelector('[data-assets-panel]') && !!entry(ctx.projectRoot).state.searched && !entry(ctx.projectRoot).state.loading, Number(params.waitMs) || 15000)
      return { ...opened, ...summary(ctx.projectRoot) }
    }
  })
  p.handle({
    name: 'ui',
    description: "Drives the open Free Assets panel the way a click would: query, kind (model, material, hdri or all) and source (polyhaven, ambientcg or all) set the filters; select picks a card by id; res and skybox set the details; import: true presses the Import button; waitMs waits for the search, or with import for the import to finish. Returns the panel summary.",
    params: { query: null as string | null, kind: null as string | null, source: null as string | null, select: '', res: '', skybox: null as boolean | null, import: false, waitMs: 15000 },
    async run(params, ctx) {
      const project = ctx.projectRoot
      const wait = Number(params.waitMs) || 15000
      const filters: Partial<Pick<PanelState, 'query' | 'kind' | 'source'>> = {}
      if (typeof params.query === 'string') filters.query = params.query
      if (typeof params.kind === 'string') filters.kind = (params.kind === 'all' ? '' : params.kind) as AssetKind | ''
      if (typeof params.source === 'string') filters.source = (params.source === 'all' ? '' : params.source) as AssetSource | ''
      if (Object.keys(filters).length) {
        setFilters(project, filters, false)
        await until(() => !entry(project).state.loading, wait)
      }
      if (params.select) {
        const card = document.querySelector(`[data-assets-card="${CSS.escape(String(params.select))}"]`) as HTMLButtonElement | null
        if (!card) throw new Error(`No card ${String(params.select)} is shown. Search for it first.`)
        if (entry(project).state.selected !== params.select) card.click()
        await until(() => !!document.querySelector(`[data-assets-details="${CSS.escape(String(params.select))}"]`), 2000)
      }
      if (params.res) update(project, { res: String(params.res) })
      if (typeof params.skybox === 'boolean') update(project, { skybox: params.skybox })
      if (params.import) {
        const button = document.querySelector('[data-assets-import]') as HTMLButtonElement | null
        if (!button) throw new Error('No Import button is shown. Select a card first, and wait for a running import to finish.')
        const id = button.getAttribute('data-assets-import') ?? ''
        const t0 = performance.now()
        button.click()
        const pendingShown = await until(() => !!document.querySelector('[data-assets-import-state="pending"], [data-assets-import-state="download"]'), 1000)
        const feedbackMs = Math.round(performance.now() - t0)
        const stages = new Set<string>()
        await until(() => {
          const st = entry(project).state.imports[id]?.stage
          if (st) stages.add(st)
          return st === 'done' || st === 'error'
        }, wait)
        return { ...summary(project), pressed: id, feedbackMs, pendingShown, stagesSeen: [...stages] }
      }
      return summary(project)
    }
  })
}
