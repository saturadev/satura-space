import type { StateCreator } from 'zustand'
import type { SearchFileResult, SearchResult } from '@shared/api'
import type { AppState } from '../index'

export interface QuickOpenTarget {
  worktreeId: string
  rootPath: string
  workspaceId: string
  groupId: string
}

export interface FileSearchState {
  query: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  includeGlobs: string
  excludeGlobs: string
  result: SearchResult | null
  collapsed: string[]
  replaceQuery: string
  replaceOpen: boolean
  preserveCase: boolean
  useGitignore: boolean
  contextLines: number
  status: 'idle' | 'searching'
  runNonce: number
}

export const DEFAULT_FILE_SEARCH: FileSearchState = {
  query: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  includeGlobs: '',
  excludeGlobs: '',
  result: null,
  collapsed: [],
  replaceQuery: '',
  replaceOpen: false,
  preserveCase: false,
  useGitignore: true,
  contextLines: 0,
  status: 'idle',
  runNonce: 0
}

const SIDEBAR_OPEN_KEY = 'ss.sidebarVisible'
const SIDEBAR_WIDTH_KEY = 'ss.sidebarWidth'
const DEFAULT_SIDEBAR_WIDTH = 260
export const MIN_SIDEBAR_WIDTH = 180
export const MAX_SIDEBAR_WIDTH = 520

const clampSidebarWidth = (width: number): number =>
  Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)))

function readSidebarOpen(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

const SIDEBAR_COLLAPSED_KEY = 'ss.sidebarCollapsed'

export type SidebarSection = 'workspaces' | 'agents'

function readSidebarCollapsed(): Partial<Record<SidebarSection, boolean>> {
  try {
    const parsed = JSON.parse(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) ?? '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function readSidebarWidth(): number {
  try {
    const raw = Number(localStorage.getItem(SIDEBAR_WIDTH_KEY))
    return raw > 0 ? clampSidebarWidth(raw) : DEFAULT_SIDEBAR_WIDTH
  } catch {
    return DEFAULT_SIDEBAR_WIDTH
  }
}

function persist(key: string, value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
  }
}

export interface UiSlice {
  quickOpen: QuickOpenTarget | null
  openQuickOpen: () => void
  closeQuickOpen: () => void

  searchStateByWorktree: Record<string, FileSearchState>
  updateSearchState: (worktreeId: string, patch: Partial<FileSearchState>) => void
  beginSearchRun: (worktreeId: string) => void
  appendSearchFiles: (worktreeId: string, files: SearchFileResult[]) => void
  finishSearchRun: (worktreeId: string, limitHit: boolean) => void
  bumpSearchRun: (worktreeId: string) => void

  explorerSearchRequest: { worktreeId: string; nonce: number } | null
  requestExplorerSearch: (worktreeId: string) => void

  explorerRevealRequest: { worktreeId: string; filePath: string; nonce: number } | null
  requestExplorerReveal: (worktreeId: string, filePath: string) => void

  sidebarOpen: boolean
  sidebarCollapsed: Partial<Record<SidebarSection, boolean>>
  toggleSidebarSection: (section: SidebarSection) => void
  toggleSidebar: () => void
  setSidebarOpen: (open: boolean) => void
  sidebarWidth: number
  setSidebarWidth: (width: number, persistWidth?: boolean) => void

  editorWordWrap: boolean
  toggleEditorWordWrap: () => void
}

export const createUiSlice: StateCreator<AppState, [], [], UiSlice> = (set, get) => ({
  quickOpen: null,

  openQuickOpen: () => {
    const s = get()
    const wsId = s.activeWorkspaceId
    if (!wsId) return
    const worktree = (s.worktreesByWorkspace[wsId] ?? [])[0]
    if (!worktree) return
    set({
      quickOpen: {
        worktreeId: worktree.id,
        rootPath: worktree.path,
        workspaceId: wsId,
        groupId: s.activeGroupIdByWorkspace[wsId] ?? ''
      }
    })
  },
  closeQuickOpen: () => set({ quickOpen: null }),

  searchStateByWorktree: {},
  updateSearchState: (worktreeId, patch) =>
    set((s) => ({
      searchStateByWorktree: {
        ...s.searchStateByWorktree,
        [worktreeId]: { ...(s.searchStateByWorktree[worktreeId] ?? DEFAULT_FILE_SEARCH), ...patch }
      }
    })),

  beginSearchRun: (worktreeId) =>
    set((s) => ({
      searchStateByWorktree: {
        ...s.searchStateByWorktree,
        [worktreeId]: {
          ...(s.searchStateByWorktree[worktreeId] ?? DEFAULT_FILE_SEARCH),
          result: { files: [], truncated: false },
          status: 'searching'
        }
      }
    })),
  appendSearchFiles: (worktreeId, files) =>
    set((s) => {
      const cur = s.searchStateByWorktree[worktreeId] ?? DEFAULT_FILE_SEARCH
      const prev = cur.result ?? { files: [], truncated: false }
      return {
        searchStateByWorktree: {
          ...s.searchStateByWorktree,
          [worktreeId]: { ...cur, result: { files: [...prev.files, ...files], truncated: prev.truncated } }
        }
      }
    }),
  finishSearchRun: (worktreeId, limitHit) =>
    set((s) => {
      const cur = s.searchStateByWorktree[worktreeId] ?? DEFAULT_FILE_SEARCH
      const prev = cur.result ?? { files: [], truncated: false }
      return {
        searchStateByWorktree: {
          ...s.searchStateByWorktree,
          [worktreeId]: { ...cur, status: 'idle', result: { files: prev.files, truncated: limitHit } }
        }
      }
    }),
  bumpSearchRun: (worktreeId) =>
    set((s) => {
      const cur = s.searchStateByWorktree[worktreeId] ?? DEFAULT_FILE_SEARCH
      return {
        searchStateByWorktree: {
          ...s.searchStateByWorktree,
          [worktreeId]: { ...cur, runNonce: cur.runNonce + 1 }
        }
      }
    }),

  explorerSearchRequest: null,
  requestExplorerSearch: (worktreeId) =>
    set((s) => ({
      explorerSearchRequest: { worktreeId, nonce: (s.explorerSearchRequest?.nonce ?? 0) + 1 }
    })),

  explorerRevealRequest: null,
  requestExplorerReveal: (worktreeId, filePath) =>
    set((s) => ({
      explorerRevealRequest: {
        worktreeId,
        filePath,
        nonce: (s.explorerRevealRequest?.nonce ?? 0) + 1
      }
    })),

  sidebarOpen: readSidebarOpen(),
  sidebarCollapsed: readSidebarCollapsed(),
  toggleSidebarSection: (section) =>
    set((s) => {
      const sidebarCollapsed = { ...s.sidebarCollapsed, [section]: !s.sidebarCollapsed[section] }
      persist(SIDEBAR_COLLAPSED_KEY, JSON.stringify(sidebarCollapsed))
      return { sidebarCollapsed }
    }),
  toggleSidebar: () =>
    set((s) => {
      const sidebarOpen = !s.sidebarOpen
      persist(SIDEBAR_OPEN_KEY, sidebarOpen ? '1' : '0')
      return { sidebarOpen }
    }),
  setSidebarOpen: (open) => {
    persist(SIDEBAR_OPEN_KEY, open ? '1' : '0')
    set({ sidebarOpen: open })
  },
  sidebarWidth: readSidebarWidth(),
  setSidebarWidth: (width, persistWidth = true) => {
    const sidebarWidth = clampSidebarWidth(width)
    if (persistWidth) persist(SIDEBAR_WIDTH_KEY, String(sidebarWidth))
    if (get().sidebarWidth !== sidebarWidth) set({ sidebarWidth })
  },

  editorWordWrap: true,
  toggleEditorWordWrap: () => set((s) => ({ editorWordWrap: !s.editorWordWrap }))
})
