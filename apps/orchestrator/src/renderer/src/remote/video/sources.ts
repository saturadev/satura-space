import type { Tab } from '@shared/types'
import { primaryWorldId } from '@shared/unity/ids'
import { tunerSurfaceKey } from '@shared/tuner-frame'
import { useScratchpadPick } from '../../lib/unity/scratchpads'

export function useVideoSource(tab: Tab | null | undefined, worktreePath: string): string | null {
  const kind = tab?.contentType
  const pick = useScratchpadPick(worktreePath, tab?.scratchpadId ?? null)
  if (!tab || !worktreePath) return null
  if (kind === 'unity-instance-player') return primaryWorldId(worktreePath)
  if (kind === 'unity-scratchpad') {
    const sp = pick.selected ?? (tab.scratchpadId ? null : pick.list[0] ?? null)
    return sp ? primaryWorldId(sp.path) : null
  }
  if (kind === 'tuner') {
    const project = tab.scratchpadId ? pick.selected?.path : worktreePath
    return project ? tunerSurfaceKey(project, tab.ptyId) : null
  }
  return null
}
