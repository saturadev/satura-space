import type { NewProjectKind } from './api'

export interface PhoneProjectWorktree {
  path: string
  name: string
  branch: string
  unity: boolean
  open: boolean
}

export interface PhoneProjectRow {
  path: string
  name: string
  exists: boolean
  unity: boolean
  open: boolean
  hidden: boolean
  worktrees?: PhoneProjectWorktree[]
}

export interface PhoneProjectsHome {
  home: string
  defaultFolder: string
  places: { label: string; path: string }[]
  recents: PhoneProjectRow[]
}

export interface PhoneProjectDir {
  dir: string
  name: string
  parent: string | null
  unity: boolean
  open: boolean
  worktrees: PhoneProjectWorktree[]
  entries: PhoneProjectRow[]
  more: number
}

export interface PhoneProjectCreation {
  active: { name: string; version: string; kind: NewProjectKind; parent: string; startedAt: number; progress: { phase: string; pct: number } | null } | null
  last: { at: number; ok: boolean; path: string | null; error: string | null; cancelled: boolean; workspaceId: string | null } | null
}
