import { useEffect, useSyncExternalStore } from 'react'
import { PHONE_REPORT_SCALE, PHONE_TERMINAL_FONT_SIZE, clampPhoneReportScale, clampPhoneTerminalFont, type RemotePrefs } from '@shared/types'

export interface PhoneScales {
  project: string
  reportScale: number
  terminalFontSize: number
  loaded: boolean
}

const stored = new Map<string, Required<RemotePrefs>>()
const loads = new Map<string, Promise<void>>()
const edited = new Set<string>()
const listeners = new Set<() => void>()
const snapshots = new Map<string, PhoneScales>()
let root = ''

function emit(): void {
  snapshots.clear()
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function setPhoneScaleRoot(project: string): void {
  root = project
}

export function phoneScaleRoot(): string {
  return root
}

export function phoneScales(project = root): PhoneScales {
  const known = snapshots.get(project)
  if (known) return known
  const s = stored.get(project)
  const out = { project, reportScale: s?.reportScale ?? PHONE_REPORT_SCALE, terminalFontSize: s?.terminalFontSize ?? PHONE_TERMINAL_FONT_SIZE, loaded: !project || !!s }
  snapshots.set(project, out)
  return out
}

export function loadPhoneScales(project: string): Promise<void> {
  if (!project) return Promise.resolve()
  const known = loads.get(project)
  if (known) return known
  const run = window.api.unity.getRemotePrefs(project).then(
    (prefs) => {
      const local = edited.has(project) ? stored.get(project) : undefined
      const next = {
        reportScale: local?.reportScale ?? clampPhoneReportScale(prefs?.reportScale ?? PHONE_REPORT_SCALE),
        terminalFontSize: local?.terminalFontSize ?? clampPhoneTerminalFont(prefs?.terminalFontSize ?? PHONE_TERMINAL_FONT_SIZE)
      }
      stored.set(project, next)
      console.info(`[phone-scales] ${project}: report ${Math.round(next.reportScale * 100)}%, terminal ${next.terminalFontSize} px${prefs && Object.keys(prefs).length ? ' (stored)' : ' (defaults)'}`)
      emit()
    },
    (e: unknown) => {
      loads.delete(project)
      if (!stored.has(project)) stored.set(project, { reportScale: PHONE_REPORT_SCALE, terminalFontSize: PHONE_TERMINAL_FONT_SIZE })
      console.warn(`[phone-scales] couldn't read the scales of ${project}: ${e instanceof Error ? e.message : String(e)}`)
      emit()
    }
  )
  loads.set(project, run)
  return run
}

export function setPhoneScale(patch: RemotePrefs, save: boolean, project = root): PhoneScales {
  if (!project) return phoneScales(project)
  const cur = phoneScales(project)
  const next = {
    reportScale: patch.reportScale !== undefined ? clampPhoneReportScale(patch.reportScale) : cur.reportScale,
    terminalFontSize: patch.terminalFontSize !== undefined ? clampPhoneTerminalFont(patch.terminalFontSize) : cur.terminalFontSize
  }
  edited.add(project)
  if (next.reportScale !== cur.reportScale || next.terminalFontSize !== cur.terminalFontSize || !cur.loaded) {
    stored.set(project, next)
    emit()
  }
  if (save) {
    const sent: RemotePrefs = {}
    if (patch.reportScale !== undefined) sent.reportScale = next.reportScale
    if (patch.terminalFontSize !== undefined) sent.terminalFontSize = next.terminalFontSize
    void window.api.unity.setRemotePrefs(project, sent).then(
      (saved) => console.info(`[phone-scales] saved ${JSON.stringify(saved)} for ${project}`),
      (e: unknown) => console.warn(`[phone-scales] couldn't save the scales of ${project}: ${e instanceof Error ? e.message : String(e)}`)
    )
  }
  return phoneScales(project)
}

export function usePhoneScales(project = root): PhoneScales {
  const scales = useSyncExternalStore(subscribe, () => phoneScales(project))
  useEffect(() => {
    void loadPhoneScales(project)
  }, [project])
  return scales
}
