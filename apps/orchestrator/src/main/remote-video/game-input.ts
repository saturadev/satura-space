import type { DataChannel } from 'node-datachannel'
import { unityProvider } from '../unity/unity-instance-provider'
import { UnityControlClient } from '../unity/unity-control-client'
import { type GiLive, type GiMacMsg, type GiPayload, type GiPhoneMsg, type GiScheme } from '@shared/game-input'
import { checkPatch } from '@shared/remote-controls'
import { debugLog } from '@shared/debug-log'
import { effectiveFor, filesStamp, overridesPath, patchOverrides } from './remote-controls-files'

const STALE_MS = 1200
const TICK_MS = 300
const SCHEME_TIMEOUT_MS = 8000
const LIVE_RESYNC_MS = 5000
const MAX_FAST_BYTES = 4096

interface Watch {
  source: string
  port: number
  client: UnityControlClient
  scheme: GiScheme | null
  off: () => void
}

function asScheme(v: unknown): GiScheme | null {
  if (!v || typeof v !== 'object') return null
  const s = v as GiScheme
  return Array.isArray(s.assets) ? s : null
}

export async function fetchScheme(worldId: string, timeoutMs = SCHEME_TIMEOUT_MS): Promise<{ scheme: GiScheme | null; error?: string }> {
  const ctl = unityProvider.worldControl(worldId)
  if (!ctl || !ctl.alive) return { scheme: null, error: `no running editor for ${worldId}` }
  const client = new UnityControlClient(ctl.port)
  try {
    const deadline = Date.now() + timeoutMs
    while (!client.isConnected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
    if (!client.isConnected) return { scheme: null, error: 'the editor control socket is not reachable' }
    const r = await client.command('input/scheme', {}, Math.max(1000, deadline - Date.now()))
    if (!r || r.status !== 'completed') return { scheme: null, error: String(r?.error ?? 'no answer from the editor') }
    return { scheme: asScheme(r.scheme) }
  } finally {
    client.close()
  }
}

class GameInputLink {
  private reliable: DataChannel | null = null
  private fast: DataChannel | null = null
  private source: string | null = null
  private sid: string | null = null
  private stamp = ''
  private announced: string | null = null
  private liveSent = ''
  private resyncAt = 0
  private controlsSent = ''
  private holding = false
  private lastAt = 0
  private watch: Watch | null = null
  private timer: NodeJS.Timeout | null = null
  private offCursor: (() => void) | null = null
  private counts = { reliable: 0, fast: 0, released: 0, controlsSent: 0, liveSent: 0, overridesSaved: 0, overridesRefused: 0 }
  private lastIssue: string | null = null
  private last: { keys: string[]; btn: number; pb: string[]; at: number } = { keys: [], btn: 0, pb: [], at: 0 }

  attachReliable(ch: DataChannel): void {
    this.reliable = ch
    this.ensureTimer()
    if (!this.offCursor)
      this.offCursor = unityProvider.onCursorState((worldId, state) => {
        if (worldId === this.source) this.send({ t: 'cursor', source: worldId, ...state })
      })
    debugLog('[game-input] reliable channel open')
  }

  attachFast(ch: DataChannel): void {
    this.fast = ch
    debugLog('[game-input] fast channel open')
  }

  detach(why: string): void {
    if (!this.reliable && !this.fast && !this.sid) return
    this.release(why)
    this.reliable = null
    this.fast = null
    this.sid = null
    this.stamp = ''
    this.liveSent = ''
    this.controlsSent = ''
    this.offCursor?.()
    this.offCursor = null
    this.closeWatch()
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  setSource(source: string | null): void {
    if (source === this.source) return
    const prev = this.source
    if (prev) this.release(`source ${prev} -> ${source ?? 'none'}`)
    this.source = source
    this.closeWatch()
    if (this.sid) this.announce()
  }

  onReliable(msg: string | Buffer | ArrayBuffer): void {
    if (typeof msg !== 'string') return
    let m: GiPhoneMsg
    try {
      m = JSON.parse(msg) as GiPhoneMsg
    } catch {
      return
    }
    if (m.t === 'hello') {
      this.sid = String(m.sid || '').slice(0, 64) || null
      this.stamp = ''
      this.liveSent = ''
      this.controlsSent = ''
      debugLog(`[game-input] phone ${this.sid} hello, source ${this.source ?? 'none'}`)
      this.announce()
      return
    }
    if (m.t === 'override') {
      const project = this.project()
      const patch = checkPatch(m.patch)
      if (!project || !patch) return
      const r = patchOverrides(project, patch)
      if (!r.ok) {
        this.counts.overridesRefused++
        this.lastIssue = r.error ?? 'refused'
        console.log(`[game-input] phone override refused for ${project}: ${r.error}`)
        this.pushControls(true, r.error)
        return
      }
      if (r.changed) {
        this.counts.overridesSaved++
        debugLog(`[game-input] phone override saved to ${overridesPath(project)}: ${JSON.stringify(patch).slice(0, 300)}`)
      }
      this.pushControls(true)
      return
    }
    if (m.t === 'in') {
      const p = m.p
      if (!p || p.v !== 3 || !this.sid) return
      p.sid = this.sid
      this.counts.reliable++
      this.lastAt = Date.now()
      if (!p.nr) {
        const keys = Array.isArray(p.keys) ? p.keys : []
        const pb = Array.isArray(p.pb) ? p.pb : []
        const btn = Number(p.btn) || 0
        this.holding = keys.length > 0 || pb.length > 0 || btn !== 0
        if (keys.join() !== this.last.keys.join() || btn !== this.last.btn || pb.join() !== this.last.pb.join())
          debugLog(`[game-input] held keys=[${keys.join(',')}] btn=${btn} pad=[${pb.join(',')}] -> ${this.source ?? 'none'}`)
        this.last = { keys, btn, pb, at: this.lastAt }
      }
      this.forward(JSON.stringify(p))
      return
    }
    if (m.t === 'bye') this.release('phone said bye')
  }

  onFast(msg: string | Buffer | ArrayBuffer): void {
    if (typeof msg !== 'string' || msg.length > MAX_FAST_BYTES || !msg.startsWith('{"v":3') || !this.sid) return
    if (!msg.includes(`"sid":"${this.sid}"`)) return
    this.counts.fast++
    this.lastAt = Date.now()
    this.forward(msg)
  }

  status(): Record<string, unknown> {
    return {
      reliableOpen: !!this.reliable?.isOpen(),
      fastOpen: !!this.fast?.isOpen(),
      source: this.source,
      project: this.project(),
      sid: this.sid,
      holding: this.holding,
      lastHeld: this.last,
      sinceLastMs: this.lastAt ? Date.now() - this.lastAt : null,
      lastIssue: this.lastIssue,
      counts: { ...this.counts },
      watch: this.watch ? { source: this.watch.source, port: this.watch.port, connected: this.watch.client.isConnected, sig: this.watch.scheme?.sig ?? null, playing: this.watch.scheme?.playing ?? null } : null,
      overridesFile: this.project() ? overridesPath(this.project()!) : null,
      gamepadModule: this.watch?.scheme?.gamepadModule ?? null
    }
  }

  private project(): string | null {
    return this.source ? unityProvider.worldControl(this.source)?.realProjectPath ?? null : null
  }

  private forward(json: string): void {
    if (!this.source) return
    unityProvider.sendInputToWorld(this.source, Buffer.from(json))
  }

  private release(why: string): void {
    if (!this.sid || !this.source) return
    const bye: GiPayload = { v: 3, sid: this.sid, now: 0, focus: 0, bye: 1 }
    this.forward(JSON.stringify(bye))
    if (this.holding) {
      this.counts.released++
      console.log(`[game-input] released phone input on ${this.source}: ${why} (keys=[${this.last.keys.join(',')}] btn=${this.last.btn} pad=[${this.last.pb.join(',')}])`)
    }
    this.holding = false
  }

  private send(m: GiMacMsg): void {
    const ch = this.reliable
    if (!ch || !ch.isOpen()) return
    try {
      ch.sendMessage(JSON.stringify(m))
    } catch {
    }
  }

  private announce(): void {
    const source = this.source
    const ctl = source ? unityProvider.worldControl(source) : null
    this.announced = ctl ? source : null
    this.liveSent = ''
    this.send({ t: 'target', source: this.announced, project: ctl?.realProjectPath ?? null, clone: ctl?.kind === 'clone' })
    if (!source || !ctl) return
    this.pushControls(true)
    const cursor = unityProvider.cursorStateOf(source)
    if (cursor) this.send({ t: 'cursor', source, ...cursor })
    if (this.watch?.source === source && this.watch.scheme) this.pushLive(this.watch)
    else this.openWatch(source)
  }

  private openWatch(source: string): void {
    this.closeWatch()
    const ctl = unityProvider.worldControl(source)
    if (!ctl || !ctl.alive) return
    const client = new UnityControlClient(ctl.port)
    const w: Watch = { source, port: ctl.port, client, scheme: null, off: () => {} }
    const offEvent = client.onEvent((e) => {
      if (e.event !== 'inputScheme' || this.watch !== w) return
      const scheme = asScheme(e.scheme)
      if (!scheme) return
      w.scheme = scheme
      this.pushLive(w)
    })
    const offConnect = client.onConnect(() => {
      void client.command('input/scheme', { watch: true }, SCHEME_TIMEOUT_MS).then((r) => {
        if (this.watch !== w || !r || r.status !== 'completed') return
        const scheme = asScheme(r.scheme)
        if (!scheme) return
        w.scheme = scheme
        this.pushLive(w)
      })
    })
    w.off = () => {
      offEvent()
      offConnect()
    }
    this.watch = w
    debugLog(`[game-input] watching the input scheme of ${source} on port ${ctl.port}`)
  }

  private closeWatch(): void {
    const w = this.watch
    if (!w) return
    this.watch = null
    w.off()
    w.client.close()
  }

  private pushLive(w: Watch): void {
    const s = w.scheme
    if (!s) return
    const maps = [...new Set(s.assets.flatMap((a) => a.maps.filter((m) => m.enabled).map((m) => m.id)))].sort()
    const live: GiLive = { playing: s.playing, paused: s.paused, maps, gamepadModule: !!s.gamepadModule }
    const key = JSON.stringify(live)
    if (key === this.liveSent) return
    const moduleChanged = !this.liveSent || (JSON.parse(this.liveSent) as GiLive).gamepadModule !== live.gamepadModule
    this.liveSent = key
    this.counts.liveSent++
    debugLog(`[game-input] live ${w.source} playing=${live.playing} paused=${live.paused} maps=[${maps.join(',')}] gamepadModule=${live.gamepadModule}`)
    this.send({ t: 'live', source: w.source, live })
    if (moduleChanged) this.pushControls(true)
  }

  private pushControls(force: boolean, error?: string): void {
    const project = this.project()
    if (!project) return
    this.stamp = filesStamp(project)
    const eff = effectiveFor(project, !!this.watch?.scheme?.gamepadModule)
    const key = JSON.stringify(eff)
    if (!force && key === this.controlsSent && !error) return
    this.controlsSent = key
    this.counts.controlsSent++
    const shown = eff.maps.reduce((n, m) => n + m.controls.filter((c) => c.visible).length, 0)
    debugLog(`[game-input] controls ${project}: ok=${eff.ok} maps=${eff.maps.length} shown=${shown} default=${eff.defaultMap || '-'} issues=${eff.issues.length}${eff.issues.length ? ` [${eff.issues.map((i) => `${i.level} ${i.where}`).join('; ')}]` : ''}`)
    this.send({ t: 'controls', project, controls: eff, ...(error ? { error } : {}) })
  }

  private ensureTimer(): void {
    if (this.timer) return
    this.timer = setInterval(() => this.tick(), TICK_MS)
  }

  private tick(): void {
    if (this.holding && this.lastAt && Date.now() - this.lastAt > STALE_MS) this.release(`no word from the phone for ${Date.now() - this.lastAt} ms`)
    const w = this.watch
    const ctl = this.source ? unityProvider.worldControl(this.source) : null
    if (this.sid && ctl && this.announced !== this.source) {
      debugLog(`[game-input] ${this.source} is up now, telling the phone`)
      this.announce()
    } else if (this.sid && !ctl && this.announced) {
      debugLog(`[game-input] ${this.announced} is gone, telling the phone`)
      this.closeWatch()
      this.announce()
    }
    if (this.sid && this.source && ctl?.alive && (!w || w.port !== ctl.port)) this.openWatch(this.source)
    if (this.sid && ctl) {
      const stamp = filesStamp(ctl.realProjectPath)
      if (stamp !== this.stamp) this.pushControls(false)
      const watch = this.watch
      if (watch && watch.client.isConnected && Date.now() >= this.resyncAt) {
        this.resyncAt = Date.now() + LIVE_RESYNC_MS
        void watch.client.command('input/scheme', { watch: true }, SCHEME_TIMEOUT_MS).then((r) => {
          if (this.watch !== watch || !r || r.status !== 'completed') return
          const scheme = asScheme(r.scheme)
          if (!scheme) return
          watch.scheme = scheme
          this.pushLive(watch)
        })
      }
    }
  }
}

export const gameInput = new GameInputLink()
