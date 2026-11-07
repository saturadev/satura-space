import type { StateCreator } from 'zustand'
import type { KimiUsageRemaining } from '@shared/api'
import type { AppState } from '../index'

export interface KimiUsageSlice {
  kimiUsageRemaining: KimiUsageRemaining | null
  kimiUsageRemainingLoading: boolean
  fetchKimiUsageRemaining: (force?: boolean) => Promise<void>
}

export const createKimiUsageSlice: StateCreator<AppState, [], [], KimiUsageSlice> = (set) => ({
  kimiUsageRemaining: null,
  kimiUsageRemainingLoading: false,

  fetchKimiUsageRemaining: async (force) => {
    set({ kimiUsageRemainingLoading: true })
    try {
      const remaining = await window.api.kimiUsage.getRemaining(force)
      set({ kimiUsageRemaining: remaining })
    } finally {
      set({ kimiUsageRemainingLoading: false })
    }
  }
})
