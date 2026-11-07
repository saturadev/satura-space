import { useEffect, useSyncExternalStore } from 'react'
import type { DashboardAlertState } from '@shared/dashboard'
import { toPosixPath } from '../path'

const NONE: DashboardAlertState[] = []
const byProject = new Map<string, DashboardAlertState[]>()
const listeners = new Set<() => void>()
const asked = new Set<string>()

const key = (p: string): string => toPosixPath(p).replace(/\/+$/, '')

export function setDashboardAlerts(project: string, alerts: DashboardAlertState[]): void {
  byProject.set(key(project), alerts)
  for (const l of [...listeners]) l()
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useDashboardAlerts(project: string): DashboardAlertState[] {
  const k = key(project)
  useEffect(() => {
    if (!k || asked.has(k)) return
    asked.add(k)
    void window.api.dashboard.alerts(k).then((list) => {
      if (!byProject.has(k)) setDashboardAlerts(k, list)
    })
  }, [k])
  return useSyncExternalStore(subscribe, () => byProject.get(k) ?? NONE)
}

export function hasUndelivered(alerts: DashboardAlertState[]): boolean {
  return alerts.some((a) => a.undelivered && a.status === 'firing')
}
