import { mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { zipSync, type MainPlugin } from '@satura/plugin'
import { renderHtml, type PackParts } from './pack'
import { PlayableError, rel, type Layout } from './project'

export interface NetworkSpec {
  id: string
  title: string
  format: 'html' | 'zip'
  limit: number
  mraid: boolean
  cta: string
  notes: string
  head?: (parts: PackParts, lay: Layout) => string
  extra?: (lay: Layout) => Record<string, string>
  entry?: (lay: Layout) => string
}

const MB = 1024 * 1024

export const NETWORKS: NetworkSpec[] = [
  { id: 'applovin', title: 'AppLovin', format: 'html', limit: 5 * MB, mraid: true, cta: 'mraid.open', notes: 'One HTML file, everything inlined, MRAID 2.0, no store redirect on the first tap.' },
  { id: 'unity', title: 'Unity Ads', format: 'html', limit: 5 * MB, mraid: true, cta: 'mraid.open', notes: 'One minified index.html under 5 MB, MRAID 3.0 injected by the webview (no mraid.js tag), starts on viewableChange, redirect only after a tap.' },
  { id: 'ironsource', title: 'ironSource', format: 'html', limit: 4 * MB, mraid: true, cta: 'mraid.open', notes: 'One HTML file, MRAID 2.0, waits for ready; no DAPI; assets and code up to 4 MB.' },
  { id: 'mintegral', title: 'Mintegral', format: 'zip', limit: 5 * MB, mraid: false, cta: 'window.install', notes: 'Zip with a folder and HTML named like the zip; calls gameReady(), waits for gameStart(), calls gameEnd() once at the end and install() on every CTA.', entry: (lay) => `${lay.config.name}-mintegral/${lay.config.name}-mintegral.html` },
  {
    id: 'google',
    title: 'Google Ads',
    format: 'zip',
    limit: 5 * MB,
    mraid: false,
    cta: 'ExitApi.exit',
    notes: 'Zip with index.html, at most 512 files and 5 MB, exitapi.js in the head, CTA through ExitApi.exit(), orientation meta tag.',
    head: (parts, lay) => {
      const stage = (lay.config.stage ?? {}) as { width?: number; height?: number }
      const portrait = (stage.height ?? 16) >= (stage.width ?? 9)
      return `<meta name="ad.orientation" content="${portrait ? 'portrait' : 'landscape'}"><script type="text/javascript" src="https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js"></script>`
    },
    entry: () => 'index.html'
  },
  { id: 'meta', title: 'Meta', format: 'html', limit: 2 * MB, mraid: false, cta: 'FbPlayableAd.onCTAClick', notes: 'One HTML file of at most 2 MB, no network requests, CTA through FbPlayableAd.onCTAClick().' },
  {
    id: 'tiktok',
    title: 'TikTok / Pangle',
    format: 'zip',
    limit: 5 * MB,
    mraid: false,
    cta: 'window.openAppStore',
    notes: 'Zip under 5 MB with index.html and config.json at the top level, no mraid.js, no HTTP requests, CTA through openAppStore() of the Pangle SDK.',
    entry: () => 'index.html',
    extra: (lay) => {
      const stage = (lay.config.stage ?? {}) as { width?: number; height?: number }
      const orientation = (stage.height ?? 16) >= (stage.width ?? 9) ? 1 : 2
      return { 'config.json': JSON.stringify({ playable_orientation: orientation, Playable_orientation: orientation, playable_languages: ['en'] }) }
    }
  }
]

export interface VariantResult {
  network: string
  title: string
  path: string
  bytes: number
  limit: number
  ok: boolean
  problems: string[]
  checks?: Record<string, unknown>
}

const MOCKS: Record<string, string> = {
  mraid: `window.__calls=[];(function(){var l={},s='loading';window.mraid={getVersion:function(){return '3.0'},getState:function(){return s},isViewable:function(){return true},addEventListener:function(e,f){(l[e]=l[e]||[]).push(f)},removeEventListener:function(){},open:function(u){__calls.push(['mraid.open',u])},close:function(){},useCustomClose:function(){}};setTimeout(function(){s='default';(l.ready||[]).forEach(function(f){f()});(l.viewableChange||[]).forEach(function(f){f(true)})},50)})();`,
  google: `window.__calls=[];window.ExitApi={exit:function(){__calls.push(['ExitApi.exit'])}};`,
  meta: `window.__calls=[];window.FbPlayableAd={onCTAClick:function(){__calls.push(['FbPlayableAd.onCTAClick'])}};`,
  mintegral: `window.__calls=[];window.gameReady=function(){__calls.push(['gameReady']);setTimeout(function(){window.gameStart&&window.gameStart()},50)};window.gameEnd=function(){__calls.push(['gameEnd'])};window.install=function(){__calls.push(['install'])};`,
  tiktok: `window.__calls=[];window.openAppStore=function(){__calls.push(['openAppStore'])};`
}

function variantHtml(parts: PackParts, spec: NetworkSpec, lay: Layout, test: boolean): string {
  const head = spec.head?.(parts, lay) ?? ''
  const mock = MOCKS[spec.mraid ? 'mraid' : spec.id] ?? ''
  return renderHtml(parts, {
    head: test ? `<script>${mock}</script>${head.replace(/<script[^>]*src=[^>]*><\/script>/g, '')}` : head,
    config: { network: spec.mraid ? 'mraid' : spec.id }
  })
}

function staticProblems(html: string, spec: NetworkSpec): string[] {
  const problems: string[] = []
  const tags = [...html.matchAll(/<(?:script|link|img|iframe|source|audio|video)\b[^>]*\b(?:src|href)\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1])
  for (const url of tags) {
    if (/^data:/i.test(url)) continue
    if (spec.id === 'google' && url === 'https://tpc.googlesyndication.com/pagead/gadgets/html5/api/exitapi.js') continue
    problems.push(`loads ${url}`)
  }
  if (/\bfetch\(|XMLHttpRequest|navigator\.sendBeacon|new WebSocket/.test(html)) problems.push('contains a network API call')
  const needle = spec.cta.replace(/^window\./, '')
  if (!html.includes(needle)) problems.push(`does not reference ${spec.cta}`)
  if (!spec.mraid && /<script[^>]+mraid\.js/i.test(html)) problems.push('includes mraid.js')
  return problems
}

async function runChecks(p: MainPlugin, html: string, file: string, spec: NetworkSpec): Promise<Record<string, unknown>> {
  await writeFile(file, html)
  const page = await p.page({ width: 360, height: 640 })
  try {
    await page.load(file)
    const started = await page.evaluate<boolean>(`new Promise((r) => { const t0 = Date.now(); const k = () => window.__playable && window.__playable.started ? r(true) : Date.now() - t0 > 8000 ? r(false) : setTimeout(k, 50); k(); })`, 15_000)
    const before = await page.evaluate<unknown[]>('window.__calls.slice()')
    await page.evaluate('window.__playable.ad.open()')
    if (spec.id === 'mintegral') await page.evaluate('window.__playable.ad.showEndCard({})')
    const after = await page.evaluate<unknown[][]>('window.__calls.slice()')
    const errors = page.messages.filter((m) => m.type === 'error').map((m) => m.text)
    const ctaCall = after.slice(before.length).map((c) => String(c[0]))
    return { started, lifecycle: before.map((c) => (c as unknown[])[0]), ctaCalls: ctaCall, fellBackToWindowOpen: page.opened.length > 0, requests: page.requests.slice(), errors }
  } finally {
    page.close()
    await rm(file, { force: true })
  }
}

export async function buildNetworks(p: MainPlugin, parts: PackParts, lay: Layout, wanted: string[] | undefined, log: (line: string) => void): Promise<VariantResult[]> {
  const ids = wanted?.length ? wanted : (lay.config.networks?.length ? lay.config.networks : NETWORKS.map((n) => n.id))
  const unknown = ids.filter((id) => !NETWORKS.some((n) => n.id === id))
  if (unknown.length) throw new PlayableError(`Unknown network ${unknown.join(', ')}. Known: ${NETWORKS.map((n) => n.id).join(', ')}.`, 'network')
  const base = join(lay.out, 'networks')
  await mkdir(base, { recursive: true })
  const results: VariantResult[] = []
  for (const id of ids) {
    const spec = NETWORKS.find((n) => n.id === id)!
    const html = variantHtml(parts, spec, lay, false)
    let path: string
    if (spec.format === 'html') {
      path = join(base, `${lay.config.name}-${spec.id}.html`)
      await writeFile(path, html)
    } else {
      const files: Record<string, Uint8Array> = { [spec.entry!(lay)]: Buffer.from(html) }
      for (const [name, text] of Object.entries(spec.extra?.(lay) ?? {})) files[name] = Buffer.from(text)
      path = join(base, spec.id === 'mintegral' ? `${lay.config.name}-mintegral.zip` : `${lay.config.name}-${spec.id}.zip`)
      await writeFile(path, zipSync(files, { level: 9 }))
    }
    const bytes = (await stat(path)).size
    const problems = staticProblems(html, spec)
    if (bytes > spec.limit) problems.push(`${bytes} bytes is over the ${spec.limit} byte limit`)
    const checks = await runChecks(p, variantHtml(parts, spec, lay, true), join(base, `.check-${spec.id}.html`), spec)
    if (!checks.started) problems.push('did not start under the network mock')
    if (!(checks.ctaCalls as string[]).some((c) => c === spec.cta.replace(/^window\./, ''))) problems.push(`CTA did not call ${spec.cta}`)
    if (checks.fellBackToWindowOpen) problems.push('CTA fell back to window.open')
    if ((checks.requests as string[]).length) problems.push(`made ${(checks.requests as string[]).length} network requests`)
    if ((checks.errors as string[]).length) problems.push(`${(checks.errors as string[]).length} console errors`)
    if (spec.id === 'mintegral' && !(checks.lifecycle as string[]).includes('gameReady')) problems.push('did not call gameReady()')
    if (spec.id === 'mintegral' && !(checks.ctaCalls as string[]).includes('gameEnd')) problems.push('did not call gameEnd() at the end card')
    results.push({ network: spec.id, title: spec.title, path: rel(lay.root, path), bytes, limit: spec.limit, ok: problems.length === 0, problems, checks })
    log(`${spec.id}: ${rel(lay.root, path)} ${bytes} bytes ${problems.length ? problems.join('; ') : 'ok'}`)
  }
  await writeFile(join(base, 'networks.json'), JSON.stringify({ at: new Date().toISOString(), results, specs: NETWORKS.filter((n) => ids.includes(n.id)).map(({ id, title, format, limit, mraid, cta, notes }) => ({ id, title, format, limit, mraid, cta, notes })) }, null, 2))
  return results
}
