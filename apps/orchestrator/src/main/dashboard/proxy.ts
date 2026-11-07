import { fillSecrets, maskDeep, maskSecrets, type DashboardFetchRequest, type DashboardFetchResult } from '@shared/dashboard'
import { readSecrets } from './files'

const TIMEOUT_MS = 20_000
const MAX_BYTES = 5 * 1024 * 1024
const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'])

const inflight = new Map<string, AbortController>()

export function abortFetch(id: string): void {
  inflight.get(id)?.abort()
  inflight.delete(id)
}

async function readCapped(res: Response, signal: AbortSignal): Promise<Buffer> {
  const declared = Number(res.headers.get('content-length') ?? 0)
  if (declared > MAX_BYTES) throw new Error(`The response is ${(declared / 1048576).toFixed(1)} MB; the dashboard takes at most 5 MB.`)
  if (!res.body) return Buffer.alloc(0)
  const reader = res.body.getReader()
  const parts: Uint8Array[] = []
  let size = 0
  for (;;) {
    if (signal.aborted) throw new Error('aborted')
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BYTES) {
      void reader.cancel().catch(() => undefined)
      throw new Error('The response is larger than 5 MB, the most the dashboard takes.')
    }
    parts.push(value)
  }
  return Buffer.concat(parts)
}

export async function proxyFetch(project: string, req: DashboardFetchRequest): Promise<DashboardFetchResult> {
  const t0 = Date.now()
  const secrets = await readSecrets(project)
  const missing = new Set<string>()
  const fail = (error: string, status = 0): DashboardFetchResult => ({
    ok: false,
    status,
    error: maskSecrets(error, secrets),
    ms: Date.now() - t0,
    at: Date.now(),
    bytes: 0
  })
  const rawUrl = String(req.url ?? '').trim()
  if (!rawUrl) return fail('useFetch needs a URL.')
  const url = fillSecrets(rawUrl, secrets, missing)
  if (!/^https?:\/\//i.test(url)) return fail(`useFetch takes http:// or https:// URLs, got ${rawUrl}`)
  const method = String(req.method ?? 'GET').toUpperCase()
  if (!METHODS.has(method)) return fail(`Unknown method ${method}.`)
  const headers: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers ?? {})) headers[k] = fillSecrets(String(v), secrets, missing)
  const body = typeof req.body === 'string' && method !== 'GET' && method !== 'HEAD' ? fillSecrets(req.body, secrets, missing) : undefined
  if (missing.size) return fail(`secrets.json has no ${[...missing].map((m) => `"${m}"`).join(', ')}. Add ${missing.size === 1 ? 'it' : 'them'} to .sspace/dashboard/secrets.json.`)
  const ctl = new AbortController()
  const id = req.id
  if (id) {
    inflight.get(id)?.abort()
    inflight.set(id, ctl)
  }
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { method, headers, body, signal: ctl.signal, redirect: 'follow' })
    const buf = await readCapped(res, ctl.signal)
    const text = buf.toString('utf8')
    const type = res.headers.get('content-type') ?? ''
    const wantJson = req.as === 'json' || (req.as !== 'text' && /json/i.test(type))
    let data: unknown = text
    if (wantJson) {
      try {
        data = text ? JSON.parse(text) : null
      } catch {
        if (req.as === 'json') return fail(`The response is not JSON (HTTP ${res.status}): ${maskSecrets(text.slice(0, 200), secrets)}`, res.status)
      }
    }
    data = maskDeep(data, secrets)
    const result: DashboardFetchResult = { ok: res.ok, status: res.status, data, ms: Date.now() - t0, at: Date.now(), bytes: buf.length }
    if (!res.ok) {
      const body = typeof data === 'string' ? data : data == null ? '' : JSON.stringify(data)
      result.error = maskSecrets(`HTTP ${res.status} ${res.statusText}${body ? `: ${body.slice(0, 300)}` : ''}`, secrets)
    }
    return result
  } catch (e) {
    if (ctl.signal.aborted) return fail(Date.now() - t0 >= TIMEOUT_MS - 50 ? `No answer from ${maskSecrets(url, secrets)} in 20 s.` : 'Cancelled.')
    const err = e as Error & { cause?: { code?: string; message?: string } }
    const cause = err.cause?.code ?? err.cause?.message ?? ''
    return fail(`Could not reach ${url}: ${err.message}${cause ? ` (${cause})` : ''}`)
  } finally {
    clearTimeout(timer)
    if (id && inflight.get(id) === ctl) inflight.delete(id)
  }
}
