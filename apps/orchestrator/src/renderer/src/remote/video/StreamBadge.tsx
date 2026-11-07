import { useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { Layer, Presence } from '../motion'
import { RV_PRESETS, type RvPreset } from '@shared/remote-video'
import type { ReceiverStats } from './receiver'
import { PATH_TEXT } from './steps'
import { setVideoSettings, useVideoStats } from './link'

type Level = 0 | 1 | 2 | 3 | 4

const openers = new Set<() => void>()

export function openStreamDetails(): void {
  for (const o of openers) o()
}

const LEVEL_COLOR = ['text-ink-4', 'text-err', 'text-warn', 'text-ok', 'text-ok']

export function rttOf(s: ReceiverStats | null): number | null {
  const r = s?.rtt ?? s?.pathRtt
  return r == null ? null : Math.round(r)
}

export function signal(s: ReceiverStats | null): { level: Level; word: string } {
  if (!s || s.state !== 'connected' || s.video !== 'connected' || !s.painted) return { level: 0, word: s?.state === 'connected' ? (s.painted && s.video !== 'connected' ? 'Reconnecting video' : 'Starting') : 'Connecting' }
  const lag = Math.max(rttOf(s) ?? 0, s.latency ?? 0)
  const sent = s.mac?.link?.video.fps ?? 0
  const kept = sent > 5 ? s.fps / sent : 1
  if (lag > 300 || s.loss > 10 || kept < 0.4) return { level: 1, word: 'Weak connection' }
  if (lag > 150 || s.loss > 4 || kept < 0.7) return { level: 2, word: 'Fair connection' }
  if (lag > 70 || s.loss > 1) return { level: 3, word: 'Good connection' }
  return { level: 4, word: 'Great connection' }
}

function Bars({ level }: { level: Level }): React.JSX.Element {
  return (
    <svg width="14" height="12" viewBox="0 0 14 12" className={LEVEL_COLOR[level]} aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <rect key={i} x={i * 3.6} y={9 - i * 3} width="2.4" height={3 + i * 3} rx="0.8" fill="currentColor" opacity={i < level ? 1 : 0.25} />
      ))}
    </svg>
  )
}

function routeText(s: ReceiverStats | null): string {
  if (!s || s.state !== 'connected') return 'No direct link yet, calls go through the relay server (WebSocket)'
  if (s.path === 'turn') return 'Through a TURN relay'
  return s.path ? PATH_TEXT[s.path] : 'Connecting'
}

function networkType(): string {
  const c = (navigator as Navigator & { connection?: { type?: string; effectiveType?: string } }).connection
  if (!c) return 'Unknown'
  const kind = c.type === 'wifi' ? 'Wi-Fi' : c.type === 'cellular' ? 'Cellular' : c.type && c.type !== 'unknown' ? c.type : ''
  return [kind, c.effectiveType ? `${c.effectiveType.toUpperCase()} speed class` : ''].filter(Boolean).join(', ') || 'Unknown'
}

function advice(s: ReceiverStats | null, level: Level): { text: string; preset?: RvPreset } | null {
  if (!s?.painted) return null
  const preset = s.settings?.preset
  if (level === 1 && preset === 'smooth') return { text: 'Still weak: Data saver uses less data', preset: 'saver' }
  if (level > 0 && level <= 2 && preset !== 'smooth' && preset !== 'saver') return { text: 'Switch to Smooth for fewer stutters', preset: 'smooth' }
  if (s.path === 'turn') return { text: 'Going through a relay server. The same Wi-Fi as the desktop gives a direct route.' }
  if (level >= 3 && (preset === 'smooth' || preset === 'saver')) return { text: 'The connection is good again', preset: 'auto' }
  return null
}

const ms = (n: number | null | undefined): string => (n == null ? '–' : `${Math.round(n)} ms`)

function sections(s: ReceiverStats | null): [string, [string, string][]][] {
  const p = s?.pair
  const mac = s?.mac?.link?.video
  return [
    [
      'Route',
      [
        ['Path', routeText(s)],
        ['Protocol', p ? `${p.protocol.toUpperCase()}${p.relay ? ` (relay over ${p.relay.toUpperCase()})` : ''}` : '–'],
        ['Candidates', p ? `${p.local} ↔ ${p.remote}` : '–'],
        ['Network', networkType()]
      ]
    ],
    [
      'Video',
      [
        ['Picture', s?.settings ? `${RV_PRESETS[s.settings.preset].label}${s.settings.filter === 'pixel' ? ', pixel art' : ''}` : '–'],
        ['Codec', s?.codec ? `${s.codec === 'H264' ? 'H.264' : s.codec}${mac?.hardware === true ? ', hardware encoder' : mac?.hardware === false ? ', software encoder' : ''}` : '–'],
        ['Resolution', s?.width ? `${s.width}×${s.height}` : '–'],
        ['Frames', s ? `${s.fps} per second` : '–'],
        ['Bitrate', s ? (s.kbps >= 1000 ? `${(s.kbps / 1000).toFixed(1)} Mbit/s` : `${s.kbps} kbit/s`) : '–'],
        ['Transport', s?.video === 'connected' ? 'WebRTC video track, encrypted end to end' : (s?.video ?? '–')]
      ]
    ],
    [
      'Quality',
      [
        ['Round trip', ms(rttOf(s))],
        ['Network round trip', ms(s?.pathRtt)],
        ['Delay to screen', s?.latency != null ? `${ms(s.latency)}, p95 ${ms(s.latencyP95)}` : '–'],
        ['Jitter buffer', ms(s?.jitter)],
        ['Packet loss', s ? `${s.loss}% now` : '–'],
        ['Freezes', s ? `${s.freezes}, ${s.dropped} frames dropped` : '–'],
        ['Recoveries', s ? `${s.nack} packets resent, ${s.pli} keyframe requests` : '–']
      ]
    ]
  ]
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    const t = document.createElement('textarea')
    t.value = text
    document.body.appendChild(t)
    t.select()
    const ok = document.execCommand('copy')
    t.remove()
    return ok
  }
}

export function StreamBadge({ stats: given, size = 30 }: { stats?: ReceiverStats | null; size?: number }): React.JSX.Element {
  const live = useVideoStats()
  const stats = given === undefined ? live : given
  const [open, setOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  useEffect(() => {
    const show = (): void => setOpen(true)
    openers.add(show)
    return () => {
      openers.delete(show)
    }
  }, [])
  const sig = signal(stats)
  const rtt = rttOf(stats)
  const tip = advice(stats, sig.level)
  const groups = sections(stats)
  const copy = async (): Promise<void> => {
    const text = [`Satura Remote stream: ${sig.word}${tip ? ` (${tip.text})` : ''}`, ...groups.flatMap(([title, rows]) => [`${title}:`, ...rows.map(([k, v]) => `  ${k}: ${v}`)]), `Settings: ${JSON.stringify(stats?.settings ?? null)}`, `At: ${new Date().toISOString()}`].join('\n')
    const ok = await copyText(text)
    console.info(`[stream-badge] diagnostics ${ok ? 'copied' : 'not copied'}, ${text.length} chars`)
    setCopied(ok)
  }
  return (
    <>
      <button
        type="button"
        tabIndex={-1}
        className="ws-glass ws-press relative flex shrink-0 flex-col items-center justify-center gap-[1px] rounded-full font-mono tabular-nums leading-none text-[var(--ws-label2)] before:absolute before:-inset-[7px] before:content-['']"
        style={{ width: size, height: size, fontSize: Math.max(7.5, size * 0.27) }}
        aria-label={`${sig.word}. Details`}
        aria-expanded={open}
        data-rv-badge={sig.level}
        data-rv-path={stats?.path ?? ''}
        data-rv-rtt={rtt ?? ''}
        data-rv-fps={stats?.fps ?? ''}
        data-rv-size={stats?.width ? `${stats.width}x${stats.height}` : ''}
        data-rv-kbps={stats?.kbps ?? ''}
        data-rv-loss={stats?.loss ?? ''}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={() => {
          setCopied(false)
          setOpen(!open)
        }}
      >
        <Bars level={sig.level} />
        <span>{rtt == null ? '–' : rtt}</span>
      </button>
      <Presence when={open}>
        {() => (
          <Layer className="z-[1200] flex flex-col justify-end" data-rv-badge-layer>
            <button type="button" aria-label="Close" className="ws-fade-in absolute inset-0 bg-black/55" onClick={() => setOpen(false)} />
            <div
              className="ws-sheet relative mx-auto flex w-full max-w-[560px] flex-col gap-3 overflow-y-auto rounded-t-[22px] bg-[#1c1c1e] px-4 pt-3 text-ink-2"
              style={{ maxHeight: 'min(80dvh, calc(var(--ws-vv-h) - env(safe-area-inset-top) - 12px))', paddingBottom: 'max(14px, env(safe-area-inset-bottom))' }}
              data-rv-badge-details
            >
              <div className="flex items-center gap-2">
                <Bars level={sig.level} />
                <span className="flex-1 text-[15px] font-semibold text-ink">{sig.word}</span>
                <button type="button" aria-label="Close" className="flex h-8 w-8 items-center justify-center rounded-full bg-white/[0.08]" onClick={() => setOpen(false)}>
                  <X size={15} />
                </button>
              </div>
              {tip && (
                <div className="flex items-center gap-3 rounded-xl bg-white/[0.06] px-3 py-2" data-rv-advice>
                  <span className="flex-1 text-[12.5px] leading-snug text-ink">{tip.text}</span>
                  {tip.preset && (
                    <button
                      type="button"
                      className="shrink-0 rounded-full bg-accent px-3 py-1.5 text-[12.5px] font-semibold text-accent-fg"
                      data-rv-advice-action={tip.preset}
                      onClick={() => {
                        console.info(`[stream-badge] switch to ${tip.preset} from the connection card`)
                        setVideoSettings({ preset: tip.preset })
                      }}
                    >
                      {tip.preset === 'auto' ? 'Use Auto' : 'Switch'}
                    </button>
                  )}
                </div>
              )}
              {groups.map(([title, rows]) => (
                <section key={title} className="flex flex-col gap-1" data-rv-section={title}>
                  <span className="text-[11px] uppercase tracking-wide text-ink-3">{title}</span>
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-[12px]">
                    {rows.map(([k, v]) => (
                      <div key={k} className="contents">
                        <dt className="text-ink-3">{k}</dt>
                        <dd className="text-right tabular-nums text-ink-2">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </section>
              ))}
              <button type="button" className="mt-1 h-10 rounded-xl bg-white/[0.08] text-[13px] font-medium text-ink" onClick={() => void copy()} data-rv-copy>
                {copied ? 'Copied' : 'Copy diagnostics'}
              </button>
            </div>
          </Layer>
        )}
      </Presence>
    </>
  )
}
