import { isClaudeTerminalTab } from '@shared/claude-sessions'
import { useAppStore } from '../store'
import { heldPtyIds, openClaudeSessionTab, pickTargetFor, useClaudeRestoreStore } from '../lib/claude-sessions/launch-restore'
import { defineHandle, type RendererCtx } from './registry'
import { settle } from './layout'

defineHandle({
  name: 'claude.restore',
  side: 'renderer',
  description:
    "Reads the Claude launch-restore state of this window: the restore prompts it shows (workspace, project, rows, checked keys), the terminals held until someone answers them, and every Claude tab with its session id. open is a Claude session id to open in a new Claude tab of the project workspace, the way the Resume a Claude session picker does. Returns { prompts, held, tabs, opened }.",
  params: { open: '' },
  async run(p, ctx: RendererCtx) {
    const sessionId = String(p.open ?? '').trim()
    let opened: string | null = null
    if (sessionId) {
      if (!ctx.workspaceId) throw new Error('Open the project first: this call has no project workspace.')
      const target = pickTargetFor(ctx.workspaceId)
      if (!target) throw new Error('The project workspace has no folder to open the session in.')
      const tab = openClaudeSessionTab(target, sessionId)
      if (!tab) throw new Error(`Couldn't open Claude session ${sessionId}.`)
      opened = tab.id
      await settle()
    }
    const s = useAppStore.getState()
    const tabs = Object.entries(s.tabsByWorkspace).flatMap(([workspaceId, list]) =>
      list.filter(isClaudeTerminalTab).map((t) => ({ workspaceId, id: t.id, ptyId: t.ptyId, sessionId: t.claudeSessionId ?? null, exited: s.exitedPtyIds.includes(t.ptyId) }))
    )
    return { prompts: Object.values(useClaudeRestoreStore.getState().prompts), held: heldPtyIds(), tabs, opened }
  }
})
