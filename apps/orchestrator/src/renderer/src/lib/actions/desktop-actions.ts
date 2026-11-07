import { useAppStore } from '../../store'
import { openFileInWorkbench, type WorkbenchOpenRequest } from '../editor/open-file'
import { useConfirmStore, type ConfirmChoice, type ConfirmRequest } from '../confirm/confirm-store'
import { findTabIn, tabMenuNodes, terminalNodes, workbenchNodes, workspaceMenuNodes } from './tab-actions'
import { newSessionModel, newSessionNodes } from './new-session-actions'
import { requestDeleteWorkspace } from '../../components/workspace/WorkspaceList'
import { leafIds, runAction, toWire, type ActionNode, type WireAction } from './action-tree'
import { openPickerKind, pickerData, pickerDismiss, pickerPick, type PickerKind } from './desktop-pickers'
import { debugLog } from '@shared/debug-log'
import { runFileVersionsCall, type FileVersionsOp } from '../editor/file-versions-store'
import type { EditRequest } from '../editor/file-versions'
import { answerRestore, setRestoreRow } from '../claude-sessions/launch-restore'

export interface RemoteConfirm {
  id: number
  title: string
  message: string
  items?: string[]
  confirmLabel?: string
  secondaryLabel?: string
  cancelLabel?: string
  danger?: boolean
}

const projectKind = new Map<string, { unity: boolean | null; git: boolean | null; at: number }>()

async function kinds(path: string | undefined): Promise<{ unity: boolean | null; git: boolean | null }> {
  if (!path) return { unity: false, git: false }
  const hit = projectKind.get(path)
  if (hit && Date.now() - hit.at < 30_000) return hit
  const [unity, git] = await Promise.all([
    window.api.unity.isProject(path).catch(() => false),
    window.api.git.isRepo(path).catch(() => false)
  ])
  const entry = { unity, git, at: Date.now() }
  projectKind.set(path, entry)
  return entry
}

export async function desktopTree(tabId: string): Promise<ActionNode[]> {
  const s = useAppStore.getState()
  const found = findTabIn(s, tabId)
  if (!found) return []
  const { workspaceId, tab } = found
  const worktrees = s.worktreesByWorkspace[workspaceId] ?? []
  const path = worktrees.find((w) => w.id === tab.worktreeId)?.path ?? worktrees[0]?.path
  const k = await kinds(path)
  const ctx = { workspaceId, groupId: tab.groupId, defaultWorktreeId: tab.worktreeId, isUnityProject: k.unity, isGitRepo: k.git, onClose: () => {} }
  const fresh = useAppStore.getState()
  const model = newSessionModel(fresh, ctx)
  const wins = await window.api.window.list().catch(() => [])
  return [
    { id: 'tab', label: 'Tab', inline: true, children: tabMenuNodes(tabId) },
    { id: 'new', label: 'New session', icon: 'plus', children: newSessionNodes(fresh, model, k.unity) },
    ...(tab.contentType === 'terminal' ? terminalNodes() : []),
    { id: 'workspace', label: 'Workspace', icon: 'square.stack.3d.up', children: [...workbenchNodes(), ...workspaceMenuNodes(workspaceId, wins.filter((w) => w.role === 'primary'), requestDeleteWorkspace)] }
  ]
}

function confirmOf(req: ConfirmRequest & { id: number }): RemoteConfirm {
  return {
    id: req.id,
    title: req.title,
    message: req.message,
    ...(req.items ? { items: req.items } : {}),
    ...(req.confirmLabel ? { confirmLabel: req.confirmLabel } : {}),
    ...(req.secondaryLabel ? { secondaryLabel: req.secondaryLabel } : {}),
    ...(req.cancelLabel ? { cancelLabel: req.cancelLabel } : {}),
    ...(req.danger ? { danger: true } : {})
  }
}

export function captureConfirm(fn: () => unknown, graceMs = 400): Promise<RemoteConfirm | null> {
  return new Promise((resolve, reject) => {
    let settled = false
    const settle = (c: RemoteConfirm | null, e?: unknown): void => {
      if (settled) return
      settled = true
      off()
      if (e !== undefined) reject(e)
      else resolve(c)
    }
    const take = (): void => {
      const req = useConfirmStore.getState().request
      if (!req || req.remote) return
      useConfirmStore.setState({ request: { ...req, remote: true } })
      settle(confirmOf(req))
    }
    const off = useConfirmStore.subscribe(take)
    Promise.resolve()
      .then(fn)
      .then(
        () => {
          take()
          setTimeout(() => settle(null), graceMs)
        },
        (e) => settle(null, e)
      )
  })
}

export function answerConfirm(id: number, choice: ConfirmChoice): void {
  const req = useConfirmStore.getState().request
  if (!req || req.id !== id) throw new Error('That question is gone')
  if (req.desktopOnly) throw new Error('Answer that on the desktop')
  useConfirmStore.getState().respond(choice)
}

let phonePicker: PickerKind | null = null
let phonePickerWatch: (() => void) | null = null

function watchPhonePicker(kind: PickerKind): void {
  phonePicker = kind
  phonePickerWatch ??= window.api.remote.onPresence((list) => {
    if (list.length || !phonePicker) return
    const open = openPickerKind()
    if (open === phonePicker) {
      debugLog(`[actions] phone left, closing the ${open} picker it opened`)
      pickerDismiss(open)
    }
    phonePicker = null
  })
}

export async function runDesktopCall(action: string, args: unknown[]): Promise<unknown> {
  if (action === 'panelActions') {
    const tree = await desktopTree(String(args[0] ?? ''))
    const wire: WireAction[] = toWire(tree)
    return { tree: wire, ids: leafIds(wire) }
  }
  if (action === 'runPanelAction') {
    const [tabId, id, value] = args as [string, string, string | undefined]
    const tree = await desktopTree(String(tabId))
    debugLog(`[actions] remote run ${id} on ${tabId}`)
    const before = openPickerKind()
    const confirm = await captureConfirm(() => runAction(tree, String(id), value === null ? undefined : value))
    const after = openPickerKind()
    const picker = after && after !== before ? after : null
    if (picker) watchPhonePicker(picker)
    return { confirm, picker }
  }
  if (action === 'pickerData') {
    const [kind, query] = args as [PickerKind, string]
    return await pickerData(kind, String(query ?? ''))
  }
  if (action === 'pickerPick') {
    const [kind, id] = args as [PickerKind, string]
    debugLog(`[actions] remote picker ${kind} pick ${id}`)
    pickerPick(kind, String(id))
    return true
  }
  if (action === 'pickerDismiss') {
    pickerDismiss(args[0] as PickerKind)
    return true
  }
  if (action === 'answerConfirm') {
    const [id, choice] = args as [number, ConfirmChoice]
    answerConfirm(Number(id), choice)
    return true
  }
  if (action === 'fileVersions') {
    const [op, req] = args as [FileVersionsOp, EditRequest & { seen?: string }]
    return await runFileVersionsCall(op, req ?? ({} as EditRequest))
  }
  if (action === 'restoreToggle') {
    const [workspaceId, promptId, key, on] = args as [string, string, string, boolean]
    const prompt = setRestoreRow(String(workspaceId ?? ''), String(key ?? ''), on === true, 'phone', String(promptId ?? ''))
    return { checked: prompt.checked }
  }
  if (action === 'restoreAnswer') {
    const [workspaceId, promptId, restore, checked] = args as [string, string, boolean, unknown]
    const keys = Array.isArray(checked) ? checked.filter((k): k is string => typeof k === 'string') : []
    return answerRestore(String(workspaceId ?? ''), String(promptId ?? ''), restore === true, keys, 'phone')
  }
  if (action === 'openFile') {
    const req = (args[0] ?? {}) as WorkbenchOpenRequest
    debugLog(`[actions] remote open ${req.file}`)
    if (!openFileInWorkbench(req)) throw new Error("Couldn't open that file on the desktop")
    return true
  }
  throw new Error(`Unknown desktop call ${action}`)
}
