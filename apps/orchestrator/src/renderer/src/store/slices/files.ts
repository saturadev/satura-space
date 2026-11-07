import type { StateCreator } from 'zustand'
import type { DirEntry, DraftMeta } from '@shared/api'
import type { AppState } from '../index'
import { toPosixPath } from '../../lib/path'

export type DirState = DirEntry[] | 'loading' | 'error'

function sameEntries(cur: DirState | undefined, next: DirEntry[]): boolean {
  if (!Array.isArray(cur) || cur.length !== next.length) return false
  for (let i = 0; i < next.length; i++) {
    if (cur[i].path !== next[i].path || cur[i].isDirectory !== next[i].isDirectory) return false
  }
  return true
}

function pruneVanished(
  cache: Record<string, DirState>,
  prev: DirState | undefined,
  next: DirEntry[]
): void {
  if (!Array.isArray(prev)) return
  const kept = new Set(next.filter((e) => e.isDirectory).map((e) => e.path))
  for (const entry of prev) {
    if (!entry.isDirectory || kept.has(entry.path)) continue
    const prefix = entry.path + '/'
    for (const key of Object.keys(cache)) {
      if (key === entry.path || key.startsWith(prefix)) delete cache[key]
    }
  }
}

function ancestorDirs(rootPath: string, filePath: string): string[] {
  const root = toPosixPath(rootPath)
  const dirs: string[] = []
  let dir = toPosixPath(filePath).slice(0, toPosixPath(filePath).lastIndexOf('/'))
  while (dir.length > root.length && dir.startsWith(root)) {
    dirs.push(dir)
    const i = dir.lastIndexOf('/')
    if (i <= 0) break
    dir = dir.slice(0, i)
  }
  return dirs
}

export interface FilesSlice {
  selectedFileByWorktree: Record<string, string>
  expandedDirsByWorktree: Record<string, string[]>
  dirCacheByWorktree: Record<string, Record<string, DirState>>
  draftsByPath: Record<string, string>
  draftMetaByPath: Record<string, DraftMeta>

  viewerFileByTab: Record<string, string>
  reportTitles: Record<string, string>
  liveByTab: Record<string, boolean>
  logAutoFollowByTab: Record<string, boolean>
  markdownViewByTab: Record<string, 'preview' | 'source'>
  blameEnabledByPath: Record<string, boolean>
  lastViewerFile: string | null

  openFileInWorktree: (worktreeId: string, filePath: string) => void
  setViewerFile: (tabId: string, filePath: string, opts?: { live?: boolean }) => void
  noteReportTitles: (titles: Record<string, string>) => void
  setViewerLive: (tabId: string, live: boolean) => void
  setLogAutoFollow: (tabId: string, on: boolean) => void
  setMarkdownView: (tabId: string, mode: 'preview' | 'source') => void
  toggleBlame: (filePath: string) => void
  noteViewerFocus: (filePath: string) => void
  revealPath: (worktreeId: string, rootPath: string, filePath: string) => void
  toggleDir: (worktreeId: string, dirPath: string) => void
  expandDirs: (worktreeId: string, dirPaths: string[]) => void
  collapseDirTree: (worktreeId: string, dirPath: string) => void
  setDirLoading: (worktreeId: string, dirPath: string) => void
  setDirEntries: (worktreeId: string, dirPath: string, entries: DirEntry[]) => void
  setDirError: (worktreeId: string, dirPath: string) => void
  resetDirCache: (worktreeId: string) => void
  setDraft: (filePath: string, content: string | null, meta?: DraftMeta) => void
  setDraftMeta: (filePath: string, meta: DraftMeta) => void
  clearWorktreeFiles: (worktreeIds: string[]) => void
}

export const createFilesSlice: StateCreator<AppState, [], [], FilesSlice> = (set, get) => ({
  selectedFileByWorktree: {},
  expandedDirsByWorktree: {},
  dirCacheByWorktree: {},
  draftsByPath: {},
  draftMetaByPath: {},
  viewerFileByTab: {},
  reportTitles: {},
  liveByTab: {},
  logAutoFollowByTab: {},
  markdownViewByTab: {},
  blameEnabledByPath: {},
  lastViewerFile: null,

  openFileInWorktree: (worktreeId, filePath) =>
    set((s) => ({
      selectedFileByWorktree: { ...s.selectedFileByWorktree, [worktreeId]: filePath }
    })),

  noteReportTitles: (titles) =>
    set((s) => {
      const changed = Object.entries(titles).filter(([f, t]) => t && s.reportTitles[f] !== t)
      return changed.length ? { reportTitles: { ...s.reportTitles, ...Object.fromEntries(changed) } } : {}
    }),

  setViewerFile: (tabId, filePath, opts) =>
    set((s) => ({
      viewerFileByTab: { ...s.viewerFileByTab, [tabId]: filePath },
      liveByTab: { ...s.liveByTab, [tabId]: !!opts?.live },
      logAutoFollowByTab: { ...s.logAutoFollowByTab, [tabId]: true }
    })),

  setViewerLive: (tabId, live) =>
    set((s) => ({ liveByTab: { ...s.liveByTab, [tabId]: live } })),

  setLogAutoFollow: (tabId, on) =>
    set((s) => ({ logAutoFollowByTab: { ...s.logAutoFollowByTab, [tabId]: on } })),

  setMarkdownView: (tabId, mode) =>
    set((s) => ({ markdownViewByTab: { ...s.markdownViewByTab, [tabId]: mode } })),

  toggleBlame: (filePath) =>
    set((s) => ({
      blameEnabledByPath: {
        ...s.blameEnabledByPath,
        [filePath]: !s.blameEnabledByPath[filePath]
      }
    })),

  noteViewerFocus: (filePath) => {
    if (get().lastViewerFile !== filePath) set({ lastViewerFile: filePath })
  },

  revealPath: (worktreeId, rootPath, filePath) =>
    set((s) => {
      const open = s.expandedDirsByWorktree[worktreeId] ?? []
      const merged = Array.from(new Set([...open, ...ancestorDirs(rootPath, filePath)]))
      return {
        expandedDirsByWorktree: { ...s.expandedDirsByWorktree, [worktreeId]: merged },
        selectedFileByWorktree: {
          ...s.selectedFileByWorktree,
          [worktreeId]: toPosixPath(filePath)
        }
      }
    }),

  toggleDir: (worktreeId, dirPath) =>
    set((s) => {
      const open = s.expandedDirsByWorktree[worktreeId] ?? []
      const next = open.includes(dirPath) ? open.filter((p) => p !== dirPath) : [...open, dirPath]
      return { expandedDirsByWorktree: { ...s.expandedDirsByWorktree, [worktreeId]: next } }
    }),

  expandDirs: (worktreeId, dirPaths) =>
    set((s) => {
      const open = s.expandedDirsByWorktree[worktreeId] ?? []
      const merged = Array.from(new Set([...open, ...dirPaths]))
      if (merged.length === open.length) return {}
      return { expandedDirsByWorktree: { ...s.expandedDirsByWorktree, [worktreeId]: merged } }
    }),

  collapseDirTree: (worktreeId, dirPath) =>
    set((s) => {
      const open = s.expandedDirsByWorktree[worktreeId] ?? []
      const next = open.filter((p) => p !== dirPath && !p.startsWith(dirPath + '/') && !p.startsWith(dirPath + '\\'))
      if (next.length === open.length) return {}
      return { expandedDirsByWorktree: { ...s.expandedDirsByWorktree, [worktreeId]: next } }
    }),

  setDirLoading: (worktreeId, dirPath) =>
    set((s) => {
      const cur = s.dirCacheByWorktree[worktreeId] ?? {}
      if (cur[dirPath] !== undefined) return {}
      return {
        dirCacheByWorktree: {
          ...s.dirCacheByWorktree,
          [worktreeId]: { ...cur, [dirPath]: 'loading' }
        }
      }
    }),

  setDirEntries: (worktreeId, dirPath, entries) =>
    set((s) => {
      const cur = s.dirCacheByWorktree[worktreeId] ?? {}
      if (sameEntries(cur[dirPath], entries)) return {}
      const next = { ...cur }
      pruneVanished(next, cur[dirPath], entries)
      next[dirPath] = entries
      return { dirCacheByWorktree: { ...s.dirCacheByWorktree, [worktreeId]: next } }
    }),

  setDirError: (worktreeId, dirPath) =>
    set((s) => {
      const cur = s.dirCacheByWorktree[worktreeId] ?? {}
      if (cur[dirPath] === 'error') return {}
      return {
        dirCacheByWorktree: {
          ...s.dirCacheByWorktree,
          [worktreeId]: { ...cur, [dirPath]: 'error' }
        }
      }
    }),

  resetDirCache: (worktreeId) =>
    set((s) => {
      const cur = s.dirCacheByWorktree[worktreeId]
      if (cur === undefined || Object.keys(cur).length === 0) return {}
      return { dirCacheByWorktree: { ...s.dirCacheByWorktree, [worktreeId]: {} } }
    }),

  setDraft: (filePath, content, meta) => {
    const s = get()
    const has = filePath in s.draftsByPath
    const cur = s.draftMetaByPath[filePath]
    const metaSame = !meta || (cur?.base === meta.base && cur.by === meta.by)
    if (content === null ? !has && !cur : s.draftsByPath[filePath] === content && metaSame) return
    set((s) => {
      const next = { ...s.draftsByPath }
      const metas = { ...s.draftMetaByPath }
      if (content === null) {
        delete next[filePath]
        delete metas[filePath]
      } else {
        next[filePath] = content
        if (meta) metas[filePath] = meta
      }
      return metaSame && cur === metas[filePath] ? { draftsByPath: next } : { draftsByPath: next, draftMetaByPath: metas }
    })
  },

  setDraftMeta: (filePath, meta) => {
    const s = get()
    const cur = s.draftMetaByPath[filePath]
    if (!(filePath in s.draftsByPath) || (cur?.base === meta.base && cur.by === meta.by)) return
    set((s) => ({ draftMetaByPath: { ...s.draftMetaByPath, [filePath]: meta } }))
  },

  clearWorktreeFiles: (worktreeIds) =>
    set((s) => {
      const ids = new Set(worktreeIds)
      const selectedFileByWorktree = { ...s.selectedFileByWorktree }
      const expandedDirsByWorktree = { ...s.expandedDirsByWorktree }
      const dirCacheByWorktree = { ...s.dirCacheByWorktree }
      const searchStateByWorktree = { ...s.searchStateByWorktree }
      for (const id of ids) {
        delete selectedFileByWorktree[id]
        delete expandedDirsByWorktree[id]
        delete dirCacheByWorktree[id]
        delete searchStateByWorktree[id]
      }
      return { selectedFileByWorktree, expandedDirsByWorktree, dirCacheByWorktree, searchStateByWorktree }
    })
})
