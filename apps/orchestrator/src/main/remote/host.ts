import { app, BrowserWindow, ipcMain, type WebContents } from 'electron'
import { createHash, createPrivateKey, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, hostname, networkInterfaces } from 'node:os'
import { join } from 'node:path'
import type { RateLimitWindow, UsageRemaining, UsageSnapshot, WindowSession } from '@shared/api'
import {
  REMOTE_STORE_ACTIONS,
  REMOTE_DESKTOP_CALLS,
  REMOTE_HOST_CALLS,
  decodeRemote,
  encodeRemote,
  type RemoteHello,
  type RemoteForgetResult,
  type RemoteMediaRead,
  type RemotePairAnswer,
  type RemotePairAsk,
  type RemotePairedPhone,
  type RemotePlace,
  type RemoteVideoPlanAsk,
  type RemotePairInfo,
  type RemotePresence,
  type RemoteRpc,
  type RpcKind,
  type RemoteStatus,
  type RemoteStoreAction
} from '@shared/remote-protocol'
import { REMOTE_PROTOCOL } from '@shared/remote-version'
import { loadState } from '../persistence'
import { DEFAULT_SETTINGS } from '@shared/types'
import { insideRoot, openScope, scopeAllows, type OpenScope } from '../open-roots'
import { vetPhoneCall, type PathUse, type PhoneCallContext } from './phone-policy'
import { frontmostWindow, windowIdForWebContents } from '../window/window-manager'
import { ptyOwnerWebContentsId } from '../ipc/pty'
import { tappedInvokeHandler, tappedListeners } from './ipc-tap'
import { claimPtySize, clientOfSender, configurePtySizeOwner, notePtyInput, releaseClient, releasePtySize } from './pty-size-owner'
import { PHONE_WEB, checkPhoneApp, phoneAppCheck, startPhoneWatch, watchesPhoneWeb } from './phone-watch'
import { checkNetworks } from './net-probe'
import { configureTermMirror, termFromPhone, termPhoneLeft } from './term-mirror'
import { remoteVideo } from '../remote-video'
import { censusGauge, censusTrack } from '@shared/census'
import { readMediaChunk, setMediaReadGuard, stopMediaTransfer, vetReportMedia } from './media-read'
import { cacheDir, videoPlan } from './phone-video'
import { videoStill } from './phone-video-still'
import { debugLog } from '@shared/debug-log'
import { onUsageChanged, watchUsage } from '../usage/usage-hub'
import { countTraffic, makeLag, relayLagKbps, relayLagMs } from './link-meter'
import { LinkPeer, deltaKeyOf, type LinkFrame, type LinkPeerDiag } from '@shared/remote-link'
import { WORLD_CHANNEL, worldStore, type WorldBroadcast } from '../unity/world-store'
import { PhonePanelTracker, describePhonePanel, type PhonePanel, type PhonePanelReport, type PhoneShowTarget } from '@shared/phone-panel'
import { TurnTally, type TurnBytes } from '../remote-video/turn-meter'
import type { RvIceServer } from '@shared/remote-video'
import { deviceKind, shortUserAgent } from '@shared/user-agent'
import { isIP } from 'node:net'
import { E2E_SESSION_HARD_MS, E2eError, isHello, readFrame, type E2eHello } from '@shared/remote-e2e'
import { checkPairProof, isMacKey, macCommit, newMacKey, startHostHandshake, type HostE2eSession, type HostHandshake, type MacE2eKey } from './e2e-host'
import { configurePhonePush, onPushResult, phonePushInvoke, type StoredPush } from './phone-push'
import { configurePhoneProjects, phoneProjectsInvoke } from './phone-projects'
import { hostKind } from './host-kind'
import { attachChunk } from './phone-attach'
import { openText, sealText } from './host-seal'
import { cleanRestorePrompts, describeRestorePrompts, type ClaudeRestorePromptState } from '@shared/claude-sessions'

interface PairedPhone {
  phoneId: string
  pub?: string
  pairedAt: number
  ua?: string
  device?: string
  pairedEmail?: string
  pairedFrom?: RemotePlace
  email?: string
  lastSeenAt?: number
  lastFrom?: RemotePlace
  push?: StoredPush
}

interface HostKey {
  x: string
  d: string
}

interface HostFile {
  hostId: string
  key: HostKey
  e2e: MacE2eKey
  phones: PairedPhone[]
  enabled?: boolean
}

interface Phone {
  cid: string
  phoneId: string
  installId: string
  ua: string
  device: string
  connected: boolean
  link: LinkPeer
  e2e: HostE2eSession
  dc: string | null
  tuners: Set<string>
  inspectors: Set<string>
  worlds: Set<string>
}

type RelayInbound =
  | { t: 'welcome'; web?: string; ping?: number }
  | { t: 'pong' }
  | { t: 'challenge'; nonce: string }
  | { t: 'refused'; reason?: string }
  | { t: 'phone-hello'; cid: string; pairing?: boolean; e2e?: unknown; ua?: string; device?: string; installId?: string; ip?: string; country?: string; region?: string; city?: string; email?: string }
  | { t: 'phone-hs'; cid: string; e2e?: unknown }
  | { t: 'phone-left'; cid: string }
  | { t: 'video-grant'; cid: string; session: string; iceServers?: RvIceServer[]; iceTransportPolicy?: 'relay' | 'all' }
  | { t: 'video-deny'; cid: string; session: string }
  | { t: 'push-result'; id: string; status?: number; gone?: boolean; error?: string }
  | { t: 'net-probe'; token?: string; path?: string }
  | { t: 'rpc'; cid: string }

const SKIPPED_EVENTS = new Set(['pty:data', 'pty:sizeOwner', 'pty:focusAgent', 'tuner:frame', 'unity:sharedFrame', 'agent-exec:request', 'app:quit-requested', 'app:quit-dismissed', 'usage:changed'])
const SKIPPED_EVENT_PREFIXES = ['gpu:', 'video:', 'remote:']
const PAIR_CODE_TTL_MS = 10 * 60_000
const HOST_ID_LENGTH = 16
const STORE_ACTION_TIMEOUT_MS = 5000
const RECONNECT_MIN_MS = 1000
const PRODUCTION_RELAY_URL = 'wss://relay.saturaspace.com/ws'
const RECONNECT_MAX_MS = 5000
const PHONE_LOG_BURST = 60
const PHONE_LOG_PER_SEC = 20
const RELAY_PING_MS = 10_000
const RELAY_SILENT_MS = 20_000
const SLOW_WINDOW_MS = 1500
const LINK_TICK_MS = 500
const DELTA_ARGS_MAX = 400
const PHONE_SCOPED = new Set(['tuner:state', 'tuner:live', 'tunerInspector:capture'])
const TURN_FLUSH_MS = 10_000
const LINK_MAX_BODY = 16 * 1024 * 1024
const REPLACED_RECONNECT_MS = 30_000
const REFUSED_RECONNECT_MS = 60_000
const DESKTOP_ONLY = 'Only Satura on the desktop can manage paired phones'
const PAIR_ASK_MS = 60_000
const PAIR_SECRET_BYTES = 8
const PAIR_FAILS_MAX = 3
const HANDSHAKE_MS = 15_000
const VIDEO_GRANT_MS = 10_000

type PhoneHello = Extract<RelayInbound, { t: 'phone-hello' }>

interface PendingHandshake {
  cid: string
  hello: PhoneHello
  hs: HostHandshake
  mode: E2eHello['mode']
  timer: NodeJS.Timeout
}

interface PendingVideo {
  phone: Phone
  m: RemoteRpc
  timer: NodeJS.Timeout
}

interface PairAsk {
  cid: string
  hello: PhoneHello
  ask: RemotePairAsk
  timer: NodeJS.Timeout
  phoneId: string
  pub: string
  session: HostE2eSession
}

const phones = new Map<string, Phone>()
const pairAsks = new Map<string, PairAsk>()
const pairCodes = new Map<string, number>()
const pairFails = new Map<string, number>()
const handshakes = new Map<string, PendingHandshake>()
const pendingVideo = new Map<string, PendingVideo>()
const videoGrants = new Map<string, { iceServers?: RvIceServer[]; iceTransportPolicy?: 'relay' | 'all'; at: number }>()
let plainRpcSeen = false
const pendingStoreActions = new Map<number, { resolve: (value: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>()
const sessions = new Map<number, WindowSession>()
const restorePrompts = new Map<number, ClaudeRestorePromptState[]>()
let saidRestore = ''
let socket: WebSocket | null = null
let relayUrl: string | null = null
let relayWeb: string | null = null
let connected = false
let reconnectMs = RECONNECT_MIN_MS
let reconnectTimer: NodeJS.Timeout | null = null
let hostFile: HostFile | null = null
let lastPairCode: string | null = null
let nextStoreReq = 1
let started = false
let phoneLogTokens = PHONE_LOG_BURST
let phoneLogAt = Date.now()
let phoneLogDropped = 0
const panels = new PhonePanelTracker()
const panelWaiters = new Set<() => void>()
let panelSweep: NodeJS.Timeout | null = null
let sentPresence = ''
let sentPanel = ''
let saidPanel = ''
const pairIssuedAt = new Map<string, number>()
const windowWaiters = new Map<string, number>()
let windowProbe: Promise<boolean> | null = null
let windowProbeFailed = false
let relayPing: NodeJS.Timeout | null = null
let relayPingAt = 0
let relayHeardAt = 0
let relayRttMs: number | null = null
let linkTimer: NodeJS.Timeout | null = null
let tapMuted = 0
const phoneOfCid = new Map<string, string>()
const turnTally = new TurnTally()
let turnFlush: NodeJS.Timeout | null = null
censusTrack('remote.phones', phones)
censusTrack('remote.pairCodes', pairCodes)
censusTrack('remote.handshakes', handshakes)
censusTrack('remote.pendingVideo', pendingVideo)
censusTrack('remote.videoGrants', videoGrants)
censusTrack('remote.pairAsks', pairAsks)
censusTrack('remote.pairIssuedAt', pairIssuedAt)
censusTrack('remote.windowWaiters', windowWaiters)
censusTrack('remote.pendingStoreActions', pendingStoreActions)
censusTrack('remote.sessions', sessions)
censusTrack('remote.restorePrompts', restorePrompts)
censusTrack('remote.panelWaiters', panelWaiters)
censusGauge('remote.panelSweep', () => (panelSweep ? 1 : 0))

function log(line: string): void {
  console.log(`[remote] ${line}`)
}

function hostFilePath(): string {
  return join(app.getPath('userData'), 'remote-host.json')
}

function hostIdForKey(x: string): string {
  return createHash('sha256').update(Buffer.from(x, 'base64url')).digest('hex').slice(0, HOST_ID_LENGTH)
}

function newHostKey(): HostKey {
  const jwk = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' })
  return { x: String(jwk.x), d: String(jwk.d) }
}

function isHostKey(k: unknown): k is HostKey {
  const key = k as Partial<HostKey> | null
  return typeof key?.x === 'string' && typeof key.d === 'string' && key.x.length === 43 && key.d.length === 43
}

function loadHostFile(): HostFile {
  if (hostFile) return hostFile
  let raw: Partial<HostFile> | null = null
  try {
    raw = JSON.parse(openText(String((JSON.parse(readFileSync(hostFilePath(), 'utf8')) as { sealed?: unknown }).sealed))) as Partial<HostFile>
  } catch {
  }
  if (raw && isHostKey(raw.key) && raw.hostId === hostIdForKey(raw.key.x) && isMacKey(raw.e2e)) {
    hostFile = { hostId: raw.hostId, key: raw.key, e2e: raw.e2e, phones: Array.isArray(raw.phones) ? raw.phones : [], ...(typeof raw.enabled === 'boolean' ? { enabled: raw.enabled } : {}) }
    return hostFile
  }
  const key = newHostKey()
  hostFile = { hostId: hostIdForKey(key.x), key, e2e: newMacKey(), phones: [] }
  log(`made host id ${hostFile.hostId} and this desktop's end-to-end key${existsSync(hostFilePath()) ? ', the old host file could not be opened' : ''}`)
  saveHostFile()
  return hostFile
}

function hostProof(nonce: string): string {
  const file = loadHostFile()
  const key = createPrivateKey({ key: { kty: 'OKP', crv: 'Ed25519', x: file.key.x, d: file.key.d }, format: 'jwk' })
  return sign(null, Buffer.from(`satura-relay-host:${nonce}:${file.hostId}`), key).toString('base64url')
}

function saveHostFile(): void {
  if (!hostFile) return
  try {
    writeFileSync(hostFilePath(), JSON.stringify({ sealed: sealText(JSON.stringify(hostFile)) }), { mode: 0o600 })
    chmodSync(hostFilePath(), 0o600)
  } catch (e) {
    log(`could not save ${hostFilePath()}: ${(e as Error).message}`)
  }
}

function desktopName(): string {
  const dev = process.env.SATURA_DEV_INSTANCE ? process.env.SATURA_REMOTE_HOST_NAME?.trim().slice(0, 60) : ''
  return dev || hostname()
}

function envRelayUrl(): string | undefined {
  return process.env.SATURA_RELAY_URL?.trim() || undefined
}

function remoteEnabled(): boolean {
  const env = envRelayUrl()
  if (env) return env !== 'off'
  const file = loadHostFile()
  return file.enabled ?? file.phones.length > 0
}

function resolveRelayUrl(): string | null {
  if (!remoteEnabled()) return null
  const env = envRelayUrl()
  if (env) return env
  const setting = loadState().settings?.remoteRelayUrl?.trim()
  if (setting) return setting
  return PRODUCTION_RELAY_URL
}

export function setRemoteEnabled(on: boolean): RemoteStatus {
  const file = loadHostFile()
  if (file.enabled !== on) {
    file.enabled = on
    saveHostFile()
  }
  const next = resolveRelayUrl()
  if (next !== relayUrl) {
    disconnectRelay()
    relayUrl = next
    if (relayUrl) {
      log(`connecting to relay ${relayUrl}`)
      connect()
    } else {
      log('relay disabled')
      if (remoteVideo.endOwnedBy(new Set(phoneOfCid.keys()), 'Satura Remote was turned off')) log('closed the phone video session')
    }
  }
  notifyWindows()
  return status()
}

export function newPairCode(): string {
  const now = Date.now()
  const replaced = pairCodes.size
  pairCodes.clear()
  pairIssuedAt.clear()
  pairFails.clear()
  const secret = randomBytes(PAIR_SECRET_BYTES).toString('hex')
  pairCodes.set(secret, now)
  lastPairCode = `${loadHostFile().hostId}:${secret}`
  pairIssuedAt.set(lastPairCode, now)
  log(`pairing code issued (one-time, 10 min, ${PAIR_SECRET_BYTES * 8}-bit secret)${replaced ? `, the older code no longer works` : ''}`)
  return lastPairCode
}

function lanHost(): string {
  const env = process.env.SATURA_RELAY_PUBLIC_HOST?.trim()
  if (env) return env
  const name = hostname()
  if (name && !/^localhost$/i.test(name)) return name.endsWith('.local') ? name : `${name}.local`
  for (const list of Object.values(networkInterfaces()))
    for (const a of list ?? []) if (a.family === 'IPv4' && !a.internal) return a.address
  return 'localhost'
}

function webOrigin(raw: string | undefined | null): string | null {
  try {
    const u = new URL(String(raw ?? '').trim())
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.origin : null
  } catch {
    return null
  }
}

export function phoneRelayUrl(): string | null {
  const explicit = webOrigin(process.env.SATURA_RELAY_PUBLIC_URL)
  if (explicit) return explicit
  if (relayUrl === PRODUCTION_RELAY_URL) return PHONE_WEB
  if (relayWeb) return relayWeb
  if (!relayUrl) return null
  try {
    const u = new URL(relayUrl)
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    if (['localhost', '127.0.0.1', '::1', '[::1]'].includes(u.hostname)) u.hostname = lanHost()
    return u.origin
  } catch {
    return null
  }
}

export function pairLink(code: string): string {
  return `${phoneRelayUrl() ?? ''}/m/#pair=${encodeURIComponent(`${code}:${macCommit(loadHostFile().e2e)}`).replace(/%3A/gi, ':')}`
}

export function pairInfo(): RemotePairInfo | null {
  if (!connected) return null
  const code = newPairCode()
  const relay = phoneRelayUrl() ?? ''
  return { code, relay, link: pairLink(code), expiresAt: (pairIssuedAt.get(code) ?? Date.now()) + PAIR_CODE_TTL_MS }
}

export function presenceList(): RemotePresence[] {
  return panels.presence(Date.now())
}

export function phonePanel(): PhonePanel {
  return panels.view(mirrorSession()?.workspace, Date.now())
}

function toWindows(ch: string, value: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send(ch, value)
}

function pushPanel(why: string): void {
  const view = phonePanel()
  const said = describePhonePanel(view)
  if (said !== saidPanel) {
    saidPanel = said
    log(`phone panel: ${said}${why ? ` (${why})` : ''}`)
  }
  const list = presenceList()
  const listText = JSON.stringify(list)
  if (listText !== sentPresence) {
    sentPresence = listText
    toWindows('remote:presence', list)
  }
  const { heardMs: _heard, ...steady } = view
  const panelText = JSON.stringify(steady)
  if (panelText !== sentPanel) {
    sentPanel = panelText
    toWindows('remote:phonePanel', view)
  }
  for (const w of [...panelWaiters]) w()
  if (!panelSweep && panels.hasReports())
    panelSweep = setInterval(() => {
      if (panels.sweep(Date.now())) pushPanel('the phone stopped reporting')
      if (!panels.hasReports() && panelSweep) {
        clearInterval(panelSweep)
        panelSweep = null
      }
    }, 5000)
}

function notePanel(phone: Phone, report: PhonePanelReport): void {
  if (typeof report.device === 'string' && report.device) phone.device = report.device.slice(0, 60)
  const { changed, resend } = panels.report(phone.cid, report, Date.now())
  if (changed) pushPanel('')
  else for (const w of [...panelWaiters]) w()
  if (resend) {
    log(`phone ${phone.phoneId} is back, asking it again to show ${resend.tabId ?? 'the focused tab'} of workspace ${resend.workspaceId}`)
    phoneEvent(phone, 'remote:showPanel', [resend])
  }
}

export async function showOnPhone(target: PhoneShowTarget, timeoutMs: number, ask = true): Promise<{ shown: boolean; panel: PhonePanel }> {
  const cid = panels.currentCid()
  const phone = cid ? phones.get(cid) : undefined
  if (!phone) return { shown: false, panel: phonePanel() }
  if (panels.shows(target)) {
    if (ask) panels.dropExpected()
    return { shown: true, panel: phonePanel() }
  }
  if (ask) {
    panels.expect(target, Date.now())
    log(`asking phone ${phone.phoneId} (${phone.device}) to show ${target.tabId ?? 'the focused tab'} of workspace ${target.workspaceId}`)
    phoneEvent(phone, 'remote:showPanel', [target])
    pushPanel('')
  }
  const shown = await new Promise<boolean>((resolve) => {
    const done = (ok: boolean): void => {
      clearTimeout(timer)
      panelWaiters.delete(check)
      resolve(ok)
    }
    const check = (): void => {
      if (panels.shows(target)) done(true)
      else if (panels.currentCid() !== cid) done(false)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    panelWaiters.add(check)
    check()
  })
  if (shown && ask) panels.dropExpected()
  return { shown, panel: phonePanel() }
}

function notifyWindows(): void {
  const s = status()
  for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('remote:phones', s)
  notifyPaired()
}

const relayOut = makeLag(relayLagMs, relayLagKbps)
const relayIn = makeLag(relayLagMs, relayLagKbps)

function trafficLabel(m: Record<string, unknown>): string {
  return typeof m.ch === 'string' ? (m.t === 'evt' ? m.ch : `${String(m.t)} ${m.ch}`) : String(m.t ?? '?')
}

function sendRelay(msg: unknown, label?: string): void {
  const ws = socket
  if (!ws || ws.readyState !== WebSocket.OPEN) return
  const text = encodeRemote(msg)
  const m = msg as Record<string, unknown>
  countTraffic('relay', 'out', label ?? trafficLabel(m), text.length)
  relayOut(text.length, () => {
    if (ws.readyState === WebSocket.OPEN) ws.send(text)
  })
}

function relaySealed(phone: Phone, text: string, label: string): boolean {
  const ws = socket
  if (!ws || ws.readyState !== WebSocket.OPEN || phone.e2e.closed) return false
  relayOut(text.length, () => {
    if (ws.readyState !== WebSocket.OPEN || phone.e2e.closed || !phone.connected) return
    const frame = phone.e2e.seal(text, phone.cid)
    countTraffic('relay', 'out', label, frame.byteLength)
    ws.send(frame)
  })
  return true
}

function newPhone(info: Omit<Phone, 'link' | 'dc' | 'tuners' | 'inspectors' | 'worlds'>): Phone {
  const phone = { ...info, dc: null, tuners: new Set<string>(), inspectors: new Set<string>(), worlds: new Set<string>() } as Phone
  phone.link = new LinkPeer({
    name: `calls to phone ${info.cid}`,
    relay: (text, label) => relaySealed(phone, text, label),
    direct: (text, label) => remoteVideo.linkSend(phone.dc, text, label),
    deliver: (m) => void dispatch(phone, m as RemoteRpc),
    loose: (a) => ({ t: 'ack', a, to: phone.cid }),
    log,
    deltas: true,
    stampAlways: false,
    overflow: (why) => dropBackedUp(phone, why),
    broken: (why) => dropBackedUp(phone, why),
    heard: () => remoteVideo.heardFrom(phone.dc),
    maxBody: LINK_MAX_BODY,
    tooBig: (head, bytes) => (head.t === 'res' ? { ...head, ok: false, error: `That is too big to send to the phone (${Math.round(bytes / 1048576)} MB)` } : null)
  })
  return phone
}

export function phoneLinks(): { cid: string; phoneId: string; device: string; dc: string | null; calls: LinkPeerDiag; stats: LinkPeer['stats']; e2e: ReturnType<HostE2eSession['stats']> }[] {
  return [...phones.values()].map((p) => ({ cid: p.cid, phoneId: p.phoneId, device: p.device, dc: p.dc, calls: p.link.diag(), stats: { ...p.link.stats }, e2e: p.e2e.stats() }))
}

function flushTurn(): void {
  if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return
  turnTally.drain((cid, d) => {
    sendRelay({ t: 'turn-usage', cid, tx: d.tx, rx: d.rx, egress: d.egress })
    log(`TURN usage to the relay for ${cid}: ${d.tx} B out, ${d.rx} B in, ${d.egress} B Cloudflare egress`)
    return true
  })
}

export function turnUsageHere(): { sinceStart: TurnBytes; since: number; pendingBytes: number; live: ReturnType<typeof remoteVideo.turnState> } {
  return { sinceStart: { ...turnTally.sinceStart }, since: turnTally.since, pendingBytes: turnTally.pendingBytes(), live: remoteVideo.turnState() }
}

export function relayHttpOrigin(): string | null {
  if (!relayUrl) return null
  try {
    const u = new URL(relayUrl)
    if (u.protocol !== 'wss:' && u.protocol !== 'ws:') return null
    u.protocol = u.protocol === 'wss:' ? 'https:' : 'http:'
    return u.origin
  } catch {
    return null
  }
}

function relayLink(): { open: boolean; rttMs: number | null } {
  return { open: connected && !!socket && socket.readyState === WebSocket.OPEN, rttMs: relayRttMs }
}

function dropBackedUp(phone: Phone, why: string): void {
  if (!phone.connected) return
  log(`phone ${phone.phoneId} link out of step (${why}), making it connect again`)
  setTimeout(() => {
    if (!phones.has(phone.cid)) return
    forgetPhone(phone.cid)
    sendRelay({ t: 'phone-kick', cid: phone.cid, reason: 'resync' })
    notifyWindows()
  }, 0)
}

function phoneEvent(phone: Phone, ch: string, args: unknown[]): void {
  if (!phone.connected) return
  phone.link.send({ t: 'evt', ch, to: phone.cid }, 'args', args, deltaKeyOf(ch, args), ch)
}

function phoneReply(phone: Phone, m: RemoteRpc, ok: boolean, value?: unknown, error?: string): void {
  if (!phone.connected) return
  let key: string | undefined
  if (ok && value !== undefined) {
    const argsText = encodeRemote(m.args ?? [])
    if (argsText.length <= DELTA_ARGS_MAX) key = `r:${m.ch}:${argsText}`
  }
  phone.link.send({ t: 'res', id: m.id, ok, ...(error ? { error } : {}), to: phone.cid }, 'value', value, key, `res ${m.ch}`)
}

function phoneWants(phone: Phone, ch: string, args: unknown[]): boolean {
  if (ch === WORLD_CHANNEL) return phone.worlds.size === 0
  if (!PHONE_SCOPED.has(ch)) return true
  const a = (args[0] ?? {}) as { session?: unknown; state?: { session?: unknown } }
  if (ch === 'tunerInspector:capture') return phone.inspectors.has(String(a.session ?? ''))
  return phone.tuners.has(String(a.session ?? a.state?.session ?? ''))
}

function broadcast(ch: string, args: unknown[]): void {
  for (const phone of phones.values()) if (phoneWants(phone, ch, args)) phoneEvent(phone, ch, args)
}

export function toPhones(ch: string, args: unknown[]): number {
  let n = 0
  for (const phone of phones.values()) {
    if (!phone.connected) continue
    phoneEvent(phone, ch, args)
    n++
  }
  return n
}

export function desktopOnly(fn: () => void): void {
  tapMuted++
  try {
    fn()
  } finally {
    tapMuted--
  }
}

function noteScope(phone: Phone, ch: string, args: unknown[]): void {
  const a = (args[0] ?? {}) as { session?: unknown; visible?: unknown; projectPath?: unknown }
  if (ch === 'unity:getWorld' && typeof a.projectPath === 'string' && a.projectPath) {
    const pp = worldStore.resolveProject(a.projectPath)
    if (!phone.worlds.has(pp)) log(`phone ${phone.phoneId} follows the Unity world of ${pp}`)
    phone.worlds.add(pp)
  }
  const session = typeof a.session === 'string' ? a.session : ''
  if (!session) return
  if (ch === 'tuner:attach' || ch === 'tuner:start') phone.tuners.add(session)
  else if (ch === 'tuner:visibility' && a.visible === false) phone.tuners.delete(session)
  else if (ch === 'tunerInspector:open') phone.inspectors.add(session)
  else if (ch === 'tunerInspector:close') phone.inspectors.delete(session)
}

function onLinkMessage(session: string, text: string): void {
  const phone = [...phones.values()].find((p) => p.dc === session)
  if (!phone) return
  let m: LinkFrame
  try {
    m = decodeRemote<LinkFrame>(text)
  } catch {
    return
  }
  phone.link.receive(m, 'direct')
}

function onLinkClosed(session: string): void {
  for (const phone of phones.values()) {
    if (phone.dc !== session) continue
    phone.dc = null
    phone.link.setDirect(false, 'the data channel closed')
  }
}

function bindLink(phone: Phone, session: string): { ok: true } {
  const owner = remoteVideo.linkOwner(session)
  if (owner === null) throw new Error('That data channel is not open on the desktop')
  const ownerPhone = owner ? phoneOfCid.get(owner) : undefined
  if (ownerPhone && ownerPhone !== phone.phoneId) throw new Error('That data channel belongs to another phone')
  for (const p of phones.values()) if (p !== phone && p.dc === session) {
    p.dc = null
    p.link.setDirect(false, 'another session took the data channel')
  }
  phone.dc = session
  phone.link.setDirect(true, `phone ${phone.phoneId} bound data channel ${session}`)
  return { ok: true }
}

function startLinkTicks(): void {
  if (linkTimer) return
  linkTimer = setInterval(() => {
    if (!phones.size) {
      if (linkTimer) clearInterval(linkTimer)
      linkTimer = null
      return
    }
    for (const p of [...phones.values()]) {
      if (Date.now() - p.e2e.startedAt > E2E_SESSION_HARD_MS) {
        log(`phone ${p.phoneId} kept one end-to-end session for ${Math.round(E2E_SESSION_HARD_MS / 3600_000)} h, making it connect with fresh keys`)
        dropBackedUp(p, 'session keys too old')
        continue
      }
      p.link.tick()
    }
  }, LINK_TICK_MS)
  linkTimer.unref()
}

function pushWorld(projectPath: string, event: WorldBroadcast): void {
  for (const phone of phones.values()) {
    if (!phone.worlds.has(projectPath)) continue
    phoneEvent(phone, WORLD_CHANNEL, [{ ...event, projectPath, id: '' }])
  }
}

function usageLine(s: UsageSnapshot): string {
  const windows = (u: UsageRemaining): string =>
    [u.session, u.weekly, ...(u.weeklyScoped ?? [])]
      .filter((w): w is RateLimitWindow => !!w)
      .map((w) => `${w.usedPercent}% used${w.resetsAt ? ` until ${new Date(w.resetsAt).toISOString()}` : ''}`)
      .join(', ')
  const line = s.providers.map((p) => {
    const u = s.usage[p]
    const state = u ? `${u.status}${u.stale ? ' stale' : ''}${windows(u) ? ` ${windows(u)}` : ''}${u.error ? ` (${u.error})` : ''}` : 'no answer yet'
    return `${p} ${s.checking.includes(p) ? 'checking, ' : ''}${state}`
  })
  return line.join('; ') || 'every agent hidden'
}

function pushUsage(s: UsageSnapshot): void {
  if (phones.size === 0) return
  debugLog(`[remote] usage to the phone: ${usageLine(s)}`)
  broadcast('usage:changed', [s])
}

function mirrorWebContents(): WebContents | null {
  const win = frontmostWindow()
  return win && !win.isDestroyed() ? win.webContents : null
}

function mirrorSession(): WindowSession | null {
  const wc = mirrorWebContents()
  const s = wc ? sessions.get(wc.id) : undefined
  return s ? { workspace: s.workspace, files: s.files } : null
}

function mirrorRestorePrompts(): ClaudeRestorePromptState[] {
  const wc = mirrorWebContents()
  return (wc ? restorePrompts.get(wc.id) : undefined) ?? []
}

function recordRestorePrompts(wcId: number, raw: unknown): void {
  if (!windowIdForWebContents(wcId)) return
  const list = cleanRestorePrompts(raw)
  if (list.length) restorePrompts.set(wcId, list)
  else restorePrompts.delete(wcId)
  if (mirrorWebContents()?.id !== wcId) return
  const said = describeRestorePrompts(list)
  if (said !== saidRestore) {
    saidRestore = said
    log(`Claude restore prompts on the desktop: ${said}${phones.size ? `, sent to ${phones.size} phone(s)` : ', no phone connected'}`)
  }
  broadcast('remote:restorePrompts', [list])
}

function fakeSender(phone: Phone): WebContents {
  const wc = mirrorWebContents()
  const self: Record<string, unknown> = {
    id: wc?.id ?? -1,
    remote: true,
    cid: phone.cid,
    isDestroyed: () => !phone.connected,
    send: (ch: string, ...args: unknown[]) => phoneEvent(phone, ch, args),
    on: () => self,
    once: () => self,
    off: () => self,
    removeListener: () => self,
    getURL: () => 'remote://phone',
    getType: () => 'remote'
  }
  return self as unknown as WebContents
}

function fakeEvent(phone: Phone): Record<string, unknown> {
  const sender = fakeSender(phone)
  return {
    sender,
    senderFrame: null,
    frameId: -1,
    processId: -1,
    ports: [],
    returnValue: undefined,
    preventDefault: () => {},
    reply: (ch: string, ...args: unknown[]) => sender.send(ch, ...args)
  }
}

const scopeCache: { at: number; scope: OpenScope | null; verdicts: Map<string, boolean> } = { at: 0, scope: null, verdicts: new Map() }
const SCOPE_TTL_MS = 1000
const blockedSeen = new Set<string>()

function freshScope(): typeof scopeCache {
  const now = Date.now()
  if (!scopeCache.scope || now - scopeCache.at > SCOPE_TTL_MS) {
    scopeCache.scope = openScope()
    scopeCache.at = now
    scopeCache.verdicts.clear()
  }
  return scopeCache
}

function phoneOffLimits(path: string, use: PathUse): boolean {
  if (use === 'media' && insideRoot(cacheDir(), path)) return false
  return insideRoot(app.getPath('userData'), path) || insideRoot(join(homedir(), '.satura'), path)
}

export function phoneMayUse(path: string, use: PathUse): boolean {
  const cache = freshScope()
  const key = `${use}\0${path}`
  const hit = cache.verdicts.get(key)
  if (hit !== undefined) return hit
  const ok = !phoneOffLimits(path, use) && scopeAllows(cache.scope as OpenScope, path, use, cacheDir())
  cache.verdicts.set(key, ok)
  return ok
}

const phoneContext: PhoneCallContext = {
  inside: phoneMayUse,
  ptyExists: (id) => ptyOwnerWebContentsId(id) !== undefined,
  settings: () => ({ ...DEFAULT_SETTINGS, ...loadState().settings })
}

function refuse(phone: Phone, m: RemoteRpc, reason: string, onlyOnce: boolean): void {
  const line = `phone ${phone.phoneId} ${m.kind} ${m.ch} refused: ${reason}`
  if (!onlyOnce) return log(line)
  debugLog(`[remote] ${line}`)
  if (blockedSeen.has(m.ch)) return
  blockedSeen.add(m.ch)
  log(`${line} (logged once per channel)`)
}

function runStoreAction(action: RemoteStoreAction, args: unknown[], hostCall = false, timeoutMs = STORE_ACTION_TIMEOUT_MS): Promise<unknown> {
  const wc = mirrorWebContents()
  if (!wc) return Promise.reject(new Error('No Satura window is open'))
  if (!(hostCall && REMOTE_HOST_CALLS.includes(action)) && !REMOTE_STORE_ACTIONS.includes(action) && !REMOTE_DESKTOP_CALLS.includes(action)) return Promise.reject(new Error(`Unknown action ${action}`))
  const reqId = nextStoreReq++
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingStoreActions.delete(reqId)
      reject(new Error("The Satura window didn't answer"))
    }, timeoutMs)
    pendingStoreActions.set(reqId, { resolve, reject, timer })
    wc.send('remote:storeAction', { reqId, action, args, at: Date.now(), ttl: timeoutMs })
  })
}

async function remoteInvoke(ch: string, args: unknown[]): Promise<unknown> {
  if (ch === 'remote:hello') {
    const hello: RemoteHello = {
      hostName: desktopName(),
      version: app.getVersion(),
      session: mirrorSession(),
      phoneLogs: process.env.SATURA_REMOTE_PHONE_LOGS === 'all' ? 'all' : 'errors',
      kind: await hostKind(),
      restorePrompts: mirrorRestorePrompts()
    }
    return hello
  }
  if (ch === 'remote:storeAction') {
    const req = (args[0] ?? {}) as { action: RemoteStoreAction; args?: unknown[] }
    const value = await runStoreAction(req.action, Array.isArray(req.args) ? req.args : [])
    if (REMOTE_DESKTOP_CALLS.includes(req.action)) return { session: null, value }
    return { session: mirrorSession() }
  }
  if (ch === 'remote:status') return { ...status(), pairCode: null }
  if (ch === 'remote:readMedia') return readMediaChunk(args[0] as RemoteMediaRead)
  if (ch === 'remote:attach') return attachChunk(args[0])
  if (ch === 'remote:mediaStop') return stopMediaTransfer(args[0] as { path?: string })
  if (ch === 'remote:videoPlan' || ch === 'remote:videoStill') {
    const ask = (args[0] ?? {}) as RemoteVideoPlanAsk
    vetReportMedia(ask.report, String(ask.path ?? ''))
    return ch === 'remote:videoPlan' ? videoPlan(ask) : videoStill(ask)
  }
  if (ch.startsWith('remote:projects:')) {
    const value = await phoneProjectsInvoke(ch, args)
    if (value !== undefined) return value
  }
  throw new Error(`No remote handler for ${ch}`)
}

function probeWindow(phone: Phone, n: number): void {
  const wc = mirrorWebContents()
  if (!wc) {
    phoneEvent(phone, 'remote:pong', [{ n, window: false }])
    return
  }
  windowWaiters.set(phone.cid, n)
  if (windowProbe) return
  const started = Date.now()
  const probe = wc.executeJavaScript('0').then(
    () => true,
    () => false
  )
  windowProbe = probe
  void probe.then((ok) => {
    if (windowProbe === probe) windowProbe = null
    const ms = Date.now() - started
    if (ms > SLOW_WINDOW_MS) log(`the Satura window answered the phone's ping after ${ms} ms`)
    const waiting = [...windowWaiters]
    windowWaiters.clear()
    if (!ok !== windowProbeFailed) log(ok ? "the Satura window runs the phone's ping again" : "the Satura window couldn't run the phone's ping")
    windowProbeFailed = !ok
    if (!ok) return
    for (const [cid, latest] of waiting) {
      const p = phones.get(cid)
      if (p) phoneEvent(p, 'remote:pong', [{ n: latest, window: true }])
    }
  })
}

function phoneInvoke(phone: Phone, ch: string, args: unknown[]): unknown {
  if (ch === 'remote:ping') {
    probeWindow(phone, Number((args[0] as { n?: number } | undefined)?.n) || 0)
    return true
  }
  if (ch === 'remote:ptyWrite') {
    const req = (args[0] ?? {}) as { id?: string; data?: string }
    const id = String(req.id ?? '')
    if (!id || ptyOwnerWebContentsId(id) === undefined) throw new Error('That terminal is not running on the desktop')
    const event = fakeEvent(phone)
    for (const l of tappedListeners('pty:write')) l(event, { id, data: String(req.data ?? '') })
    return true
  }
  if (ch === 'remote:panelReport' || ch === 'remote:presence') {
    const req = (args[0] ?? {}) as PhonePanelReport
    notePanel(phone, req && typeof req === 'object' ? req : {})
    return true
  }
  if (ch === 'remote:claimPty') {
    const id = String((args[0] as { id?: string } | undefined)?.id ?? '')
    if (!id || ptyOwnerWebContentsId(id) === undefined) throw new Error('That terminal is not running on the desktop')
    claimPtySize(id, phone.cid, 'opened on the phone')
    return true
  }
  if (ch === 'remote:link') return bindLink(phone, String((args[0] as { session?: string } | undefined)?.session ?? ''))
  if (ch.startsWith('remote:push:')) {
    const value = phonePushInvoke(phone.phoneId, ch, ch === 'remote:push:test' ? [{ from: desktopName() }] : args)
    if (value !== undefined) return value
  }
  if (ch === 'remote:releasePty') {
    const id = String((args[0] as { id?: string } | undefined)?.id ?? '')
    if (id) releasePtySize(id, phone.cid, 'closed on the phone')
    return true
  }
  return undefined
}

function phoneLog(phone: Phone, args: unknown[]): void {
  const now = Date.now()
  phoneLogTokens = Math.min(PHONE_LOG_BURST, phoneLogTokens + ((now - phoneLogAt) / 1000) * PHONE_LOG_PER_SEC)
  phoneLogAt = now
  if (phoneLogTokens < 1) {
    phoneLogDropped++
    return
  }
  phoneLogTokens--
  const req = (args[0] ?? {}) as { level?: string; text?: string }
  const level = String(req.level ?? 'log').slice(0, 8)
  const text = String(req.text ?? '').slice(0, 4000)
  if (phoneLogDropped) {
    debugLog(`[remote-phone] ${phone.device || phone.phoneId}: ${phoneLogDropped} lines dropped (rate limit)`)
    phoneLogDropped = 0
  }
  if (level === 'error' || level === 'warn') console.log(`[remote-phone] ${level}: ${text}`)
  else debugLog(`[remote-phone] ${level}: ${text}`)
}

const faults = new Map<string, 'refuse' | 'stall'>()

export function setRemoteFaults(next: Record<string, unknown>): Record<string, string> {
  faults.clear()
  for (const [k, v] of Object.entries(next)) if (v === 'refuse' || v === 'stall') faults.set(k, v)
  if (faults.size) log(`test faults on phone calls: ${[...faults].map(([k, v]) => `${k}=${v}`).join(', ')}`)
  return Object.fromEntries(faults)
}

function faultFor(m: RemoteRpc, args: unknown[]): 'refuse' | 'stall' | null {
  if (!faults.size) return null
  const action = m.ch === 'remote:storeAction' ? String((args[0] as { action?: unknown } | undefined)?.action ?? '') : ''
  return faults.get(m.ch) ?? (action ? faults.get(`store:${action}`) : undefined) ?? null
}

async function dispatch(phone: Phone, m: RemoteRpc): Promise<void> {
  if (heldForGrant(phone, m)) return
  if (m.ch === 'remote:log') return phoneLog(phone, Array.isArray(m.args) ? m.args : [])
  if (m.ch === 'remote:term') return termFromPhone(phone.cid, Array.isArray(m.args) ? m.args[0] : null)
  const reply = (ok: boolean, value?: unknown, error?: string): void => {
    if (m.kind !== 'send') phoneReply(phone, m, ok, value, error)
  }
  const args = Array.isArray(m.args) ? m.args : []
  noteScope(phone, m.ch, args)
  try {
    if (m.ch.startsWith('remote:') && m.kind !== 'invoke') {
      refuse(phone, m, 'only invoke calls reach remote channels', true)
      reply(false, undefined, "You can't do that from the phone yet")
      return
    }
    const verdict = vetPhoneCall(m.ch, args, phoneContext)
    if (!verdict.ok) {
      refuse(phone, m, verdict.reason, !!verdict.blocked)
      reply(false, undefined, verdict.blocked ? "You can't do that from the phone yet" : verdict.reason)
      return
    }
    const vetted = verdict.args
    const fault = faultFor(m, vetted)
    if (fault) {
      log(`phone ${phone.phoneId} ${m.kind} ${m.ch} ${fault === 'refuse' ? 'refused' : 'left unanswered'} by a remote.fault test fault`)
      if (fault === 'refuse') reply(false, undefined, 'The desktop refused this on purpose (remote.fault test)')
      return
    }
    if (m.ch.startsWith('remote:')) {
      const direct = phoneInvoke(phone, m.ch, vetted)
      reply(true, direct !== undefined ? direct : await remoteInvoke(m.ch, vetted))
      return
    }
    const event = fakeEvent(phone)
    if (m.kind === 'invoke') {
      const handler = tappedInvokeHandler(m.ch)
      if (!handler) throw new Error(`No handler registered for '${m.ch}'`)
      reply(true, await handler(event as never, ...vetted))
      return
    }
    const listeners = tappedListeners(m.ch)
    for (const l of listeners) l(event, ...vetted)
    if (m.kind === 'sendSync') reply(true, event.returnValue)
  } catch (e) {
    reply(false, undefined, (e as Error)?.message ?? String(e))
  }
}

export function macCall(action: RemoteStoreAction, args: unknown[], timeoutMs: number): Promise<unknown> {
  return runStoreAction(action, args, true, timeoutMs)
}

export function simulatePhoneCall(ch: string, args: unknown[], kind: RpcKind = 'invoke'): Promise<{ ok: boolean; value?: unknown; error?: string }> {
  return new Promise((resolve) => {
    const link = {
      send: (frame: { t?: string; ok?: boolean; error?: string }, _field: string, value: unknown) => {
        if (frame.t === 'res') resolve({ ok: !!frame.ok, value, ...(frame.error ? { error: frame.error } : {}) })
      }
    }
    const phone = { cid: 'simulated', phoneId: 'simulated', installId: '', ua: 'handle', device: 'simulated phone', connected: true, dc: null, tuners: new Set(), inspectors: new Set(), worlds: new Set(), link } as unknown as Phone
    void dispatch(phone, { t: 'rpc', id: 1, kind, ch, args }).then(() => {
      if (kind === 'send') resolve({ ok: true })
    })
  })
}

function deviceName(m: { device?: string; ua?: string }): string {
  const named = String(m.device ?? '').trim().slice(0, 60)
  if (named) return named
  const ua = String(m.ua ?? '')
  return /iPad/.test(ua) ? 'an iPad' : /iPhone/.test(ua) ? 'an iPhone' : 'another phone'
}

const phoneLeftListeners = new Set<(cid: string) => void>()
censusTrack('remote.phoneLeftListeners', phoneLeftListeners)

export function onPhoneLeft(cb: (cid: string) => void): () => void {
  phoneLeftListeners.add(cb)
  return () => phoneLeftListeners.delete(cb)
}

function phoneLeft(cid: string): void {
  for (const cb of phoneLeftListeners) {
    try {
      cb(cid)
    } catch (e) {
      log(`phone-left listener failed: ${(e as Error).message}`)
    }
  }
}

function helloEmail(m: { email?: string }): string {
  const e = String(m.email ?? '').trim().toLowerCase()
  return e.length <= 200 && /^[^\s@]+@[^\s@]+$/.test(e) ? e : ''
}

function cleanText(v: unknown, max: number): string {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, max) : ''
}

function placeOfHello(m: { ip?: string; country?: string; region?: string; city?: string }): RemotePlace | undefined {
  const ip = cleanText(m.ip, 64)
  const country = cleanText(m.country, 2).toUpperCase()
  const place: RemotePlace = {
    ...(ip && isIP(ip) ? { ip } : {}),
    ...(/^[A-Z]{2}$/.test(country) && country !== 'XX' ? { country } : {}),
    ...(cleanText(m.region, 80) ? { region: cleanText(m.region, 80) } : {}),
    ...(cleanText(m.city, 80) ? { city: cleanText(m.city, 80) } : {})
  }
  return Object.keys(place).length ? place : undefined
}

function placeText(p: RemotePlace | undefined): string {
  return [[p?.city, p?.country].filter(Boolean).join(', '), p?.ip].filter(Boolean).join(' · ')
}

function seenFacts(m: Extract<RelayInbound, { t: 'phone-hello' }>, at: number): Partial<PairedPhone> {
  const named = String(m.device ?? '').trim().slice(0, 60)
  const email = helloEmail(m)
  const place = placeOfHello(m)
  return { ...(named ? { device: named } : {}), ...(email ? { email } : {}), lastSeenAt: at, ...(place ? { lastFrom: place } : {}) }
}

function pairingFacts(m: Extract<RelayInbound, { t: 'phone-hello' }>, at: number): Partial<PairedPhone> {
  const email = helloEmail(m)
  const place = placeOfHello(m)
  return { ...seenFacts(m, at), ...(email ? { pairedEmail: email } : {}), ...(place ? { pairedFrom: place } : {}) }
}

function noteSeen(phoneId: string, at: number): boolean {
  const known = hostFile?.phones.find((p) => p.phoneId === phoneId)
  if (!known) return false
  known.lastSeenAt = at
  return true
}

function liveSessions(phoneId: string): Phone[] {
  return [...phones.values()].filter((p) => p.phoneId === phoneId)
}

export function pairedPhones(): RemotePairedPhone[] {
  const file = loadHostFile()
  const emails = new Set(file.phones.map((p) => p.email ?? p.pairedEmail).filter((e): e is string => !!e))
  return file.phones.map((p) => {
    const email = p.email ?? p.pairedEmail ?? null
    const online = liveSessions(p.phoneId).length
    return {
      phoneId: p.phoneId,
      device: p.device || deviceKind(p.ua),
      ua: p.ua ?? '',
      uaShort: shortUserAgent(p.ua),
      email,
      pairedEmail: p.pairedEmail ?? null,
      pairedAt: p.pairedAt,
      pairedFrom: p.pairedFrom ?? null,
      lastSeenAt: p.lastSeenAt ?? null,
      lastFrom: p.lastFrom ?? null,
      online,
      newCountry: !!p.pairedFrom?.country && !!p.lastFrom?.country && p.pairedFrom.country !== p.lastFrom.country,
      otherAccount: !!email && [...emails].some((e) => e !== email),
      accountChanged: !!p.pairedEmail && !!p.email && p.pairedEmail !== p.email
    }
  })
}

function notifyPaired(): void {
  toWindows('remote:pairedPhones', pairedPhones())
}

export function forgetPaired(ids: string[] | 'all', why: string): RemoteForgetResult {
  const file = loadHostFile()
  const drop = new Set(ids === 'all' ? file.phones.map((p) => p.phoneId) : ids)
  const removed = file.phones.filter((p) => drop.has(p.phoneId)).map((p) => p.phoneId)
  if (removed.length) {
    if (file.enabled === undefined) file.enabled = file.phones.length > 0
    file.phones = file.phones.filter((p) => !drop.has(p.phoneId))
    saveHostFile()
  }
  let kicked = 0
  const cids = new Set<string>()
  for (const p of [...phones.values()]) {
    if (!drop.has(p.phoneId)) continue
    cids.add(p.cid)
    forgetPhone(p.cid)
    sendRelay({ t: 'phone-kick', cid: p.cid, reason: 'removed' })
    kicked++
  }
  for (const h of [...handshakes.values()]) {
    if (!drop.has(h.hs.phoneId)) continue
    endHandshake(h.cid)
    rejectPhone(h.cid, 'This desktop removed this phone. Pair it again with a new code.', 'removed')
  }
  for (const a of [...pairAsks.values()]) if (drop.has(a.phoneId)) dropAsksOf(a.cid, 'its phone was removed on the desktop')
  for (const [cid, id] of [...phoneOfCid]) {
    if (!drop.has(id)) continue
    cids.add(cid)
    phoneOfCid.delete(cid)
  }
  const video = cids.size > 0 && remoteVideo.endOwnedBy(cids, 'its phone was removed on the desktop')
  if (removed.length || kicked) {
    log(`removed ${removed.length} paired phone(s) ${removed.join(', ') || '-'} (${why}), closed ${kicked} live session(s)${video ? ' and its video session' : ''}; their pinned keys are deleted and can't connect again`)
    notifyWindows()
  }
  return { removed, kicked, phones: pairedPhones() }
}

export function newHostKeys(why: string): RemoteForgetResult {
  const forgot = forgetPaired('all', why)
  const file = loadHostFile()
  const key = newHostKey()
  file.hostId = hostIdForKey(key.x)
  file.key = key
  file.e2e = newMacKey()
  file.phones = []
  saveHostFile()
  log(`made new keys for this desktop (${why}): host id ${file.hostId}, every phone pairs again with a new code`)
  disconnectRelay()
  connect()
  notifyWindows()
  notifyPaired()
  return { ...forgot, phones: pairedPhones() }
}

function forgetPhone(cid: string): Phone | undefined {
  const p = phones.get(cid)
  if (!p) return undefined
  if (noteSeen(p.phoneId, Date.now())) saveHostFile()
  p.connected = false
  p.e2e.close()
  for (const [k, v] of pendingVideo) if (v.phone === p) {
    clearTimeout(v.timer)
    pendingVideo.delete(k)
  }
  p.link.reset()
  p.dc = null
  phones.delete(cid)
  watchUsage(phones.size > 0)
  windowWaiters.delete(cid)
  releaseClient(cid, 'phone left')
  phoneLeft(cid)
  if (panels.leave(cid)) pushPanel(`phone ${p.phoneId} left`)
  return p
}

function busyWith(cid: string, phoneId: string | null, installId: string): Phone | undefined {
  const sameDevice = (p: Phone): boolean => (phoneId !== null && p.phoneId === phoneId) || (installId !== '' && p.installId === installId)
  return [...phones.values()].find((p) => p.cid !== cid && !sameDevice(p))
}

function refuseBusy(cid: string, phoneId: string | null, installId: string): boolean {
  const busy = busyWith(cid, phoneId, installId)
  if (!busy) return false
  log(`refused phone ${phoneId ?? 'new'} as ${cid}: ${busy.phoneId} (${busy.device}) is connected as ${busy.cid}`)
  sendRelay({ t: 'phone-reject', cid, code: 'busy', device: busy.device, reason: 'Satura Remote is already open on another device' })
  return true
}

function rejectPhone(cid: string, reason: string, code?: string): void {
  sendRelay({ t: 'phone-reject', cid, reason, ...(code ? { code } : {}) })
}

function endHandshake(cid: string): PendingHandshake | undefined {
  const h = handshakes.get(cid)
  if (!h) return undefined
  handshakes.delete(cid)
  clearTimeout(h.timer)
  return h
}

function pairSecretFor(hello: E2eHello, hostId: string): string | null {
  const now = Date.now()
  for (const [secret, at] of pairCodes) {
    if (now - at > PAIR_CODE_TTL_MS) continue
    if (checkPairProof(hello, hostId, secret)) return secret
  }
  return null
}

function burnCode(secret: string): void {
  pairCodes.delete(secret)
  pairFails.delete(secret)
  const code = `${loadHostFile().hostId}:${secret}`
  pairIssuedAt.delete(code)
  if (lastPairCode === code) lastPairCode = null
}

function notePairFail(): void {
  for (const secret of [...pairCodes.keys()]) {
    const n = (pairFails.get(secret) ?? 0) + 1
    pairFails.set(secret, n)
    if (n >= PAIR_FAILS_MAX) {
      burnCode(secret)
      log(`pairing code burned after ${n} wrong proofs; make a new one on the Mac`)
    }
  }
}

function onPhoneHello(m: PhoneHello): void {
  const file = loadHostFile()
  const hello = m.e2e
  endHandshake(m.cid)
  if (!isHello(hello)) {
    log(`rejected phone connection ${m.cid}: it sent no end-to-end handshake`)
    return rejectPhone(m.cid, 'The end-to-end handshake failed', 'auth')
  }
  let phonePub: string
  let secret: string | undefined
  if (hello.mode === 'resume') {
    const known = file.phones.find((p) => p.phoneId === hello.phoneId)
    if (!known?.pub) {
      log(`rejected phone ${hello.phoneId} as ${m.cid}: no pinned key for it on this Mac (removed, or never paired)`)
      return rejectPhone(m.cid, 'This phone is not paired with this desktop', 'unpaired')
    }
    phonePub = known.pub
  } else {
    const found = typeof hello.pub === 'string' ? pairSecretFor(hello, file.hostId) : null
    if (!found) {
      notePairFail()
      log(`rejected pairing from ${m.cid}: its proof of the pairing code doesn't check out (wrong or expired code, or a changed key)`)
      return rejectPhone(m.cid, 'That pairing code is wrong or expired')
    }
    burnCode(found)
    secret = found
    phonePub = hello.pub as string
  }
  let hs: HostHandshake
  try {
    hs = startHostHandshake({ hello, hostId: file.hostId, hostName: desktopName(), mac: file.e2e, phonePub, ...(secret !== undefined ? { secret } : {}) })
  } catch (e) {
    log(`rejected phone ${m.cid}: ${(e as Error).message}`)
    return rejectPhone(m.cid, 'The end-to-end handshake failed', 'auth')
  }
  const timer = setTimeout(() => {
    if (!endHandshake(m.cid)) return
    log(`phone ${m.cid} didn't finish the end-to-end handshake in ${HANDSHAKE_MS / 1000} s`)
    rejectPhone(m.cid, 'The end-to-end handshake timed out', 'auth')
  }, HANDSHAKE_MS)
  handshakes.set(m.cid, { cid: m.cid, hello: m, hs, mode: hello.mode, timer })
  sendRelay({ t: 'phone-hs', cid: m.cid, e2e: hs.reply })
}

function onPhoneFinish(m: Extract<RelayInbound, { t: 'phone-hs' }>): void {
  const h = endHandshake(m.cid)
  if (!h) return
  let session: HostE2eSession
  try {
    session = h.hs.finish(m.e2e)
  } catch (e) {
    log(`end-to-end handshake with phone ${h.hs.phoneId} as ${m.cid} failed: ${(e as Error).message}`)
    if (h.mode === 'pair') notePairFail()
    return rejectPhone(m.cid, 'The end-to-end handshake failed', 'auth')
  }
  const installId = String(h.hello.installId ?? '').slice(0, 64)
  log(`end-to-end session with phone ${h.hs.phoneId} as ${m.cid} (${h.mode === 'pair' ? 'pairing, code proven by both sides' : 'pinned keys'})`)
  if (h.mode === 'pair') return askToPair(h.hello, h.hs.phoneId, h.hs.phonePub, session)
  if (refuseBusy(m.cid, h.hs.phoneId, installId)) return session.close()
  const file = loadHostFile()
  const known = file.phones.find((p) => p.phoneId === h.hs.phoneId)
  if (!known?.pub) {
    session.close()
    return rejectPhone(m.cid, 'This phone is not paired with this desktop', 'unpaired')
  }
  Object.assign(known, { ua: String(h.hello.ua ?? '').slice(0, 200), ...seenFacts(h.hello, Date.now()) })
  saveHostFile()
  admitPhone(h.hello, known.phoneId, session)
}

function askOf(m: PhoneHello, id: string, expiresAt: number): RemotePairAsk {
  const ua = String(m.ua ?? '').slice(0, 200)
  return { id, device: String(m.device ?? '').trim().slice(0, 60) || deviceKind(ua), ua, uaShort: shortUserAgent(ua), email: helloEmail(m) || null, place: placeOfHello(m) ?? null, expiresAt }
}

function askToPair(m: PhoneHello, phoneId: string, pub: string, session: HostE2eSession): void {
  const wc = mirrorWebContents()
  if (!wc) {
    log(`phone ${m.cid} had a valid pairing code, but no Satura window is open to allow it`)
    session.close()
    sendRelay({ t: 'phone-reject', cid: m.cid, reason: 'Open Satura on the desktop to allow this phone, then make a new code' })
    return
  }
  const id = randomBytes(6).toString('hex')
  const ask = askOf(m, id, Date.now() + PAIR_ASK_MS)
  const timer = setTimeout(() => answerPair(id, false, 'nobody answered on the desktop'), PAIR_ASK_MS)
  pairAsks.set(id, { cid: m.cid, hello: m, ask, timer, phoneId, pub, session })
  sendRelay({ t: 'phone-hs', cid: m.cid, wait: 'allow' })
  log(`asking the Mac to allow phone ${m.cid} (${ask.device}, ${ask.uaShort || ask.ua || 'no user agent'}) from ${placeText(ask.place ?? undefined) || 'an unknown place'}${ask.email ? ` as ${ask.email}` : ''}`)
  wc.send('remote:pairAsk', ask)
}

export function pairAskList(): RemotePairAsk[] {
  return [...pairAsks.values()].map((a) => a.ask)
}

function endAsk(id: string): PairAsk | undefined {
  const a = pairAsks.get(id)
  if (!a) return undefined
  pairAsks.delete(id)
  clearTimeout(a.timer)
  toWindows('remote:pairAskDone', { id })
  if (a.session.closed) return undefined
  return a
}

function dropAsksOf(cid: string | null, why: string): void {
  for (const [id, a] of [...pairAsks]) {
    if (cid !== null && a.cid !== cid) continue
    endAsk(id)
    a.session.close()
    log(`stopped asking to allow phone ${a.cid}: ${why}`)
  }
}

export function answerPair(id: string, allow: boolean, why: string): RemotePairAnswer {
  const a = endAsk(String(id ?? ''))
  if (!a) return { ok: false, state: 'gone' }
  const m = a.hello
  if (!allow) {
    a.session.close()
    log(`denied phone ${a.cid} (${a.ask.device}): ${why}`)
    sendRelay({ t: 'phone-reject', cid: a.cid, reason: "The desktop didn't allow this phone" })
    return { ok: true, state: 'denied' }
  }
  const installId = String(m.installId ?? '').slice(0, 64)
  const phoneId = a.phoneId
  if (refuseBusy(a.cid, phoneId, installId)) {
    a.session.close()
    return { ok: false, state: 'busy' }
  }
  const file = loadHostFile()
  const now = Date.now()
  const ua = String(m.ua ?? '').slice(0, 200)
  file.phones = file.phones.filter((p) => p.phoneId !== phoneId)
  file.phones.push({ phoneId, pub: a.pub, pairedAt: now, ua, ...pairingFacts(m, now) })
  saveHostFile()
  log(`paired phone ${phoneId} (${ua}) from ${placeText(placeOfHello(m)) || 'an unknown place'}${helloEmail(m) ? ` as ${helloEmail(m)}` : ''}, allowed on the Mac (${why}); its public key is pinned`)
  admitPhone(m, phoneId, a.session)
  return { ok: true, state: 'allowed', phoneId }
}

function admitPhone(m: PhoneHello, phoneId: string, session: HostE2eSession): void {
  const ua = String(m.ua ?? '').slice(0, 200)
  const device = deviceName(m)
  const installId = String(m.installId ?? '').slice(0, 64)
  for (const old of [...phones.values()]) {
    if (old.cid === m.cid || !(old.phoneId === phoneId || (installId !== '' && old.installId === installId))) continue
    forgetPhone(old.cid)
    sendRelay({ t: 'phone-kick', cid: old.cid, reason: 'replaced' })
    log(`phone ${phoneId} reconnected as ${m.cid}, dropped its old session ${old.cid}`)
  }
  phones.set(m.cid, newPhone({ cid: m.cid, phoneId, installId, ua, device, connected: true, e2e: session }))
  panels.connect(m.cid, device, Date.now())
  phoneOfCid.set(m.cid, phoneId)
  while (phoneOfCid.size > 64) phoneOfCid.delete(phoneOfCid.keys().next().value as string)
  startLinkTicks()
  watchUsage(true)
  sendRelay({ t: 'phone-accept', cid: m.cid, phoneId })
  log(`phone ${phoneId} (${device}) connected as ${m.cid} (${phones.size} connected)`)
  notifyWindows()
  pushPanel(`phone ${phoneId} connected`)
}

function onMessage(text: string): void {
  let m: RelayInbound
  try {
    m = decodeRemote<RelayInbound>(text)
  } catch {
    return
  }
  relayHeardAt = Date.now()
  countTraffic('relay', 'in', trafficLabel(m as Record<string, unknown>), text.length)
  if (m.t === 'pong') {
    if (relayPingAt) relayRttMs = relayHeardAt - relayPingAt
    return
  }
  if (m.t === 'challenge') {
    if (typeof m.nonce === 'string' && m.nonce.length <= 128) sendRelay({ t: 'auth', sig: hostProof(m.nonce) })
    return
  }
  if (m.t === 'refused') {
    log(`relay refused this Mac: ${String(m.reason ?? 'no reason given').slice(0, 200)}`)
    reconnectMs = REFUSED_RECONNECT_MS
    return
  }
  if (m.t === 'welcome') {
    connected = true
    reconnectMs = RECONNECT_MIN_MS
    relayWeb = webOrigin(m.web)
    if (relayUrl === PRODUCTION_RELAY_URL && relayWeb && relayWeb !== PHONE_WEB) log(`the relay asked phones to open ${relayWeb}, this desktop keeps ${PHONE_WEB} for the hosted relay`)
    log(`registered with relay ${relayUrl} as host ${loadHostFile().hostId}, phones open ${phoneRelayUrl() ?? '-'}/m/`)
    if (m.ping) watchRelay()
    notifyWindows()
    return
  }
  if (m.t === 'phone-hello') return onPhoneHello(m)
  if (m.t === 'phone-hs') return onPhoneFinish(m)
  if (m.t === 'video-grant') return onVideoGrant(m)
  if (m.t === 'video-deny') return onVideoDeny(m)
  if (m.t === 'push-result') return onPushResult(m)
  if (m.t === 'net-probe') {
    const origin = relayHttpOrigin()
    if (origin) checkNetworks(origin, m.token, m.path, log)
    return
  }
  if (m.t === 'phone-left') {
    endHandshake(m.cid)
    dropAsksOf(m.cid, 'the phone left')
    const p = forgetPhone(m.cid)
    if (p) {
      log(`phone ${p.phoneId} disconnected (${phones.size} connected)`)
      notifyWindows()
    }
    return
  }
  if (m.t === 'rpc' && !plainRpcSeen) {
    plainRpcSeen = true
    log(`ignored a plaintext call for phone ${String(m.cid ?? '-')} from the relay: phones only reach the Mac end-to-end encrypted (logged once)`)
  }
}

function integrityFail(phone: Phone, why: string): void {
  if (!phone.connected) return
  log(`end-to-end check failed for phone ${phone.phoneId} as ${phone.cid}: ${why}; closing its session`)
  forgetPhone(phone.cid)
  sendRelay({ t: 'phone-kick', cid: phone.cid, reason: 'integrity' })
  notifyWindows()
}

function onSealed(bytes: Uint8Array): void {
  relayHeardAt = Date.now()
  let cid: string
  try {
    cid = readFrame(bytes, true).cid
  } catch {
    return
  }
  const phone = phones.get(cid)
  if (!phone) return
  let text: string
  try {
    text = phone.e2e.open(bytes)
  } catch (e) {
    return integrityFail(phone, e instanceof E2eError ? e.message : String(e))
  }
  let m: LinkFrame
  try {
    m = decodeRemote<LinkFrame>(text)
  } catch {
    return integrityFail(phone, 'a sealed frame held no message')
  }
  countTraffic('relay', 'in', typeof m.ch === 'string' ? `${String(m.t)} ${m.ch}` : String(m.t ?? '?'), bytes.byteLength)
  phone.link.receive(m, 'relay')
}

function videoKey(cid: string, session: unknown): string {
  return `${cid}|${String(session ?? '').slice(0, 64)}`
}

const grantedVideo = new WeakSet<object>()

function withGrant(m: RemoteRpc, grant: { iceServers?: RvIceServer[]; iceTransportPolicy?: 'relay' | 'all' }): RemoteRpc {
  const { iceServers: _ice, iceTransportPolicy: _policy, ...hello } = (m.args[0] ?? {}) as Record<string, unknown>
  const out = { ...m, args: [{ ...hello, iceServers: Array.isArray(grant.iceServers) ? grant.iceServers.slice(0, 8) : [], ...(grant.iceTransportPolicy === 'relay' ? { iceTransportPolicy: 'relay' as const } : {}) }] }
  grantedVideo.add(out)
  return out
}

function heldForGrant(phone: Phone, m: RemoteRpc): boolean {
  const sig = (Array.isArray(m.args) ? m.args[0] : null) as { type?: string; session?: string } | null
  if (m.ch !== 'rvideo:signal' || sig?.type !== 'hello' || grantedVideo.has(m)) return false
  const key = videoKey(phone.cid, sig.session)
  const grant = videoGrants.get(key)
  if (grant) {
    videoGrants.delete(key)
    void dispatch(phone, withGrant(m, grant))
    return true
  }
  const old = pendingVideo.get(key)
  if (old) clearTimeout(old.timer)
  const timer = setTimeout(() => {
    if (pendingVideo.get(key)?.timer !== timer) return
    pendingVideo.delete(key)
    log(`video hello ${key} from phone ${phone.phoneId} had no ICE grant from the relay in ${VIDEO_GRANT_MS / 1000} s, dropped`)
  }, VIDEO_GRANT_MS)
  pendingVideo.set(key, { phone, m, timer })
  return true
}

function onVideoGrant(m: Extract<RelayInbound, { t: 'video-grant' }>): void {
  const key = videoKey(String(m.cid ?? ''), m.session)
  const now = Date.now()
  for (const [k, g] of videoGrants) if (now - g.at > VIDEO_GRANT_MS) videoGrants.delete(k)
  const pend = pendingVideo.get(key)
  if (!pend) {
    if (videoGrants.size < 16) videoGrants.set(key, { iceServers: m.iceServers, iceTransportPolicy: m.iceTransportPolicy, at: now })
    return
  }
  pendingVideo.delete(key)
  clearTimeout(pend.timer)
  if (phones.get(pend.phone.cid) !== pend.phone) return
  void dispatch(pend.phone, withGrant(pend.m, m))
}

function onVideoDeny(m: Extract<RelayInbound, { t: 'video-deny' }>): void {
  const key = videoKey(String(m.cid ?? ''), m.session)
  videoGrants.delete(key)
  const pend = pendingVideo.get(key)
  if (pend) {
    pendingVideo.delete(key)
    clearTimeout(pend.timer)
    log(`the relay refused video ${key} for phone ${pend.phone.phoneId}`)
  }
  remoteVideo.endOwnedBy(new Set([String(m.cid ?? '')]), 'the relay refused the game stream')
}

function dropPhones(): void {
  dropAsksOf(null, 'the relay link closed')
  const now = Date.now()
  let seen = false
  for (const h of [...handshakes.keys()]) endHandshake(h)
  for (const v of pendingVideo.values()) clearTimeout(v.timer)
  pendingVideo.clear()
  videoGrants.clear()
  for (const p of phones.values()) {
    seen = noteSeen(p.phoneId, now) || seen
    p.connected = false
    p.e2e.close()
    p.link.reset()
    p.dc = null
    releaseClient(p.cid, 'phones dropped')
    phoneLeft(p.cid)
  }
  if (seen) saveHostFile()
  phones.clear()
  watchUsage(false)
  windowWaiters.clear()
  if (panels.clear()) pushPanel('the relay link closed')
}

function stopRelayWatch(): void {
  if (relayPing) clearInterval(relayPing)
  relayPing = null
  relayPingAt = 0
}

function watchRelay(): void {
  stopRelayWatch()
  const ws = socket
  relayPing = setInterval(() => {
    if (socket !== ws || !ws) return stopRelayWatch()
    const now = Date.now()
    if (relayPingAt && relayHeardAt < relayPingAt && now - relayPingAt > RELAY_SILENT_MS) {
      log(`the relay hasn't answered for ${Math.round((now - relayPingAt) / 1000)} s, connecting again`)
      stopRelayWatch()
      try {
        ws.close()
      } catch {
      }
      relayClosed(ws)
      return
    }
    if (relayHeardAt >= relayPingAt) {
      relayPingAt = now
      sendRelay({ t: 'ping' })
    }
  }, RELAY_PING_MS)
  relayPing.unref()
}

function scheduleReconnect(): void {
  if (reconnectTimer || !relayUrl) return
  const wait = reconnectMs > RECONNECT_MAX_MS ? reconnectMs : Math.round(reconnectMs * (0.75 + Math.random() * 0.5))
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null
    connect()
  }, wait)
  reconnectMs = Math.min(RECONNECT_MAX_MS, reconnectMs * 2)
}

function connect(): void {
  if (!relayUrl) return
  void hostKind()
  let ws: WebSocket
  try {
    ws = new WebSocket(relayUrl)
  } catch (e) {
    log(`bad relay url ${relayUrl}: ${(e as Error).message}`)
    return
  }
  socket = ws
  ws.onopen = () => {
    const file = loadHostFile()
    ws.send(encodeRemote({ t: 'hello', role: 'host', hostId: file.hostId, key: file.key.x, name: desktopName(), version: app.getVersion(), protocol: REMOTE_PROTOCOL, minPhone: REMOTE_PROTOCOL }))
  }
  ws.binaryType = 'arraybuffer'
  ws.onmessage = (e) => {
    if (e.data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(e.data)
      relayIn(bytes.byteLength, () => {
        if (socket === ws) onSealed(bytes)
      })
      return
    }
    if (typeof e.data !== 'string') return
    const text = e.data
    relayIn(text.length, () => {
      if (socket === ws) onMessage(text)
    })
  }
  ws.onclose = (e) => {
    if (socket === ws && e.code === 4005) {
      log(`the relay took this host id from this Mac (${e.reason || 'replaced'}): another Satura with the same key connected, trying again in ${REPLACED_RECONNECT_MS / 1000} s`)
      reconnectMs = REPLACED_RECONNECT_MS
    } else if (socket === ws && e.code === 1012) reconnectMs = RECONNECT_MIN_MS
    relayClosed(ws)
  }
  ws.onerror = () => {}
}

function relayClosed(ws: WebSocket): void {
  if (socket !== ws) return
  stopRelayWatch()
  if (connected) log('relay connection closed')
  const was = connected
  connected = false
  socket = null
  dropPhones()
  if (was) notifyWindows()
  scheduleReconnect()
}

function tapWindow(win: BrowserWindow): void {
  const wc = win.webContents
  const send = wc.send.bind(wc)
  wc.send = (channel: string, ...args: unknown[]): void => {
    send(channel, ...args)
    if (phones.size === 0 || tapMuted) return
    if (SKIPPED_EVENTS.has(channel) || SKIPPED_EVENT_PREFIXES.some((p) => channel.startsWith(p))) return
    if (mirrorWebContents() !== wc) return
    broadcast(channel, args)
  }
  const id = wc.id
  wc.once('destroyed', () => {
    sessions.delete(id)
    restorePrompts.delete(id)
  })
}

function recordSession(wcId: number, session: WindowSession): void {
  if (!session || typeof session !== 'object' || !windowIdForWebContents(wcId)) return
  sessions.set(wcId, session)
  if (phones.size === 0 || mirrorWebContents()?.id !== wcId) return
  broadcast('remote:session', [{ workspace: session.workspace, files: session.files }])
  pushPanel('the desktop changed its tabs')
}

export function status(): RemoteStatus {
  return {
    enabled: remoteEnabled(),
    url: relayUrl,
    connected,
    hostId: loadHostFile().hostId,
    phones: phones.size,
    paired: loadHostFile().phones.length,
    pairCode: lastPairCode,
    phoneRelay: phoneRelayUrl(),
    phoneApp: phoneAppCheck()
  }
}

const phoneWatch = {
  applies: () => remoteEnabled() && watchesPhoneWeb(phoneRelayUrl()),
  hostId: () => loadHostFile().hostId,
  changed: () => notifyWindows(),
  log
}

export function checkPhoneAppNow(): ReturnType<typeof checkPhoneApp> {
  return checkPhoneApp(phoneWatch)
}

export function phoneAppWatched(): boolean {
  return phoneWatch.applies()
}

export function startRemoteHost(): void {
  if (started) return
  started = true
  setMediaReadGuard((path) => phoneMayUse(path, 'media'))
  for (const win of BrowserWindow.getAllWindows()) tapWindow(win)
  app.on('browser-window-created', (_e, win) => tapWindow(win))
  ipcMain.on('session:put-window', (event, session: WindowSession) => recordSession(event.sender.id, session))
  ipcMain.on('session:update-window', (event, session: WindowSession) => recordSession(event.sender.id, session))
  ipcMain.on('remote:setRestorePrompts', (event, list: unknown) => {
    if ((event.sender as unknown as { remote?: boolean }).remote) return
    recordRestorePrompts(event.sender.id, list)
  })
  ipcMain.on('remote:storeActionDone', (_event, done: { reqId: number; error?: string; value?: unknown }) => {
    const p = pendingStoreActions.get(done?.reqId)
    if (!p) return
    pendingStoreActions.delete(done.reqId)
    clearTimeout(p.timer)
    if (done.error) p.reject(new Error(done.error))
    else p.resolve(done.value)
  })
  const fromPhone = (event: { sender: unknown }): boolean => !!(event.sender as { remote?: boolean }).remote
  ipcMain.handle('remote:status', (event) => (fromPhone(event) ? { ...status(), pairCode: null } : status()))
  ipcMain.handle('remote:newPairCode', (event) => {
    if (fromPhone(event)) throw new Error(DESKTOP_ONLY)
    return connected ? newPairCode() : null
  })
  ipcMain.handle('remote:pairInfo', (event) => {
    if (fromPhone(event)) throw new Error(DESKTOP_ONLY)
    return pairInfo()
  })
  ipcMain.handle('remote:pairAsks', (event) => {
    if (fromPhone(event)) throw new Error(DESKTOP_ONLY)
    return pairAskList()
  })
  ipcMain.handle('remote:answerPair', (event, id: string, allow: boolean) => {
    if (fromPhone(event)) throw new Error(DESKTOP_ONLY)
    return answerPair(String(id ?? ''), allow === true, allow === true ? 'Allow pressed' : 'Deny pressed')
  })
  ipcMain.handle('remote:setEnabled', (event, on: boolean) => ((event.sender as unknown as { remote?: boolean }).remote ? status() : setRemoteEnabled(!!on)))
  ipcMain.handle('remote:presence', (event) => ((event.sender as unknown as { remote?: boolean }).remote ? true : presenceList()))
  ipcMain.handle('remote:phonePanel', () => phonePanel())
  ipcMain.handle('remote:pairedPhones', (event) => {
    if (fromPhone(event)) throw new Error(DESKTOP_ONLY)
    return pairedPhones()
  })
  ipcMain.handle('remote:forgetPhone', (event, phoneId: string) => {
    if (fromPhone(event)) throw new Error(DESKTOP_ONLY)
    return forgetPaired([String(phoneId ?? '')], 'removed in Settings')
  })
  ipcMain.handle('remote:forgetAllPhones', (event) => {
    if (fromPhone(event)) throw new Error(DESKTOP_ONLY)
    return forgetPaired('all', 'removed all in Settings')
  })
  ipcMain.handle('remote:newKeys', (event) => {
    if (fromPhone(event)) throw new Error(DESKTOP_ONLY)
    return newHostKeys('new keys from Settings')
  })
  ipcMain.on('pty:write', (event, req: { id?: string; data?: string } | undefined) => {
    notePtyInput(String(req?.id ?? ''), clientOfSender(event.sender), String(req?.data ?? ''))
  })
  configurePtySizeOwner({
    announce: (a) => {
      for (const win of BrowserWindow.getAllWindows()) if (!win.isDestroyed()) win.webContents.send('pty:sizeOwner', a)
      broadcast('pty:sizeOwner', [a])
    },
    log
  })
  configureTermMirror({
    sendWs: (cid, msg) => {
      const phone = phones.get(cid)
      if (phone) phoneEvent(phone, 'remote:term', [msg])
    },
    writeInput: (cid, id, data) => {
      const phone = phones.get(cid)
      if (!phone || ptyOwnerWebContentsId(id) === undefined) return
      const event = fakeEvent(phone)
      for (const l of tappedListeners('pty:write')) l(event, { id, data })
    },
    alive: (cid) => phones.has(cid),
    log
  })
  onPhoneLeft(termPhoneLeft)
  configurePhoneProjects({
    openOnMac: (path, root) => macCall('openProject', root ? [path, root] : [path], 15_000) as Promise<{ workspaceId: string; created: boolean; unity: boolean }>,
    broadcast: (ch, args) => broadcast(ch, args),
    log
  })
  configurePhonePush({
    phones: () => loadHostFile().phones,
    save: saveHostFile,
    relay: (msg) => {
      if (!connected || !socket || socket.readyState !== WebSocket.OPEN) return false
      sendRelay(msg, 'push')
      return true
    },
    broadcast: (ch, args) => broadcast(ch, args),
    live: (phoneId) => {
      const cid = panels.currentCid()
      const p = cid ? phones.get(cid) : undefined
      if (!p || p.phoneId !== phoneId) return null
      const v = phonePanel()
      return { visible: v.connected && v.visible, stale: v.stale, workspaceId: v.workspace?.id ?? null, tabId: v.screen === 'panel' ? (v.tab?.id ?? null) : null }
    },
    log
  })
  onUsageChanged(pushUsage)
  worldStore.onWorldBroadcast(pushWorld)
  remoteVideo.setTermCid(() => [...phones.values()][0]?.cid ?? null)
  remoteVideo.setLinkHandlers({ message: onLinkMessage, closed: onLinkClosed })
  remoteVideo.setLinkInfo({
    calls: (cid) => (cid ? (phones.get(cid)?.link.diag() ?? null) : null),
    relay: relayLink,
    videoSecret: (cid) => {
      const e2e = cid ? phones.get(cid)?.e2e : undefined
      return e2e && !e2e.closed ? Buffer.from(e2e.video) : null
    }
  })
  remoteVideo.setTurnSink((cid, d) => turnTally.add(cid, d))
  turnFlush ??= setInterval(flushTurn, TURN_FLUSH_MS)
  turnFlush.unref()
  startPhoneWatch(phoneWatch)
  relayUrl = resolveRelayUrl()
  if (!relayUrl) {
    log('relay disabled')
    return
  }
  log(`connecting to relay ${relayUrl}`)
  connect()
}

function disconnectRelay(keepCodes = false): void {
  if (reconnectTimer) clearTimeout(reconnectTimer)
  reconnectTimer = null
  reconnectMs = RECONNECT_MIN_MS
  dropPhones()
  stopRelayWatch()
  const ws = socket
  socket = null
  connected = false
  relayWeb = null
  if (!keepCodes) {
    lastPairCode = null
    pairCodes.clear()
    pairIssuedAt.clear()
  }
  try {
    ws?.close()
  } catch {
  }
}

export function stopRemoteHost(): void {
  relayUrl = null
  disconnectRelay()
}
