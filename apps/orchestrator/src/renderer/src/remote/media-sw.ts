import parseRange from 'range-parser'
import { PUSH_GENERIC_TAG, PUSH_GENERIC_TITLE, PUSH_INNER_AAD, PUSH_INNER_VERSION, desktopNameKey, pushGenericBody, pushKeyName, pushOpenKey, readPushLink, type PushNote, type PushSealed } from '../../../shared/remote-push'
import { storeGet, storePut, type StoredMacName, type StoredPushKey } from './push-store'

interface SwClient {
  id: string
  url: string
  focused?: boolean
  postMessage(message: unknown, transfer?: Transferable[]): void
  focus?(): Promise<unknown>
}

interface SwNotification {
  tag: string
  data: unknown
  close(): void
}

interface SwExtendable extends Event {
  waitUntil(p: Promise<unknown>): void
}

interface SwPushEvent extends SwExtendable {
  data: { json(): unknown; text(): string } | null
}

interface SwClickEvent extends SwExtendable {
  notification: SwNotification
}

interface SwMessageEvent extends SwExtendable {
  data: unknown
}

interface SwSubChangeEvent extends SwExtendable {
  oldSubscription?: PushSubscription | null
}

interface SwFetchEvent extends Event {
  request: Request
  clientId: string
  respondWith(r: Promise<Response> | Response): void
}

interface SwScope {
  location: Location
  clients: {
    get(id: string): Promise<SwClient | undefined>
    matchAll(opts: { type: 'window'; includeUncontrolled?: boolean }): Promise<SwClient[]>
    claim(): Promise<void>
    openWindow(url: string): Promise<unknown>
  }
  registration: {
    scope: string
    showNotification(title: string, options: Record<string, unknown>): Promise<void>
    getNotifications(filter?: { tag?: string }): Promise<SwNotification[]>
    pushManager: PushManager
  }
  skipWaiting(): Promise<void>
  addEventListener(type: 'install' | 'activate', fn: (e: SwExtendable) => void): void
  addEventListener(type: 'fetch', fn: (e: SwFetchEvent) => void): void
  addEventListener(type: 'push', fn: (e: SwPushEvent) => void): void
  addEventListener(type: 'notificationclick', fn: (e: SwClickEvent) => void): void
  addEventListener(type: 'message', fn: (e: SwMessageEvent) => void): void
  addEventListener(type: 'pushsubscriptionchange', fn: (e: SwSubChangeEvent) => void): void
}

interface Piece {
  size: number
  type: string
  data: ArrayBuffer
}

const sw = self as unknown as SwScope
const PIECE = 480 * 1024
const HEAD_PIECE = 240 * 1024
const ASK_TIMEOUT_MS = 45_000
const PIECE_ATTEMPTS = 2
const SIZES_KEPT = 64
const sizes = new Map<string, { size: number; type: string }>()
const LOCKED = { 'content-security-policy': "sandbox; default-src 'none'", 'x-content-type-options': 'nosniff' }
const DOCUMENT_DESTINATIONS = new Set(['document', 'iframe', 'frame', 'object', 'embed'])

sw.addEventListener('install', (e) => e.waitUntil(sw.skipWaiting()))
sw.addEventListener('activate', (e) => e.waitUntil(sw.clients.claim()))
sw.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url)
  if (url.origin !== sw.location.origin || !url.pathname.includes('/media-stream/')) return
  if (url.pathname.endsWith('/media-stream/keepalive')) {
    e.respondWith(new Response(null, { status: 204, headers: { ...LOCKED, 'cache-control': 'no-store' } }))
    return
  }
  if (e.request.mode === 'navigate' || DOCUMENT_DESTINATIONS.has(e.request.destination)) {
    e.respondWith(failed(403, 'Media files open inside Satura Remote, not as a page'))
    return
  }
  e.respondWith(serve(e, url))
})

const ICON = '/m/icon-192.png'

function hostIdOfScope(): string {
  return /\/h\/([a-z0-9]{6,32})\//.exec(sw.registration.scope)?.[1] ?? ''
}

function unb64u(text: string): Uint8Array<ArrayBuffer> {
  const b = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4))
  const out = new Uint8Array(new ArrayBuffer(b.length))
  for (let i = 0; i < b.length; i++) out[i] = b.charCodeAt(i)
  return out
}

function readSealed(raw: unknown): PushSealed | null {
  const r = raw as Partial<PushSealed> | null
  return r && r.v === PUSH_INNER_VERSION && typeof r.n === 'string' && typeof r.c === 'string' && /^[A-Za-z0-9_-]{16}$/.test(r.n) && /^[A-Za-z0-9_-]{20,8000}$/.test(r.c) ? (r as PushSealed) : null
}

function readNote(raw: unknown): PushNote | null {
  const r = raw as Partial<PushNote> | null
  if (!r || r.v !== PUSH_INNER_VERSION || typeof r.title !== 'string' || typeof r.tag !== 'string' || typeof r.id !== 'string') return null
  return { v: r.v, id: r.id.slice(0, 40), tag: r.tag.slice(0, 300), cat: (r.cat ?? 'test') as PushNote['cat'], title: r.title.slice(0, 160), body: String(r.body ?? '').slice(0, 600), link: readPushLink(r.link) ?? { kind: 'test' }, at: Number(r.at) || Date.now(), ...(r.loud ? { loud: true } : {}), clear: Array.isArray(r.clear) ? r.clear.filter((t): t is string => typeof t === 'string').slice(0, 20) : [] }
}

async function openNote(data: SwPushEvent['data']): Promise<{ note: PushNote | null; why: string }> {
  if (!data) return { note: null, why: 'the push had no data' }
  let sealed: PushSealed | null = null
  try {
    sealed = readSealed(data.json())
  } catch {
    return { note: null, why: "the push wasn't one Satura sealed" }
  }
  if (!sealed) return { note: null, why: "the push wasn't one Satura sealed" }
  const hostId = hostIdOfScope()
  const stored = hostId ? await storeGet<StoredPushKey>(pushKeyName(hostId)).catch(() => undefined) : undefined
  if (!stored?.key) return { note: null, why: 'this phone has no notification key for its desktop' }
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64u(sealed.n), additionalData: new TextEncoder().encode(PUSH_INNER_AAD), tagLength: 128 }, stored.key, unb64u(sealed.c))
    const note = readNote(JSON.parse(new TextDecoder().decode(plain)))
    return note ? { note, why: '' } : { note: null, why: 'the note inside was malformed' }
  } catch {
    return { note: null, why: "the note didn't decrypt with this phone's key" }
  }
}

async function macName(hostId: string): Promise<string> {
  if (!hostId) return ''
  const m = await storeGet<StoredMacName>(desktopNameKey(hostId)).catch(() => undefined)
  return typeof m?.name === 'string' ? m.name.slice(0, 80) : ''
}

async function onPush(e: SwPushEvent): Promise<void> {
  const host = hostIdOfScope()
  const [{ note, why }, mac] = await Promise.all([openNote(e.data), macName(host)])
  if (!note) {
    console.warn(`[push] showing the generic notice: ${why}`)
    await sw.registration.showNotification(PUSH_GENERIC_TITLE, { body: pushGenericBody(mac), tag: PUSH_GENERIC_TAG, icon: ICON, data: { link: null, tag: PUSH_GENERIC_TAG, why, host, mac, at: Date.now() } })
    return
  }
  await sw.registration.showNotification(note.title, {
    body: mac ? `On ${mac}${note.body ? `\n${note.body}` : ''}` : note.body,
    tag: note.tag,
    icon: ICON,
    timestamp: note.at,
    ...(note.loud ? { renotify: true } : {}),
    data: { link: note.link, tag: note.tag, id: note.id, cat: note.cat, at: note.at, host, mac }
  })
  for (const tag of note.clear ?? []) for (const n of await sw.registration.getNotifications({ tag })) n.close()
}

async function openFrom(data: unknown): Promise<void> {
  const d = (data ?? {}) as { link?: unknown; tag?: unknown }
  const link = readPushLink(d.link)
  const tag = typeof d.tag === 'string' ? d.tag : ''
  const host = hostIdOfScope()
  await storePut(pushOpenKey(host), { link, tag, at: Date.now() }).catch(() => {})
  const scope = sw.registration.scope
  const all = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true })
  const mine = all.filter((c) => c.url.startsWith(scope))
  const c = mine.find((x) => x.focused) ?? mine[0]
  if (c) {
    c.postMessage({ t: 'push-open', host, link, tag })
    try {
      await c.focus?.()
      return
    } catch {
    }
  }
  const other = all.find((x) => x.focused) ?? all[0]
  if (other) {
    console.info(`[push] a notification from ${host} was tapped while the app shows ${new URL(other.url).pathname}, sending it there`)
    other.postMessage({ t: 'push-go', host, url: scope, tag })
    try {
      await other.focus?.()
      return
    } catch {
    }
  }
  await sw.clients.openWindow(scope)
}

sw.addEventListener('push', (e) => e.waitUntil(onPush(e)))
sw.addEventListener('notificationclick', (e) => {
  e.notification.close()
  e.waitUntil(openFrom(e.notification.data))
})
sw.addEventListener('message', (e) => {
  const m = (e.data ?? {}) as { t?: unknown; tag?: unknown }
  if (m.t !== 'click-notification' || typeof m.tag !== 'string') return
  const tag = m.tag
  e.waitUntil(
    sw.registration.getNotifications({ tag }).then(async (list) => {
      const n = list[0]
      if (!n) return
      n.close()
      await openFrom(n.data)
    })
  )
})
sw.addEventListener('pushsubscriptionchange', (e) => {
  const options = e.oldSubscription?.options
  if (!options?.applicationServerKey) return
  e.waitUntil(sw.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: options.applicationServerKey }).then(() => undefined, () => undefined))
})

async function clientFor(e: SwFetchEvent): Promise<SwClient | null> {
  if (e.clientId) {
    const c = await sw.clients.get(e.clientId)
    if (c) return c
  }
  const all = await sw.clients.matchAll({ type: 'window' })
  return all.find((c) => c.focused) ?? all[0] ?? null
}

function ask(client: SwClient, path: string, start: number, end: number, first: boolean): Promise<Piece> {
  return new Promise((resolve, reject) => {
    const ch = new MessageChannel()
    const timer = setTimeout(() => {
      ch.port1.close()
      reject(new Error('The page did not answer'))
    }, ASK_TIMEOUT_MS)
    ch.port1.onmessage = (m: MessageEvent) => {
      clearTimeout(timer)
      ch.port1.close()
      const r = m.data as (Piece & { ok: true }) | { ok: false; error?: string } | null
      if (r?.ok) resolve(r)
      else reject(new Error(r?.error || 'The desktop could not read the file'))
    }
    client.postMessage({ t: 'media-read', path, start, end, first }, [ch.port2])
  })
}

async function askAgain(e: SwFetchEvent, client: SwClient, path: string, start: number, end: number): Promise<Piece> {
  let last: unknown
  for (let i = 0; i < PIECE_ATTEMPTS; i++) {
    try {
      return await ask(i ? ((await clientFor(e)) ?? client) : client, path, start, end, false)
    } catch (err) {
      last = err
    }
  }
  throw last instanceof Error ? last : new Error(String(last))
}

function failed(status: number, text: string): Response {
  return new Response(text, { status, headers: { ...LOCKED, 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' } })
}

function remember(path: string, size: number, type: string): void {
  sizes.delete(path)
  sizes.set(path, { size, type })
  if (sizes.size > SIZES_KEPT) sizes.delete(sizes.keys().next().value as string)
}

async function serve(e: SwFetchEvent, url: URL): Promise<Response> {
  const path = url.searchParams.get('p') ?? ''
  const client = await clientFor(e)
  if (!client || !path) return failed(503, 'No page to read the file through')
  const header = e.request.headers.get('range')?.trim() ?? ''
  try {
    let known = sizes.get(path)
    let head: Piece | null = null
    if (!known) {
      head = await ask(client, path, 0, HEAD_PIECE - 1, true)
      known = { size: head.size, type: head.type }
      remember(path, head.size, head.type)
    }
    const { size, type } = known
    const ranges = header ? parseRange(size, header, { combine: true }) : -2
    if (ranges === -1) return new Response(null, { status: 416, headers: { ...LOCKED, 'content-range': `bytes */${size}`, 'cache-control': 'no-store' } })
    const ranged = Array.isArray(ranges) && ranges.type === 'bytes' && ranges.length > 0
    const start = ranged ? ranges[0].start : 0
    const end = ranged ? ranges[0].end : size - 1
    const length = Math.max(0, end - start + 1)
    const headers: Record<string, string> = {
      ...LOCKED,
      'content-type': type || 'application/octet-stream',
      'content-length': String(length),
      'accept-ranges': 'bytes',
      'cache-control': 'no-store'
    }
    if (ranged) headers['content-range'] = `bytes ${start}-${end}/${size}`
    const status = ranged ? 206 : 200
    if (e.request.method === 'HEAD' || !length) return new Response(null, { status, headers })
    let first: Uint8Array
    if (head && start < head.data.byteLength) first = new Uint8Array(head.data, start, Math.min(head.data.byteLength - start, length))
    else first = new Uint8Array((await ask(client, path, start, Math.min(end, start + PIECE - 1), !head)).data)
    if (!first.byteLength) throw new Error('The file got shorter')
    let pos = start + first.byteLength
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(first)
        if (pos > end) c.close()
      },
      async pull(c) {
        if (pos > end) return
        try {
          const next = await askAgain(e, client, path, pos, Math.min(end, pos + PIECE - 1))
          if (cancelled) return
          if (!next.data.byteLength) throw new Error('The file got shorter')
          if (next.size !== size) throw new Error('The file changed on the desktop')
          pos += next.data.byteLength
          c.enqueue(new Uint8Array(next.data))
          if (pos > end) c.close()
        } catch (err) {
          sizes.delete(path)
          if (!cancelled) c.error(err)
        }
      },
      cancel() {
        cancelled = true
      }
    })
    return new Response(body, { status, headers })
  } catch (err) {
    sizes.delete(path)
    return failed(502, err instanceof Error ? err.message : String(err))
  }
}
