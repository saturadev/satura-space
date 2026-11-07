import type { VideoStep } from '@shared/report-frame'
import { playerCore } from '../components/report/frame-player-core'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const frame = (): Promise<void> => new Promise((r) => requestAnimationFrame(() => r()))

function players(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('[data-frame-player], [data-sound-player]')]
}

function pick(index?: number, name?: string): HTMLElement {
  const all = players()
  const el = name ? all.find((p) => (p.dataset.videoName ?? '').includes(name)) : all[index ?? 0]
  if (!el) throw new Error(`No video player ${name ? `named ${name}` : `#${index ?? 0}`} on screen (${all.length} players: ${all.map((p) => p.dataset.videoName ?? '?').join(', ')})`)
  return el
}

function soundState(el: HTMLElement): Record<string, unknown> {
  const v = el.querySelector('video') as (HTMLVideoElement & { webkitAudioDecodedByteCount?: number; webkitVideoDecodedByteCount?: number; audioTracks?: { length: number } }) | null
  if (!v) return { kind: 'sound', video: null }
  const ranges: [number, number][] = []
  for (let i = 0; i < v.buffered.length; i++) ranges.push([Math.round(v.buffered.start(i) * 100) / 100, Math.round(v.buffered.end(i) * 100) / 100])
  return {
    kind: 'sound',
    time: Math.round(v.currentTime * 1000) / 1000,
    duration: v.duration,
    paused: v.paused,
    muted: v.muted,
    volume: v.volume,
    readyState: v.readyState,
    buffered: ranges,
    audioTracks: v.audioTracks?.length ?? null,
    audioBytes: v.webkitAudioDecodedByteCount ?? null,
    videoBytes: v.webkitVideoDecodedByteCount ?? null,
    error: v.error ? v.error.code : null
  }
}

function state(el: HTMLElement): Record<string, unknown> {
  const core = playerCore(el)
  return core ? { name: el.dataset.videoName ?? null, ...core.state() } : { name: el.dataset.videoName ?? null, ...soundState(el) }
}

async function settle(el: HTMLElement, want: number, ms = 3000): Promise<number> {
  const core = playerCore(el)
  const t0 = performance.now()
  while (core && performance.now() - t0 < ms) {
    const s = core.state()
    if (s.shown === want && !core.playing) return Math.round(performance.now() - t0)
    await wait(10)
  }
  return -1
}

function overviewPoint(el: HTMLElement, f: number): { x: number; y: number; ov: HTMLElement } {
  const ov = el.querySelector<HTMLElement>('.srv-overview')
  const core = playerCore(el)
  if (!ov || !core) throw new Error('This player has no timeline')
  ov.scrollIntoView({ block: 'center' })
  const r = ov.getBoundingClientRect()
  return { x: r.left + ((f + 0.5) / core.n) * r.width, y: r.top + r.height / 2, ov }
}

function pointer(type: string, target: HTMLElement, x: number, y: number): void {
  target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, pointerId: 41, pointerType: 'mouse', isPrimary: true, clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1 }))
}

async function run(el: HTMLElement, step: VideoStep): Promise<Record<string, unknown>> {
  const core = playerCore(el)
  const t0 = performance.now()
  const since = Math.round(t0)
  const out: Record<string, unknown> = { do: step.do }
  switch (step.do) {
    case 'state':
      break
    case 'goto': {
      if (core) {
        out.result = core.goto({ frame: step.frame, t: step.t })
        out.settleMs = await settle(el, core.frame)
      } else {
        const v = el.querySelector('video')
        if (v && step.t != null) v.currentTime = step.t
        await wait(300)
      }
      break
    }
    case 'step': {
      if (!core) throw new Error('Only frame players step')
      const btn = el.querySelector<HTMLElement>(`[data-a="${step.by < 0 ? 'stepB' : 'stepF'}"]`)
      const seen: { want: number; shown: number; ms: number }[] = []
      for (let i = 0; i < Math.abs(step.by); i++) {
        const s0 = performance.now()
        btn?.click()
        const want = core.frame
        const ms = await settle(el, want)
        seen.push({ want, shown: Number(core.state().shown), ms: ms < 0 ? -1 : Math.round(performance.now() - s0) })
      }
      out.steps = seen
      break
    }
    case 'scrub': {
      if (!core) throw new Error('Only frame players scrub')
      const n = Math.max(2, step.steps ?? 30)
      const each = Math.max(4, Math.round((step.ms ?? 600) / n))
      const a = overviewPoint(el, step.from)
      pointer('pointerdown', a.ov, a.x, a.y)
      const path: { want: number; shown: number }[] = []
      for (let i = 1; i <= n; i++) {
        const f = Math.round(step.from + ((step.to - step.from) * i) / n)
        const p = overviewPoint(el, f)
        pointer('pointermove', p.ov, p.x, p.y)
        await wait(each)
        path.push({ want: core.frame, shown: Number(core.state().shown) })
      }
      const end = overviewPoint(el, step.to)
      pointer('pointerup', end.ov, end.x, end.y)
      out.path = path
      out.settleMs = await settle(el, core.frame)
      break
    }
    case 'play': {
      if (core) {
        el.querySelector<HTMLElement>('[data-a="play"]')?.click()
        const samples: number[] = []
        const t1 = performance.now()
        while (performance.now() - t1 < (step.ms ?? 1000)) {
          await frame()
          samples.push(core.frame)
        }
        out.frames = { first: samples[0], last: samples[samples.length - 1], distinct: new Set(samples).size }
      } else {
        const v = el.querySelector('video')
        el.querySelector<HTMLElement>('.sv-bar media-play-button')?.click()
        const times: number[] = []
        const t1 = performance.now()
        while (performance.now() - t1 < (step.ms ?? 1000)) {
          await wait(100)
          times.push(Math.round((v?.currentTime ?? 0) * 1000) / 1000)
        }
        out.times = times
      }
      break
    }
    case 'pause':
      if (core) {
        if (core.playing) el.querySelector<HTMLElement>('[data-a="play"]')?.click()
        out.settleMs = await settle(el, core.frame)
      } else el.querySelector('video')?.pause()
      break
    case 'wait':
      await wait(step.ms)
      break
    case 'unmute': {
      const v = el.querySelector('video')
      if (v) {
        v.muted = false
        v.volume = 1
      }
      break
    }
  }
  out.ms = Math.round(performance.now() - t0)
  out.state = state(el)
  if (core) out.decodes = core.decodeLog(since)
  return out
}

export async function probeVideo(q: { index?: number; name?: string; steps?: VideoStep[] }): Promise<Record<string, unknown>> {
  const el = pick(q.index, q.name)
  el.scrollIntoView({ block: 'center' })
  await wait(50)
  const results: Record<string, unknown>[] = []
  for (const s of q.steps ?? [{ do: 'state' }]) results.push(await run(el, s))
  return { players: players().map((p) => ({ name: p.dataset.videoName ?? null, kind: p.dataset.soundPlayer !== undefined ? 'sound' : (p.dataset.decode ?? 'frames') })), results }
}
