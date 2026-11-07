import type { IpcTransport } from '@shared/create-api'
import { decodeRemote, encodeRemote, readAllowance, type RemoteAllowance, type RemotePhoneLogs, type RemoteRpc, type RemoteVideoRefusal, type RpcKind } from '@shared/remote-protocol'
import { postToShell } from './shell-bus'
import { censusGauge, censusTrack } from '@shared/census'
import { deflateSync, inflateSync } from 'fflate'
import { LinkPeer, LinkUnpacker, packLink, type LinkCodec, type LinkFrame, type LinkPeerDiag } from '@shared/remote-link'
import { REMOTE_PROTOCOL } from '@shared/remote-version'
import { E2E_SESSION_SOFT_MS, type E2eMode, type E2ePairCode } from '@shared/remote-e2e'
import { askPersist, e2eUnsupported, forgetPairing, loadIdentity, loadPairing, savePairing, startPhoneHandshake, type PhoneE2eSession, type PhoneHandshake, type PhoneIdentity, type PhonePairing } from './e2e'
import { deviceKind } from '@shared/user-agent'
import { clearPairFromUrl, pairCodeInUrl, readMark, writeMark } from './pair-marker'
import { getMac, pathHostId, setLastPlace, updateMac } from './macs'
import { afterPaint, logTap, tapStartedAt } from './motion'
import { dropTicket, goSignIn, loadConfig, loadTicket, ticketNow, type PhoneConfig } from './account'

export type ConnectionState = 'connecting' | 'online' | 'offline' | 'unpaired' | 'busy' | 'replaced' | 'signin' | 'denied' | 'away'
export type RemoteAccess = 'local' | 'any'
export type AwayCheck = 'idle' | 'checking' | 'error'
export type Outage = 'stuck' | 'offline' | 'relay'
export type Fit = 'update' | 'relay'

interface Handshake {
  ws: WebSocket
  mode: E2eMode
  finish: PhoneHandshake['finish']
  code: E2ePairCode | null
}

interface PendingCall {
  ch: string
  resolve: (v: unknown) => void
  reject: (e: Error) => void
}

type Listener = (...args: any[]) => void

const INSTALL_KEY = 'satura-remote-install'
const UPDATE_RELOAD_KEY = 'satura-remote-update-reload'
const UPDATE_RELOAD_MS = 15_000
const DEFAULT_DEADLINE_MS = 10_000
const DEADLINES: Record<string, number> = {
  'remote:storeAction': 5000,
  'remote:videoStill': 30_000,
  'pty:spawn': 10_000,
  'unity:start': 30_000,
  'unity:setMode': 10_000
}
const NO_PENDING = new Set(['remote:hello', 'settings:get', 'remote:readMedia', 'remote:panelReport', 'remote:presence', 'remote:claimPty', 'remote:releasePty', 'system:load', 'unity:watchLifecycle'])
const TAP_SELECTOR = 'button, [role="button"], a, [data-remote-tap]'
const MAX_QUEUED_LOGS = 300
const PING_MS = 1500
const LATE_MS = 4000
const BULK_LATE_MS = 15_000
const OPEN_MS = 8000
const WELCOME_MS = 6000
const TICK_MS = 500
const SLOW_PONG_MS = 1500
const STOPPED_DEAD_MS = 10_000
const SILENT_CLOSE_MS = 1000
const ALLOW_WAIT_MS = 65_000
const VERIFY_FAILS_SHOWN = 3
const VERIFY_TEXT = "This phone couldn't verify your desktop: its end-to-end key isn't the one this phone paired with. If Satura on the desktop was reset or reinstalled, pair this phone again. Otherwise something between this phone and your desktop is changing the connection."
const ALLOW_TIMEOUT_TEXT = "Nobody allowed this phone on your desktop in time. Make a new code on your desktop and try again."
const LOST_KEY_TEXT = "This phone lost its pairing key (the browser cleared this site's storage). Pair it again with a new code from your desktop."
const OUTAGE_TEXT: Record<Outage, string> = {
  stuck: "Your desktop isn't responding",
  offline: 'Your desktop is offline',
  relay: "Can't connect to Satura Remote"
}
const LAYER_NAME = { relay: 'the relay', main: 'Satura on the desktop', window: 'the Satura window on the desktop' }
type Layer = keyof typeof LAYER_NAME

class Outaged extends Error {}
class CallTimedOut extends Error {}

const listeners = new Map<string, Set<Listener>>()
const calls = new Map<number, PendingCall>()
const outbox: RemoteRpc[] = []
const logQueue: string[] = []
const hostLogQueue: RemoteRpc[] = []
const stateListeners = new Set<(s: ConnectionState, detail?: string) => void>()
const driveHandlers = new Set<(m: Record<string, unknown>) => void>()
const pendingByElement = new Map<HTMLElement, number>()
const retries = new Map<number, () => void>()
censusTrack('phone.listenerChannels', listeners)
censusGauge('phone.listeners', () => [...listeners.values()].reduce((n, s) => n + s.size, 0))
censusTrack('phone.calls', calls)
censusTrack('phone.retries', retries)
censusTrack('phone.pendingByElement', pendingByElement)
censusTrack('phone.stateListeners', stateListeners)
censusGauge('phone.outbox', () => outbox.length)

let socket: WebSocket | null = null
let state: ConnectionState = 'connecting'
let stateDetail = ''
let nextId = 1
let nextRetry = 1
let tapTarget: HTMLElement | null = null
let quiet = 0
let hostName = ''
let captured: Promise<unknown>[] | null = null
let hostLogs: RemotePhoneLogs = 'errors'
let hostGone = false
const ACCOUNT_CODES = new Set(['signin', 'denied', 'away'])
const IDLE_STATES = new Set<ConnectionState>(['unpaired', 'busy', 'replaced', 'signin', 'denied', 'away'])
const AWAY_CHECK_MS = 8000
let access: RemoteAccess | null = null
let awayCheck: AwayCheck = 'idle'
let awayCheckedAt = 0
let allowance: RemoteAllowance | null = null
let videoRefusal: RemoteVideoRefusal | null = null
const noticeListeners = new Set<() => void>()
const pingSent = new Map<number, number>()
const pingRpc = new Map<number, number>()
const heard: Record<Layer, number> = { relay: 0, main: 0, window: 0 }
let outage: Outage | null = null
let outageAt = 0
let welcomePing = 0
let resynced = false
let everOnline = false
let welcomedWs: WebSocket | null = null
let relayPings = false
let hostPings = true
let hostSilent = false
let pingSeq = 0
let pingAt = 0
let connectAt = 0
let openedAt = 0
let halted: '' | 'cancelled' | 'failed' = ''
let autoUsed = true
let lastTick = 0
let quietSince = 0
let stale = ''
let silentClose = 0
let tickTimer: ReturnType<typeof setInterval> | null = null
let pairing: PhonePairing | null = null
let identity: PhoneIdentity | null = null
let storeLoad: Promise<void> | null = null
let storeReady = false
let storeWaiting = false
let lostKey = false
let cryptoProblem = ''
let phoneConfig: PhoneConfig | null = null
let configWaiting = false
let fit: Fit | null = null
let verifyFails = 0
let pairStopped = false
let session: PhoneE2eSession | null = null
let sessionWs: WebSocket | null = null
let handshake: Handshake | null = null
let pendingPair: { hostId: string; macPub: string; hostName: string } | null = null
let waitingAllow = 0
let inbound: Promise<unknown> = Promise.resolve()
let plainIgnored = 0
let sealFailed = false
censusTrack('phone.pingSent', pingSent)
censusTrack('phone.pingRpc', pingRpc)

const LINK_REBIND_MS = 5000
const LINK_RELAY_GRACE_MS = 2000
const linkCodec: LinkCodec = { deflate: (raw) => deflateSync(raw), inflate: (packed) => inflateSync(packed) }
const unpacker = new LinkUnpacker(linkCodec)
let linkCh: RTCDataChannel | null = null
let linkSession = ''
let linkBound = false
let linkBinding: RTCDataChannel | null = null
let linkBoundAt = 0
let linkNextBind = 0
let linkRelayFrames = 0
let linkHeard: () => number = () => 0
let relayRttMs: number | null = null
const callRtts: number[] = []

const link = new LinkPeer({
  name: 'phone calls',
  relay: (text) => sealSend(text),
  direct: (text) => directSend(text),
  deliver: (m, path) => deliverFrame(m, path),
  loose: (a) => ({ t: 'rpc', id: 0, kind: 'send', ch: 'remote:ack', args: [], a }),
  log: (line) => console.info(`[remote] ${line}`),
  deltas: false,
  stampAlways: true,
  overflow: (why) => setTimeout(() => fail('relay', `calls to the desktop backed up: ${why}`), 0),
  broken: (why) => {
    console.warn(`[remote] the link to the Mac got out of step: ${why}`)
    setTimeout(() => fail('relay', 'the link to the desktop got out of step'), 0)
  },
  heard: () => linkHeard(),
  maxBody: 7 * 1024 * 1024,
  tooBig: (head, bytes) => {
    const c = typeof head.id === 'number' ? calls.get(head.id) : undefined
    if (c) {
      calls.delete(head.id)
      c.reject(new Error(`That is too big to send to the desktop (${Math.round(bytes / 1048576)} MB)`))
    }
    return null
  }
})
censusGauge('phone.linkUnacked', () => link.unacked)

function directSend(text: string): boolean {
  const ch = linkCh
  if (!ch || !linkBound || ch.readyState !== 'open') return false
  try {
    for (const part of packLink(text, linkCodec)) ch.send(part as string)
    return true
  } catch {
    return false
  }
}

export function linkState(): { channel: string; bound: boolean; direct: boolean; unacked: number; stats: LinkPeer['stats'] } {
  return { channel: linkCh?.readyState ?? 'none', bound: linkBound, direct: link.direct, unacked: link.unacked, stats: { ...link.stats } }
}

export function videoSecret(): Uint8Array | null {
  return session && !session.closed ? session.video.slice() : null
}

export function setLinkHeard(fn: () => number): void {
  linkHeard = fn
}

function percentile(values: number[], p: number): number | null {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  return Math.round(sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))])
}

export function callsDiag(): LinkPeerDiag & { channel: string; callMs: number | null; callP95: number | null } {
  return { ...link.diag(), channel: linkCh?.readyState ?? 'none', callMs: percentile(callRtts.slice(-5), 0.5), callP95: percentile(callRtts, 0.95) }
}

export function relayDiag(): { open: boolean; rttMs: number | null } {
  return { open: socketOpen() && state === 'online', rttMs: relayRttMs }
}

export function hydrating(): boolean {
  return quiet > 0
}

export function setLinkChannel(ch: RTCDataChannel | null, session: string): void {
  if (linkCh === ch) return
  if (linkCh) {
    linkBound = false
    link.setDirect(false, 'the video link restarted')
  }
  linkCh = ch
  linkSession = session
  unpacker.reset()
  if (!ch) return
  ch.binaryType = 'arraybuffer'
  ch.onmessage = (e) => {
    if (linkCh !== ch) return
    const text = unpacker.push(e.data as string | ArrayBuffer)
    if (text !== null) onFrame(text, 'direct')
  }
  ch.onclose = () => {
    if (linkCh !== ch) return
    linkCh = null
    linkBound = false
    link.setDirect(false, 'the data channel closed')
  }
  ch.onopen = () => bindLink('the data channel opened')
  if (ch.readyState === 'open') bindLink('the data channel is open')
}

function bindLink(why: string): void {
  const ch = linkCh
  if (!ch || ch.readyState !== 'open' || linkBound || linkBinding === ch || !welcomed() || state !== 'online') return
  if (Date.now() < linkNextBind) return
  linkBinding = ch
  const t0 = performance.now()
  invokeRemote<{ ok?: boolean }>('remote:link', { session: linkSession })
    .then((r) => {
      if (linkCh !== ch || !r?.ok) return
      linkBound = true
      linkBoundAt = Date.now()
      linkRelayFrames = 0
      link.setDirect(true, `${why}, bound in ${Math.round(performance.now() - t0)} ms`)
    })
    .catch((e: Error) => {
      if (linkCh !== ch) return
      linkNextBind = Date.now() + LINK_REBIND_MS
      console.info(`[remote] calls stay on the relay: ${e.message}`)
    })
    .finally(() => {
      if (linkBinding === ch) linkBinding = null
    })
}

function watchLink(now: number): void {
  link.tick()
  if (linkBound && !link.direct) {
    linkBound = false
    linkNextBind = now + LINK_REBIND_MS
  }
  if (linkBound && linkRelayFrames > 3 && now - linkBoundAt > LINK_REBIND_MS) {
    console.info(`[remote] the Mac answers over the relay again (${linkRelayFrames} frames), binding the data channel again`)
    linkBound = false
    link.setDirect(false, 'the desktop went back to the relay')
  }
  if (!linkBound) bindLink('retry')
}


function loadStore(): Promise<void> {
  storeLoad ??= (async () => {
    const why = e2eUnsupported()
    if (why) {
      cryptoProblem = why
      console.warn(`[remote] e2e: ${why}`)
      return
    }
    try {
      const host = pageHostId()
      pairing = host ? await loadPairing(host) : null
      identity = host ? await loadIdentity(host, false) : null
      if (pairing && !identity) {
        console.warn("[remote] e2e: this phone has a pairing but lost its key, so it must pair again")
        await forgetPairing(pairing.hostId, false)
        pairing = null
        lostKey = true
      }
      const known = getMac(host)
      if (!pairing && known && !known.removed && !pairCodeInUrl()) {
        lostKey = true
        updateMac(known.hostId, { removed: { at: Date.now(), why: LOST_KEY_TEXT } })
      }
      if (pairing) writeMark({ hostId: pairing.hostId, phoneId: pairing.phoneId, hostName: known?.name || pairing.hostName })
      if (host && pathHostId()) setLastPlace(host)
      console.info(`[remote] e2e: key store ready for ${host ?? 'no Mac'}, ${pairing ? `paired with ${pairing.hostId} as ${pairing.phoneId}` : 'not paired'}${identity ? '' : ', no key yet'}`)
    } catch (e) {
      cryptoProblem = `This browser couldn't open this phone's key store (${(e as Error).message}).`
      console.warn(`[remote] e2e: ${cryptoProblem}`)
    }
  })().finally(() => {
    storeReady = true
  })
  return storeLoad
}

function pageHostId(): string | null {
  return pathHostId() ?? pairCodeInUrl()?.hostId ?? null
}

export function currentHostId(): string | null {
  return pathHostId()
}

function clearPairing(why: string, shown: string): void {
  const host = pairing?.hostId ?? readMark()?.hostId ?? null
  if (!host) return
  console.info(`[remote] e2e: forgetting the pairing with ${host} (${why}); this phone's key for it stays, other Macs are untouched`)
  pairing = null
  updateMac(host, { removed: { at: Date.now(), why: shown } })
  void forgetPairing(host, false).catch((e: Error) => console.warn(`[remote] e2e: couldn't clear the pairing: ${e.message}`))
}

function endSession(): void {
  session?.close()
  session = null
  sessionWs = null
  handshake = null
  pendingPair = null
  waitingAllow = 0
  sealFailed = false
}

function sealSend(text: string): boolean {
  const ws = socket
  const s = session
  if (!ws || ws.readyState !== WebSocket.OPEN || !s || sessionWs !== ws) return false
  void s.seal(text).then(
    (bytes) => {
      if (socket === ws && ws.readyState === WebSocket.OPEN) ws.send(bytes)
    },
    (e: Error) => {
      if (sealFailed || socket !== ws || session !== s) return
      sealFailed = true
      console.warn(`[remote] e2e: couldn't encrypt a frame: ${e.message}`)
      setTimeout(() => fail('relay', "a frame couldn't be encrypted"), 0)
    }
  )
  return true
}

export function e2eState(): { supported: string | null; hostId: string | null; paired: { hostId: string; phoneId: string; hostName: string; pairedAt: number } | null; phoneId: string | null; session: ReturnType<PhoneE2eSession['stats']> | null; waitingAllow: boolean; plainIgnored: number } {
  return {
    supported: cryptoProblem || null,
    paired: pairing ? { hostId: pairing.hostId, phoneId: pairing.phoneId, hostName: pairing.hostName, pairedAt: pairing.pairedAt } : null,
    hostId: pageHostId(),
    phoneId: identity?.phoneId ?? null,
    session: session?.stats() ?? null,
    waitingAllow: waitingAllow > 0,
    plainIgnored
  }
}

function deviceLabel(): string {
  return String((window as unknown as { __saturaDevice?: string }).__saturaDevice ?? '').trim().slice(0, 60) || deviceKind(navigator.userAgent)
}

function devOrigin(): boolean {
  const h = location.hostname
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h.endsWith('.local') || /^(10|127)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\./.test(h)
}

function installId(): string {
  try {
    const known = localStorage.getItem(INSTALL_KEY)
    if (known) return known
    const made = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('')
    localStorage.setItem(INSTALL_KEY, made)
    return made
  } catch {
    return ''
  }
}

function reloadedForUpdate(): boolean {
  try {
    const last = Number(sessionStorage.getItem(UPDATE_RELOAD_KEY) ?? 0)
    if (Date.now() - last < UPDATE_RELOAD_MS) return true
    sessionStorage.setItem(UPDATE_RELOAD_KEY, String(Date.now()))
  } catch {
  }
  return false
}

function setState(next: ConnectionState, detail = ''): void {
  state = next
  stateDetail = outage && next !== 'online' && !IDLE_STATES.has(next) ? OUTAGE_TEXT[outage] : detail
  for (const l of stateListeners) l(next, stateDetail)
  postToShell({ type: 'connection', state: next, detail: stateDetail, hostName, paired: hasPairing(), hostGone, outage, halted, fit, verify: next === 'unpaired' && verifyFails >= VERIFY_FAILS_SHOWN, explain: next === 'unpaired' && pairStopped, allow: next === 'connecting' && waitingAllow ? { device: deviceLabel() } : null, access, wasOnline: everOnline, awayCheck, awayCheckedAt })
}

export function connectionState(): { state: ConnectionState; detail: string; hostName: string; outage: Outage | null; access: RemoteAccess | null } {
  return { state, detail: stateDetail, hostName, outage, access }
}

export function liveOutage(): Outage | null {
  return outage
}

export function allowanceNow(): RemoteAllowance | null {
  return allowance
}

export function videoRefusalNow(): RemoteVideoRefusal | null {
  return videoRefusal
}

export function clearVideoRefusal(): void {
  if (!videoRefusal) return
  videoRefusal = null
  for (const l of noticeListeners) l()
}

export function onRelayNotice(cb: () => void): () => void {
  noticeListeners.add(cb)
  return () => noticeListeners.delete(cb)
}

function noteAllowance(m: Record<string, any>): void {
  const next = readAllowance(m)
  if (!next) return
  const was = allowance
  allowance = next
  if (!was || was.overQuota !== next.overQuota || was.blocked !== next.blocked) console.info(`[remote] allowance: ${Math.round(next.usedBytes / 1e6)} of ${Math.round(next.allowanceBytes / 1e6)} MB used${next.overQuota ? ', over' : ''}${next.blocked ? ', the game stream is paused' : ''}, resets ${new Date(next.resetAt).toISOString()}`)
  if (videoRefusal?.code === 'quota' && !next.blocked) videoRefusal = null
  postToShell({ type: 'allowance', allowance: next })
  for (const l of noticeListeners) l()
}

function noteVideoRefused(m: Record<string, any>): void {
  const reason = String(m.reason ?? '').slice(0, 300)
  if (!videoRefusal || videoRefusal.reason !== reason) console.warn(`[remote] the relay refused the game stream (${String(m.code ?? '')}): ${reason}`)
  videoRefusal = { code: String(m.code ?? '').slice(0, 20), reason, resetAt: Number(m.resetAt) > 0 ? Number(m.resetAt) : null, at: Date.now() }
  for (const l of noticeListeners) l()
}

export function onConnectionState(cb: (s: ConnectionState, detail?: string) => void): () => void {
  stateListeners.add(cb)
  return () => stateListeners.delete(cb)
}

export function onDrive(cb: (m: Record<string, unknown>) => void): () => void {
  driveHandlers.add(cb)
  return () => driveHandlers.delete(cb)
}

let relayPush: string | null = null
const pushBinds = new Map<string, { resolve: (v: { token: string; key: string }) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>()

export function relayPushKey(): string | null {
  return relayPush
}

export function bindPushEndpoint(endpoint: string, ms = 10_000): Promise<{ token: string; key: string }> {
  return new Promise((resolve, reject) => {
    if (state !== 'online') return reject(new Error('Satura Remote is not connected to your desktop'))
    if (!relayPush) return reject(new Error("This relay can't send notifications yet"))
    pushBinds.get(endpoint)?.reject(new Error('asked again'))
    const timer = setTimeout(() => {
      pushBinds.delete(endpoint)
      reject(new Error("The relay didn't answer the notification sign-up"))
    }, ms)
    pushBinds.set(endpoint, { resolve, reject, timer })
    if (!rawSend(encodeRemote({ t: 'push-bind', endpoint }))) {
      clearTimeout(timer)
      pushBinds.delete(endpoint)
      reject(new Error('Satura Remote is not connected to your desktop'))
    }
  })
}

function pushBound(m: Record<string, any>): void {
  const endpoint = String(m.endpoint ?? '')
  const w = pushBinds.get(endpoint)
  if (!w) return
  pushBinds.delete(endpoint)
  clearTimeout(w.timer)
  if (typeof m.token === 'string' && m.token) w.resolve({ token: m.token, key: String(m.key ?? relayPush ?? '') })
  else w.reject(new Error(String(m.error || 'The relay refused the notification sign-up')))
}

function rawSend(text: string): boolean {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false
  socket.send(text)
  return true
}

function socketOpen(): boolean {
  return !!socket && socket.readyState === WebSocket.OPEN
}

function linkSend(frame: RemoteRpc): void {
  const { args, ...head } = frame
  link.send(head, 'args', args)
}

function sendRpc(frame: RemoteRpc): void {
  if (state === 'online' && socketOpen()) return linkSend(frame)
  if (everOnline || outage) return
  outbox.push(frame)
}

function failFast(): string | null {
  if (state === 'online' || (!everOnline && !outage)) return null
  return outage ? OUTAGE_TEXT[outage] : "This phone isn't connected to your desktop"
}

function flushOutbox(): void {
  while (outbox.length && socketOpen()) linkSend(outbox.shift()!)
}

function flushLogs(): void {
  while (logQueue.length && rawSend(logQueue[0])) logQueue.shift()
}

function flushHostLogs(): void {
  while (hostLogQueue.length && state === 'online' && socketOpen()) linkSend(hostLogQueue.shift()!)
}

export function setHostLogs(mode: RemotePhoneLogs | undefined): void {
  const next = mode === 'all' ? 'all' : 'errors'
  if (next === hostLogs) return
  hostLogs = next
  console.info(`[remote] console lines sent to the Mac log: ${next}`)
}

function toHost(level: string, text: string): void {
  if (level !== 'error' && level !== 'warn' && hostLogs !== 'all') return
  const frame: RemoteRpc = { t: 'rpc', id: nextId++, kind: 'send', ch: 'remote:log', args: [{ level, text }] }
  if (state === 'online' && socketOpen()) return linkSend(frame)
  hostLogQueue.push(frame)
  if (hostLogQueue.length > MAX_QUEUED_LOGS) hostLogQueue.shift()
}

function markPending(el: HTMLElement): () => void {
  pendingByElement.set(el, (pendingByElement.get(el) ?? 0) + 1)
  el.classList.add('remote-pending')
  el.setAttribute('aria-busy', 'true')
  let done = false
  return () => {
    if (done) return
    done = true
    const n = (pendingByElement.get(el) ?? 1) - 1
    if (n > 0) {
      pendingByElement.set(el, n)
      return
    }
    pendingByElement.delete(el)
    el.classList.remove('remote-pending')
    el.removeAttribute('aria-busy')
  }
}

function labelOf(el: HTMLElement | null): string {
  const text = el?.getAttribute('aria-label') || el?.textContent || ''
  return text.trim().replace(/\s+/g, ' ').slice(0, 60)
}

function offerRetry(el: HTMLElement | null, text: string, again = true): void {
  console.warn(`[remote] tap on "${labelOf(el) || 'a control'}" failed: ${text}`)
  const id = nextRetry++
  if (el && again) retries.set(id, () => el.isConnected && el.click())
  postToShell({ type: 'toast', text, retryId: el && again ? id : null })
}

function didntGo(el: HTMLElement, why: string): string {
  return `${labelOf(el) || 'That'} didn't go through. ${why}.`
}

export function retry(id: number): void {
  const fn = retries.get(id)
  retries.delete(id)
  fn?.()
}

function call(kind: RpcKind, ch: string, args: unknown[]): Promise<unknown> {
  while (args.length && args[args.length - 1] === undefined) args = args.slice(0, -1)
  if (quiet > 0) {
    console.warn(`[remote] dropped ${kind} ${ch} during mirror hydration`)
    return Promise.resolve(undefined)
  }
  const el = kind === 'invoke' && !NO_PENDING.has(ch) ? tapTarget : null
  const down = failFast()
  if (down) {
    if (el) offerRetry(el, didntGo(el, down), false)
    return Promise.reject(new Outaged(down))
  }
  const id = nextId++
  const settle = el ? markPending(el) : null
  const tapAt = el ? tapStartedAt() ?? performance.now() : 0
  const promise = new Promise((resolve, reject) => {
    const deadline = DEADLINES[ch] ?? DEFAULT_DEADLINE_MS
    const timer = el
      ? setTimeout(() => {
          if (!calls.has(id)) return
          calls.delete(id)
          settle?.()
          const text = `${labelOf(el) || 'That'} didn't answer in ${Math.round(deadline / 1000)} s`
          offerRetry(el, text)
          reject(new CallTimedOut(text))
        }, deadline)
      : null
    calls.set(id, {
      ch,
      resolve: (v) => {
        if (timer) clearTimeout(timer)
        settle?.()
        if (el) {
          const acked = performance.now()
          afterPaint((at) => logTap(`${ch} from "${labelOf(el)}"`, { desktop: acked - tapAt, shown: at - tapAt }))
        }
        resolve(v)
      },
      reject: (e) => {
        if (timer) clearTimeout(timer)
        settle?.()
        if (el) offerRetry(el, e instanceof Outaged ? didntGo(el, e.message) : e.message, !(e instanceof Outaged))
        reject(e)
      }
    })
    sendRpc({ t: 'rpc', id, kind, ch, args })
  })
  if (captured && kind === 'invoke') captured.push(promise)
  return promise
}

export async function trackCalls(fn: () => void): Promise<number> {
  const prev = captured
  const mine: Promise<unknown>[] = []
  captured = mine
  try {
    fn()
  } finally {
    captured = prev
  }
  await new Promise((r) => setTimeout(r, 0))
  await Promise.all(mine)
  return mine.length
}

export function hostLabel(): string {
  return hostName
}

function emit(ch: string, args: unknown[]): void {
  const set = listeners.get(ch)
  if (!set) return
  for (const l of [...set]) {
    try {
      l(...args)
    } catch (e) {
      console.error(`[remote] listener for ${ch} threw`, e)
    }
  }
}

function notePaired(p: { hostId: string; macPub: string; hostName: string }): void {
  const id = identity
  if (!id) return
  const next: PhonePairing = { hostId: p.hostId, phoneId: id.phoneId, macPub: p.macPub, hostName: p.hostName, pairedAt: Date.now() }
  pairing = next
  lostKey = false
  updateMac(next.hostId, { name: next.hostName, phoneId: next.phoneId, pairedAt: next.pairedAt, seenAt: next.pairedAt, removed: null })
  setLastPlace(next.hostId)
  savePairing(next).then(
    () => console.info(`[remote] e2e: paired with ${next.hostId} as ${next.phoneId}, the Mac's key is pinned on this phone`),
    (e: Error) => console.error(`[remote] e2e: couldn't keep the pairing: ${e.message}`)
  )
  void askPersist().then((kept) => console.info(`[remote] e2e: persistent storage ${kept === null ? 'not offered by this browser' : kept ? 'granted' : 'not granted, the browser may clear this pairing'}`))
}

function welcome(m: Record<string, any>): void {
  if (!session || sessionWs !== socket) {
    console.warn('[remote] e2e: the relay said welcome before the Mac proved itself, ignored')
    return
  }
  if (pendingPair) notePaired(pendingPair)
  else if (pairing && hostName && pairing.hostName !== hostName) {
    pairing = { ...pairing, hostName }
    void savePairing(pairing).catch(() => {})
  }
  if (pairing) writeMark({ hostId: pairing.hostId, phoneId: pairing.phoneId, hostName: hostName || pairing.hostName })
  if (pairing) updateMac(pairing.hostId, { seenAt: Date.now() })
  pendingPair = null
  waitingAllow = 0
  clearPairFromUrl()
  logQueue.length = 0
  hostGone = false
  hostSilent = false
  everOnline = true
  welcomedWs = socket
  link.reset()
  linkBound = false
  linkNextBind = 0
  relayPings ||= !!m.ping
  const was = access
  access = m.access === 'local' ? 'local' : 'any'
  if (was !== access) console.info(`[remote] ${access === 'local' ? "free on this network: this phone and the desktop share it, so Satura Remote needs no subscription here" : 'Satura Remote works from any network on this account'}`)
  awayCheck = 'idle'
  relayPush = typeof m.push?.key === 'string' && /^[A-Za-z0-9_-]{80,100}$/.test(m.push.key) ? m.push.key : null
  hostPings = true
  heard.main = heard.window = pingSeq
  welcomePing = pingSeq
  resynced = false
  console.info(`[remote] online: host ${hostName} phone ${m.phoneId}${outage ? `, resyncing after "${OUTAGE_TEXT[outage]}"` : ''}`)
  setState('online')
  sendPings(Date.now())
  flushOutbox()
  flushHostLogs()
  emit('remote:online', [])
  bindLink('online')
}

function deliverFrame(m: LinkFrame, path: 'relay' | 'direct'): void {
  if (path === 'relay' && typeof m.s === 'number' && linkBound && Date.now() - linkBoundAt > LINK_RELAY_GRACE_MS) linkRelayFrames++
  if (m.t === 'evt' && m.ch === 'remote:pong') return heardPong('window', Number(m.args?.[0]?.n))
  if (m.t === 'evt') return emit(m.ch, Array.isArray(m.args) ? m.args : [])
  if (m.t !== 'res') return
  if (pingRpc.has(m.id)) {
    const n = pingRpc.get(m.id) ?? 0
    pingRpc.delete(m.id)
    if (m.ok) return heardPong('main', n)
    if (hostPings) console.warn(`[remote] liveness: this Mac doesn't answer pings (${m.error}), only the socket is watched`)
    hostPings = false
    return
  }
  const c = calls.get(m.id)
  if (!c) return
  calls.delete(m.id)
  if (m.ok) c.resolve(m.value)
  else c.reject(new Error(m.error || `${c.ch} failed`))
}

async function onHandshake(ws: WebSocket, m: Record<string, any>): Promise<void> {
  if (m.wait === 'allow') {
    if (!handshake && session && sessionWs === ws && pendingPair) {
      waitingAllow = Date.now()
      console.info(`[remote] e2e: waiting for Allow on the Mac, which shows this phone as ${deviceLabel()}`)
      setState('connecting', 'Waiting for you to allow this phone on your desktop')
    }
    return
  }
  const h = handshake
  if (!h || h.ws !== ws || !m.e2e) return
  handshake = null
  try {
    const r = await h.finish(m.e2e)
    if (socket !== ws) return r.session.close()
    session?.close()
    session = r.session
    sessionWs = ws
    verifyFails = 0
    hostName = r.hostName
    pendingPair = h.code ? { hostId: h.code.hostId, macPub: r.macPub, hostName: r.hostName } : null
    ws.send(encodeRemote({ t: 'hs', e2e: r.finish }))
    console.info(`[remote] e2e: verified ${r.hostName || 'the Mac'} (${h.mode === 'pair' ? `pairing code proven both ways${h.code?.commit ? ', key matches the QR code' : ''}` : 'pinned key'}), session keys set`)
  } catch (e) {
    const why = (e as Error).message
    console.error(`[remote] e2e: ${why}; closing the connection`)
    if (h.mode === 'pair') {
      clearPairFromUrl()
      pairStopped = true
      dropSocketQuietly()
      setState('unpaired', `Pairing failed: couldn't verify your desktop (${why}). Make a new code on your desktop and try again.`)
      return
    }
    if (++verifyFails >= VERIFY_FAILS_SHOWN) {
      dropSocketQuietly()
      setState('unpaired', VERIFY_TEXT)
      return
    }
    fail('relay', `couldn't verify the desktop: ${why}`)
  }
}

function dropSocketQuietly(): void {
  const old = socket
  socket = null
  welcomedWs = null
  endSession()
  if (!old) return
  old.onclose = null
  old.onmessage = null
  try {
    old.close()
  } catch {
  }
}

async function onWire(ws: WebSocket, data: unknown): Promise<void> {
  if (socket !== ws) return
  if (typeof data === 'string') {
    if (data.startsWith('{"t":"hs"')) {
      let m: Record<string, any>
      try {
        m = JSON.parse(data) as Record<string, any>
      } catch {
        return
      }
      return onHandshake(ws, m)
    }
    return onFrame(data, 'relay', false)
  }
  if (!(data instanceof ArrayBuffer)) return
  const s = session
  if (!s || sessionWs !== ws) return
  let text: string
  try {
    text = await s.open(new Uint8Array(data))
  } catch (e) {
    if (socket !== ws) return
    console.error(`[remote] e2e: ${(e as Error).message}; the relay or the network changed a frame`)
    return fail('relay', 'a frame from the desktop failed its integrity check')
  }
  if (socket === ws) onFrame(text, 'relay', true)
}

function onFrame(text: string, path: 'relay' | 'direct', sealed = false): void {
  quietSince = Date.now()
  let m: Record<string, any>
  try {
    m = decodeRemote<Record<string, any>>(text)
  } catch {
    return
  }
  if (m.t === 'evt' || m.t === 'res' || m.t === 'ack') {
    if (path === 'relay' && !sealed) {
      if (plainIgnored++ === 0) console.warn(`[remote] e2e: ignored a plaintext ${m.t} frame from the relay; the Mac only talks to this phone encrypted`)
      return
    }
    return link.receive(m, path)
  }
  if (path !== 'relay' || sealed) return
  if (m.t === 'pong') {
    relayPings = true
    hostSilent = m.host === 'silent'
    return heardPong('relay', Number(m.id))
  }
  if (m.t === 'welcome') return welcome(m)
  if (m.t === 'allowance') return noteAllowance(m)
  if (m.t === 'push-bound') return pushBound(m)
  if (m.t === 'video-refused') return noteVideoRefused(m)
  if (m.t === 'reject' && m.code === 'busy') {
    console.warn(`[remote] refused, another phone is connected: ${m.reason}`)
    setState('busy', String(m.reason ?? ''))
    return
  }
  if (m.t === 'reject' && m.code === 'update') {
    console.warn(`[remote] the Mac and this phone app don't fit: ${m.reason}`)
    if (!reloadedForUpdate()) return location.reload()
    dropSocketQuietly()
    halted = 'failed'
    fit = m.fit === 'update' || m.fit === 'relay' ? m.fit : /newer/i.test(String(m.reason ?? '')) ? 'relay' : 'update'
    setState('offline', String(m.reason ?? ''))
    return
  }
  if (m.t === 'reject' && m.code === 'away') {
    const first = state !== 'away'
    if (first) console.warn(`[remote] this phone isn't on the desktop's network and the account has no subscription for use over the internet${everOnline ? ', so Satura Remote paused' : ''}: ${m.reason}`)
    else console.info(`[remote] checked the network again: still not on the desktop's network`)
    awayCheck = 'idle'
    awayCheckedAt = Date.now()
    if (first) failCalls("This phone isn't on your desktop's network", true)
    setState('away', String(m.reason ?? ''))
    return
  }
  if (m.t === 'reject' && ACCOUNT_CODES.has(m.code)) {
    console.warn(`[remote] refused by the account gate (${m.code}): ${m.reason}`)
    setState(m.code as ConnectionState, String(m.reason ?? ''))
    if (m.code === 'signin') {
      if (ticketNow()) void dropTicket(`the relay refused it: ${m.reason}`)
      goSignIn(`the relay said: ${m.reason}`)
    }
    return
  }
  if (m.t === 'reject') {
    console.warn(`[remote] rejected${m.code ? ` (${m.code})` : ''}: ${m.reason}`)
    if (pairCodeInUrl()) {
      clearPairFromUrl()
      pairStopped = true
    } else clearPairing(`the desktop said: ${String(m.reason ?? 'rejected')}`, String(m.reason || 'This desktop no longer accepts this phone.'))
    endSession()
    setState('unpaired', String(m.reason ?? ''))
    return
  }
  if (m.t === 'host-left') {
    hostGone = true
    hostSilent = m.reason === 'silent'
    fail(hostSilent ? 'stuck' : 'offline', hostSilent ? 'the relay lost the desktop: it stopped answering' : 'the relay says the desktop left')
    return
  }
  if (m.t === 'drive') {
    if (devOrigin()) for (const h of driveHandlers) h(m)
    else console.warn('[remote] ignored a drive frame from the relay: drive only works on a local dev relay')
  }
}

function failCalls(reason: string, down = false): void {
  for (const [id, c] of [...calls]) {
    calls.delete(id)
    c.reject(down ? new Outaged(reason) : new Error(reason))
  }
}

function restartPings(): void {
  pingSent.clear()
  pingRpc.clear()
  heard.relay = heard.main = heard.window = pingSeq
  pingAt = 0
}

function heardPong(layer: Layer, n: number): void {
  if (!(n > 0)) return
  const at = pingSent.get(n)
  const ms = at ? Date.now() - at : 0
  if (at && n > heard[layer]) {
    if (layer === 'relay') relayRttMs = ms
    if (layer === 'main') {
      callRtts.push(ms)
      if (callRtts.length > 40) callRtts.shift()
    }
  }
  if (ms > SLOW_PONG_MS) console.info(`[remote] liveness: ${LAYER_NAME[layer]} answered after ${ms} ms`)
  if (n > heard[layer]) heard[layer] = n
  if (autoUsed && welcomed() && (!hostPings || (heard.main > welcomePing && heard.window > welcomePing))) autoUsed = false
  if (outage) maybeBack()
}

function maybeBack(): void {
  if (!outage || !resynced || state !== 'online') return
  if (hostPings && (heard.main <= welcomePing || heard.window <= welcomePing)) return
  console.info(`[remote] liveness: back after ${Math.round((Date.now() - outageAt) / 1000)} s, state resynced`)
  outage = null
  setState('online')
}

let bulkAt = 0

export function noteBulkFlow(): void {
  bulkAt = Date.now()
}

function lateBy(layer: Layer, now: number): number {
  for (const [n, at] of pingSent) if (n > heard[layer]) return now - at > BULK_LATE_MS ? now - at : now - Math.max(at, bulkAt)
  return 0
}

function welcomed(): boolean {
  return !!socket && socket === welcomedWs && socket.readyState === WebSocket.OPEN
}

function sendPings(now: number): void {
  if (!socket || socket.readyState !== WebSocket.OPEN) return
  const n = ++pingSeq
  pingSent.set(n, now)
  pingAt = now
  rawSend(encodeRemote({ t: 'ping', id: n }))
  if (welcomed() && hostPings) {
    const id = nextId++
    pingRpc.set(id, n)
    linkSend({ t: 'rpc', id, kind: 'invoke', ch: 'remote:ping', args: [{ n }] })
  }
  const floor = Math.min(relayPings ? heard.relay : n - 1, welcomed() && hostPings ? Math.min(heard.main, heard.window) : n - 1)
  for (const [k, at] of pingSent) {
    if (k > floor && now - at < 60_000) break
    pingSent.delete(k)
  }
  for (const [id] of pingRpc) {
    if (pingRpc.size <= 100) break
    pingRpc.delete(id)
  }
}

function lostKind(): Outage {
  return hostGone ? (hostSilent ? 'stuck' : 'offline') : 'relay'
}

function fail(kind: Outage, why: string): void {
  dropSocketQuietly()
  dropDeadLink()
  if (!halted && !autoUsed) {
    autoUsed = true
    console.warn(`[remote] liveness: ${OUTAGE_TEXT[kind]} (${why}); one automatic attempt`)
    failCalls(OUTAGE_TEXT[kind], true)
    outbox.length = 0
    setState('connecting')
    connect()
    return
  }
  if (!halted) console.warn(`[remote] liveness: ${OUTAGE_TEXT[kind]} (${why}); no more attempts until Try again`)
  halted ||= 'failed'
  if (!outage) outageAt = Date.now()
  outage = kind
  failCalls(OUTAGE_TEXT[kind], true)
  if (outbox.length) console.info(`[remote] dropped ${outbox.length} queued calls: ${OUTAGE_TEXT[kind]}`)
  outbox.length = 0
  setState(state === 'online' || state === 'connecting' || state === 'away' ? 'offline' : state)
}

function watching(): boolean {
  return !IDLE_STATES.has(state) && hasPairing()
}

function noteStopped(now: number): void {
  if (!socket || !lastTick || stale) return
  const quiet = now - Math.max(lastTick, quietSince)
  if (quiet > STOPPED_DEAD_MS) stale = `the page was stopped for ${Math.round(quiet / 1000)} s and heard nothing, so the relay has dropped its socket`
}

function deadSocket(): string {
  if (!socket) return ''
  if (socket.readyState === WebSocket.CLOSING || socket.readyState === WebSocket.CLOSED) return 'the socket to the relay closed without telling the page'
  return stale
}

function dropDeadLink(): void {
  if (linkCh && linkCh.readyState !== 'open') setLinkChannel(null, '')
}

function noteDead(why: string): boolean {
  const dead = deadSocket()
  if (!dead) return false
  fail(lostKind(), `${why}: ${dead}`)
  return true
}

function judge(now: number): void {
  const ws = socket
  if (ws && ws.readyState === WebSocket.CLOSED) {
    silentClose ||= now
    if (now - silentClose > SILENT_CLOSE_MS) noteDead('no close event came')
    return
  }
  if (ws && ws.readyState === WebSocket.CONNECTING && now - connectAt > OPEN_MS) return fail('relay', `no connection to the relay in ${OPEN_MS / 1000} s`)
  if (ws && ws.readyState === WebSocket.OPEN) {
    const relayLate = relayPings ? lateBy('relay', now) : 0
    if (relayLate > LATE_MS) return fail('relay', `the relay didn't answer for ${Math.round(relayLate / 1000)} s`)
    if (welcomed() && hostPings) {
      const main = lateBy('main', now)
      const win = lateBy('window', now)
      if (main > LATE_MS) return fail('stuck', `${LAYER_NAME.main} didn't answer for ${Math.round(main / 1000)} s`)
      if (win > LATE_MS) return fail('stuck', `${LAYER_NAME.window} didn't answer for ${Math.round(win / 1000)} s`)
      return
    }
    if (waitingAllow && now - waitingAllow > ALLOW_WAIT_MS) {
      console.warn('[remote] e2e: nobody allowed this phone on the Mac in time')
      clearPairFromUrl()
      pairStopped = true
      dropSocketQuietly()
      setState('unpaired', ALLOW_TIMEOUT_TEXT)
      return
    }
    if (!welcomed() && openedAt && now - openedAt > WELCOME_MS && state === 'connecting' && !waitingAllow)
      fail('stuck', `the desktop didn't take the connection in ${WELCOME_MS / 1000} s${hostSilent ? ', the relay says it went quiet' : ''}`)
  }
}

function tick(): void {
  const now = Date.now()
  const gap = lastTick > 0 ? now - lastTick : 0
  noteStopped(now)
  lastTick = now
  if (document.visibilityState === 'hidden' || halted) return
  if (gap > TICK_MS * 6) {
    console.info(`[remote] liveness: timers were paused for ${Math.round(gap / 1000)} s, probing again`)
    restartPings()
    if (openedAt) openedAt = now
  }
  if (!watching()) return
  if (stale && noteDead('the page runs again')) return
  if (now - pingAt >= PING_MS) sendPings(now)
  if (session && state === 'online' && now - session.startedAt > E2E_SESSION_SOFT_MS && calls.size === 0) return rekey(`fresh session keys after ${Math.round(E2E_SESSION_SOFT_MS / 3600_000)} h`)
  watchLink(now)
  judge(now)
}

function onShown(why: string, restored = false): void {
  if (document.visibilityState !== 'visible') return
  const now = Date.now()
  noteStopped(now)
  if (halted || !socket) return
  if (restored) stale ||= 'the page came back from the back-forward cache, which closes its sockets'
  restartPings()
  if (openedAt) openedAt = now
  if (!watching() || noteDead(why)) return
  console.info(`[remote] liveness: ${why}, probing now`)
  tick()
}

function startWatch(): void {
  if (tickTimer) return
  lastTick = Date.now()
  tickTimer = setInterval(tick, TICK_MS)
  document.addEventListener('visibilitychange', () => onShown('page shown'))
  document.addEventListener('resume', () => onShown('page resumed'))
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) onShown('page restored', true)
  })
}

export function liveProbe(ms = LATE_MS): Promise<boolean> {
  if (!welcomed() || !hostPings) return Promise.resolve(welcomed())
  sendPings(Date.now())
  const n = pingSeq
  const t0 = Date.now()
  return new Promise((resolve) => {
    const check = (): void => {
      if (heard.main >= n && heard.window >= n) return resolve(true)
      if (Date.now() - t0 > ms || !welcomed()) return resolve(false)
      setTimeout(check, 100)
    }
    check()
  })
}

export function liveSynced(): void {
  resynced = true
  maybeBack()
}

export function liveSyncFailed(why: string): void {
  if (state === 'online') fail(outage ?? 'stuck', `resync failed: ${why}`)
}

async function sendHello(ws: WebSocket, code: E2ePairCode | null): Promise<void> {
  const known = pairing
  const id = code ? (identity ??= await loadIdentity(code.hostId, true)) : identity
  if (!id) throw new Error('no key on this phone')
  const hostId = code ? code.hostId : (known?.hostId ?? '')
  const hs = code
    ? await startPhoneHandshake({ mode: 'pair', hostId, identity: id, secret: code.secret, commit: code.commit })
    : await startPhoneHandshake({ mode: 'resume', hostId, identity: id, pinned: known?.macPub })
  if (socket !== ws || ws.readyState !== WebSocket.OPEN) return
  handshake = { ws, mode: code ? 'pair' : 'resume', finish: hs.finish, code }
  ws.send(
    encodeRemote({
      t: 'hello',
      role: 'phone',
      hostId,
      ...(code ? { pairing: true } : {}),
      e2e: hs.hello,
      ...(phoneConfig?.account && ticketNow() ? { ticket: ticketNow()!.raw } : {}),
      installId: installId(),
      protocol: REMOTE_PROTOCOL,
      minHost: REMOTE_PROTOCOL,
      ua: navigator.userAgent,
      device: deviceLabel()
    })
  )
}

export function stopConnecting(why: string): void {
  if (halted) return
  halted = 'cancelled'
  dropSocketQuietly()
  console.info(`[remote] stopped connecting: ${why}; no more attempts until Try again`)
  setState(state === 'online' ? 'offline' : state, stateDetail)
}

export function checkNetworkAgain(why: string): boolean {
  if (state !== 'away') return false
  if (socket && awayCheck === 'checking' && Date.now() - connectAt < AWAY_CHECK_MS) return true
  dropSocketQuietly()
  halted = ''
  awayCheck = 'checking'
  console.info(`[remote] checking the network again: ${why}`)
  setState('away', stateDetail)
  connect()
  return true
}

export function tryAgain(why: string): void {
  if (socket && !halted && !deadSocket()) return
  dropSocketQuietly()
  dropDeadLink()
  halted = ''
  console.info(`[remote] trying again, one attempt: ${why}`)
  setState('connecting')
  connect()
}

function rekey(why: string): void {
  dropSocketQuietly()
  console.info(`[remote] connecting fresh: ${why}`)
  connect()
}

function noConfig(): void {
  halted = 'failed'
  if (!outage) outageAt = Date.now()
  outage = 'relay'
  console.warn("[remote] this page couldn't read its phone config, so it has no relay to connect to")
  setState('offline')
}

export function connect(): void {
  if (halted) return
  if (!storeReady) {
    if (storeWaiting) return
    storeWaiting = true
    void loadStore().then(() => {
      storeWaiting = false
      if (!socket) connect()
    })
    return
  }
  if (!phoneConfig) {
    if (configWaiting) return
    configWaiting = true
    void loadConfig().then(async (c) => {
      if (c?.account) await loadTicket()
      configWaiting = false
      phoneConfig = c
      if (c) connect()
      else noConfig()
    })
    return
  }
  const code = pairCodeInUrl()
  if (cryptoProblem) {
    setState('unpaired', cryptoProblem)
    return
  }
  if (!code && !pairing) {
    setState('unpaired', lostKey ? LOST_KEY_TEXT : getMac(pathHostId())?.removed?.why ?? '')
    return
  }
  const pathHost = /^\/h\/([a-z0-9]{6,32})\//.exec(location.pathname)?.[1]
  if (code && pathHost && pathHost !== code.hostId) {
    location.replace(`/h/${code.hostId}/${location.hash}`)
    return
  }
  if (phoneConfig.account && !ticketNow()) {
    setState('signin', '')
    goSignIn('this phone has no ticket for the relay')
    return
  }
  fit = null
  startWatch()
  const ws = new WebSocket(phoneConfig.relay)
  socket = ws
  welcomedWs = null
  stale = ''
  silentClose = 0
  connectAt = Date.now()
  quietSince = connectAt
  openedAt = 0
  restartPings()
  endSession()
  if (state !== 'unpaired' && state !== 'away') setState('connecting')
  ws.binaryType = 'arraybuffer'
  ws.onopen = () => {
    if (socket !== ws) return
    openedAt = Date.now()
    flushLogs()
    sendHello(ws, code).catch((e: Error) => {
      if (socket !== ws) return
      console.error(`[remote] e2e: couldn't start the handshake: ${e.message}`)
      dropSocketQuietly()
      setState('unpaired', `This phone couldn't start an encrypted link to your desktop (${e.message}).`)
    })
  }
  ws.onmessage = (e) => {
    const data = e.data as unknown
    inbound = inbound.then(() => onWire(ws, data)).catch((err: Error) => console.error(`[remote] frame handling failed: ${err.message}`))
  }
  ws.onclose = (e) => {
    if (socket !== ws) return
    socket = null
    welcomedWs = null
    endSession()
    if (e.code === 4009) console.warn('[remote] e2e: the Mac closed this session after a frame failed its integrity check')
    failCalls(outage ? OUTAGE_TEXT[outage] : 'Lost the connection to the desktop', !!outage)
    if (state === 'busy') return
    if (e.code === 4006) {
      console.warn('[remote] this session was replaced by a newer one from the same phone')
      setState('replaced', '')
      return
    }
    if (state === 'unpaired' && (pairStopped || (!pairing && !pairCodeInUrl()))) return
    if (state === 'away' && awayCheck === 'checking') {
      awayCheck = 'error'
      awayCheckedAt = Date.now()
      console.warn(`[remote] couldn't check the network again: the socket to the relay closed (${e.code})`)
      setState('away', stateDetail)
      return
    }
    if (ACCOUNT_CODES.has(state)) return
    if (e.code === 4004) hostGone = true
    fail(lostKind(), `the socket to the relay closed (${e.code})`)
  }
  ws.onerror = () => {}
}

export function socketAlive(): boolean {
  noteStopped(Date.now())
  return !!socket && socket.readyState === WebSocket.OPEN && state === 'online' && !stale
}

export function hasPairing(): boolean {
  return !!(storeReady ? pairing : readMark()) || !!pairCodeInUrl()
}

export function withQuietCalls<T>(fn: () => T): T {
  quiet++
  try {
    return fn()
  } finally {
    quiet--
  }
}

export function invokeRemote<T = unknown>(ch: string, ...args: unknown[]): Promise<T> {
  return call('invoke', ch, args) as Promise<T>
}

function askVideo(sig: unknown): void {
  const m = sig as { type?: string; session?: string; policy?: string } | null
  if (m?.type !== 'hello' || typeof m.session !== 'string' || state !== 'online') return
  rawSend(encodeRemote({ t: 'video-ask', session: m.session, ...(m.policy === 'relay' ? { policy: 'relay' } : {}) }))
}

export const wsTransport: IpcTransport = {
  invoke: (ch, ...args) => call('invoke', ch, args),
  send: (ch, ...args) => {
    if (quiet > 0) {
      console.warn(`[remote] dropped send ${ch} during mirror hydration`)
      return
    }
    if (ch === 'rvideo:signal') askVideo(args[0])
    sendRpc({ t: 'rpc', id: nextId++, kind: 'send', ch, args })
  },
  sendSync: (ch) => {
    console.warn(`[remote] sendSync ${ch} is not available on the phone`)
    return undefined
  },
  on: (ch, listener) => {
    let set = listeners.get(ch)
    if (!set) {
      set = new Set()
      listeners.set(ch, set)
    }
    set.add(listener)
    return () => {
      set.delete(listener)
    }
  }
}

function stringify(v: unknown): string {
  if (typeof v === 'string') return v
  if (v instanceof Error) return `${v.name}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

export function installConsoleForwarding(): void {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[level].bind(console)
    console[level] = (...args: unknown[]) => {
      orig(...args)
      const line = args.map(stringify).join(' ').slice(0, 4000)
      toHost(level, line)
      if (state === 'online' && welcomed()) return
      const text = encodeRemote({ t: 'log', level, text: line, at: Date.now() })
      if (!rawSend(text)) {
        logQueue.push(text)
        if (logQueue.length > MAX_QUEUED_LOGS) logQueue.shift()
      }
    }
  }
  window.addEventListener('error', (e) => {
    if (String(e.message).startsWith('ResizeObserver loop')) return
    console.error(`[uncaught] ${e.message} at ${e.filename}:${e.lineno}`)
  })
  window.addEventListener('unhandledrejection', (e) => {
    const r = e.reason as { name?: string; message?: string } | undefined
    if (r?.name === 'Canceled' && r.message === 'Canceled') {
      e.preventDefault()
      return
    }
    if (r instanceof Outaged || r instanceof CallTimedOut) {
      e.preventDefault()
      console.info(`[remote] a call nobody waited for failed: ${r.message}`)
      return
    }
    console.error('[unhandled rejection]', e.reason)
  })
}

export function installTapTracking(): void {
  document.addEventListener(
    'click',
    (e) => {
      const hit = e.target instanceof Element ? e.target.closest<HTMLElement>(TAP_SELECTOR) : null
      const t = hit && !hit.closest('[data-own-pending]') ? hit : null
      tapTarget = t
      setTimeout(() => {
        if (tapTarget === t) tapTarget = null
      }, 0)
    },
    true
  )
}
