import { useEffect, useRef, useState } from 'react'
import type { HubState } from '@shared/api'
import type { UnityLifecycle } from '@shared/unity/lifecycle'
import { useUnityLifecycle } from '../../lib/unity/lifecycle-store'
import { remoteLink } from '../../lib/remote-link'
import { ProgressBar } from '../../remote/motion'

const START_WAIT_MS = 45_000
const HUB_DOWNLOAD_URL = 'https://unity.com/download'

function Waiting() {
  if (remoteLink() !== null) return <ProgressBar value={null} className="h-[3px] w-[160px]" />
  return <div className="h-5 w-5 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
}

export function useHubState(projectPath: string, enabled: boolean): HubState | null {
  const life = useUnityLifecycle(enabled && projectPath ? projectPath : null)
  return enabled ? (life?.hub ?? null) : null
}

export function UnityHubCard({
  state,
  compact = false
}: {
  state: Exclude<HubState, 'ready'>
  compact?: boolean
}) {
  const [clickedAt, setClickedAt] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [, setTick] = useState(0)
  useEffect(() => {
    if (!clickedAt) return
    const t = window.setTimeout(() => setTick((n) => n + 1), START_WAIT_MS)
    return () => window.clearTimeout(t)
  }, [clickedAt])
  const waitingOnClick = state === 'not-running' && clickedAt > 0 && Date.now() - clickedAt < START_WAIT_MS
  const shown = waitingOnClick ? 'starting' : state
  const timedOut = state === 'not-running' && clickedAt > 0 && !waitingOnClick

  const start = (): void => {
    setError(null)
    setClickedAt(Date.now())
    void window.api.unity.startHub().then((r) => {
      if (!r.ok) {
        setClickedAt(0)
        setError(r.error ?? "Unity Hub didn't start.")
      }
    })
  }

  const title =
    shown === 'starting'
      ? 'Starting Unity Hub…'
      : shown === 'not-installed'
        ? "Unity Hub isn't installed"
        : shown === 'signed-out'
          ? "Unity Hub isn't signed in"
          : "Unity Hub isn't running"
  const body =
    shown === 'starting'
      ? 'The editor opens once Hub is up.'
      : shown === 'not-installed'
        ? 'Unity needs Unity Hub to check your license. Install it and sign in, then come back here.'
        : shown === 'signed-out'
          ? 'Unity needs a signed-in Unity Hub to check your license. Sign in to Hub and the editor opens by itself.'
          : 'Unity needs Unity Hub to check your license. Start Hub and the editor opens by itself.'
  const note = error ?? (timedOut ? "Unity Hub still isn't running. Try again, or open it yourself." : null)

  return (
    <div
      data-unity-hub={shown}
      className={`pointer-events-auto relative flex flex-col items-center text-center ${compact ? 'max-w-[240px] gap-2 px-4' : 'max-w-sm gap-3 px-6'}`}
    >
      {shown === 'starting' ? (
        <Waiting />
      ) : (
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400" />
      )}
      <p className={compact ? 'text-xs text-zinc-200' : 'text-sm text-zinc-200'}>{title}</p>
      <p className={`leading-snug text-zinc-500 ${compact ? 'text-[11px]' : 'text-xs'}`}>{body}</p>
      {note && <p className="text-[11px] leading-snug text-rose-300">{note}</p>}
      {shown === 'not-running' && (
        <button
          onClick={start}
          className="mt-1 rounded border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-100 outline-none transition-colors hover:bg-white/15 hover:text-white"
        >
          Start Unity Hub
        </button>
      )}
      {shown === 'signed-out' && (
        <button
          onClick={() => void window.api.unity.startHub()}
          className="mt-1 rounded border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-100 outline-none transition-colors hover:bg-white/15 hover:text-white"
        >
          Open Unity Hub
        </button>
      )}
      {shown === 'not-installed' && (
        <button
          onClick={() => void window.api.shell.openExternal(HUB_DOWNLOAD_URL)}
          className="mt-1 rounded border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-100 outline-none transition-colors hover:bg-white/15 hover:text-white"
        >
          Download Unity Hub
        </button>
      )}
    </div>
  )
}

export function UnityHubBlockedView({
  projectPath,
  initial,
  onReady
}: {
  projectPath: string
  initial: Exclude<HubState, 'ready'>
  onReady: () => void
}) {
  const live = useHubState(projectPath, true)
  const fired = useRef(false)
  useEffect(() => {
    if (live !== 'ready' || fired.current) return
    fired.current = true
    console.log('[unity] Unity Hub is ready, launching the editor')
    onReady()
  }, [live, onReady])
  const state = live && live !== 'ready' ? live : initial
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-canvas">
      {live === 'ready' ? (
        <Waiting />
      ) : (
        <UnityHubCard state={state} />
      )}
    </div>
  )
}

export function UnityVersionCard({ life, compact = false }: { life: UnityLifecycle; compact?: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const [asked, setAsked] = useState(false)
  const installing = life.phase === 'installing' && !!life.install
  const pct = installing && life.install && life.install.pct >= 0 ? Math.round(life.install.pct) : null
  const title = installing
    ? `Installing Unity ${life.version}…`
    : `Unity ${life.version} isn't installed`
  const body = installing
    ? `${life.install?.state === 'installing' ? 'Unity Hub is installing it' : life.install?.state === 'queued' ? 'Unity Hub has it queued' : 'Unity Hub is downloading it'}. The editor opens by itself when it's done.`
    : `This project needs Unity ${life.version}. ${life.editors.length ? `You have ${life.editors.join(', ')}.` : 'No Unity editors are installed.'} Install it in Unity Hub and the editor opens by itself.`
  const install = (): void => {
    setError(null)
    setAsked(true)
    void window.api.unity.installEditor(life.project).then((r) => {
      if (!r.ok) {
        setAsked(false)
        setError(r.error ?? "Unity Hub didn't open.")
      }
    })
  }
  return (
    <div
      data-unity-editor={life.phase}
      className={`pointer-events-auto relative flex flex-col items-center text-center ${compact ? 'max-w-[240px] gap-2 px-4' : 'max-w-sm gap-3 px-6'}`}
    >
      {installing ? (
        <Waiting />
      ) : (
        <span className="h-2.5 w-2.5 shrink-0 rounded-full bg-amber-400" />
      )}
      <p className={compact ? 'text-xs text-zinc-200' : 'text-sm text-zinc-200'}>{title}</p>
      <p className={`leading-snug text-zinc-500 ${compact ? 'text-[11px]' : 'text-xs'}`}>{body}</p>
      {installing && pct !== null && (
        <div className="h-1 w-40 overflow-hidden rounded-full bg-white/10">
          <div className="h-full rounded-full bg-white/60 transition-[width]" style={{ width: `${pct}%` }} />
        </div>
      )}
      {installing && pct !== null && <p className="text-[11px] tabular-nums text-zinc-500">{pct}%</p>}
      {error && <p className="text-[11px] leading-snug text-rose-300">{error}</p>}
      {!installing && (
        <button
          onClick={install}
          className="mt-1 rounded border border-white/10 bg-white/[0.06] px-3 py-1.5 text-xs text-zinc-100 outline-none transition-colors hover:bg-white/15 hover:text-white"
        >
          {asked ? 'Open Unity Hub again' : 'Install in Unity Hub'}
        </button>
      )}
    </div>
  )
}

export function UnityVersionView({ life }: { life: UnityLifecycle }) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center bg-canvas">
      <UnityVersionCard life={life} />
    </div>
  )
}
