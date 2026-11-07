import { useEffect } from 'react'
import type { ScratchpadInfo, ScratchpadPlay, ScratchpadStatus } from '@shared/scratchpads'
import { scratchpadPlayOf } from '@shared/scratchpads'
import { ensureProject, useEffectiveLifecycle, useEffectivePaused, useWorldStore } from '../../lib/unity/world-store'
import { primaryWorldId } from '../../lib/unity/instance-ids'
import { shownScratchpadStatus, useScratchpadAction, type ScratchpadAction } from '../../lib/unity/scratchpads'

export const STATUS_LABEL: Record<ScratchpadStatus, string> = {
  stopped: 'Stopped',
  starting: 'Starting',
  running: 'Running',
  stopping: 'Stopping',
  error: 'Error'
}

export const PLAY_LABEL: Record<ScratchpadPlay, string> = {
  edit: 'Edit Mode',
  entering: 'Entering Play Mode',
  playing: 'Play Mode',
  paused: 'Paused',
  exiting: 'Exiting Play Mode'
}

export function statusDot(status: ScratchpadStatus): string {
  switch (status) {
    case 'running':
      return 'bg-emerald-400'
    case 'starting':
      return 'bg-amber-400 animate-pulse'
    case 'stopping':
      return 'bg-amber-400'
    case 'error':
      return 'bg-red-400'
    default:
      return 'bg-zinc-500'
  }
}

export interface ScratchpadView {
  status: ScratchpadStatus
  play: ScratchpadPlay | null
  action: ScratchpadAction | null
  actionError: string | null
  dot: string
  label: string
  tone: string
}

function viewOf(status: ScratchpadStatus, play: ScratchpadPlay | null, action: ScratchpadAction | null = null, actionError: string | null = null): ScratchpadView {
  return {
    status,
    play,
    action,
    actionError,
    dot: statusDot(status),
    label: play ? PLAY_LABEL[play] : STATUS_LABEL[status],
    tone: play === 'playing' ? 'text-emerald-300/80' : play === 'paused' ? 'text-amber-300/80' : 'text-zinc-500'
  }
}

export function useScratchpadView(projectPath: string, info: ScratchpadInfo, streamed = false): ScratchpadView {
  const { action, error } = useScratchpadAction(projectPath, info.id)
  const status = shownScratchpadStatus(info, action)
  const watched = streamed ? info.path : ''
  const wid = primaryWorldId(info.path)
  const lifecycle = useEffectiveLifecycle(watched, wid)
  const paused = useEffectivePaused(watched, wid)
  const play = status === 'running' ? (scratchpadPlayOf(lifecycle, paused) ?? info.play) : null
  return viewOf(status, play, action, error)
}

const STARTING = new Set(['init', 'launching', 'restarting'])

export function useEditorView(projectPath: string): ScratchpadView {
  useEffect(() => {
    if (projectPath) ensureProject(projectPath)
  }, [projectPath])
  const wid = primaryWorldId(projectPath)
  const status = useWorldStore((s): ScratchpadStatus => {
    const entry = s.worlds[projectPath]
    if (!entry || entry.desired.stopped) return 'stopped'
    const inst = entry.observed.instances[wid] ?? Object.values(entry.observed.instances).find((i) => i.role === 'primary')
    if (!inst || inst.lifecycle === 'exited') return 'stopped'
    if (inst.lifecycle === 'error') return 'error'
    return STARTING.has(inst.lifecycle) ? 'starting' : 'running'
  })
  const lifecycle = useEffectiveLifecycle(projectPath, wid)
  const paused = useEffectivePaused(projectPath, wid)
  return viewOf(status, status === 'running' ? scratchpadPlayOf(lifecycle, paused) : null)
}

export function useEditorProgress(projectPath: string): string {
  return useWorldStore((s) => {
    const entry = s.worlds[projectPath]
    const inst = entry ? Object.values(entry.observed.instances).find((i) => i.role === 'primary') : undefined
    if (!inst?.progressLabel) return ''
    const pct = inst.progressPct >= 0 && !inst.progressLabel.includes('%') ? ` ${Math.round(inst.progressPct)}%` : ''
    return `${inst.progressLabel}${pct}`
  })
}
