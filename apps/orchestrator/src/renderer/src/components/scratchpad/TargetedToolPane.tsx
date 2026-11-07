import { Suspense, lazy } from 'react'
import { FlaskConical, Loader2 } from 'lucide-react'
import { useAppStore } from '../../store'
import { useUnityTarget } from '../../lib/unity/unity-target'
import { PaneUnityConsoleSlot } from '../workbench/PaneUnityConsoleSlot'
import { UnityTargetChip } from './UnityTargetChip'
import { UnityTargetChoices } from './UnityTargetChoices'

const PaneTunerSlot = lazy(() => import('../tuner/PaneTunerSlot').then((m) => ({ default: m.PaneTunerSlot })))

export type TargetedToolType = 'unity-console' | 'tuner'

export function isTargetedToolType(t: string): t is TargetedToolType {
  return t === 'unity-console' || t === 'tuner'
}

export function TargetedToolPane({
  contentType,
  tabId,
  ptyId,
  worktreePath,
  scratchpadId
}: {
  contentType: TargetedToolType
  tabId: string
  ptyId: string
  worktreePath: string
  scratchpadId: string | null
}) {
  const target = useUnityTarget(worktreePath, scratchpadId)
  const setTabScratchpad = useAppStore((s) => s.setTabScratchpad)

  if (target.state === 'loading') {
    return (
      <div className="flex h-full items-center justify-center bg-canvas">
        <Loader2 className="h-4 w-4 animate-spin text-zinc-500" />
      </div>
    )
  }

  if (target.state === 'missing') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas px-6 text-center" data-scratchpad-missing={scratchpadId ?? ''}>
        <FlaskConical className="h-6 w-6 text-violet-400" />
        <p className="max-w-sm text-sm text-zinc-400">
          This tab&apos;s scratchpad was deleted.
        </p>
        <button
          type="button"
          onClick={() => setTabScratchpad(tabId, null)}
          className="rounded border border-white/10 bg-white/5 px-4 py-2 text-sm text-zinc-200 transition-colors hover:bg-white/10 hover:text-white"
        >
          Switch to the project
        </button>
      </div>
    )
  }

  const { projectPath, scratchpad, list } = target
  const chip =
    list.length > 0 || scratchpad ? <UnityTargetChip tabId={tabId} projectPath={worktreePath} list={list} scratchpad={scratchpad} /> : null

  if (contentType === 'unity-console') {
    return <PaneUnityConsoleSlot key={projectPath} id={ptyId} projectPath={projectPath} scratchpad={scratchpad} targetChip={chip} />
  }
  return (
    <Suspense fallback={<div className="h-full bg-canvas" />}>
      <PaneTunerSlot
        key={projectPath}
        tabId={tabId}
        ptyId={ptyId}
        projectPath={projectPath}
        scratchpad={scratchpad}
        targetChip={chip}
        targetChoices={<UnityTargetChoices tabId={tabId} projectPath={worktreePath} list={list} scratchpad={scratchpad} />}
      />
    </Suspense>
  )
}
