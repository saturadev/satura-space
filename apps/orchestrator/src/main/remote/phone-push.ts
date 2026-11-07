import { randomBytes } from 'node:crypto'
import { censusTrack } from '@shared/census'
import { PUSH_CATEGORIES, PUSH_DEFAULT_PREFS, PUSH_INNER_VERSION, cleanPushPrefs, type ActivityEntry, type PushCategory, type PushLink, type PushNote, type PushPrefs, type PushRegister, type PushState } from '@shared/remote-push'
import { PUSH_MAX_PLAIN, checkPushKey, checkSubscriptionKeys, encryptWebPush, pushTopic, sealPushNote } from './web-push'

export interface StoredPush {
  endpoint: string
  p256dh: string
  auth: string
  token: string
  key: string
  prefs: PushPrefs
  at: number
  service: string
}

export interface PushPhoneRecord {
  phoneId: string
  device?: string
  push?: StoredPush
}

export interface PushLive {
  visible: boolean
  stale: boolean
  workspaceId: string | null
  tabId: string | null
}

export interface PushHost {
  phones(): PushPhoneRecord[]
  save(): void
  relay(msg: Record<string, unknown>): boolean
  broadcast(ch: string, args: unknown[]): void
  live(phoneId: string): PushLive | null
  log(line: string): void
}

export interface PushWhere {
  workspaceId: string
  tabId: string | null
}

export interface OutNote {
  cat: PushCategory | 'test'
  tag: string
  title: string
  body: string
  link: PushLink
  where?: PushWhere | null
  loud?: boolean
  urgency?: 'very-low' | 'low' | 'normal' | 'high'
  ttl?: number
  only?: string
  who?: string
  hold?: string
}

export interface PushRecord {
  at: number
  id: string
  phoneId: string
  device: string
  cat: string
  tag: string
  title: string
  body: string
  link: PushLink
  decision: string
  status?: number
  error?: string
  bytes?: number
  ms?: number
}

const TITLE_MAX = 110
const BODY_MAX = 400
const SAME_TEXT_MS = 30_000
const BURST_MS = 3000
const RECORDS_MAX = 60
const TTL_DEFAULT_S = 4 * 3600
const OUTSTANDING_MAX = 200
const FEED_MAX = 60
const CLEAR_MAX = 8

let host: PushHost | null = null
const records: PushRecord[] = []
const lastByTag = new Map<string, { at: number; text: string }>()
const outstanding = new Map<string, Map<string, { at: number; resolved: boolean }>>()
const pending = new Map<string, PushRecord>()
const feed = new Map<string, { e: ActivityEntry; who: string }>()
censusTrack('remote.pushLastByTag', lastByTag)
censusTrack('remote.pushOutstanding', outstanding)
censusTrack('remote.pushPending', pending)
censusTrack('remote.activityFeed', feed)

export function configurePhonePush(h: PushHost): void {
  host = h
}

function log(line: string): void {
  host?.log(`push: ${line}`)
}

function clip(text: string, max: number): string {
  const flat = String(text ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').replace(/[ \t]+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

function record(r: PushRecord): PushRecord {
  records.push(r)
  if (records.length > RECORDS_MAX) records.splice(0, records.length - RECORDS_MAX)
  return r
}

function phoneRecord(phoneId: string): PushPhoneRecord | undefined {
  return host?.phones().find((p) => p.phoneId === phoneId)
}

function serviceOf(endpoint: string): string {
  try {
    return new URL(endpoint).hostname
  } catch {
    return '?'
  }
}

function stateOf(p: PushPhoneRecord | undefined): PushState {
  const last = [...records].reverse().find((r) => r.phoneId === p?.phoneId && r.decision === 'sent')
  return {
    supported: true,
    registered: !!p?.push,
    endpoint: p?.push?.endpoint ?? null,
    prefs: p?.push?.prefs ?? { ...PUSH_DEFAULT_PREFS },
    lastSent: last ? { at: last.at, status: last.status ?? 0, title: last.title } : null
  }
}

function register(phoneId: string, raw: unknown): PushState {
  const p = phoneRecord(phoneId)
  if (!p) throw new Error('This phone is not paired with this desktop')
  const r = (raw ?? {}) as Partial<PushRegister>
  const endpoint = typeof r.endpoint === 'string' ? r.endpoint : ''
  let u: URL
  try {
    u = new URL(endpoint)
  } catch {
    throw new Error("That isn't a push address")
  }
  if (endpoint.length > 1024 || (u.protocol !== 'https:' && u.protocol !== 'http:')) throw new Error("That isn't a push address")
  const keys = { p256dh: String(r.p256dh ?? ''), auth: String(r.auth ?? '') }
  const bad = checkSubscriptionKeys(keys)
  if (bad) throw new Error(`The push keys are malformed: ${bad}`)
  const keyBad = checkPushKey(String(r.key ?? ''))
  if (keyBad) throw new Error(`The notification key is malformed: ${keyBad}`)
  const token = String(r.token ?? '')
  if (!/^[A-Za-z0-9_-]{16,128}$/.test(token)) throw new Error('The relay sign-up token is malformed')
  const prefs = cleanPushPrefs(r.prefs, p.push?.prefs ?? PUSH_DEFAULT_PREFS)
  const was = p.push?.endpoint
  p.push = { endpoint, ...keys, token, key: String(r.key), prefs, at: Date.now(), service: u.hostname }
  host?.save()
  outstanding.delete(phoneId)
  log(`phone ${phoneId} (${p.device || 'phone'}) ${was === endpoint ? 'renewed its notification key' : was ? 'moved its notifications to a new push address' : 'turned notifications on'} via ${u.hostname}; categories ${PUSH_CATEGORIES.filter((c) => prefs[c]).join(', ') || 'none'}${prefs.on ? '' : ' (paused)'}`)
  return stateOf(p)
}

function setPrefs(phoneId: string, raw: unknown): PushState {
  const p = phoneRecord(phoneId)
  if (!p?.push) throw new Error('Notifications are off on this phone')
  const next = cleanPushPrefs(raw, p.push.prefs)
  if (JSON.stringify(next) !== JSON.stringify(p.push.prefs)) {
    p.push.prefs = next
    host?.save()
    log(`phone ${phoneId} notifications ${next.on ? 'on' : 'paused'}: ${PUSH_CATEGORIES.map((c) => `${c} ${next[c] ? 'on' : 'off'}`).join(', ')}`)
  }
  return stateOf(p)
}

function unregister(phoneId: string, why: string): PushState {
  const p = phoneRecord(phoneId)
  if (p?.push) {
    delete p.push
    host?.save()
    outstanding.delete(phoneId)
    log(`phone ${phoneId} notifications off (${why})`)
  }
  return stateOf(p)
}

function seen(phoneId: string, tags: unknown): number {
  const mine = outstanding.get(phoneId)
  if (!mine || !Array.isArray(tags)) return 0
  let n = 0
  for (const t of tags) if (typeof t === 'string' && mine.delete(t)) n++
  return n
}

function sync(phoneId: string): { clear: string[] } {
  const mine = outstanding.get(phoneId)
  if (!mine) return { clear: [] }
  const clear = [...mine].filter(([, v]) => v.resolved).map(([k]) => k)
  for (const k of clear) mine.delete(k)
  if (clear.length) log(`phone ${phoneId} clears ${clear.length} notification(s) seen on the Mac: ${clear.join(', ')}`)
  return { clear }
}

export function phonePushInvoke(phoneId: string, ch: string, args: unknown[]): unknown {
  const a = args[0]
  if (ch === 'remote:push:state') return stateOf(phoneRecord(phoneId))
  if (ch === 'remote:push:register') return register(phoneId, a)
  if (ch === 'remote:push:prefs') return setPrefs(phoneId, (a as { prefs?: unknown } | undefined)?.prefs ?? a)
  if (ch === 'remote:push:unregister') return unregister(phoneId, 'turned off on the phone')
  if (ch === 'remote:push:seen') return { cleared: seen(phoneId, (a as { tags?: unknown } | undefined)?.tags) }
  if (ch === 'remote:push:sync') return sync(phoneId)
  if (ch === 'remote:push:activity') return activity()
  if (ch === 'remote:push:test') return notify({ cat: 'test', tag: 'test', title: 'Satura Remote notifications work', body: `This came from ${String((a as { from?: unknown } | undefined)?.from ?? 'your desktop').slice(0, 60)}, encrypted for this phone only.`, link: { kind: 'test' }, only: phoneId, loud: true })
  return undefined
}

function shown(live: PushLive | null, where: PushWhere | null | undefined): boolean {
  if (!live || !where || !live.visible || live.stale) return false
  return live.workspaceId === where.workspaceId && (where.tabId === null || live.tabId === where.tabId)
}

function fit(p: StoredPush, note: PushNote): Buffer {
  let n = note
  for (let i = 0; i < 6; i++) {
    const inner = sealPushNote(p.key, n)
    if (inner.length <= PUSH_MAX_PLAIN) return inner
    n = { ...n, body: clip(n.body, Math.max(40, Math.floor(n.body.length / 2))) }
  }
  return sealPushNote(p.key, { ...n, body: '', clear: undefined })
}

export function notify(out: OutNote): { sent: number; records: PushRecord[] } {
  const made: PushRecord[] = []
  if (!host) return { sent: 0, records: made }
  const title = clip(out.title, TITLE_MAX)
  const body = clip(out.body, BODY_MAX)
  if (out.cat !== 'test') activityPut({ id: out.tag, kind: out.cat, title, body, at: Date.now(), link: out.link }, out.who ?? title)
  if (out.hold) {
    log(`${out.cat} "${title}" not sent: ${out.hold}`)
    return { sent: 0, records: made }
  }
  let sent = 0
  for (const p of host.phones()) {
    if (out.only && p.phoneId !== out.only) continue
    const id = randomBytes(6).toString('hex')
    const base = { at: Date.now(), id, phoneId: p.phoneId, device: p.device || '', cat: out.cat, tag: out.tag, title, body, link: out.link }
    const skip = (decision: string): void => {
      made.push(record({ ...base, decision }))
    }
    const s = p.push
    if (!s) continue
    if (out.cat !== 'test' && !s.prefs.on) {
      skip('paused on the phone')
      continue
    }
    if (out.cat !== 'test' && !s.prefs[out.cat]) {
      skip(`${out.cat} turned off on the phone`)
      continue
    }
    if (shown(host.live(p.phoneId), out.where)) {
      skip('the phone shows it right now')
      continue
    }
    const key = `${p.phoneId}|${out.tag}`
    const text = `${title}\n${body}`
    const last = lastByTag.get(key)
    if (last && (Date.now() - last.at < BURST_MS || (last.text === text && Date.now() - last.at < SAME_TEXT_MS))) {
      skip(last.text === text ? 'same text sent just before' : `another one for ${out.tag} went out ${Date.now() - last.at} ms ago`)
      continue
    }
    const clear = [...(outstanding.get(p.phoneId) ?? [])].filter(([k, v]) => v.resolved && k !== out.tag).map(([k]) => k).slice(-CLEAR_MAX)
    const note: PushNote = { v: PUSH_INNER_VERSION, id, tag: out.tag, cat: out.cat, title, body, link: out.link, at: base.at, ...(out.loud ? { loud: true } : {}), ...(clear.length ? { clear } : {}) }
    let sealed: Buffer
    try {
      sealed = encryptWebPush({ p256dh: s.p256dh, auth: s.auth }, fit(s, note))
    } catch (e) {
      skip(`couldn't encrypt: ${(e as Error).message}`)
      continue
    }
    const ok = host.relay({ t: 'push', id, endpoint: s.endpoint, token: s.token, ttl: out.ttl ?? TTL_DEFAULT_S, urgency: out.urgency ?? (out.cat === 'ask' ? 'high' : 'normal'), topic: pushTopic(s.key, out.tag), body: sealed.toString('base64url') })
    if (!ok) {
      skip('the relay is not connected')
      continue
    }
    lastByTag.set(key, { at: base.at, text })
    while (lastByTag.size > 400) lastByTag.delete(lastByTag.keys().next().value as string)
    let mine = outstanding.get(p.phoneId)
    if (!mine) outstanding.set(p.phoneId, (mine = new Map()))
    mine.set(out.tag, { at: base.at, resolved: false })
    while (mine.size > OUTSTANDING_MAX) mine.delete(mine.keys().next().value as string)
    const r = record({ ...base, decision: 'sent', bytes: sealed.length })
    pending.set(id, r)
    setTimeout(() => pending.delete(id), 60_000).unref()
    made.push(r)
    sent++
    log(`${out.cat} "${title}" to phone ${p.phoneId} via ${s.service}, ${sealed.length} encrypted bytes, tag ${out.tag}`)
  }
  for (const r of made) if (r.decision !== 'sent') log(`${r.cat} "${r.title}" not sent to phone ${r.phoneId}: ${r.decision}`)
  return { sent, records: made }
}

export function onPushResult(m: { id?: unknown; status?: unknown; gone?: unknown; error?: unknown }): void {
  const id = String(m.id ?? '')
  const r = pending.get(id)
  if (!r) return
  pending.delete(id)
  r.status = Number(m.status) || 0
  r.ms = Date.now() - r.at
  if (typeof m.error === 'string' && m.error) r.error = m.error.slice(0, 200)
  const ok = r.status >= 200 && r.status < 300
  log(`${r.cat} ${id} for phone ${r.phoneId}: push service answered ${r.status || 'nothing'}${r.error ? ` (${r.error})` : ''} after ${r.ms} ms`)
  if (m.gone === true && !ok) unregister(r.phoneId, `the push service says the address is gone (${r.status})`)
}

export function resolvePush(tag: string, why: string): void {
  let n = 0
  for (const mine of outstanding.values()) {
    const o = mine.get(tag)
    if (o && !o.resolved) {
      o.resolved = true
      n++
    }
  }
  if (!n) return
  log(`${tag} was seen (${why}); ${n} phone(s) clear it now if open, else when they open or get the next notification`)
  host?.broadcast('remote:push:resolved', [])
}

function activity(): ActivityEntry[] {
  return [...feed.values()].map((k) => k.e).sort((a, b) => b.at - a.at)
}

function feedChanged(): void {
  host?.broadcast('remote:activity', [activity()])
}

export function activityPut(e: Omit<ActivityEntry, 'count' | 'open'>, who: string): void {
  const was = feed.get(e.id)?.e
  feed.delete(e.id)
  feed.set(e.id, { e: { ...e, open: e.kind === 'ask', count: was?.kind === e.kind ? was.count + 1 : 1 }, who })
  while (feed.size > FEED_MAX) feed.delete(feed.keys().next().value as string)
  log(`activity ${e.id}: ${e.title}${was ? ` (replaces "${was.title}")` : ''}`)
  feedChanged()
}

export function activitySettle(id: string, word: string): void {
  resolvePush(id, word)
  const k = feed.get(id)
  if (!k || !(k.e.open || k.e.kind === 'unity')) return
  const title = `${k.who} ${word}`
  if (k.e.title === title) return
  k.e = { ...k.e, title, open: false }
  log(`activity ${id}: ${title}`)
  feedChanged()
}

export function pushReport(): { activity: ActivityEntry[]; phones: (PushState & { phoneId: string; device: string; service: string | null; outstanding: string[] })[]; records: PushRecord[] } {
  return {
    activity: activity(),
    phones: (host?.phones() ?? []).map((p) => ({ phoneId: p.phoneId, device: p.device || '', service: p.push?.service ?? null, ...stateOf(p), endpoint: p.push ? `${p.push.service}/…${p.push.endpoint.slice(-6)}` : null, outstanding: [...(outstanding.get(p.phoneId)?.keys() ?? [])] })),
    records: [...records]
  }
}
