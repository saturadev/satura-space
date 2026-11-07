import type { ScratchpadInfo } from '@shared/scratchpads'
import { useScratchpadPick } from './scratchpads'

export type UnityTarget =
  | { state: 'project'; projectPath: string; scratchpad: null; list: ScratchpadInfo[] }
  | { state: 'ready'; projectPath: string; scratchpad: ScratchpadInfo; list: ScratchpadInfo[] }
  | { state: 'loading' | 'missing'; projectPath: ''; scratchpad: null; list: ScratchpadInfo[] }

export function useUnityTarget(worktreePath: string, scratchpadId: string | null | undefined): UnityTarget {
  const { list, missing, selected } = useScratchpadPick(worktreePath, scratchpadId)
  if (!scratchpadId) return { state: 'project', projectPath: worktreePath, scratchpad: null, list }
  if (selected) return { state: 'ready', projectPath: selected.path, scratchpad: selected, list }
  return { state: missing || !worktreePath ? 'missing' : 'loading', projectPath: '', scratchpad: null, list }
}
