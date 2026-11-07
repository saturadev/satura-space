import { agentExecService } from '../agent-exec'
import { defineHandle, sleep } from './registry'
import { agentAttentionSnapshot, agentNotifications, focusAgentPane } from '../agent-hooks/attention'

const SHELL_SETTLE_MS = 1500

defineHandle({
  name: 'agent.spawn',
  side: 'main',
  description:
    'Starts a Claude Code agent on Haiku in a new terminal tab of the project workspace and types prompt into it. Only Haiku is allowed, to keep test runs cheap. If the call has no terminal of its own, it opens a plain terminal first and spawns the agent from there. placement is tab, split or window. Returns the new agent id, label and placement, plus the workspace agent list.',
  params: { prompt: 'Say hi in one short sentence, then stop.', label: '', placement: 'tab', model: 'haiku' },
  async run(p, ctx) {
    if (String(p.model ?? 'haiku').toLowerCase() !== 'haiku') throw new Error('agent.spawn only runs Haiku.')
    let caller = ctx.paneKey
    if (!caller) {
      const opened = (await ctx.renderer('layout.open', { kind: 'terminal' })) as { tab?: { ptyId?: string } } | null
      caller = opened?.tab?.ptyId ?? ''
      if (!caller) throw new Error('Could not open a terminal to spawn the agent from.')
      await sleep(SHELL_SETTLE_MS, ctx.signal)
    }
    const service = agentExecService()
    const args = { agent: 'claude', model: 'haiku', prompt: String(p.prompt ?? ''), placement: String(p.placement ?? 'tab'), ...(p.label ? { label: String(p.label) } : {}) }
    const res = await service.handle({ command: 'spawn', args, paneKey: caller, projectRoot: ctx.projectRoot })
    if (!res.ok) throw new Error(String(res.error ?? 'The spawn failed.'))
    const status = await service.handle({ command: 'status', args: {}, paneKey: caller, projectRoot: ctx.projectRoot })
    const { ok: _ok, ...spawned } = res
    return { ...spawned, from: caller.slice(0, 8), agents: status.agents ?? [] }
  }
})

defineHandle({
  name: 'agent.status',
  side: 'main',
  description: 'Lists the agents and their terminals in the project workspace: id, label, agent, status (working, finished, attention, exited) and parent. Returns the workspace name and that list.',
  params: {},
  async run(_p, ctx) {
    const res = await agentExecService().handle({ command: 'status', args: {}, paneKey: ctx.paneKey || undefined, projectRoot: ctx.projectRoot })
    if (!res.ok) throw new Error(String(res.error ?? 'The status call failed.'))
    const { ok: _ok, ...rest } = res
    return rest
  }
})

defineHandle({
  name: 'agents.attention',
  side: 'main',
  description:
    "Reads the agent state machine the app keeps for every terminal: per pane its agent, state (working, waiting, done, idle), since when, whether hooks drive it or only the terminal title, the open wait (permission, question or input, with tool and subagent), the reason for the last change, and what the window reported about the pane (agent, label, workspace, visible) plus whether its window is focused. Also the last 40 transitions with their reason and source (hook, input, title). Returns { panes, transitions }.",
  params: {},
  async run() {
    return agentAttentionSnapshot()
  }
})

defineHandle({
  name: 'notifications.recent',
  side: 'main',
  description:
    "Lists the agent notifications the app decided on, oldest first: kind (finished or needs-you), whether it was shown, the reason it was shown or suppressed (turned off in Settings, tab visible in the focused window, repeat within 5 s, not an agent terminal, the agent started again), and the title, subtitle and body. clear: true empties the list after reading. focus: 'focused' or 'blurred' makes the visibility check treat every window as focused or not, for testing without stealing focus; 'real' goes back to the real window focus. Returns { focus, supported, records }.",
  params: { clear: false, focus: '' },
  async run(p) {
    return agentNotifications({ clear: p.clear === true, focus: String(p.focus ?? '') })
  }
})

defineHandle({
  name: 'notifications.click',
  side: 'main',
  description:
    'Does what clicking an agent notification does for the pane ptyId: brings its window forward and focuses that terminal tab. raise: false skips bringing the window forward, so a test does not take focus from the person at the Mac. Returns whether a window took it.',
  params: { ptyId: '', raise: true },
  async run(p) {
    const ptyId = String(p.ptyId ?? '').trim()
    if (!ptyId) throw new Error('Pass ptyId: agents.attention lists the panes.')
    return { ptyId, focused: focusAgentPane(ptyId, p.raise !== false) }
  }
})
