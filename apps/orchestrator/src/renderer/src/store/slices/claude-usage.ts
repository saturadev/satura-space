import type { StateCreator } from 'zustand'
import type { ClaudeUsageRemaining } from '@shared/api'
import type { AppState } from '../index'

export interface ClaudeUsageSlice {
  claudeUsageRemaining: ClaudeUsageRemaining | null
  claudeUsageRemainingLoading: boolean
  fetchClaudeUsageRemaining: (force?: boolean) => Promise<void>
}

export const createClaudeUsageSlice: StateCreator<AppState, [], [], ClaudeUsageSlice> = (set) => ({
  claudeUsageRemaining: null,
  claudeUsageRemainingLoading: false,

  fetchClaudeUsageRemaining: async (force) => {
    set({ claudeUsageRemainingLoading: true })
    try {
      const remaining = await window.api.claudeUsage.getRemaining(force)
      set({ claudeUsageRemaining: remaining })
    } finally {
      set({ claudeUsageRemainingLoading: false })
    }
  }
})
