import { createRoot } from 'react-dom/client'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type MouseEvent, type ReactElement } from 'react'
import '../index.css'
import '../components/report/report-kit.css'
import { CODE_EXTENSIONS } from '@shared/report-code'
import { FloatingInParent } from '../components/ui/FloatingInParent'
import { resolveReportPath, type ReportLocation } from '@shared/report-link'
import { buildReportTree, nestedCount, type ReportNode } from '@shared/report-tree'
import { EXPORT_ASSET_PREFIX, EXPORT_DATA_ID, gitCallKey, type ReportExportData } from '@shared/report-export'
import { ReportApi, ReportContext, ReportSavedContext, ReportStore, type ReportBridge, type ReportGit } from '../components/report/report-context'
import { ReportBoundary, RuntimeError, evaluate, type Loaded } from '../components/report/report-eval'
import { ReportOverlay, type ImageGallery, type ImageHint, type Overlay } from '../components/report/ReportOverlay'
import { parseCodeHref } from '../components/report/code-ref'
import { reportView } from '../components/report/report-view-state'
import { setClipboardWriter } from '../lib/clipboard'

type Page = ReportExportData['pages'][number]

const data = JSON.parse(document.getElementById(EXPORT_DATA_ID)?.textContent ?? 'null') as ReportExportData
const byId = new Map(data.pages.map((p) => [p.id, p]))
const byFile = new Map(data.pages.map((p) => [p.file, p]))
const start = byFile.get(data.start) ?? data.pages[0]

const urls = new Map<string, string>()

function decode(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function assetUrl(path: string): string {
  const hit = urls.get(path)
  if (hit) return hit
  const a = data.assets[path]
  if (!a) return 'data:,'
  const parts: Uint8Array<ArrayBuffer>[] = []
  for (let k = 0; k < a.chunks; k++) parts.push(decode(document.getElementById(`${EXPORT_ASSET_PREFIX}${a.id}-${k}`)?.textContent?.trim() ?? ''))
  const url = URL.createObjectURL(new Blob(parts, { type: a.type }))
  urls.set(path, url)
  return url
}

function copyText(text: string): Promise<void> {
  const fallback = (): void => {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.cssText = 'position:fixed;left:-9999px;top:0'
    document.body.appendChild(ta)
    ta.select()
    document.execCommand('copy')
    ta.remove()
  }
  if (!navigator.clipboard) {
    fallback()
    return Promise.resolve()
  }
  return navigator.clipboard.writeText(text).catch(fallback)
}

setClipboardWriter(copyText)

function replay(page: Page): ReportBridge {
  const snap = page.snapshot
  const call =
    (method: string) =>
    (...args: unknown[]): Promise<never> => {
      const key = gitCallKey(method, args)
      return Promise.resolve((key in snap.git ? snap.git[key] : { ok: false, error: { message: 'This diff is not in the export' } }) as never)
    }
  const git = {
    getState: call('getState'),
    getCommit: call('getCommit'),
    diffBetweenWithStats: call('diffBetweenWithStats'),
    show: call('show'),
    patch: call('patch')
  } as ReportGit
  return {
    statPath: (p) => Promise.resolve({ exists: p in data.assets }),
    codeRefs: (_f, _r, refs) => Promise.resolve(Object.fromEntries(refs.map((r) => [r, snap.refs[r] ?? { ref: r, status: 'missing' as const }]))),
    readCode: (_f, _r, rel) => Promise.resolve(snap.code[rel] ?? { ok: false as const, error: 'missing' as const }),
    fileInfo: () =>
      Promise.resolve({
        bytes: null,
        mtimeMs: page.savedAt ?? null,
        owner: null,
        links: page.links.filter((l) => byFile.has(l)).length,
        nested: nestedCount(tree, page.file),
        home: ''
      }),
    git
  }
}

function hashOf(id: string, loc?: ReportLocation): string {
  const q = new URLSearchParams()
  if (loc?.video) q.set('video', loc.video)
  if (loc?.frame != null) q.set('frame', String(loc.frame))
  if (loc?.t != null) q.set('t', String(loc.t))
  const qs = q.toString()
  return `#/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`
}

function parseHash(): { page: Page; loc: ReportLocation | null } {
  const m = /^#\/([^?]*)(?:\?(.*))?$/.exec(location.hash)
  const page = (m && byId.get(decodeURIComponent(m[1]))) || start
  if (!m?.[2]) return { page, loc: null }
  const q = new URLSearchParams(m[2])
  const num = (k: string): number | undefined => (q.has(k) && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined)
  const loc: ReportLocation = { video: q.get('video') ?? undefined, frame: num('frame'), t: num('t') }
  return { page, loc: loc.video || loc.frame != null || loc.t != null ? loc : null }
}

const tree = buildReportTree(
  data.pages.map((p) => ({ file: p.file, name: p.id, title: p.title, status: '', subtitle: '', mtimeMs: p.savedAt ?? 0, links: p.links.filter((l) => byFile.has(l)), text: '' }))
)

const parents = new Map<string, string>()
const walk = (n: ReportNode): void => {
  for (const c of n.children) {
    parents.set(c.r.file, n.r.file)
    walk(c)
  }
}
tree.forEach(walk)

function trail(file: string): Page[] {
  const out: Page[] = []
  const seen = new Set<string>()
  let cur: string | undefined = file
  while (cur && !seen.has(cur)) {
    seen.add(cur)
    const p = byFile.get(cur)
    if (p) out.unshift(p)
    cur = parents.get(cur)
  }
  return out
}

function TreeList({ nodes, current, depth, onPick }: { nodes: ReportNode[]; current: string; depth: number; onPick: () => void }): ReactElement {
  return (
    <>
      {nodes.map((n) => {
        const p = byFile.get(n.r.file)
        if (!p) return null
        return (
          <div key={p.id}>
            <a
              href={hashOf(p.id)}
              onClick={onPick}
              data-export-nav={p.id}
              className={`block truncate rounded px-2 py-1 text-xs no-underline ${p.file === current ? 'bg-white/[0.08] text-ink' : 'text-ink-2 hover:bg-white/[0.05] hover:text-ink'}`}
              style={{ paddingLeft: 8 + depth * 14 }}
            >
              {p.title}
            </a>
            {n.children.length > 0 && <TreeList nodes={n.children} current={current} depth={depth + 1} onPick={onPick} />}
          </div>
        )
      })}
    </>
  )
}

function Nav({ page }: { page: Page }): ReactElement {
  const [open, setOpen] = useState(false)
  const menuRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      if (!menuRef.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey, true)
    }
  }, [open])
  const crumbs = trail(page.file)
  return (
    <div className="flex h-9 shrink-0 items-center gap-2 border-b border-white/[0.06] bg-canvas px-3 text-xs" data-export-bar>
      <div className="flex min-w-0 flex-1 items-center gap-1.5 truncate" data-export-crumbs>
        {crumbs.map((c, i) => (
          <span key={c.id} className="flex min-w-0 items-center gap-1.5">
            {i > 0 && <span className="text-ink-4">/</span>}
            {c.file === page.file ? (
              <span className="truncate font-medium text-zinc-100">{c.title}</span>
            ) : (
              <a href={hashOf(c.id)} className="truncate text-ink-2 no-underline hover:text-ink">
                {c.title}
              </a>
            )}
          </span>
        ))}
      </div>
      {data.pages.length > 1 && (
        <div className="relative shrink-0" ref={menuRef}>
          <button
            type="button"
            onClick={() => setOpen((o) => !o)}
            className={`rounded px-2 py-0.5 ${open ? 'bg-white/10 text-ink' : 'text-ink-2 hover:bg-white/[0.07] hover:text-ink'}`}
            data-export-menu
          >
            All reports · {data.pages.length}
          </button>
          {open && (
            <FloatingInParent placement="bottom-end" className="surface-overlay z-50 max-h-[70vh] w-72 overflow-auto rounded-[var(--radius-menu)] p-1" data-export-tree>
              <TreeList nodes={tree} current={page.file} depth={0} onPick={() => setOpen(false)} />
            </FloatingInParent>
          )}
        </div>
      )}
      <span className="shrink-0 text-ink-3" title={new Date(data.exportedAt).toLocaleString()}>
        Exported from Satura Space
      </span>
    </div>
  )
}

const scrolls = new Map<string, number>()

function PageView({ page, loc, go }: { page: Page; loc: ReportLocation | null; go: (file: string, loc: ReportLocation) => boolean }): ReactElement {
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  const [toast, setToast] = useState<{ text: string; n: number } | null>(null)
  const [retry, setRetry] = useState(0)
  const hostRef = useRef<HTMLDivElement>(null)
  const view = useMemo(() => reportView('export', page.file), [page.file])
  const url = useMemo(() => encodeURI(page.file.replace(/\\/g, '/')), [page.file])
  const mapper = useMemo(() => {
    const shown = data.root && page.file.startsWith(`${data.root}/`) ? page.file.slice(data.root.length + 1) : page.file
    return { shown, map: (t: string) => t }
  }, [page.file])
  const loaded = useMemo<Loaded>(
    () => (page.code ? evaluate({ ok: true, file: page.file, stamp: '', code: page.code, diagnostics: [], text: '', ms: 0 }, mapper, url) : { error: page.error ?? 'This report did not compile.' }),
    [page, mapper, url]
  )
  useEffect(() => {
    if (!toast) return
    const t = window.setTimeout(() => setToast(null), 1600)
    return () => window.clearTimeout(t)
  }, [toast])
  const copyLink = useCallback((link: string) => {
    void copyText(link)
    setToast((prev) => ({ text: 'Link copied', n: (prev?.n ?? 0) + 1 }))
  }, [])
  const goRef = useRef(go)
  goRef.current = go
  const api = useMemo(() => {
    void retry
    return new ReportApi({
      file: page.file,
      root: data.root,
      version: 'export',
      store: new ReportStore(),
      initial: loc,
      frames: view.frames,
      states: view.states,
      bridge: replay(page),
      mediaUrl: assetUrl,
      setTitle: (t) => {
        document.title = t.trim() || page.title
      },
      openReport: (f, l) => {
        if (!goRef.current(f, l)) setToast((prev) => ({ text: "That report isn't in this export", n: (prev?.n ?? 0) + 1 }))
      },
      openFile: () => {},
      showImage: (u: string, alt?: string, gallery?: ImageGallery, hint?: ImageHint) => setOverlay({ kind: 'image', url: u, alt: alt ?? '', gallery, path: hint?.path, size: hint?.size }),
      showCode: (target) => setOverlay({ kind: 'code', ...target }),
      copyLink
    })
  }, [page, view, copyLink, retry])
  const apiRef = useRef(api)
  apiRef.current = api
  useEffect(() => {
    if (loc && apiRef.current.host.initial !== loc) apiRef.current.goto(loc)
  }, [loc])

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    const want = scrolls.get(page.id) ?? 0
    let tries = 0
    const apply = (): void => {
      host.scrollTop = want
      if (Math.abs(host.scrollTop - want) > 2 && tries++ < 20) requestAnimationFrame(apply)
    }
    if (want > 0 && !loc) apply()
    const onScroll = (): void => {
      scrolls.set(page.id, host.scrollTop)
    }
    host.addEventListener('scroll', onScroll, { passive: true })
    return () => host.removeEventListener('scroll', onScroll)
  }, [page.id, loc])

  const onClickCapture = (e: MouseEvent): void => {
    const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a || a.closest('[data-export-bar]')) return
    const href = a.getAttribute('href') ?? ''
    const code = parseCodeHref(href)
    e.preventDefault()
    e.stopPropagation()
    if (code) {
      setOverlay({ kind: 'code', ref: code.path, line: code.line, endLine: code.endLine })
      return
    }
    if (href.startsWith('#')) {
      try {
        hostRef.current?.querySelector(`#${CSS.escape(decodeURIComponent(href.slice(1)))}`)?.scrollIntoView({ block: 'start', behavior: 'smooth' })
      } catch {
        return
      }
      return
    }
    if (/^https?:\/\//i.test(href)) {
      window.open(href, '_blank', 'noopener,noreferrer')
      return
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(href) && !/^[A-Za-z]:[\\/]/.test(href)) {
      copyLink(href)
      return
    }
    let local = href.split('#')[0].split('?')[0]
    try {
      local = decodeURIComponent(local)
    } catch {
      return
    }
    const target = resolveReportPath(page.file, local)
    const ext = target.slice(target.lastIndexOf('.') + 1).toLowerCase()
    if (/(^|\/)report\.tsx$|\.report\.tsx$/i.test(target)) api.host.openReport(target, {})
    else if (/^(png|jpe?g|gif|webp|avif|svg)$/.test(ext) && target in data.assets) setOverlay({ kind: 'image', url: assetUrl(target), alt: local })
    else if (CODE_EXTENSIONS.has(ext)) setOverlay({ kind: 'code', ref: target })
    else copyLink(target)
  }

  const C = loaded.Component
  return (
    <div className="sr-scope absolute inset-0" onClickCapture={onClickCapture} data-export-page={page.id}>
      {C ? (
        <div className="sr-scope rk-host" ref={hostRef}>
          <div className="rk-report">
            <ReportContext.Provider value={api}>
              <ReportSavedContext.Provider value={page.savedAt}>
                <ReportBoundary key={retry} mapper={mapper} onError={() => {}} onRetry={() => setRetry((n) => n + 1)}>
                  <C />
                </ReportBoundary>
              </ReportSavedContext.Provider>
            </ReportContext.Provider>
          </div>
        </div>
      ) : (
        <div className="rk-host" ref={hostRef}>
          <RuntimeError text={loaded.error ?? ''} />
        </div>
      )}
      {overlay && (
        <ReportOverlay overlay={overlay} file={page.file} root={data.root} onClose={() => setOverlay(null)} onChange={setOverlay} read={api.bridge.readCode} />
      )}
      {toast && (
        <div key={toast.n} className="rk-toast">
          {toast.text}
        </div>
      )}
    </div>
  )
}

function App(): ReactElement {
  const [route, setRoute] = useState(parseHash)
  useEffect(() => {
    const on = (): void => setRoute(parseHash())
    window.addEventListener('hashchange', on)
    return () => window.removeEventListener('hashchange', on)
  }, [])
  const page = route.page
  useEffect(() => {
    document.title = page.title
  }, [page])
  const go = useCallback((file: string, loc: ReportLocation): boolean => {
    const target = byFile.get(file)
    if (!target) return false
    location.hash = hashOf(target.id, loc)
    return true
  }, [])
  return (
    <div className="flex h-full flex-col bg-canvas text-ink">
      <Nav page={page} />
      <div className="relative min-h-0 flex-1">
        <PageView key={page.id} page={page} loc={route.loc} go={go} />
      </div>
    </div>
  )
}

document.documentElement.dataset.theme = 'dark'
const mount = document.getElementById('root') as HTMLElement
createRoot(mount).render(<App />)
