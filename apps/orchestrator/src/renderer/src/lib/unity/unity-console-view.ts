import { useSyncExternalStore } from 'react'
import { censusTrack } from '@shared/census'

export interface ConsoleView {
  showLog: boolean
  showWarn: boolean
  showError: boolean
  collapse: boolean
  search: string
  clearedThrough: number
  clearedPath: string
}

const DEFAULT: ConsoleView = {
  showLog: true,
  showWarn: true,
  showError: true,
  collapse: true,
  search: '',
  clearedThrough: 0,
  clearedPath: ''
}

export interface ConsolePrefs {
  showLog: boolean
  showWarn: boolean
  showError: boolean
  collapse: boolean
}

export function consolePrefsOf(view: ConsoleView): ConsolePrefs {
  return {
    showLog: view.showLog,
    showWarn: view.showWarn,
    showError: view.showError,
    collapse: view.collapse
  }
}

const views = new Map<string, ConsoleView>()
censusTrack('unity-console-view.views', views)
const listeners = new Map<string, Set<() => void>>()
censusTrack('unity-console-view.listeners', listeners)

export function getConsoleView(id: string): ConsoleView {
  return views.get(id) ?? DEFAULT
}

export function setConsoleView(id: string, patch: Partial<ConsoleView>): void {
  views.set(id, { ...getConsoleView(id), ...patch })
  listeners.get(id)?.forEach((fn) => fn())
}

export function forgetConsoleView(id: string): void {
  views.delete(id)
}

export function useConsoleView(id: string): ConsoleView {
  return useSyncExternalStore(
    (cb) => {
      let set = listeners.get(id)
      if (!set) {
        set = new Set()
        listeners.set(id, set)
      }
      set.add(cb)
      return () => {
        set!.delete(cb)
        if (set!.size === 0) listeners.delete(id)
      }
    },
    () => getConsoleView(id)
  )
}
