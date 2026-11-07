import { create } from 'zustand'
import { createWorkspacesSlice, type WorkspacesSlice } from './slices/workspaces'
import { createWorkspaceOverlaySlice, type WorkspaceOverlaySlice } from './slices/workspace-overlay'
import { createWorktreesSlice, type WorktreesSlice } from './slices/worktrees'
import { createTabsSlice, type TabsSlice } from './slices/tabs'
import { createFilesSlice, type FilesSlice } from './slices/files'
import { createSettingsSlice, type SettingsSlice } from './slices/settings'
import { createUiSlice, type UiSlice } from './slices/ui'
import { createClaudeUsageSlice, type ClaudeUsageSlice } from './slices/claude-usage'
import { createCodexUsageSlice, type CodexUsageSlice } from './slices/codex-usage'
import { createKimiUsageSlice, type KimiUsageSlice } from './slices/kimi-usage'
import { createAuthSlice, type AuthSlice } from './slices/auth'
import { createAgentAlertsSlice, type AgentAlertsSlice } from './slices/agent-alerts'
import { noteActiveTabs } from '../lib/tab-mru'

export type AppState = WorkspacesSlice &
  WorkspaceOverlaySlice &
  WorktreesSlice &
  TabsSlice &
  FilesSlice &
  SettingsSlice &
  UiSlice &
  ClaudeUsageSlice &
  CodexUsageSlice &
  KimiUsageSlice &
  AuthSlice &
  AgentAlertsSlice

export const useAppStore = create<AppState>()((...a) => ({
  ...createAuthSlice(...a),
  ...createWorkspacesSlice(...a),
  ...createWorkspaceOverlaySlice(...a),
  ...createWorktreesSlice(...a),
  ...createTabsSlice(...a),
  ...createFilesSlice(...a),
  ...createUiSlice(...a),
  ...createClaudeUsageSlice(...a),
  ...createCodexUsageSlice(...a),
  ...createKimiUsageSlice(...a),
  ...createSettingsSlice(...a),
  ...createAgentAlertsSlice(...a)
}))

noteActiveTabs(useAppStore.getState().groupsByWorkspace, undefined)
useAppStore.subscribe((s, prev) => noteActiveTabs(s.groupsByWorkspace, prev.groupsByWorkspace))
