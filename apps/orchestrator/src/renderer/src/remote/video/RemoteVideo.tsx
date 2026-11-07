import { useEffect, useRef, useState } from 'react'
import { Unplug } from 'lucide-react'
import { GameInput, type GamePlay } from '../game-input/GameInput'
import { StreamMenu, type StreamQuality } from '../game-input/StreamMenu'
import type { FrRect } from '@shared/remote-frame'
import type { RvSettings } from '@shared/remote-video'
import type { ReceiverStats } from './receiver'
import { newVideoTrack, requestVideoKey, restartVideo, setVideoSettings, videoTrouble, watchVideo } from './link'
import { StreamProgress, StreamWait } from './StreamProgress'
import { clearVideoRefusal, onRelayNotice, videoRefusalNow } from '../ws-transport'
import type { RemoteVideoRefusal } from '@shared/remote-protocol'

export interface RemoteVideoProps {
  source: string
  project?: string | null
  scope?: string
  showStats?: boolean
  game?: boolean
  expectFrames?: boolean
  play?: GamePlay
}

const STATS_LOG_MS = 2000
const STUCK_MS = 20_000
const STALL_MS = 3500
const STALL_TRACK_MS = 4000
const STALL_STUCK_MS = 12_000
const STALL_POLL_MS = 400
const DOWN_STATES = new Set(['disconnected', 'failed', 'closed', 'reconnecting'])

type Phase = 'connecting' | 'first-frame' | 'reconnecting' | 'live'

function phaseOf(s: ReceiverStats | null): Phase {
  if (!s) return 'connecting'
  if (s.painted > 0 && s.fps > 0) return 'live'
  if (s.state === 'connected' && s.video === 'connected') return s.painted > 0 ? 'live' : 'first-frame'
  return s.painted > 0 && (DOWN_STATES.has(s.state) || DOWN_STATES.has(s.video)) ? 'reconnecting' : 'connecting'
}

function useStuck(phase: Phase, expect: boolean, source: string): { stuck: string | null; retry: () => void } {
  const [stuck, setStuck] = useState<string | null>(null)
  const [round, setRound] = useState(0)
  const waiting = expect && phase !== 'live'
  useEffect(() => {
    setStuck(null)
    if (!waiting) return
    const t = setTimeout(() => {
      const why = videoTrouble()
      console.warn(`video: ${source} has no picture after ${STUCK_MS / 1000} s: ${why}`)
      setStuck(why)
    }, STUCK_MS)
    return () => clearTimeout(t)
  }, [waiting, round, source])
  const retry = (): void => {
    console.log(`video: Try again on ${source}`)
    restartVideo('Try again on the game stream')
    setRound((n) => n + 1)
  }
  return { stuck, retry }
}

function useStall(last: React.RefObject<ReceiverStats | null>, source: string): { stalled: boolean; stalledStuck: boolean; retryStall: () => void } {
  const [state, setState] = useState<{ stalled: boolean; stuck: boolean }>({ stalled: false, stuck: false })
  const seen = useRef({ painted: 0, at: performance.now(), since: 0, live: false, track: false })
  useEffect(() => {
    const w = seen.current
    w.painted = 0
    w.at = performance.now()
    w.since = 0
    w.live = false
    w.track = false
    setState({ stalled: false, stuck: false })
    const onShown = (): void => {
      if (document.visibilityState === 'visible') w.at = performance.now()
    }
    document.addEventListener('visibilitychange', onShown)
    const t = setInterval(() => {
      const s = last.current
      const now = performance.now()
      if (s && s.painted !== w.painted) {
        w.painted = s.painted
        w.at = now
        if (s.painted > 0) w.live = true
      }
      const quiet = now - w.at
      const stalled = !!s && w.live && s.state === 'connected' && document.visibilityState === 'visible' && quiet > STALL_MS
      if (stalled && !w.since) {
        w.since = now
        w.track = false
        console.log(`video: ${source} stalled, no frame for ${(quiet / 1000).toFixed(1)} s (video ${s?.video ?? '-'}, ${s?.fps ?? 0} fps, mac src=${s?.mac?.link?.video.sourceFps ?? '-'} fps)`)
        requestVideoKey(`no frame for ${(quiet / 1000).toFixed(1)} s`)
      } else if (stalled && !w.track && now - w.since > STALL_TRACK_MS) {
        w.track = true
        newVideoTrack(`still no frame ${((now - w.since) / 1000).toFixed(1)} s after a keyframe request`)
      } else if (!stalled && w.since) {
        console.log(`video: ${source} frames again after ${((now - w.since) / 1000).toFixed(1)} s stalled`)
        w.since = 0
      }
      const stuck = stalled && now - w.since > STALL_STUCK_MS
      setState((prev) => (prev.stalled === stalled && prev.stuck === stuck ? prev : { stalled, stuck }))
    }, STALL_POLL_MS)
    return () => {
      clearInterval(t)
      document.removeEventListener('visibilitychange', onShown)
    }
  }, [last, source])
  const retryStall = (): void => {
    console.log(`video: Try again on a stalled ${source}`)
    seen.current.at = performance.now()
    seen.current.since = 0
    restartVideo('Try again on a stalled game stream')
  }
  return { stalled: state.stalled, stalledStuck: state.stuck, retryStall }
}

function useRefusal(): RemoteVideoRefusal | null {
  const [r, setR] = useState<RemoteVideoRefusal | null>(() => videoRefusalNow())
  useEffect(() => onRelayNotice(() => setR(videoRefusalNow())), [])
  return r
}

function refusalText(r: RemoteVideoRefusal): string {
  if (r.code !== 'quota' || !r.resetAt) return r.reason
  return `${r.reason} It resets on ${new Date(r.resetAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}.`
}

function fmt(n: number | null | undefined, unit = ''): string {
  return n == null ? '–' : `${n}${unit}`
}

function macLine(s: ReceiverStats): string {
  const v = s.mac?.link?.video
  if (!v) return '-'
  return `sent=${v.fps}fps ${v.kbps}kbps target=${fmt(v.targetKbps)} avail=${fmt(v.availableKbps)} limit=${v.limit ?? '-'} src=${v.source ?? '-'} srcFps=${v.sourceFps} ${v.width}x${v.height} ${v.codec ?? '-'} pair=${v.pair}`
}

export function RemoteVideo({ source, project = null, scope, showStats = true, game = false, expectFrames = true, play = { mode: 'busy' } }: RemoteVideoProps): React.JSX.Element {
  const canvas = useRef<HTMLCanvasElement>(null)
  const [canvasEl, setCanvasEl] = useState<HTMLCanvasElement | null>(null)
  useEffect(() => setCanvasEl(canvas.current), [])
  const [stats, setStats] = useState<ReceiverStats | null>(null)
  const [videoRect, setVideoRect] = useState<FrRect | null>(null)
  const [want, setWant] = useState<Partial<RvSettings>>({})
  const last = useRef<ReceiverStats | null>(null)

  useEffect(() => {
    if (!canvas.current) return
    return watchVideo({
      source,
      project,
      canvas: canvas.current,
      onStats: (s) => {
        last.current = s
        setStats(s)
      }
    })
  }, [source])

  useEffect(() => {
    const t = setInterval(() => {
      const s = last.current
      if (!s) return
      console.log(
        `video: stats state=${s.state} video=${s.video} fps=${s.fps} kbps=${s.kbps} step=${s.step} path=${s.path ?? '-'} pathRtt=${fmt(s.pathRtt, 'ms')} latency=${fmt(s.latency, 'ms')} p95=${fmt(s.latencyP95, 'ms')} rtt=${fmt(s.rtt && Math.round(s.rtt), 'ms')} loss=${s.loss}% jitter=${fmt(s.jitter, 'ms')} nack=${s.nack} pli=${s.pli} freezes=${s.freezes} dropped=${s.dropped} failed=${s.failed} ${s.width}x${s.height} ${s.codec ?? '-'} mac{${macLine(s)}} settings=${JSON.stringify(s.settings)}`
      )
    }, STATS_LOG_MS)
    return () => clearInterval(t)
  }, [])

  const cur = stats?.settings
  const pick = (patch: Partial<RvSettings>): void => {
    setWant((w) => ({ ...w, ...patch }))
    setVideoSettings(patch)
  }
  const isPending = <K extends keyof RvSettings>(k: K, v: RvSettings[K]): boolean => want[k] === v && cur?.[k] !== v

  const quality: StreamQuality = { stats, showStats, pick, pending: isPending }
  const phase = phaseOf(stats)
  const { stuck, retry } = useStuck(phase, expectFrames, source)
  const { stalled, stalledStuck, retryStall } = useStall(last, source)
  const showStall = expectFrames && phase === 'live' && stalled
  const refusal = useRefusal()
  const refused = !!refusal && expectFrames && phase !== 'live'
  useEffect(() => {
    if (phase === 'live') clearVideoRefusal()
  }, [phase])

  const progress = <StreamProgress key={phase === 'reconnecting' ? 'again' : 'first'} stats={stats ?? undefined} tag="game stream" />
  const stallWait = <StreamWait tag="game stream" label="No new frames, reconnecting the video…" />
  const status = expectFrames && phase !== 'live' && !refused && !stuck ? progress : showStall && !stalledStuck ? stallWait : null
  return (
    <div className={`relative h-full w-full overflow-hidden bg-black ${game ? 'gi-host' : ''}`} data-video-state={refused ? `refused-${refusal.code}` : stuck ? 'stuck' : showStall ? (stalledStuck ? 'stalled-stuck' : 'stalled') : phase}>
      <canvas
        ref={canvas}
        className={`absolute object-contain transition-opacity duration-300 ${game && videoRect ? '' : 'inset-0 h-full w-full'} ${showStall ? 'opacity-40' : ''}`}
        style={game && videoRect ? { left: videoRect.x, top: videoRect.y, width: videoRect.w, height: videoRect.h } : undefined}
        data-rv-canvas
      />
      {game ? <GameInput source={source} canvas={canvasEl} quality={quality} onFrame={setVideoRect} play={play} scope={scope} status={status} streaming={phase === 'live' && !refused} /> : <StreamMenu canvas={canvasEl} quality={quality} />}
      {refused && (
        <div className="absolute inset-0 z-30 flex items-center justify-center">
          <div data-video-refused={refusal.code} className="flex max-w-[300px] flex-col items-center gap-2 rounded bg-black/75 px-4 py-3 text-center">
            <Unplug className="h-4 w-4 text-zinc-500" />
            <div className="text-[12px] leading-relaxed text-zinc-300">{refusalText(refusal)}</div>
            {refusal.code !== 'quota' && (
              <button
                type="button"
                data-video-retry
                onClick={() => {
                  clearVideoRefusal()
                  retry()
                }}
                className="min-h-9 rounded border border-white/10 bg-white/5 px-4 py-1.5 text-[12px] text-zinc-200 transition-colors hover:bg-white/10 hover:text-white"
              >
                Try again
              </button>
            )}
          </div>
        </div>
      )}
      {expectFrames && phase !== 'live' && !refused && (
        <div className={`absolute z-20 flex items-center justify-center ${game && videoRect ? '' : 'inset-0'} ${stuck ? '' : 'pointer-events-none'}`} style={game && videoRect ? { left: videoRect.x, top: videoRect.y, width: videoRect.w, height: videoRect.h } : undefined}>
          {stuck ? (
            <div data-video-stuck className="flex max-w-[280px] flex-col items-center gap-2 rounded bg-black/70 px-4 py-3 text-center">
              <Unplug className="h-4 w-4 text-zinc-500" />
              <div className="text-[12px] leading-relaxed text-zinc-300">Can't show the game: {stuck}</div>
              <button
                type="button"
                data-video-retry
                onClick={retry}
                className="min-h-9 rounded border border-white/10 bg-white/5 px-4 py-1.5 text-[12px] text-zinc-200 transition-colors hover:bg-white/10 hover:text-white"
              >
                Try again
              </button>
            </div>
          ) : (
            !game && progress
          )}
        </div>
      )}
      {showStall && (
        <div className={`absolute z-20 flex items-center justify-center ${game && videoRect ? '' : 'inset-0'} ${stalledStuck ? '' : 'pointer-events-none'}`} style={game && videoRect ? { left: videoRect.x, top: videoRect.y, width: videoRect.w, height: videoRect.h } : undefined}>
          {stalledStuck ? (
            <div data-video-stalled className="flex max-w-[280px] flex-col items-center gap-2 rounded bg-black/75 px-4 py-3 text-center">
              <Unplug className="h-4 w-4 text-zinc-500" />
              <div className="text-[12px] leading-relaxed text-zinc-300">No new frames from your desktop.</div>
              <button
                type="button"
                data-video-retry
                onClick={retryStall}
                className="min-h-9 rounded border border-white/10 bg-white/5 px-4 py-1.5 text-[12px] text-zinc-200 transition-colors hover:bg-white/10 hover:text-white"
              >
                Try again
              </button>
            </div>
          ) : (
            !game && stallWait
          )}
        </div>
      )}
    </div>
  )
}
