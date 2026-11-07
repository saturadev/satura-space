import type { StateCreator } from 'zustand'
import type { CodexUsageRemaining } from '@shared/api'
import type { AppState } from '../index'

export interface CodexUsageSlice {
  codexUsageRemaining: CodexUsageRemaining | null
  codexUsageRemainingLoading: boolean
  fetchCodexUsageRemaining: (force?: boolean) => Promise<void>
}

export const createCodexUsageSlice: StateCreator<AppState, [], [], CodexUsageSlice> = (set) => ({
  codexUsageRemaining: null,
  codexUsageRemainingLoading: false,

  fetchCodexUsageRemaining: async (force) => {
    set({ codexUsageRemainingLoading: true })
    try {
      const remaining = await window.api.codexUsage.getRemaining(force)
      set({ codexUsageRemaining: remaining })
    } finally {
      set({ codexUsageRemainingLoading: false })
    }
  }
})
