import { create } from 'zustand'

interface AppQuittingState {
  quitting: boolean
}

const useAppQuittingStore = create<AppQuittingState>()(() => ({ quitting: false }))

export function wireAppQuitting(): () => void {
  return window.api.app.onQuitting(() => useAppQuittingStore.setState({ quitting: true }))
}

export function useAppQuitting(): boolean {
  return useAppQuittingStore((s) => s.quitting)
}
