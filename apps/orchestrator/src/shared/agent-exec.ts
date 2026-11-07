import type { RendererHandleCall } from './app-handles'
import type { AgentConfig, AgentId } from './types'
import type { PaneAct } from './pane-plan'
import type { ExecTab } from './tab-ref'
import {
  AGENT_CATALOG,
  buildAgentLaunchCommand,
  getAgentEntry,
  type AgentCatalogEntry,
  type AgentModelOption
} from './agent-catalog'
import { cleanPaneKey } from './satura-exec'

export { cleanPaneKey }

const MAX_LIVE_CHILDREN = 4
const MAX_EXEC_TEXT = 32000
export const MAX_CHILD_LABEL = 60
export const PROMPT_ENV = 'SATURA_AGENT_PROMPT'
export const PROMPT_FILE_DIR = '.sspace/agent-prompts'
const PASTE_START = '\x1b[200~'
const PASTE_END = '\x1b[201~'
export const SUBMIT_KEY = '\r'

export const EXEC_COMMANDS = ['status', 'spawn', 'send', 'report', 'close'] as const
export type ExecCommand = (typeof EXEC_COMMANDS)[number]

export const CHILD_PLACEMENTS = ['tab', 'right', 'down'] as const
export type ChildPlacement = (typeof CHILD_PLACEMENTS)[number]

export type ExecRunStatus = 'working' | 'needs-input' | 'finished' | 'exited'
export type ExecRelation = 'you' | 'child' | 'parent'

interface ExecTerminal {
  ptyId: string
  label: string
  agentId: AgentId | null
  status: ExecRunStatus
  parentPtyId: string | null
  cwd: string
  sessionId?: string | null
}

export interface ExecSnapshot {
  workspace: string
  workspaceId?: string
  terminals: ExecTerminal[]
}

export interface ExecRequest {
  paneKey?: unknown
  projectRoot?: unknown
  command?: unknown
  args?: unknown
}

export type ExecReply = { ok: boolean; error?: string } & Record<string, unknown>

export type AgentTellResult = 'sent' | 'gone' | 'shell'

export interface ExecAgentRow {
  id: string
  label: string
  agent: string | null
  status: ExecRunStatus
  relation: ExecRelation | null
  parentId: string | null
}

export interface SpawnPlan {
  agentId: AgentId
  model?: string
  effort?: string
  label: string | null
  placement: ChildPlacement
  prompt: string
}

export interface Delivery {
  targetPtyId: string
  text: string
}

export type Planned<T> = ({ ok: true } & T) | { ok: false; error: string }

export interface SnapshotQuery {
  ptyId?: string
  projectRoot?: string
}

export interface SpawnOrder {
  callerPtyId: string
  ptyId: string
  placement: ChildPlacement
  agentId: AgentId
  label: string | null
  command: string
  env: Record<string, string>
}

export interface SpawnDone {
  ptyId?: string
  label?: string
  error?: string
}

export interface CloseOrder {
  ptyIds: string[]
}

export interface CloseDone {
  closed: string[]
}

export type ExecRendererRequest =
  | { kind: 'snapshot'; payload: SnapshotQuery }
  | { kind: 'spawn'; payload: SpawnOrder }
  | { kind: 'close'; payload: CloseOrder }
  | { kind: 'drive'; payload: { workspaceId: string; on: boolean } }
  | { kind: 'tuners'; payload: { workspaceId: string; show?: string } }
  | { kind: 'panes'; payload: { workspaceId: string; ptyId?: string; take?: boolean; act?: PaneAct; groupId?: string } }
  | { kind: 'reportExport'; payload: { file: string; root: string } }
  | { kind: 'handle'; payload: RendererHandleCall }
  | { kind: 'handles' }
  | { kind: 'census'; payload: { reset: boolean } }
  | { kind: 'tabs'; payload: { workspaceId: string; show?: string } }

export type ExecTabsReply = { workspaceId: string; tabs: ExecTab[]; shown?: ExecTab } | { error: string }

export type ExecRendererHandler = (request: ExecRendererRequest) => unknown

const REPORT_CALL = "the satura_exec tool: await agents.report('your result')"
const CLOSE_CALL = 'agents.close(id)'

export function shortId(ptyId: string): string {
  return ptyId.slice(0, 8)
}

function argText(args: Record<string, unknown>, key: string): string {
  const v = args[key]
  return typeof v === 'string' ? v : ''
}

function oneLine(value: string): string {
  return value.replace(/\s+/g, ' ').trim()
}


function findTerminal(
  terminals: ExecTerminal[],
  ref: string
): Planned<{ terminal: ExecTerminal }> {
  const want = ref.trim().toLowerCase()
  if (!want) return { ok: false, error: 'Pass the id of the terminal.' }
  const exact = terminals.find((t) => t.ptyId.toLowerCase() === want)
  if (exact) return { ok: true, terminal: exact }
  const hits = terminals.filter((t) => shortId(t.ptyId).toLowerCase() === want)
  if (hits.length === 1) return { ok: true, terminal: hits[0] }
  if (hits.length > 1) return { ok: false, error: `Id ${ref.trim()} matches more than one terminal.` }
  return { ok: false, error: `No agent terminal with id ${ref.trim()} in this project.` }
}

export function childrenOf(terminals: ExecTerminal[], ptyId: string): ExecTerminal[] {
  return terminals.filter((t) => t.parentPtyId === ptyId && t.ptyId !== ptyId)
}

export function liveChildrenOf(terminals: ExecTerminal[], ptyId: string): ExecTerminal[] {
  return childrenOf(terminals, ptyId).filter((t) => t.status !== 'exited')
}

function descendantsOf(terminals: ExecTerminal[], ptyId: string): ExecTerminal[] {
  const out: ExecTerminal[] = []
  const seen = new Set([ptyId])
  const queue = [ptyId]
  while (queue.length > 0) {
    const current = queue.shift() as string
    for (const child of childrenOf(terminals, current)) {
      if (seen.has(child.ptyId)) continue
      seen.add(child.ptyId)
      out.push(child)
      queue.push(child.ptyId)
    }
  }
  return out
}

export function relationOf(t: ExecTerminal, caller: ExecTerminal | null): ExecRelation | null {
  if (!caller) return null
  if (t.ptyId === caller.ptyId) return 'you'
  if (t.parentPtyId === caller.ptyId) return 'child'
  if (caller.parentPtyId === t.ptyId) return 'parent'
  return null
}

export function statusRows(snapshot: ExecSnapshot, callerPtyId: string | null): ExecAgentRow[] {
  const caller = snapshot.terminals.find((t) => t.ptyId === callerPtyId) ?? null
  return snapshot.terminals.map((t) => ({
    id: shortId(t.ptyId),
    label: t.label,
    agent: t.agentId ? (getAgentEntry(t.agentId)?.label ?? t.agentId) : null,
    status: t.status,
    relation: relationOf(t, caller),
    parentId: t.parentPtyId ? shortId(t.parentPtyId) : null
  }))
}

export function resolveAgentId(raw: string): AgentId | null {
  const want = raw.trim().toLowerCase()
  if (!want) return null
  const entry = AGENT_CATALOG.find(
    (e) => e.id === want || e.label.toLowerCase() === want || e.cmd.toLowerCase() === want
  )
  return entry?.id ?? null
}

function resolveOption(
  options: readonly AgentModelOption[] | undefined,
  raw: string,
  kind: 'model' | 'effort',
  agentLabel: string
): Planned<{ value?: string }> {
  const want = raw.trim().toLowerCase()
  if (!want) return { ok: true }
  if (!options) return { ok: false, error: `${agentLabel} has no ${kind} option in Satura Space.` }
  const hit = options.find((o) => o.value.toLowerCase() === want || o.label.toLowerCase() === want)
  if (hit) return { ok: true, value: hit.value }
  const valid = options.map((o) => o.value).join(', ')
  return { ok: false, error: `Unknown ${kind} "${raw.trim()}" for ${agentLabel}. Use one of: ${valid}.` }
}

function checkText(text: string, what: string): string | null {
  if (!text.trim()) return `Pass ${what}.`
  if (text.length > MAX_EXEC_TEXT) {
    return `The ${what} is too long: keep it under ${MAX_EXEC_TEXT} characters.`
  }
  return null
}

export function planSpawn(
  snapshot: ExecSnapshot,
  callerPtyId: string,
  args: Record<string, unknown>,
  ctx: { launchable: (id: AgentId) => boolean; defaultAgent: AgentId | null }
): Planned<{ plan: SpawnPlan }> {
  const caller = snapshot.terminals.find((t) => t.ptyId === callerPtyId)
  if (!caller) return { ok: false, error: 'Your terminal is not in this project.' }
  const placement = (argText(args, 'placement').trim().toLowerCase() || 'tab') as ChildPlacement
  if (!CHILD_PLACEMENTS.includes(placement)) {
    return { ok: false, error: 'placement must be tab, right or down.' }
  }
  const prompt = argText(args, 'prompt')
  const promptError = checkText(prompt, 'a prompt')
  if (promptError) return { ok: false, error: promptError }
  const rawAgent = argText(args, 'agent')
  const agentId = rawAgent.trim() ? resolveAgentId(rawAgent) : (caller.agentId ?? ctx.defaultAgent)
  if (!agentId) {
    const known = AGENT_CATALOG.map((e) => e.id).join(', ')
    const error = rawAgent.trim()
      ? `Unknown agent "${rawAgent.trim()}". Use one of: ${known}.`
      : "Pass agent. Your terminal isn't an agent tab, and Settings has no default agent."
    return { ok: false, error }
  }
  const entry = getAgentEntry(agentId) as AgentCatalogEntry
  if (!ctx.launchable(agentId)) {
    return { ok: false, error: `${entry.label} isn't installed, or it's turned off in Settings.` }
  }
  const model = resolveOption(entry.models, argText(args, 'model'), 'model', entry.label)
  if (!model.ok) return model
  const effort = resolveOption(entry.efforts, argText(args, 'effort'), 'effort', entry.label)
  if (!effort.ok) return effort
  const live = liveChildrenOf(snapshot.terminals, callerPtyId)
  if (live.length >= MAX_LIVE_CHILDREN) {
    const ids = live.map((t) => shortId(t.ptyId)).join(', ')
    const full = `You already have ${MAX_LIVE_CHILDREN} live child agents (${ids}).`
    return { ok: false, error: `${full} Close one with ${CLOSE_CALL} first.` }
  }
  const label = oneLine(argText(args, 'label')).slice(0, MAX_CHILD_LABEL) || null
  return {
    ok: true,
    plan: {
      agentId,
      ...(model.value ? { model: model.value } : {}),
      ...(effort.value ? { effort: effort.value } : {}),
      label,
      placement,
      prompt: frameChildPrompt(caller, prompt)
    }
  }
}

function ownChild(
  snapshot: ExecSnapshot,
  callerPtyId: string,
  ref: string,
  verb: string
): Planned<{ terminal: ExecTerminal }> {
  const found = findTerminal(snapshot.terminals, ref)
  if (!found.ok) return found
  const id = shortId(found.terminal.ptyId)
  if (found.terminal.ptyId === callerPtyId) {
    return { ok: false, error: `You can't ${verb} your own terminal.` }
  }
  if (found.terminal.parentPtyId !== callerPtyId) {
    const rule = `You can only ${verb} your own child agents.`
    return { ok: false, error: `Terminal ${id} isn't one you started. ${rule}` }
  }
  return found
}

export function planSend(
  snapshot: ExecSnapshot,
  callerPtyId: string,
  args: Record<string, unknown>
): Planned<Delivery> {
  const caller = snapshot.terminals.find((t) => t.ptyId === callerPtyId)
  if (!caller) return { ok: false, error: 'Your terminal is not in this project.' }
  const target = ownChild(snapshot, callerPtyId, argText(args, 'id'), 'send to')
  if (!target.ok) return target
  if (target.terminal.status === 'exited') {
    return { ok: false, error: `Terminal ${shortId(target.terminal.ptyId)} has exited.` }
  }
  const text = argText(args, 'text')
  const textError = checkText(text, 'text')
  if (textError) return { ok: false, error: textError }
  return { ok: true, targetPtyId: target.terminal.ptyId, text: frameMessage(caller, text) }
}

export function planReport(
  snapshot: ExecSnapshot,
  callerPtyId: string,
  args: Record<string, unknown>
): Planned<Delivery> {
  const caller = snapshot.terminals.find((t) => t.ptyId === callerPtyId)
  if (!caller) return { ok: false, error: 'Your terminal is not in this project.' }
  if (!caller.parentPtyId) {
    return { ok: false, error: 'No agent started you, so there is nobody to report to.' }
  }
  const parent = snapshot.terminals.find((t) => t.ptyId === caller.parentPtyId)
  if (!parent) return { ok: false, error: 'The agent that started you has been closed.' }
  if (parent.status === 'exited') return { ok: false, error: 'The agent that started you has exited.' }
  if (!parent.agentId) {
    return { ok: false, error: 'You were started from a plain terminal with no agent in it, so there is nobody to report to.' }
  }
  const text = argText(args, 'text')
  const textError = checkText(text, 'text')
  if (textError) return { ok: false, error: textError }
  return { ok: true, targetPtyId: parent.ptyId, text: frameReport(caller, text) }
}

export function planClose(
  snapshot: ExecSnapshot,
  callerPtyId: string,
  args: Record<string, unknown>
): Planned<{ ptyIds: string[] }> {
  const target = ownChild(snapshot, callerPtyId, argText(args, 'id'), 'close')
  if (!target.ok) return target
  const below = descendantsOf(snapshot.terminals, target.terminal.ptyId).map((t) => t.ptyId)
  return { ok: true, ptyIds: [...below.reverse(), target.terminal.ptyId] }
}

function who(t: Pick<ExecTerminal, 'label' | 'ptyId'>): string {
  return `"${oneLine(t.label) || 'Agent'}" (id ${shortId(t.ptyId)})`
}

function frameChildPrompt(parent: Pick<ExecTerminal, 'label' | 'ptyId'>, prompt: string): string {
  return (
    `[Satura Space] The agent ${who(parent)} started you and gave you the task below. ` +
    `When you finish, send your result back with ${REPORT_CALL}.\n\n${prompt}`
  )
}

export function frameMessage(from: Pick<ExecTerminal, 'label' | 'ptyId'>, text: string): string {
  return `[Satura Space] Message from ${who(from)}, the agent that started you:\n\n${text}`
}

function frameReport(from: Pick<ExecTerminal, 'label' | 'ptyId'>, text: string): string {
  return `[Satura Space] Report from your child agent ${who(from)}:\n\n${text}`
}

function sanitizeTerminalText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '')
}

export function pasteSequence(text: string): string {
  return `${PASTE_START}${sanitizeTerminalText(text).replace(/\n/g, '\r')}${PASTE_END}`
}

export function submitDelayMs(text: string): number {
  return 250 + Math.min(1250, Math.floor(text.length / 40))
}

const POSIX_SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'mksh', 'ash', 'fish'])

export function isPosixShell(shellPath: string, platform: string): boolean {
  if (platform === 'win32') return false
  const base = (shellPath.split(/[\\/]/).pop() ?? '').replace(/^-/, '').toLowerCase()
  return POSIX_SHELLS.has(base)
}

export type PromptDelivery = 'env' | 'file' | 'pty'

export function promptDeliveryFor(
  entry: AgentCatalogEntry,
  shellPath: string,
  platform: string
): PromptDelivery {
  const posix = isPosixShell(shellPath, platform)
  if (entry.promptArg) return posix ? 'env' : 'file'
  return 'pty'
}

export function promptFileRel(ptyId: string): string {
  return `${PROMPT_FILE_DIR}/${ptyId.replace(/[^A-Za-z0-9-]/g, '')}.md`
}

export function childLaunchCommand(
  entry: AgentCatalogEntry,
  config: AgentConfig | undefined,
  delivery: PromptDelivery,
  ptyId: string
): string {
  const base = buildAgentLaunchCommand(entry, config)
  if (delivery === 'env') return `${base} "$${PROMPT_ENV}"`
  if (delivery === 'file') return `${base} "Read ${promptFileRel(ptyId)} and do the task it describes."`
  return base
}
