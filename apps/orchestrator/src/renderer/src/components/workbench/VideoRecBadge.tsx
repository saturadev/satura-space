import { useEffect, useState } from 'react'
import type { UnityVideoEvent } from '@shared/api'

const STALE_MS = 3500

function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function VideoRecBadge({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<UnityVideoEvent | null>(null)

  useEffect(() => {
    let staleTimer: number | null = null
    const off = window.api.unity.onVideo((e) => {
      if (e.id !== sessionId) return
      if (staleTimer != null) window.clearTimeout(staleTimer)
      staleTimer = null
      if (!e.active) {
        setState(null)
        return
      }
      setState(e)
      staleTimer = window.setTimeout(() => setState(null), STALE_MS)
    })
    return () => {
      off()
      if (staleTimer != null) window.clearTimeout(staleTimer)
    }
  }, [sessionId])

  if (!state) return null
  const size = `${state.width}×${state.height}`
  return (
    <div
      className="pointer-events-auto absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg border border-white/10 bg-black/75 px-2.5 py-1 text-xs text-zinc-100 shadow-lg backdrop-blur-sm"
      title={`An agent is recording this player. The stream stays at ${size} until the agent calls video.finish() or video.clear().`}
      data-video-rec={state.recording ? 'recording' : 'paused'}
    >
      {state.recording ? (
        <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
      ) : (
        <span className="h-2 w-2 shrink-0 rounded-sm bg-zinc-400" />
      )}
      <span className="font-medium tabular-nums">
        {state.recording ? 'REC' : 'Paused'} {clock(state.seconds)}
      </span>
      {state.audio && <span className="text-zinc-400">with sound</span>}
      <span className="text-zinc-400">· {size}, locked by MCP</span>
    </div>
  )
}
