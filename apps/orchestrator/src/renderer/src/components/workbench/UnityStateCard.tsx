import { useEffect, useState } from 'react'
import { STATE_ACTION_LABELS, stateLabel, stateTitle, type UnityLifecycle, type UnityStateAction } from '@shared/unity/lifecycle'
import { remoteLink } from '../../lib/remote-link'
import { postToShell } from '../../remote/shell-bus'
import { useAppStore } from '../../store'

const PHONE_HIDDEN: ReadonlySet<UnityStateAction> = new Set<UnityStateAction>(['install'])

export function isUnityDown(life: UnityLifecycle | null | undefined): life is UnityLifecycle {
  return !!life && (life.state === 'failed' || life.state === 'exited')
}

function openAnotherProject(phone: boolean): void {
  if (phone) postToShell({ type: 'home' })
  else useAppStore.getState().setActiveWorkspace(null)
}

function runAction(life: UnityLifecycle, action: UnityStateAction, phone: boolean, onOpenProject?: () => void): Promise<void> {
  const project = life.project
  const said = (what: string, r: { ok: boolean; error?: string; note?: string }): void =>
    console.log(`[unity] ${what} ${r.ok ? 'ok' : 'failed'}${r.error ? `: ${r.error}` : r.note ? `: ${r.note}` : ''}`)
  console.log(`[unity] state card ${stateLabel(life)}: ${action} pressed for ${project}`)
  if (action === 'open-project') {
    if (onOpenProject) onOpenProject()
    else openAnotherProject(phone)
    return Promise.resolve()
  }
  if (action === 'install') return window.api.unity.installEditor(project).then((r) => said('install', r))
  if (action === 'start-hub') return window.api.unity.startHub().then((r) => said('start Unity Hub', r))
  if (action === 'close-other')
    return window.api.unity.closeExternalEditor(project, false).then(async (r) => {
      said('close the other Unity', r)
      if (r.ok) said('retry', await window.api.unity.retry(project))
    })
  return window.api.unity.retry(project).then((r) => said('retry', r))
}

export function UnityStateCard({
  life,
  remote = false,
  compact = false,
  onOpenProject,
  onAction
}: {
  life: UnityLifecycle
  remote?: boolean
  compact?: boolean
  onOpenProject?: () => void
  onAction?: (action: UnityStateAction) => void
}) {
  const [busy, setBusy] = useState<UnityStateAction | null>(null)
  useEffect(() => setBusy(null), [life.seq])
  const phone = remote || remoteLink() !== null
  const actions = life.actions.filter((a) => !(phone && PHONE_HIDDEN.has(a)))
  const down = life.state === 'failed'
  const press = (a: UnityStateAction): void => {
    if (busy) return
    setBusy(a)
    onAction?.(a)
    void runAction(life, a, phone, onOpenProject).finally(() => setBusy((b) => (b === a ? null : b)))
  }
  const starting = life.state === 'starting' || life.state === 'stopping'
  const detail = starting ? [life.progress, life.stall].filter(Boolean).join(' · ') : life.error
  return (
    <div
      className={`relative flex flex-col items-center justify-center gap-2 text-center ${compact ? 'max-w-[280px] px-3' : 'max-w-md px-6'}`}
      data-unity-state-card={stateLabel(life)}
      data-unity-state={life.state}
      data-unity-code={life.code}
    >
      {starting ? (
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-white/20 border-t-white/70" />
      ) : (
        <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${down ? 'bg-rose-400' : 'bg-zinc-500'}`} />
      )}
      <p className={`text-sm ${down ? 'text-rose-300' : 'text-zinc-300'}`}>{stateTitle(life)}</p>
      {detail && <p className={`whitespace-pre-line text-xs leading-snug ${down ? 'text-zinc-400' : 'text-zinc-500'} ${compact ? 'line-clamp-6' : 'line-clamp-[10]'}`}>{detail}</p>}
      {phone && down && life.actions.some((a) => PHONE_HIDDEN.has(a)) && (
        <p className="text-xs leading-snug text-zinc-500">{life.code === 'version-missing' ? 'Install it in Unity Hub.' : 'Fix it in Unity Hub.'}</p>
      )}
      {actions.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center justify-center gap-2">
          {actions.map((a, i) => (
            <button
              key={a}
              type="button"
              data-unity-state-action={a}
              disabled={!!busy}
              onClick={() => press(a)}
              className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-xs outline-none transition-colors disabled:opacity-50 ${
                i === 0 ? 'bg-white/10 text-zinc-100 hover:bg-white/15' : 'border border-white/10 text-zinc-300 hover:bg-white/10 hover:text-white'
              }`}
            >
              {busy === a && !phone && <span className="h-3 w-3 animate-spin rounded-full border border-white/30 border-t-white/80" />}
              {STATE_ACTION_LABELS[a]}
              {busy === a && phone && '…'}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
