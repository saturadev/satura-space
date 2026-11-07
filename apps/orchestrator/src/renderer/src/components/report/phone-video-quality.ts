import type { RemoteRenditionId, RemoteVideoPlan, RemoteVideoRendition } from '@shared/remote-protocol'
import type { MediaHeld, MediaTier } from '../../lib/media-loader'
import { qualityName, type VideoQuality } from '../../lib/mobile/phone-quality'

export interface QualityOption {
  value: VideoQuality
  text: string
  disabled?: boolean
}

export interface HeldState {
  best: MediaHeld | null
  bestDone: boolean
  lower: MediaHeld | null
}

const RENDITION_IDS: RemoteRenditionId[] = ['1080', '720', '480']
const pct = (p?: number): number => Math.round((p ?? 0) * 100)
const done = (h: MediaHeld): boolean => h.size > 0 && h.bytes >= h.size

export const mbps = (bits: number): string => (bits >= 1e7 ? `${Math.round(bits / 1e6)} Mbps` : `${(bits / 1e6).toFixed(1)} Mbps`)

export const sizeText = (n: number): string =>
  n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(n >= 1e8 ? 0 : 1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`

export function effectiveQuality(plan: RemoteVideoPlan | null, q: VideoQuality): VideoQuality {
  return q === 'auto' && plan?.slow && plan.renditions?.some((r) => r.id === '480') ? '480' : q
}

export function bestPath(plan: RemoteVideoPlan | null): string | null {
  if (!plan) return null
  const v = plan.version
  if (v?.state === 'ready' && v.path && (v.lossless || !plan.plays)) return v.path
  return plan.plays ? plan.path : null
}

export function bestOf(plan: RemoteVideoPlan | null, path: string): boolean {
  if (!plan) return false
  if (path === plan.path) return plan.plays
  const v = plan.version
  return path === v?.path && v.state === 'ready' && (!!v.lossless || !plan.plays)
}

export function tierOf(plan: RemoteVideoPlan, path: string): MediaTier {
  if (path === plan.path) return 'best'
  if (path === plan.version?.path) return plan.version.lossless || !plan.plays ? 'best' : 'phone'
  return plan.renditions?.find((r) => r.path === path)?.id ?? 'phone'
}

export function heldState(held: MediaHeld[]): HeldState {
  const bests = held.filter((h) => h.q === 'best').sort((a, b) => b.bytes / Math.max(1, b.size) - a.bytes / Math.max(1, a.size))
  const best = bests[0] ?? null
  const lower = held.filter((h) => h.q !== 'best' && h.bytes > 0).sort((a, b) => b.bytes / Math.max(1, b.size) - a.bytes / Math.max(1, a.size))[0] ?? null
  return { best, bestDone: !!best && done(best), lower }
}

export function heldQuality(h: HeldState): VideoQuality | null {
  if (h.best && h.best.bytes > 0) return 'original'
  if (h.lower && h.lower.q !== 'phone' && h.lower.q !== 'best') return h.lower.q
  return null
}

export function chosenRendition(plan: RemoteVideoPlan | null, q: VideoQuality): RemoteVideoRendition | null {
  if (!plan || q === 'auto' || q === 'original') return null
  return plan.renditions?.find((r) => r.id === q) ?? null
}

export function readyRendition(plan: RemoteVideoPlan | null, q: VideoQuality): string | null {
  const r = chosenRendition(plan, q)
  return r?.state === 'ready' && r.path ? r.path : null
}

export function makingRendition(plan: RemoteVideoPlan | null, q: VideoQuality): RemoteVideoRendition | null {
  const r = chosenRendition(plan, q)
  return r && r.state !== 'ready' ? r : null
}

function heldText(h: MediaHeld | undefined): string {
  if (!h || !h.bytes || !h.size) return ''
  return done(h) ? ' · on this phone' : ` · ${Math.min(99, Math.floor((h.bytes / h.size) * 100))}% on this phone`
}

function autoText(plan: RemoteVideoPlan, best: boolean): string {
  if (best) return 'Best is on this phone'
  if (effectiveQuality(plan, 'auto') !== 'auto') return '480p on this connection'
  const v = plan.version
  if (!plan.reason || !v) return plan.label
  if (v.state === 'ready') return `phone version · ${v.label ?? 'ready'}`
  if (v.state === 'queued' || v.state === 'preparing') return `phone version · making ${pct(v.progress)}%`
  return plan.plays ? plan.label : "can't play here"
}

function bestText(plan: RemoteVideoPlan, path: string | null): string {
  const v = plan.version
  if (path && path === v?.path) return `${v.lossless ? 'Original, set up for streaming' : 'Phone version'} · ${v.label ?? plan.label}${v.bytes ? ` · ${sizeText(v.bytes)}` : ''}`
  if (path) return `Original · ${plan.label}${plan.bytes ? ` · ${sizeText(plan.bytes)}` : ''}`
  if (v?.state === 'queued' || v?.state === 'preparing') return `phone version · making ${pct(v.progress)}%`
  return `${plan.label} · can't play here`
}

function renditionText(r: RemoteVideoRendition): string {
  const head = `${r.id}p · ${mbps(r.bitrate)} · ${r.state === 'ready' ? '' : '~'}${sizeText(r.bytes)}`
  if (r.state === 'preparing') return `${head} · making ${pct(r.progress)}%`
  if (r.state === 'queued') return `${head} · queued`
  if (r.state === 'failed' || r.state === 'skipped') return `${head} · ${r.note ?? "the desktop couldn't make it"}`
  return head
}

export function qualityOptions(plan: RemoteVideoPlan, held: MediaHeld[], best: string | null): QualityOption[] {
  const hs = heldState(held)
  const at = (p?: string): MediaHeld | undefined => (p ? held.find((h) => h.path === p) : undefined)
  const bestHere = hs.bestDone && !!best && best === hs.best?.path
  const out: QualityOption[] = [
    { value: 'auto', text: `Auto · ${autoText(plan, bestHere)}` },
    { value: 'original', text: `Best · ${bestText(plan, best)}${heldText(at(best ?? undefined))}`, disabled: !best && !(plan.version?.state === 'queued' || plan.version?.state === 'preparing') }
  ]
  for (const id of RENDITION_IDS) {
    const r = plan.renditions?.find((x) => x.id === id)
    const short = plan.width && plan.height ? Math.min(plan.width, plan.height) : 0
    const why = short && short <= Number(id) ? `the video is ${short}p` : 'not made for this video'
    if (!r) out.push({ value: id, text: `${id}p · ${why}`, disabled: true })
    else if (bestHere) out.push({ value: id, text: `${id}p · Best is on this phone`, disabled: true })
    else out.push({ value: id, text: `${renditionText(r)}${heldText(at(r.path))}` })
  }
  return out
}

export function qualityLabel(plan: RemoteVideoPlan | null, q: VideoQuality, auto: boolean): string {
  if (!plan || q === 'auto' || q === 'original') return auto && q !== 'auto' ? `Auto · ${qualityName(q)}` : qualityName(q)
  const short = plan.width && plan.height ? Math.min(plan.width, plan.height) : 0
  if (!chosenRendition(plan, q)) return short ? `${short}p` : qualityName('auto')
  const r = makingRendition(plan, q)
  const name = auto ? `Auto · ${qualityName(q)}` : qualityName(q)
  if (!r) return name
  if (r.state === 'preparing') return `${name} · ${pct(r.progress)}%`
  if (r.state === 'queued') return `${name} · queued`
  return name
}
