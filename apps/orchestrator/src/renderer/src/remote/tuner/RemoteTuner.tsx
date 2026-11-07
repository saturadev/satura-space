import { useEffect, useRef, useState } from 'react'
import { Unplug } from 'lucide-react'
import type { Tab } from '@shared/types'
import { TargetedToolPane } from '../../components/scratchpad/TargetedToolPane'
import { restartVideo, setVideoCanvas, watchVideo } from '../video/link'
import type { ReceiverStats } from '../video/receiver'
import { phoneTunerSurface, phoneTunerWait, resetPhoneTunerWait } from './platform'
import { useVideoSource } from '../video/sources'
import { PendingState } from '../../components/ui/PendingState'
import { StreamProgress, StreamWait } from '../video/StreamProgress'
import { connectionState, onConnectionState, type ConnectionState } from '../ws-transport'
import { isUnityDown } from '../../components/workbench/UnityStateCard'
import { useUnityLifecycle } from '../../lib/unity/lifecycle-store'
import './tuner.css'

const STATS_LOG_MS = 5000
const CHIP_POLL_MS = 400
const STALL_MS = 3500
const UNITY_STALL_MS = 3000
const STUCK_MS = 12_000

type VideoPhase = 'connecting' | 'first-frame' | 'reconnecting' | 'live' | 'stalled' | 'unity-stalled'

const VIDEO_LABEL: Record<'stalled' | 'unity-stalled', string> = {
  stalled: 'Stream stalled. Reconnecting…',
  'unity-stalled': "Unity isn't drawing new frames…"
}

const STALLS = new Set<VideoPhase>(['stalled', 'unity-stalled'])

const DOWN_STATES = new Set(['disconnected', 'failed', 'closed', 'reconnecting'])

function relayLabel(s: ConnectionState): string | null {
  return s === 'connecting' || s === 'offline' ? 'Reconnecting to the desktop…' : null
}

export function RemoteTuner({ tab, worktreePath }: { tab: Tab; worktreePath: string }): React.JSX.Element {
  const root = useRef<HTMLDivElement>(null)
  const source = useVideoSource(tab, worktreePath)
  const unityDown = isUnityDown(useUnityLifecycle(tab.scratchpadId ? null : worktreePath))
  const [chip, setChip] = useState<{ phase: VideoPhase; x: number; y: number; stuck: boolean } | null>(null)
  const retryRef = useRef<() => void>(() => {})
  const [relay, setRelay] = useState(() => relayLabel(connectionState().state))
  const relayRef = useRef(relay)

  useEffect(
    () =>
      onConnectionState((s) => {
        const next = relayLabel(s)
        if (next === relayRef.current) return
        relayRef.current = next
        console.log(`[tuner] phone relay ${next ? `down: ${s}` : 'back online'}`)
        setRelay(next)
      }),
    []
  )

  useEffect(() => {
    const el = root.current
    if (!el || !source) return
    const find = (): HTMLCanvasElement | null => {
      for (const c of el.querySelectorAll<HTMLCanvasElement>('canvas[data-unity-session]')) if (c.dataset.unitySession === source) return c
      return null
    }
    let seen = 0
    let phase: VideoPhase = 'connecting'
    let everLive = false
    let netState = 'new'
    let painted = 0
    let paintedAt = performance.now()
    let stalledAt = 0
    let lastStats: ReceiverStats | null = null
    const dim = (on: boolean): void => {
      for (const c of el.querySelectorAll<HTMLCanvasElement>('canvas[data-unity-session]')) {
        if (on && c.dataset.unitySession === source) c.setAttribute('data-stream-stalled', '')
        else c.removeAttribute('data-stream-stalled')
      }
    }
    const busy = (): boolean => !!el.querySelector('[data-tuner-loading], [data-tuner-neutral]')
    const place = (): void => {
      const c = find()
      dim(STALLS.has(phase) && !!c && !busy())
      if (phase === 'live' || !c || busy()) {
        setChip(null)
        return
      }
      const r = c.getBoundingClientRect()
      const o = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) {
        setChip(null)
        return
      }
      const stuck = STALLS.has(phase) && stalledAt > 0 && performance.now() - stalledAt > STUCK_MS
      setChip((prev) => {
        const x = Math.round(r.left - o.left + r.width / 2)
        const y = Math.round(r.top - o.top + r.height / 2)
        return prev && prev.phase === phase && prev.x === x && prev.y === y && prev.stuck === stuck ? prev : { phase, x, y, stuck }
      })
    }
    const setPhase = (next: VideoPhase, why: string): void => {
      if (next === phase) return
      const was = phase
      console.log(`[tuner] phone scene video ${was} -> ${next} (${why})`)
      phase = next
      if (next === 'live') everLive = true
      if (STALLS.has(next) && !STALLS.has(was)) {
        stalledAt = performance.now()
        phoneTunerSurface()
      } else if (!STALLS.has(next)) {
        if (STALLS.has(was) && next === 'live') console.log(`[tuner] phone scene video recovered after ${((performance.now() - stalledAt) / 1000).toFixed(1)} s stalled`)
        stalledAt = 0
      }
      place()
    }
    const judge = (): void => {
      if (document.visibilityState !== 'visible' || !everLive || netState !== 'connected' || busy()) return
      const now = performance.now()
      const quiet = now - paintedAt
      const { waited, idle } = phoneTunerWait()
      if (quiet > STALL_MS) setPhase('stalled', `no frame for ${(quiet / 1000).toFixed(1)} s, ${lastStats?.fps ?? 0} fps, mac src=${lastStats?.mac?.link?.video.sourceFps ?? '-'} fps`)
      else if (waited > UNITY_STALL_MS && (idle < UNITY_STALL_MS || phase === 'unity-stalled')) setPhase('unity-stalled', `no new Unity frame ${(waited / 1000).toFixed(1)} s after a camera or handle move, mac src=${lastStats?.mac?.link?.video.sourceFps ?? '-'} fps`)
      else if (STALLS.has(phase)) setPhase('live', `frames again, ${lastStats?.fps ?? 0} fps`)
    }
    const tick = (): void => {
      judge()
      place()
    }
    const poll = setInterval(tick, CHIP_POLL_MS)
    const onShown = (): void => {
      if (document.visibilityState !== 'visible') return
      paintedAt = performance.now()
      resetPhoneTunerWait()
    }
    document.addEventListener('visibilitychange', onShown)
    retryRef.current = () => {
      console.log(`[tuner] Try again on a stalled scene view (${phase})`)
      paintedAt = performance.now()
      stalledAt = performance.now()
      resetPhoneTunerWait()
      restartVideo('Try again on a stalled scene view')
      phoneTunerSurface()
      place()
    }
    const viewer = {
      source,
      project: worktreePath,
      canvas: find(),
      onStats: (s: ReceiverStats) => {
        netState = s.state === 'connected' && s.video !== 'connected' ? `video ${s.video}` : s.state
        lastStats = s
        if (s.painted !== painted) {
          painted = s.painted
          paintedAt = performance.now()
        }
        if (netState === 'connected') {
          if (!STALLS.has(phase)) setPhase(s.painted > 0 || phase === 'live' ? 'live' : 'first-frame', `${s.state}, ${s.fps} fps`)
          judge()
        } else setPhase((DOWN_STATES.has(s.state) || DOWN_STATES.has(s.video)) && everLive ? 'reconnecting' : 'connecting', netState)
        if (performance.now() - seen < STATS_LOG_MS) return
        seen = performance.now()
        console.log(`[tuner] phone scene view ${s.width}x${s.height} ${s.fps} fps latency=${s.latency ?? '-'}ms p95=${s.latencyP95 ?? '-'}ms mac src=${s.mac?.link?.video.sourceFps ?? '-'} fps`)
      }
    }
    const stop = watchVideo(viewer)
    const mo = new MutationObserver(() => {
      const c = find()
      if (c !== viewer.canvas) setVideoCanvas(viewer, c)
    })
    mo.observe(el, { childList: true, subtree: true })
    console.log(`[tuner] phone scene video ${phase} (${netState}) for ${source}`)
    place()
    return () => {
      clearInterval(poll)
      document.removeEventListener('visibilitychange', onShown)
      mo.disconnect()
      stop()
      dim(false)
      retryRef.current = () => {}
      setChip(null)
    }
  }, [source])

  useEffect(() => {
    let last = ''
    const note = (): void => {
      const now = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait'
      if (now === last) return
      last = now
      console.log(`[tuner] phone ${now} ${window.innerWidth}x${window.innerHeight}`)
    }
    note()
    window.addEventListener('resize', note)
    return () => window.removeEventListener('resize', note)
  }, [])

  return (
    <div ref={root} className="remote-tuner relative h-full w-full" data-remote-tuner={tab.id}>
      <TargetedToolPane contentType="tuner" tabId={tab.id} ptyId={tab.ptyId} worktreePath={worktreePath} scratchpadId={tab.scratchpadId ?? null} />
      {relay && (
        <div className="pointer-events-none absolute inset-x-0 top-2 z-40 flex justify-center" data-tuner-relay-state={relay}>
          <PendingState tag="relay" label={relay} className="rounded-full bg-black/70 px-3 py-1.5" />
        </div>
      )}
      {!relay && !unityDown && chip && chip.phase !== 'live' && (
        <div
          className={`absolute z-30 -translate-x-1/2 -translate-y-1/2 ${chip.stuck ? '' : 'pointer-events-none'}`}
          style={{ left: chip.x, top: chip.y }}
          data-tuner-video-state={chip.stuck ? 'stuck' : chip.phase}
        >
          {chip.stuck ? (
            <div data-tuner-video-stuck className="flex w-[240px] flex-col items-center gap-2 rounded bg-black/75 px-4 py-3 text-center">
              <Unplug className="h-4 w-4 text-zinc-500" />
              <div className="text-[12px] leading-relaxed text-zinc-300">
                {chip.phase === 'unity-stalled' ? "Unity stopped drawing the scene view. It may be busy." : 'No new frames from your desktop.'}
              </div>
              <button
                type="button"
                data-tuner-video-retry
                onClick={() => retryRef.current()}
                className="min-h-9 rounded border border-white/10 bg-white/5 px-4 py-1.5 text-[12px] text-zinc-200 transition-colors hover:bg-white/10 hover:text-white"
              >
                Try again
              </button>
            </div>
          ) : (
            chip.phase === 'stalled' || chip.phase === 'unity-stalled' ? <StreamWait key={chip.phase} tag="scene video" label={VIDEO_LABEL[chip.phase]} /> : <StreamProgress key={chip.phase === 'reconnecting' ? 'again' : 'first'} tag="scene video" />
          )}
        </div>
      )}
    </div>
  )
}
