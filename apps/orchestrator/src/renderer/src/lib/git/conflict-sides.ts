import type { ScmConflictKind, ScmConflictSides } from '@shared/git-scm'

export function conflictSideNames(kind: ScmConflictKind): { current: string; incoming: string } {
  if (kind === 'rebase') return { current: 'the branch you rebase onto', incoming: 'your commit' }
  if (kind === 'stash') return { current: 'your branch', incoming: 'your stash' }
  if (kind === 'cherryPick') return { current: 'your branch', incoming: 'cherry-picked commit' }
  if (kind === 'revert') return { current: 'your branch', incoming: 'revert' }
  return { current: 'your branch', incoming: 'the other branch' }
}

export function conflictGroupLabel(sides: ScmConflictSides | undefined): string {
  if (!sides) return 'Merge Conflicts'
  if (sides.kind === 'stash') return 'Conflicts from Stash'
  if (sides.kind === 'rebase') return 'Rebase Conflicts'
  if (sides.kind === 'cherryPick') return 'Cherry-Pick Conflicts'
  if (sides.kind === 'revert') return 'Revert Conflicts'
  return 'Merge Conflicts'
}
