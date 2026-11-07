import { readdirSync, rmSync } from 'node:fs'
import { basename, join } from 'node:path'
import { ENV_BLOB_DIR, GIT_SETTINGS_FILE, NEVER_COMMIT_FILE } from '@shared/git-scm'
import { LEGACY_TUNER_VIEWS_DIR, TUNER_VIEWS_DIR } from '@shared/tuner'
import { SCRATCHPADS_REL, SCRATCHPAD_HOST_FILE } from '@shared/scratchpads'
import { STREAM_RESOLUTIONS_FILE } from '@shared/unity/stream-size'
import { SSPACE_DIR, ensureProjectSspaceSync } from '../sspace'
import { LAST_SCENE_FILE } from './project-scene-state'
import { PREFS_FILE } from './project-prefs'
import { COMMAND_ACK_FILE, COMMAND_LOG_FILE, FEEDBACK_FILE, WORLD_SNAPSHOT_FILE } from '@shared/unity/protocol'

export const WORKTREES_DIR = 'worktrees'
export const AGENT_WORKTREES_DIR = 'agent-worktrees'
export const MCP_LOGS_DIR = '.mcp_logs'
export const SCREENSHOTS_DIR = 'screenshots'
export const VIDEOS_DIR = 'videos'
export const REPORTS_DIR = 'reports'
export const DASHBOARD_DIR = 'dashboard'

export const PERSISTENT_SSPACE_ENTRIES: ReadonlySet<string> = new Set([
  '.gitignore',
  PREFS_FILE,
  LAST_SCENE_FILE,
  WORKTREES_DIR,
  AGENT_WORKTREES_DIR,
  MCP_LOGS_DIR,
  NEVER_COMMIT_FILE,
  GIT_SETTINGS_FILE,
  STREAM_RESOLUTIONS_FILE,
  ENV_BLOB_DIR,
  basename(SCRATCHPADS_REL),
  SCRATCHPAD_HOST_FILE,
  TUNER_VIEWS_DIR,
  LEGACY_TUNER_VIEWS_DIR,
  SCREENSHOTS_DIR,
  VIDEOS_DIR,
  REPORTS_DIR,
  DASHBOARD_DIR
])

export const EPHEMERAL_SSPACE_FILES: ReadonlySet<string> = new Set([
  '.mcp_quit_trigger.json',
  '.mcp_status.json',
  '.mcp_scene_results.json',
  '.mcp_stopplay_results.json',
  '.mcp_refresh_results.json',
  '.mcp_exec_results.json',
  '.mcp_flush_logs_results.json',
  '.mcp_players_command.json',
  '.mcp_players_result.json',
  '.mppm_clone_links.json',
  '.mcp_orchestrator.json',
  '.open_editor_request.json',
  '.modal_status.json',
  '.modal_cmd.json',
  '.winhook_reveal',
  '.winhook_reveal.status',
  '.mcp_rawstream_editor.log',
  '.mcp_editor.log',
  '.mcp_editor.pid',
  '.mcp_editor.mode.json',
  '.mcp_compile_errors.log',
  '.mcp_last_clean_compile',
  '.mcp_exec.lock',
  '.mcp_exec.lock.owner',
  '.mcp_asset_batches.json',
  '.legacy_input_scan.json',
  '.world_floor.json',
  '.hidden_layout_maximize',
  '.satura-app.json',
  'fps-cap',
  WORLD_SNAPSHOT_FILE,
  COMMAND_LOG_FILE,
  COMMAND_ACK_FILE,
  FEEDBACK_FILE
])

export const EPHEMERAL_SSPACE_DIRS: ReadonlySet<string> = new Set(['exec', 'feedback', 'fs-sync'])

const EXEC_RESULTS = /^\.mcp_exec_results\.[A-Za-z0-9_-]+\.json$/

function tempOf(entry: string): string | null {
  let m = /^(.+)\.tmp(?:\.\d+)?$/.exec(entry)
  if (m) {
    const inner = /^\.(.+)\.\d+\.[0-9a-f]+$/.exec(m[1])
    return inner ? inner[1] : m[1]
  }
  m = /^\.(.+)\.\d+\.[0-9a-f]+\.tmp$/.exec(entry)
  return m ? m[1] : null
}

function isEphemeralFile(name: string): boolean {
  return EPHEMERAL_SSPACE_FILES.has(name) || EXEC_RESULTS.test(name)
}

function isEphemeralSspaceEntry(entry: string): boolean {
  if (PERSISTENT_SSPACE_ENTRIES.has(entry)) return false
  if (isEphemeralFile(entry) || EPHEMERAL_SSPACE_DIRS.has(entry)) return true
  const base = tempOf(entry)
  return base !== null && isEphemeralFile(base)
}

export function guardSspace(projectPath: string): void {
  try {
    ensureProjectSspaceSync(projectPath)
  } catch {
  }
}

export function clearProjectState(projectPath: string): void {
  const dir = join(projectPath, SSPACE_DIR)
  let entries: string[]
  try {
    entries = readdirSync(dir)
  } catch {
    return
  }
  for (const entry of entries) {
    if (!isEphemeralSspaceEntry(entry)) continue
    try {
      rmSync(join(dir, entry), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    } catch (e) {
      console.log(`[unity] clear project state failed for ${entry}: ${(e as Error).message}`)
    }
  }
  guardSspace(projectPath)
}
