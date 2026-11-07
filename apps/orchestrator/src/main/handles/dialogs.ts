import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dialogButtonLabel } from '@shared/unity/lifecycle'
import { answerDialog, openDialogs } from '../unity/modal-dialogs'
import { BlockedError, type HandleCtx } from './registry'

export interface DialogInfo {
  id: string
  title: string
  message: string
  buttons: string[]
  editor: string
}

const SAFE: [RegExp, RegExp][] = [
  [/backup/i, /^keep backups?$/i],
  [/corrupted library|rebuild (the )?library/i, /^don'?t rebuild/i],
  [/input system native platform backend/i, /^don'?t enable/i],
  [/api update/i, /^(no thanks|skip|cancel)$/i]
]
const STALL_S = 6

export const buttonLabel = dialogButtonLabel

export function safeButton(d: Pick<DialogInfo, 'title' | 'message' | 'buttons'>): string | null {
  const text = `${d.title} ${d.message}`
  for (const [match, button] of SAFE) {
    if (!match.test(text)) continue
    const hit = d.buttons.find((b) => button.test(buttonLabel(b).trim()))
    if (hit) return hit
  }
  return null
}

function editorDirs(project: string): string[] {
  const vp = join(project, 'Library', 'VP')
  try {
    return [project, ...readdirSync(vp, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => join(vp, e.name))]
  } catch {
    return [project]
  }
}

function dialogsIn(dir: string): DialogInfo[] {
  return openDialogs(dir).map((d) => ({ ...d, editor: dir }))
}

function loopStalled(dir: string): boolean {
  let ts = NaN
  try {
    ts = Number((JSON.parse(readFileSync(join(dir, '.sspace', '.mcp_status.json'), 'utf8')) as { timestamp?: unknown }).timestamp)
  } catch {
    ts = NaN
  }
  return !Number.isFinite(ts) || Date.now() / 1000 - ts >= STALL_S
}

async function answer(d: DialogInfo, button: string, signal: AbortSignal): Promise<boolean> {
  return (await answerDialog(d.editor, d.id, button, signal)).ok
}

export async function guardDialogs(ctx: HandleCtx, project: string): Promise<void> {
  const dirs = editorDirs(project).filter((dir) => existsSync(join(dir, '.sspace', '.modal_status.json')))
  for (const dir of dirs) {
    const dialogs = dialogsIn(dir)
    if (!dialogs.length) continue
    const blocked: DialogInfo[] = []
    for (const d of dialogs) {
      const button = safeButton(d)
      if (button && (await answer(d, button, ctx.signal))) {
        const line = `answered Unity dialog '${d.title || 'untitled'}' with '${buttonLabel(button)}'`
        ctx.log(line)
        ctx.answered.push(line)
      } else if (button || loopStalled(dir)) blocked.push(d)
    }
    if (blocked.length) {
      throw new BlockedError(
        `A Unity dialog is blocking the editor and is not on the safe-answer list, so nothing was clicked: ${blocked.map((d) => `'${d.title || 'untitled'}'`).join(', ')}. Answer it with unity.answer(button) in satura_exec, then call the handle again.`,
        blocked.map((d) => ({ id: d.id, title: d.title, message: d.message, buttons: d.buttons.map(buttonLabel), editor: d.editor }))
      )
    }
  }
}
