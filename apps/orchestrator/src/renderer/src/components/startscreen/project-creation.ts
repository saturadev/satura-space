import { useSyncExternalStore } from 'react'
import type { NewProjectArgs, NewProjectProgress, NewProjectResult } from '@shared/api'
import { censusTrack } from '@shared/census'

export interface ProjectCreation {
  active: { name: string; version: string; progress: NewProjectProgress | null } | null
  error: string | null
}

let state: ProjectCreation = { active: null, error: null }
const listeners = new Set<() => void>()
censusTrack('project-creation.listeners', listeners)

function set(next: ProjectCreation): void {
  state = next
  for (const l of listeners) l()
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useProjectCreation(): ProjectCreation {
  return useSyncExternalStore(subscribe, () => state)
}

export function projectCreationState(): ProjectCreation {
  return state
}

export function clearProjectCreationError(): void {
  if (state.error) set({ ...state, error: null })
}

export async function runProjectCreation(args: NewProjectArgs): Promise<NewProjectResult> {
  if (state.active) return { ok: false, error: 'A project is already being created.' }
  set({ active: { name: args.name, version: args.version, progress: null }, error: null })
  const stop = window.api.unity.onCreateProgress((progress) => {
    if (state.active) set({ ...state, active: { ...state.active, progress } })
  })
  let res: NewProjectResult
  try {
    res = await window.api.unity.createProject(args)
  } catch (e) {
    res = { ok: false, error: (e as Error).message || 'Project creation failed.' }
  } finally {
    stop()
  }
  set({ active: null, error: res.ok || res.cancelled ? null : res.error })
  return res
}
