import { app } from 'electron'
import { createHash } from 'node:crypto'
import type { PhoneAppCheck } from '@shared/remote-protocol'

export const PHONE_WEB = 'https://remote.saturaspace.com'
const ATTESTATIONS = 'https://api.github.com/repos/saturadev/satura-space/attestations'
const REPO = 'https://github.com/saturadev/satura-space'
const WORKFLOW = '.github/workflows/phone-site.yml'
const MAIN = 'refs/heads/main'
const BUILDER = `${REPO}/${WORKFLOW}@${MAIN}`
const PROVENANCE = 'https://slsa.dev/provenance/v1'
const MANIFEST = 'phone-app.json'
const EVERY_MS = 4 * 3600_000
const TICK_MS = 10 * 60_000
const FIRST_MS = 30_000
const TIMEOUT_MS = 10_000
const ATTESTATION_GRACE_MS = 30 * 60_000
const MAX_FETCHES = 40
const MAX_BYTES = 24 * 1024 * 1024
const MAX_PROBLEMS = 6
const SHA256 = /^[0-9a-f]{64}$/
const COMMIT = /^[0-9a-f]{7,40}$/
const PHONE_PAGES = ['m/', 'h/all/']
const REF = /<(?:script|link)\b[^>]*?\b(?:src|href)\s*=\s*["']([^"']+)["']/gi

interface Manifest {
  commit: string
  files: Record<string, string>
}

interface Fetched {
  status: number
  url: string
  type: string
  body: Buffer
}

interface WatchContext {
  applies: () => boolean
  hostId: () => string
  changed: () => void
  log: (line: string) => void
}

class Unreachable extends Error {}

let last: PhoneAppCheck | null = null
let running: Promise<PhoneAppCheck> | null = null
let lastRunAt = 0
let timer: NodeJS.Timeout | null = null
const unattestedSince = new Map<string, number>()

function devUrl(name: string): string | null {
  if (app.isPackaged) return null
  const raw = process.env[name]?.trim()
  if (!raw) return null
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' || u.protocol === 'http:' ? raw.replace(/\/+$/, '') : null
  } catch {
    return null
  }
}

export function watchedWeb(): string {
  return devUrl('SATURA_PHONE_APP_WEB') ?? PHONE_WEB
}

export function watchesPhoneWeb(web: string | null): boolean {
  return web === PHONE_WEB || watchedWeb() !== PHONE_WEB
}

function attestationsBase(): string {
  return devUrl('SATURA_PHONE_APP_ATTESTATIONS') ?? ATTESTATIONS
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Fetched> {
  const where = hostOf(url)
  try {
    const res = await fetch(url, { headers: { 'user-agent': `Satura/${app.getVersion()}`, 'cache-control': 'no-cache', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) })
    if (res.status >= 500 || res.status === 429) throw new Unreachable(`${where} answered ${res.status}`)
    if (Number(res.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Unreachable(`${where} sent a file too big to check`)
    return { status: res.status, url: res.url || url, type: res.headers.get('content-type') ?? '', body: Buffer.from(await res.arrayBuffer()) }
  } catch (e) {
    if (e instanceof Unreachable) throw e
    throw new Unreachable(`${where} didn't answer (${(e as Error).message})`)
  }
}

function readManifest(body: Buffer): Manifest | null {
  let raw: unknown
  try {
    raw = JSON.parse(body.toString('utf8'))
  } catch {
    return null
  }
  const o = raw as { commit?: unknown; files?: unknown } | null
  if (!o || typeof o.commit !== 'string' || !COMMIT.test(o.commit) || !o.files || typeof o.files !== 'object' || Array.isArray(o.files)) return null
  const files: Record<string, string> = {}
  for (const [path, sha] of Object.entries(o.files as Record<string, unknown>)) {
    if (typeof sha !== 'string' || !SHA256.test(sha) || !path) return null
    files[path.replace(/^\/+/, '')] = sha
  }
  if (!Object.keys(files).some((p) => p.endsWith('.html'))) return null
  return { commit: o.commit, files }
}

function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function field(o: unknown, ...keys: string[]): unknown {
  let at = o
  for (const k of keys) at = at && typeof at === 'object' ? (at as Record<string, unknown>)[k] : undefined
  return at
}

function attestedDigests(attestation: unknown, digest: string): string[] | null {
  const payload = field(attestation, 'bundle', 'dsseEnvelope', 'payload')
  if (typeof payload !== 'string') return null
  let statement: unknown
  try {
    statement = JSON.parse(Buffer.from(payload, 'base64').toString('utf8'))
  } catch {
    return null
  }
  if (field(statement, 'predicateType') !== PROVENANCE) return null
  const subjects = field(statement, 'subject')
  if (!Array.isArray(subjects)) return null
  const digests = subjects.map((s) => field(s, 'digest', 'sha256')).filter((d): d is string => typeof d === 'string' && SHA256.test(d))
  if (!digests.includes(digest)) return null
  const workflow = field(statement, 'predicate', 'buildDefinition', 'externalParameters', 'workflow')
  if (field(workflow, 'repository') !== REPO || field(workflow, 'path') !== WORKFLOW || field(workflow, 'ref') !== MAIN) return null
  if (field(statement, 'predicate', 'runDetails', 'builder', 'id') !== BUILDER) return null
  return digests
}

async function attestedFiles(digest: string): Promise<Set<string> | null> {
  const r = await get(`${attestationsBase()}/sha256:${digest}?predicate_type=provenance`, { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' })
  if (r.status === 404) return null
  if (r.status !== 200) throw new Unreachable(`GitHub answered ${r.status} for the attestations`)
  let list: unknown
  try {
    list = JSON.parse(r.body.toString('utf8')).attestations
  } catch {
    throw new Unreachable(`GitHub sent attestations that aren't JSON`)
  }
  if (!Array.isArray(list)) throw new Unreachable(`GitHub sent no attestation list`)
  const files = new Set<string>()
  for (const a of list) for (const d of attestedDigests(a, digest) ?? []) files.add(d)
  return files.size ? files : null
}

function pathOf(url: string): string {
  return decodeURIComponent(new URL(url).pathname).replace(/^\/+/, '')
}

async function checkFiles(web: string, m: Manifest, attested: Set<string>, hostId: string): Promise<{ checked: number; problems: string[] }> {
  const hashes = new Set(Object.values(m.files))
  const origin = new URL(web).origin
  const queue: { url: string; expect: string | null; label: string; optional: boolean }[] = []
  for (const [path, sha] of Object.entries(m.files)) if (path.endsWith('.html')) queue.push({ url: new URL(path, `${web}/`).href, expect: sha, label: path, optional: false })
  for (const page of [...PHONE_PAGES, ...(hostId ? [`h/${hostId}/`] : [])]) queue.push({ url: new URL(page, `${web}/`).href, expect: null, label: `/${page}`, optional: true })
  const seen = new Set<string>()
  const problems: string[] = []
  let checked = 0
  let bytes = 0
  while (queue.length && checked < MAX_FETCHES && bytes < MAX_BYTES) {
    const item = queue.shift()!
    if (seen.has(item.url)) continue
    seen.add(item.url)
    const r = await get(item.url)
    if (r.status !== 200) {
      if (!item.optional) problems.push(`${item.label} answered ${r.status}`)
      continue
    }
    checked++
    bytes += r.body.length
    const sha = sha256(r.body)
    const want = item.expect ?? m.files[pathOf(r.url)] ?? null
    if (want ? sha !== want : !hashes.has(sha)) problems.push(`${item.label} doesn't match the manifest`)
    else if (!attested.has(sha)) problems.push(`${item.label} isn't among the attested files`)
    if (!/text\/html/i.test(r.type) && !/\.html$|\/$/.test(new URL(r.url).pathname)) continue
    for (const ref of r.body.toString('utf8').matchAll(REF)) {
      let next: URL
      try {
        next = new URL(ref[1], r.url)
      } catch {
        continue
      }
      if (next.origin !== origin || !/\.(m?js|css)$/i.test(next.pathname)) continue
      next.hash = ''
      queue.push({ url: next.href, expect: m.files[pathOf(next.href)] ?? null, label: pathOf(next.href), optional: false })
    }
  }
  return { checked, problems }
}

async function runCheck(ctx: WatchContext): Promise<PhoneAppCheck> {
  const web = watchedWeb()
  const where = hostOf(web)
  const result = (status: PhoneAppCheck['status'], detail: string, more: Partial<PhoneAppCheck> = {}): PhoneAppCheck => ({ status, at: Date.now(), web, commit: null, checked: 0, detail, problems: [], ...more })
  try {
    const live = await get(`${web}/${MANIFEST}`)
    if (live.status !== 200) return result('mismatch', `${where} serves no ${MANIFEST} (${live.status}).`)
    const m = readManifest(live.body)
    if (!m) return result('mismatch', `${where}/${MANIFEST} isn't a phone app manifest.`)
    const short = m.commit.slice(0, 12)
    const digest = sha256(live.body)
    const attested = await attestedFiles(digest)
    if (!attested) {
      const since = unattestedSince.get(digest) ?? Date.now()
      unattestedSince.set(digest, since)
      if (Date.now() - since < ATTESTATION_GRACE_MS) return result('unknown', `No attestation from the phone-site workflow on main covers ${where}/${MANIFEST} (commit ${short}) yet.`, { commit: m.commit })
      return result('mismatch', `No attestation from the phone-site workflow on main covers ${where}/${MANIFEST} (commit ${short}), 30 minutes after this desktop first saw it.`, { commit: m.commit })
    }
    unattestedSince.delete(digest)
    const files = await checkFiles(web, m, attested, ctx.hostId())
    if (files.problems.length) return result('mismatch', `Files on ${where} don't match the attested build of ${short}.`, { commit: m.commit, checked: files.checked, problems: files.problems.slice(0, MAX_PROBLEMS) })
    return result('ok', `${where} serves commit ${short}, ${files.checked} files match its attested build.`, { commit: m.commit, checked: files.checked })
  } catch (e) {
    return result('unknown', e instanceof Unreachable ? `Couldn't check: ${e.message}.` : `Couldn't check: ${(e as Error).message}.`)
  }
}

export function phoneAppCheck(): PhoneAppCheck | null {
  return last
}

export function checkPhoneApp(ctx: WatchContext): Promise<PhoneAppCheck> {
  running ??= runCheck(ctx).then((r) => {
    running = null
    lastRunAt = Date.now()
    const was = last?.status
    last = r
    if (r.status === 'mismatch') console.warn(`[remote] PHONE APP MISMATCH: ${r.detail}${r.problems.length ? ` ${r.problems.join('; ')}` : ''}`)
    else ctx.log(`phone app check ${r.status}: ${r.detail}`)
    if (was !== r.status) ctx.changed()
    return r
  })
  return running
}

export function startPhoneWatch(ctx: WatchContext): void {
  if (timer) return
  const tick = (): void => {
    if (!ctx.applies() || Date.now() - lastRunAt < EVERY_MS) return
    void checkPhoneApp(ctx)
  }
  setTimeout(tick, FIRST_MS).unref()
  timer = setInterval(tick, TICK_MS)
  timer.unref()
}
