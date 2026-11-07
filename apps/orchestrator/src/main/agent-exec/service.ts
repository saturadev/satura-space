import type { AgentConfig, AgentId, Settings } from '@shared/types'
import { getAgentEntry, type AgentCatalogEntry } from '@shared/agent-catalog'
import {
  EXEC_COMMANDS,
  PROMPT_ENV,
  SUBMIT_KEY,
  childLaunchCommand,
  cleanPaneKey,
  isPosixShell,
  pasteSequence,
  planClose,
  planReport,
  planSend,
  planSpawn,
  promptDeliveryFor,
  promptFileRel,
  shortId,
  statusRows,
  submitDelayMs,
  type CloseDone,
  type ExecCommand,
  type ExecReply,
  type ExecRendererRequest,
  type ExecRequest,
  type ExecSnapshot,
  type AgentTellResult,
  type SpawnDone
} from '@shared/agent-exec'

export const READY_TIMEOUT_MS = 60_000

const NO_PANE =
  "SATURA_PANE_KEY isn't set, so this MCP server can't tell which terminal it runs in and only " +
  'agents.status() works. Run the agent in a Satura Space terminal tab to use the rest.'
const UNKNOWN_PANE =
  "Satura Space has no terminal with this call's SATURA_PANE_KEY. Run the agent in a terminal " +
  "tab of the Satura Space app that's running now."
const NO_PROJECT = "This project isn't open in Satura Space."

export interface AgentExecDeps {
  ownerOf: (ptyId: string) => number | undefined
  windowIds: () => number[]
  request: (wcId: number, request: ExecRendererRequest) => Promise<unknown>
  write: (ptyId: string, data: string) => void
  settings: () => Settings
  launchable: (agentId: AgentId) => boolean
  shell: () => string
  platform: string
  newPtyId: () => string
  writePromptFile: (cwd: string, rel: string, text: string) => boolean
  agentInFront: (ptyId: string) => Promise<boolean>
  waitForAgentReady: (ptyId: string, timeoutMs: number) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
}

interface PendingPrompt {
  ptyId: string
  prompt: string
  entry: AgentCatalogEntry
}

interface Outcome {
  reply: ExecReply
  pending?: PendingPrompt
}

function fail(error: string): ExecReply {
  return { ok: false, error }
}

function isSnapshot(v: unknown): v is ExecSnapshot {
  return !!v && typeof v === 'object' && Array.isArray((v as ExecSnapshot).terminals)
}

export interface AgentExecService {
  handle: (req: ExecRequest) => Promise<ExecReply>
  windowForProject: (projectRoot: string) => Promise<number | null>
  workspaceOf: (paneKey: string, projectRoot: string) => Promise<{ wcId: number; workspaceId: string | null } | null>
  tell: (paneKey: string, text: string, wait?: boolean) => Promise<AgentTellResult>
  paneForProject: (projectRoot: string, prefer?: string) => Promise<string | null>
}

export function createAgentExecService(deps: AgentExecDeps): AgentExecService {
  let queue: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = queue.then(fn, fn)
    queue = run.catch(() => undefined)
    return run
  }

  const snapshotOf = async (wcId: number, ptyId: string): Promise<ExecSnapshot | null> => {
    const snap = await deps.request(wcId, { kind: 'snapshot', payload: { ptyId } })
    return isSnapshot(snap) ? snap : null
  }

  const projectWindow = (projectRoot: string): Promise<{ wcId: number; snap: ExecSnapshot } | null> =>
    new Promise((resolve) => {
      const ids = projectRoot ? deps.windowIds() : []
      let left = ids.length
      if (left === 0) resolve(null)
      for (const wcId of ids) {
        void deps
          .request(wcId, { kind: 'snapshot', payload: { projectRoot } })
          .catch(() => null)
          .then((snap) => {
            left--
            if (isSnapshot(snap)) resolve({ wcId, snap })
            else if (left === 0) resolve(null)
          })
      }
    })

  const projectSnapshot = async (projectRoot: string): Promise<ExecSnapshot | null> =>
    (await projectWindow(projectRoot))?.snap ?? null

  const deliver = async (ptyId: string, text: string): Promise<void> => {
    deps.write(ptyId, pasteSequence(text))
    await deps.sleep(submitDelayMs(text))
    deps.write(ptyId, SUBMIT_KEY)
  }

  const status = (snap: ExecSnapshot, callerPtyId: string | null): ExecReply => ({
    ok: true,
    workspace: snap.workspace,
    callerId: callerPtyId ? shortId(callerPtyId) : null,
    agents: statusRows(snap, callerPtyId)
  })

  const spawn = async (
    wcId: number,
    snap: ExecSnapshot,
    caller: string,
    args: Record<string, unknown>
  ): Promise<Outcome> => {
    const settings = deps.settings()
    const planned = planSpawn(snap, caller, args, {
      launchable: deps.launchable,
      defaultAgent: settings.defaultAgent ?? null
    })
    if (!planned.ok) return { reply: fail(planned.error) }
    const { plan } = planned
    const entry = getAgentEntry(plan.agentId) as AgentCatalogEntry
    const shell = deps.shell()
    const delivery = promptDeliveryFor(entry, shell, deps.platform)
    if (delivery === 'pty' && !isPosixShell(shell, deps.platform)) {
      const why = `${entry.label} can't take a first prompt in this terminal shell.`
      return { reply: fail(`${why} Start Claude Code, Codex or Cursor instead.`) }
    }
    const saved = settings.agents[plan.agentId] as AgentConfig | undefined
    const config: AgentConfig = {
      ...(saved ?? { enabled: true }),
      ...(plan.model ? { model: plan.model } : {}),
      ...(plan.effort ? { effort: plan.effort } : {})
    }
    const ptyId = deps.newPtyId()
    const callerCwd = snap.terminals.find((t) => t.ptyId === caller)?.cwd ?? ''
    const fileRel = promptFileRel(ptyId)
    if (delivery === 'file' && !deps.writePromptFile(callerCwd, fileRel, plan.prompt)) {
      return { reply: fail('Could not write the prompt file for the new agent.') }
    }
    const done = (await deps.request(wcId, {
      kind: 'spawn',
      payload: {
        callerPtyId: caller,
        ptyId,
        placement: plan.placement,
        agentId: plan.agentId,
        label: plan.label,
        command: childLaunchCommand(entry, config, delivery, ptyId),
        env: delivery === 'env' ? { [PROMPT_ENV]: plan.prompt } : {}
      }
    })) as SpawnDone | null
    if (!done?.ptyId) {
      return { reply: fail(done?.error ?? 'Satura Space could not open the new tab.') }
    }
    const reply: ExecReply = {
      ok: true,
      id: shortId(done.ptyId),
      label: done.label ?? entry.label,
      agent: entry.label,
      placement: plan.placement,
      ...(plan.model ? { model: plan.model } : {}),
      ...(plan.effort ? { effort: plan.effort } : {})
    }
    return delivery === 'pty'
      ? { reply, pending: { ptyId: done.ptyId, prompt: plan.prompt, entry } }
      : { reply }
  }

  const mutate = async (
    command: ExecCommand,
    wcId: number,
    caller: string,
    args: Record<string, unknown>
  ): Promise<Outcome> => {
    const snap = await snapshotOf(wcId, caller)
    if (!snap) return { reply: fail(UNKNOWN_PANE) }
    if (command === 'spawn') return spawn(wcId, snap, caller, args)
    if (command === 'send' || command === 'report') {
      const planned =
        command === 'send' ? planSend(snap, caller, args) : planReport(snap, caller, args)
      if (!planned.ok) return { reply: fail(planned.error) }
      if (!(await deps.agentInFront(planned.targetPtyId))) {
        const id = shortId(planned.targetPtyId)
        return { reply: fail(`No agent is running in terminal ${id}, only its shell, so nothing was typed.`) }
      }
      await deliver(planned.targetPtyId, planned.text)
      return { reply: { ok: true, id: shortId(planned.targetPtyId) } }
    }
    const planned = planClose(snap, caller, args)
    if (!planned.ok) return { reply: fail(planned.error) }
    const done = (await deps.request(wcId, {
      kind: 'close',
      payload: { ptyIds: planned.ptyIds }
    })) as CloseDone | null
    return { reply: { ok: true, closed: (done?.closed ?? []).map(shortId) } }
  }

  const typeInWhenReady = async (reply: ExecReply, pending: PendingPrompt): Promise<ExecReply> => {
    if (!(await deps.waitForAgentReady(pending.ptyId, READY_TIMEOUT_MS))) {
      const late = `${pending.entry.label} still wasn't ready after ${READY_TIMEOUT_MS / 1000} seconds`
      const retry = `Send the task with agents.send('${shortId(pending.ptyId)}', task) in satura_exec.`
      return { ...reply, warning: `${late}, so the app didn't type its task in. ${retry}` }
    }
    await deliver(pending.ptyId, pending.prompt)
    return reply
  }

  const handle = async (req: ExecRequest): Promise<ExecReply> => {
    const raw = typeof req.command === 'string' ? req.command.trim().toLowerCase() : ''
    if (!(EXEC_COMMANDS as readonly string[]).includes(raw)) {
      const got = String(req.command ?? '')
      return fail(`Unknown command "${got}". Use status, spawn, send, report or close.`)
    }
    const command = raw as ExecCommand
    const args =
      req.args && typeof req.args === 'object' && !Array.isArray(req.args)
        ? (req.args as Record<string, unknown>)
        : {}
    const paneKey = cleanPaneKey(req.paneKey)
    if (!paneKey) {
      if (command !== 'status') return fail(NO_PANE)
      const root = typeof req.projectRoot === 'string' ? req.projectRoot : ''
      const snap = await projectSnapshot(root)
      return snap ? status(snap, null) : fail(NO_PROJECT)
    }
    const wcId = deps.ownerOf(paneKey)
    if (wcId === undefined) return fail(UNKNOWN_PANE)
    if (command === 'status') {
      const snap = await snapshotOf(wcId, paneKey)
      return snap ? status(snap, paneKey) : fail(UNKNOWN_PANE)
    }
    const { reply, pending } = await serial(() => mutate(command, wcId, paneKey, args))
    return pending ? typeInWhenReady(reply, pending) : reply
  }

  const windowForProject = async (projectRoot: string): Promise<number | null> =>
    (await projectWindow(projectRoot))?.wcId ?? null

  const workspaceOf = async (
    paneKey: string,
    projectRoot: string
  ): Promise<{ wcId: number; workspaceId: string | null } | null> => {
    const key = cleanPaneKey(paneKey)
    if (key) {
      const wcId = deps.ownerOf(key)
      if (wcId === undefined) return null
      const snap = await snapshotOf(wcId, key).catch(() => null)
      return { wcId, workspaceId: snap?.workspaceId ?? null }
    }
    const found = await projectWindow(projectRoot)
    return found ? { wcId: found.wcId, workspaceId: found.snap.workspaceId ?? null } : null
  }

  const tell = async (paneKey: string, text: string, wait = false): Promise<AgentTellResult> => {
    const key = cleanPaneKey(paneKey)
    if (!key || !text.trim()) return 'gone'
    if (wait) {
      for (let i = 0; i < 75 && deps.ownerOf(key) === undefined; i++) await deps.sleep(200)
      if (deps.ownerOf(key) !== undefined && !(await deps.waitForAgentReady(key, READY_TIMEOUT_MS))) return 'shell'
    }
    if (deps.ownerOf(key) === undefined) return 'gone'
    return serial(async () => {
      if (deps.ownerOf(key) === undefined) return 'gone'
      if (!(await deps.agentInFront(key))) return 'shell'
      await deliver(key, text)
      return 'sent'
    })
  }

  const paneForProject = async (projectRoot: string, prefer?: string): Promise<string | null> => {
    const want = prefer ? cleanPaneKey(prefer) : ''
    if (want && deps.ownerOf(want) !== undefined) return want
    const snap = await projectSnapshot(projectRoot)
    const terms = snap?.terminals ?? []
    const pick =
      terms.find((t) => t.agentId && !t.parentPtyId) ?? terms.find((t) => t.agentId) ?? terms[0]
    return pick?.ptyId ?? null
  }

  return { handle, windowForProject, workspaceOf, tell, paneForProject }
}
