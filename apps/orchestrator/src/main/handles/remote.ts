import { BrowserWindow, app, ipcMain, webContents } from 'electron'
import { writeHeapSnapshot } from 'node:v8'
import { censusSizes } from '@shared/census'
import { defineHandle, sleep } from './registry'
import { collect, heapNow } from './perf'
import { answerPair, checkPhoneAppNow, forgetPaired, newPairCode, pairAskList, pairLink, pairedPhones, phoneAppWatched, phoneLinks, phonePanel, presenceList, setRemoteEnabled, setRemoteFaults, showOnPhone, simulatePhoneCall, status } from '../remote/host'
import { describePhonePanel } from '@shared/phone-panel'
import { dcLagKbps, dcLagMs, relayLagKbps, relayLagMs, trafficReport } from '../remote/link-meter'
import { mediaReadReport } from '../remote/media-read'
import { hostKind } from '../remote/host-kind'
import { remoteVideo } from '../remote-video'
import { fetchAccountUsage } from '../remote/account-usage'
import { notify, pushReport, resolvePush } from '../remote/phone-push'
import { readPushLink } from '@shared/remote-push'
import { resizeTermMirror, termMirrorTerminal, termMirrors } from '../remote/term-mirror'

const CENSUS_PREFIXES = ['remote', 'term-mirror', 'pty-size-owner', 'tuner', 'unity-instance-provider.subIndex', 'pty.owners']

interface ProcessInternals {
  _getActiveHandles?: () => object[]
}

const heaps = new Map<string, Map<string, { count: number; size: number }>>()

function heapGrowth(tag: string, base: string): { name: string; count: number; kb: number }[] | string {
  const now = heapNow(tag || 'remote')
  if (tag) heaps.set(tag, now)
  const before = base ? heaps.get(base) : undefined
  if (!base) return []
  if (!before) return `No heap saved under ${base}`
  const rows: { name: string; count: number; kb: number }[] = []
  for (const [name, e] of now) {
    const prev = before.get(name) ?? { count: 0, size: 0 }
    if (e.count !== prev.count || e.size !== prev.size) rows.push({ name, count: e.count - prev.count, kb: Math.round((e.size - prev.size) / 102.4) / 10 })
  }
  return rows.sort((a, b) => b.kb - a.kb || b.count - a.count).slice(0, 20)
}

function round(n: number): number {
  return Math.round(n * 100) / 100
}

async function settledGc(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    collect()
    await new Promise((r) => setTimeout(r, 50))
  }
}

defineHandle({
  name: 'remote.status',
  side: 'main',
  description:
    'Reads the Satura Remote host: whether Remote is on, relay url, whether it is registered with the relay, host id, connected phones, the last pairing code and kind, what this desktop tells phones it is (os macos, windows, linux or other; form laptop, all-in-one, compact, tower, desktop or unknown; model). Remote is off until the user pairs a phone. pair: true turns it on, waits up to 10 s for the relay and mints a fresh one-time pairing code (valid 10 minutes). pairLink is the link the desktop QR code encodes (<phone web base>/m/#pair=<code>:<commitment to the end-to-end key of the Mac>, in the fragment so the relay never sees the code); open it on the phone. pairCode is the shorter code a person types. phoneRelay is the web base phones open, which the relay can set (SATURA_RELAY_PUBLIC_WEB) except the hosted relay, where it is always https://remote.saturaspace.com. phoneApp is the last result of the phone app tripwire (remote.phoneApp). off: true turns Remote off and closes the relay socket. Returns that status.',
  params: { pair: false, off: false },
  async run(p) {
    if (p.off) return setRemoteEnabled(false)
    if (p.pair) {
      if (!status().enabled) setRemoteEnabled(true)
      for (let i = 0; i < 50 && !status().connected; i++) await new Promise((r) => setTimeout(r, 200))
      if (status().connected) newPairCode()
    }
    const s = status()
    return { ...s, pairLink: s.pairCode ? pairLink(s.pairCode) : null, kind: await hostKind() }
  }
})

defineHandle({
  name: 'remote.phoneApp',
  side: 'main',
  description:
    "Runs the phone app tripwire now and returns its result, the one Settings > Mobile warns about. It fetches phone-app.json (commit and sha256 per file) from the hosted phone app, asks the GitHub API for the build attestations of its sha256 and needs one that is SLSA provenance v1 from .github/workflows/phone-site.yml on refs/heads/main of saturadev/satura-space and lists that digest, then downloads the manifest's html files, the pages phones open (/m/, /h/all/, /h/<this host id>/) and the scripts and styles they load, and checks each hash against the manifest and the attestation's subjects. status: ok, mismatch (logged as PHONE APP MISMATCH; also when no such attestation turns up within 30 minutes of first seeing that manifest), unknown (GitHub or the phone app didn't answer, GitHub refused or rate-limited the call, or the attestation isn't up yet). Also returns detail, problems, commit, checked (files hashed), web and watched (whether the desktop checks on its own: Remote is on and phones use the hosted phone app; then it checks every 4 hours). A dev build reads the phone app URL from SATURA_PHONE_APP_WEB and the attestations URL (default https://api.github.com/repos/saturadev/satura-space/attestations, the check appends /sha256:<hex>) from SATURA_PHONE_APP_ATTESTATIONS.",
  params: {},
  agentOnly: true,
  async run() {
    return { ...(await checkPhoneAppNow()), watched: phoneAppWatched() }
  }
})

defineHandle({
  name: 'remote.pairedPhones',
  side: 'main',
  description:
    "Lists the phones paired with this Mac, the same list the Mobile settings show: phoneId, device name, user agent and its short OS and browser form (uaShort), the account email it last connected with (email) and the one it paired with (pairedEmail), pairedAt and pairedFrom (ip, country, region, city the relay saw), lastSeenAt and lastFrom, online (live sessions now), and the warnings: newCountry (last country differs from the pairing country), otherAccount (another phone on this Mac uses a different email), accountChanged (the email differs from the pairing one). Places and emails come from the relay and are missing with an older relay or without a trusted proxy. forget: <phoneId> removes that phone the way Remove in Settings does: deletes it from the host file, closes its live sessions and its video session, and its key stops connecting. forgetAll: true removes every phone. Returns the list, or { removed, kicked, phones } after a removal.",
  params: { forget: '', forgetAll: false },
  agentOnly: true,
  async run(p) {
    if (p.forgetAll) return forgetPaired('all', 'remote.pairedPhones handle')
    if (p.forget) return forgetPaired([String(p.forget)], 'remote.pairedPhones handle')
    return { paired: status().paired, phones: pairedPhones() }
  }
})

defineHandle({
  name: 'remote.pairAsk',
  side: 'main',
  description:
    "Reads the pairings waiting for the Mac's Allow or Deny: a phone with a valid one-time code isn't admitted until someone allows it on the Mac, and the ask denies itself after 60 s or when the phone leaves. Each ask has id, device, ua, uaShort, email, place (ip, country, region, city) and expiresAt; the Satura window shows it as the Allow this phone? dialog. answer: allow or deny with id (default the oldest ask) answers it the way the dialog buttons do. wait: <seconds> first waits that long for an ask to appear. Returns the asks, or the answer (state allowed, denied, busy or gone, and the new phoneId).",
  params: { answer: '', id: '', wait: 0 },
  agentOnly: true,
  async run(p) {
    const until = Date.now() + Math.max(0, Number(p.wait) || 0) * 1000
    while (!pairAskList().length && Date.now() < until) await new Promise((r) => setTimeout(r, 100))
    const asks = pairAskList()
    if (!p.answer) return { asks }
    const id = String(p.id || asks[0]?.id || '')
    if (!id) throw new Error('No pairing is waiting for an answer.')
    return answerPair(id, p.answer === 'allow', `${p.answer} through the remote.pairAsk handle`)
  }
})

defineHandle({
  name: 'remote.phoneActivePanel',
  side: 'main',
  description:
    "Reads the one panel the connected phone shows right now, as the Mac tracks it: connected, device, visible (foreground), screen (projects, layout = the panel list, panel, files), workspace, tab (id, label, kind, pane number, onMac = the Mac's focused pane shows it too, closed = the Mac closed it), heardMs since the phone last reported, stale when it stopped reporting, and pending, a switch the phone hasn't shown yet. summary says it in one line and presence is what the tab badges show. show: <tab id> with workspace: <id> asks the phone to show that tab and waits up to wait seconds (default 6) for it to report it.",
  params: { show: '', workspace: '', wait: 6 },
  async run(p) {
    let shown: boolean | undefined
    if (p.show || p.workspace) {
      const ws = String(p.workspace || phonePanel().workspace?.id || '')
      if (!ws) throw new Error('Pass workspace: the phone has no workspace open.')
      shown = (await showOnPhone({ workspaceId: ws, tabId: p.show ? String(p.show) : null }, Math.max(0.5, Number(p.wait) || 6) * 1000)).shown
    }
    const panel = phonePanel()
    return { summary: describePhonePanel(panel), ...panel, presence: presenceList(), ...(shown === undefined ? {} : { shown }) }
  }
})

defineHandle({
  name: 'remote.census',
  side: 'main',
  description:
    'Counts what Satura Remote holds in the main process after a forced garbage collection: phones, presence, pair codes, store-action pendings, terminal mirrors and their headless terminals, pty size owners, the video session, live PeerConnections and DataChannels, the encoder view, layout capture state, Tuner remote viewers and rendering sessions, stream subscribers. Also main heap, RSS, active Node handles by type, WebContents and window counts, the ipcMain listener total, and CPU and memory per Electron process. Take it before and after phone connect/disconnect cycles to spot leaks. save: <tag> also keeps a main heap snapshot summary under that tag, base: <tag> diffs the current heap against it by constructor and returns the groups that grew. file writes the raw main .heapsnapshot to that path for retainer analysis.',
  params: { save: '', base: '', file: '' },
  async run(p) {
    await settledGc()
    const save = String(p.save ?? '')
    const base = String(p.base ?? '')
    const heapDiff = save || base ? heapGrowth(save, base) : undefined
    if (p.file) writeHeapSnapshot(String(p.file))
    const maps = Object.fromEntries(Object.entries(censusSizes()).filter(([k]) => CENSUS_PREFIXES.some((p) => k.startsWith(p))))
    const handles: Record<string, number> = {}
    for (const h of (process as unknown as ProcessInternals)._getActiveHandles?.() ?? []) {
      const name = h?.constructor?.name ?? 'unknown'
      handles[name] = (handles[name] ?? 0) + 1
    }
    const resources: Record<string, number> = {}
    for (const r of process.getActiveResourcesInfo()) resources[r] = (resources[r] ?? 0) + 1
    const mem = process.memoryUsage()
    let ipcListeners = 0
    for (const name of ipcMain.eventNames()) ipcListeners += ipcMain.listenerCount(name)
    const all = webContents.getAllWebContents()
    const pages: Record<string, number> = {}
    for (const wc of all) {
      const page = wc.isDestroyed() ? 'destroyed' : wc.getURL().split('?')[0].split('/').pop() || wc.getType()
      pages[page] = (pages[page] ?? 0) + 1
    }
    const processes = app.getAppMetrics().map((m) => ({ pid: m.pid, type: m.type, name: m.name ?? m.serviceName ?? '', cpu: round(m.cpu.percentCPUUsage), mb: round(m.memory.workingSetSize / 1024) }))
    return {
      maps,
      heapMB: round(mem.heapUsed / 1048576),
      externalMB: round(mem.external / 1048576),
      arrayBuffersMB: round(mem.arrayBuffers / 1048576),
      rssMB: round(mem.rss / 1048576),
      handles,
      resources,
      webContents: all.length,
      webContentsByPage: pages,
      windows: BrowserWindow.getAllWindows().length,
      ipcListeners,
      processes,
      ...(heapDiff !== undefined ? { heapDiff } : {})
    }
  }
})

defineHandle({
  name: 'remote.traffic',
  side: 'main',
  description:
    'Counts what the Mac sent to and got from the phone since the last reset, per path (relay = the relay websocket, dc = the WebRTC data channels) and per channel (IPC channel, "res <channel>" for call answers, video, tiles, control messages): messages, KB and kbit/s, plus totals per path and direction. Byte counts are what went on the wire after encoding and compression. lag shows the test-only link emulation from SATURA_REMOTE_RELAY_DELAY_MS / SATURA_REMOTE_RELAY_KBPS and SATURA_REMOTE_DC_DELAY_MS / SATURA_REMOTE_DC_KBPS (one-way delay per direction and bandwidth cap). media lists the report media files the phone read since the last reset, with reads and KB per file (images, first-frame stills, video streams). reset: true starts a new count after reading.',
  params: { reset: false },
  async run(p) {
    return { lag: { relayMs: relayLagMs, relayKbps: relayLagKbps, dcMs: dcLagMs, dcKbps: dcLagKbps }, ...trafficReport(!!p.reset), media: mediaReadReport(!!p.reset) }
  }
})

defineHandle({
  name: 'remote.link',
  side: 'main',
  description:
    "Reads the live phone link, the same numbers as the phone's Network details panel. verdict is the one-line call, kind ok, network, app or waiting. mac is what the Mac measures: calls (data channel or relay, last switch and its reason, switches in the last minute, unanswered and resent frames, ack time), relay socket and its RTT, the data channel WebRTC state, selected candidate pair and SCTP RTT, the video track (its own WebRTC connection: state, candidate pair, RTCP RTT and loss, source, encoder state, fps from Unity, fed, encoded and sent, sent, resent and target kbps, congestion estimate, size and fps caps, codec and hardware, what limits quality, keyframes, NACKs and keyframe requests, frames that failed to encrypt) and kbit/s plus buffered KB per data channel and the relay. phone is the phone's last report (ageMs old): its call path and call round trip, relay RTT, ICE state and candidate pair with the TURN server, the video track state and pair, frames received, decoded and shown per second, packet loss, jitter buffer, freezes, dropped frames, NACKs, keyframe requests, decrypt failures, delay to screen, first-frame time or the current wait. phones lists the call link of every connected phone.",
  params: {},
  async run() {
    return { ...remoteVideo.linkReport(), phones: phoneLinks() }
  }
})

defineHandle({
  name: 'remote.stream',
  side: 'main',
  description:
    "Reads the phone game stream as the Mac sends it, a WebRTC H.264 video track encrypted end to end per frame: settings (preset auto, sharp, smooth or saver; filter smooth or pixel), the caps the preset gives (maxSide, fpsCap, maxKbps, degrade = the sender's degradation preference), what libwebrtc does with them (width, height, fps sent, kbps, targetKbps from its congestion control, availableKbps it estimates, limit = what holds quality back: none, bandwidth or cpu), the codec and whether the encoder is hardware, the video track state and path, its RTCP RTT and loss, NACKs and keyframe requests from the phone, keyframes sent, frames that could not be encrypted. set: { preset, filter } changes them as if the phone asked. null when no phone streams.",
  params: { set: null as unknown },
  async run(p) {
    if (p.set && typeof p.set === 'object') remoteVideo.setSettings(p.set as Record<string, never>)
    const mac = remoteVideo.linkReport().mac
    const v = mac?.video
    if (!v) return null
    return {
      track: v.state,
      path: v.pair,
      preset: v.preset,
      filter: v.filter,
      degrade: remoteVideo.degradeNow(),
      maxSide: v.maxSide,
      fpsCap: v.fpsCap,
      maxKbps: v.maxKbps,
      codec: v.codec,
      hardware: v.hardware,
      width: v.width,
      height: v.height,
      sourceFps: v.sourceFps,
      fps: v.fps,
      kbps: v.kbps,
      targetKbps: v.targetKbps,
      availableKbps: v.availableKbps,
      limit: v.limit,
      rttMs: v.rttMs,
      lossPct: v.lossPct,
      nack: v.nack,
      pli: v.pli,
      keys: v.keys,
      unsealed: v.unsealed,
      source: v.source,
      encoder: v.encoder
    }
  }
})

defineHandle({
  name: 'remote.usage',
  side: 'main',
  description:
    "Reads the signed-in account's Satura Remote traffic, the same numbers the Satura Remote settings show. The Mac asks its relay (GET /usage/me with the account's sign-in). state is ok, no-auth, signed-out, off, other-relay, no-accounts, refused or error, with detail saying why. today, thisMonth and total are byte counts for the UTC day, the UTC month and all time: cfEgress and cfIngress are Cloudflare's own TURN counts for this account (egress is what Cloudflare bills), turnTx, turnRx and turnEgress are what Macs measured on data channels whose selected candidate pair is relayed (turnEgress is the part Cloudflare bills for), wsIn and wsOut are the relay's websocket bytes for this account on both the Mac's and the phone's socket, web is the phone web app the relay served, mints the TURN credentials it handed out. days lists the last days. cloudflare says when the relay last read Cloudflare's analytics. thisMac is this Mac's own TURN count since the app started, what it hasn't sent the relay yet, and the live video session's path (local, remote or both ends relayed, or null when direct) and totals.",
  params: {},
  async run() {
    return fetchAccountUsage()
  }
})

defineHandle({
  name: 'remote.fault',
  side: 'main',
  description:
    "Makes the desktop refuse or ignore calls from the connected phone, to check that the phone shows a failure instead of nothing. set maps an IPC channel (fs:rename, unity:setMode, remote:openFile) or store:<action> for a phone store action (store:activateTab, store:runPanelAction, store:openFile) to refuse (the call fails at once with a test error) or stall (the call is never answered, so the phone's deadline runs out). Each call to this handle replaces the whole set; set: {} clears it. Returns the faults now on.",
  params: { set: {} as Record<string, unknown> },
  agentOnly: true,
  async run(p) {
    return { faults: setRemoteFaults(p.set && typeof p.set === 'object' ? (p.set as Record<string, unknown>) : {}) }
  }
})

defineHandle({
  name: 'remote.phoneCall',
  side: 'main',
  description:
    'Runs one call the way a paired phone would send it, through the same checks: the phone allowlist, the open-folder path guard, the running-terminal check and the settings filter. ch is the IPC channel, args its arguments, kind invoke or send. Returns ok with the value, or the error the phone would see; refusals also log a [remote] line.',
  params: { ch: '', args: [] as unknown[], kind: 'invoke' },
  async run(p) {
    const kind = p.kind === 'send' ? 'send' : 'invoke'
    return simulatePhoneCall(String(p.ch), Array.isArray(p.args) ? p.args : [], kind)
  }
})

defineHandle({
  name: 'remote.push',
  side: 'main',
  description:
    "Reads Satura Remote notifications: per paired phone whether it signed up for push, through which push service, its categories (ask, finished, tuner, unity, alert) and the tags it still has to clear, plus the last 60 decisions (sent with the push service's status, or why it was held back: paused, category off, the phone shows it right now, a repeat, no relay). send: { cat, title, body, tag, link } pushes one note through the same path a real event takes, encrypted for each phone; link is { kind: agent | tuner | unity | alert | test, workspaceId, tabId, ptyId, projectPath, view }. resolve: '<tag>' marks a tag seen on the Mac, as when an agent goes on. Returns { activity, phones, records } and what send did; activity is the phone's Activity feed, one entry per tag, newest first, open while it still needs you.",
  params: { send: null as unknown, resolve: '' },
  async run(p) {
    const s = p.send && typeof p.send === 'object' ? (p.send as Record<string, unknown>) : null
    const cats = ['ask', 'finished', 'tuner', 'unity', 'alert', 'test']
    let sent: unknown = null
    if (s) {
      const cat = cats.includes(String(s.cat)) ? (String(s.cat) as 'ask') : 'test'
      sent = notify({ cat, tag: String(s.tag || `handle:${cat}`), title: String(s.title ?? 'Satura Remote'), body: String(s.body ?? ''), link: readPushLink(s.link) ?? { kind: 'test' }, loud: s.loud === true })
    }
    if (p.resolve) resolvePush(String(p.resolve), 'remote.push handle')
    for (let i = 0; i < 40 && s && pushReport().records.some((r) => r.decision === 'sent' && r.status === undefined); i++) await new Promise((r) => setTimeout(r, 250))
    return { ...pushReport(), ...(sent ? { sent } : {}) }
  }
})

defineHandle({
  name: 'remote.termMirror',
  side: 'main',
  description:
    "Lists the terminal mirrors the phone reads (id, phone cid, grid). id with sizes: [[cols, rows], ...] resizes that mirror to each size in turn, gapMs apart, the way a PTY resize reaches it; a size can be any number or 'NaN'. corrupt: true first moves that mirror's screen off its buffer, so the next output it parses throws inside xterm the way a broken mirror does. Returns the mirrors after.",
  params: { id: '', sizes: [] as unknown[], gapMs: 0, corrupt: false },
  async run(p, ctx) {
    const buffer = (termMirrorTerminal(String(p.id)) as unknown as { _core?: { _bufferService: { buffer: { ybase: number } } } } | undefined)?._core?._bufferService.buffer
    if (p.corrupt && buffer) buffer.ybase = -1e6
    const sizes = Array.isArray(p.sizes) ? p.sizes : []
    for (const [i, s] of sizes.entries()) {
      if (i && p.gapMs) await sleep(Number(p.gapMs), ctx.signal)
      const [cols, rows] = Array.isArray(s) ? s : []
      if (!resizeTermMirror(String(p.id), Number(cols), Number(rows))) throw new Error(`No mirror for ${p.id}: the phone has to open that terminal first.`)
    }
    return { mirrors: termMirrors() }
  }
})
