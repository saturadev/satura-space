import type { StateCreator } from 'zustand'
import type { AppState } from '../index'

export type WorkspaceOverlayPhase = 'idle' | 'entering' | 'holding' | 'leaving'

export interface WorkspaceOverlaySlice {
  overlayPhase: WorkspaceOverlayPhase
  overlayMounted: boolean
  overlayWorkSettled: boolean
  overlayCommit: (() => void) | null

  beginWorkspaceOverlay: () => void
  settleWorkspaceOverlay: (commit?: () => void) => void

  setOverlayMounted: (mounted: boolean) => void
  overlayEntered: () => void
  overlayLeft: () => void
}

const CLEARED = { overlayWorkSettled: false, overlayCommit: null } as const

export const createWorkspaceOverlaySlice: StateCreator<AppState, [], [], WorkspaceOverlaySlice> = (
  set,
  get
) => {
  const commitThen = (commit: (() => void) | null | undefined, next: WorkspaceOverlayPhase) => {
    set(CLEARED)
    try {
      commit?.()
    } finally {
      set({ overlayPhase: next })
    }
  }

  return {
    overlayPhase: 'idle',
    overlayMounted: false,
    overlayWorkSettled: false,
    overlayCommit: null,

    beginWorkspaceOverlay: () => set({ overlayPhase: 'entering', ...CLEARED }),

    settleWorkspaceOverlay: (commit) => {
      const { overlayPhase, overlayMounted } = get()
      if (overlayPhase === 'entering' && overlayMounted) {
        set({ overlayWorkSettled: true, overlayCommit: commit ?? null })
        return
      }
      if (overlayPhase === 'holding') commitThen(commit, 'leaving')
      else if (overlayPhase === 'entering') commitThen(commit, 'idle')
      else commitThen(commit, overlayPhase)
    },

    setOverlayMounted: (mounted) => {
      set({ overlayMounted: mounted })
      const { overlayPhase, overlayWorkSettled, overlayCommit } = get()
      if (mounted || overlayPhase === 'idle' || !overlayWorkSettled) return
      commitThen(overlayCommit, 'idle')
    },

    overlayEntered: () => {
      const { overlayPhase, overlayWorkSettled, overlayCommit } = get()
      if (overlayPhase !== 'entering') return
      if (!overlayWorkSettled) {
        set({ overlayPhase: 'holding' })
        return
      }
      commitThen(overlayCommit, 'leaving')
    },

    overlayLeft: () => {
      if (get().overlayPhase !== 'leaving') return
      set({ overlayPhase: 'idle', ...CLEARED })
    }
  }
}
