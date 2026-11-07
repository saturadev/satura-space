import { ipcMain } from 'electron'
import type { ClaudeSessionRef, ClaudeSessionSummary } from '@shared/claude-sessions'
import { describeClaudeSession, listClaudeSessions } from '../claude-sessions/transcripts'

const MAX_DESCRIBE = 64

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function registerClaudeSessionHandlers(): void {
  ipcMain.handle(
    'claude-sessions:list',
    (
      _event,
      args: { projectPath?: unknown; limit?: unknown; exclude?: unknown; configDir?: unknown }
    ): Promise<ClaudeSessionSummary[]> =>
      listClaudeSessions(text(args?.projectPath), {
        limit: typeof args?.limit === 'number' ? args.limit : undefined,
        exclude: Array.isArray(args?.exclude) ? args.exclude.filter((v) => typeof v === 'string') : [],
        configDir: text(args?.configDir) || null
      }).catch(() => [])
  )

  ipcMain.handle(
    'claude-sessions:describe',
    (
      _event,
      args: { items?: unknown; configDir?: unknown }
    ): Promise<(ClaudeSessionSummary | null)[]> => {
      const items = (Array.isArray(args?.items) ? args.items : []).slice(0, MAX_DESCRIBE)
      const configDir = text(args?.configDir) || null
      return Promise.all(
        items.map((raw) => {
          const ref = (raw ?? {}) as Partial<ClaudeSessionRef>
          return describeClaudeSession(text(ref.projectPath), text(ref.sessionId), configDir).catch(
            () => null
          )
        })
      )
    }
  )
}
