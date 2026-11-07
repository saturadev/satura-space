import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { UnityDialog } from '@shared/unity/lifecycle'
import { ensureProjectSspaceSync } from '../sspace'

export interface ModalStatus {
  pid?: number
  seq?: number
  dialogs?: { id?: unknown; title?: unknown; message?: unknown; text?: unknown; buttons?: unknown }[]
  lastCmd?: { seq?: number; outcome?: string }
}

const ANSWER_MS = 15_000

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as T
  } catch {
    return null
  }
}

function alive(pid: number | undefined): boolean {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal?.aborted) return done()
    const timer = setTimeout(finish, ms)
    function finish(): void {
      clearTimeout(timer)
      signal?.removeEventListener('abort', finish)
      done()
    }
    signal?.addEventListener('abort', finish, { once: true })
  })
}

export function modalStatus(dir: string, pid?: number | null): ModalStatus | null {
  const status = readJson<ModalStatus>(join(dir, '.sspace', '.modal_status.json'))
  if (!status || !alive(status.pid)) return null
  return pid && status.pid !== pid ? null : status
}

export function openDialogs(dir: string, pid?: number | null): UnityDialog[] {
  return (modalStatus(dir, pid)?.dialogs ?? [])
    .filter((d) => d && typeof d.id === 'string' && d.id)
    .map((d) => ({
      id: String(d.id),
      title: typeof d.title === 'string' ? d.title : '',
      message: typeof d.message === 'string' ? d.message : typeof d.text === 'string' ? d.text : '',
      buttons: Array.isArray(d.buttons) ? d.buttons.filter((b): b is string => typeof b === 'string') : []
    }))
}

function writeCmd(dir: string, status: ModalStatus, id: string, button: string): number {
  const prev = readJson<{ seq?: number }>(join(dir, '.sspace', '.modal_cmd.json'))?.seq ?? 0
  const seq = Math.max(Number(status.seq) || 0, Number(status.lastCmd?.seq) || 0, Number(prev) || 0, Date.now()) + 1
  ensureProjectSspaceSync(dir)
  const target = join(dir, '.sspace', '.modal_cmd.json')
  writeFileSync(`${target}.tmp`, JSON.stringify({ v: 1, seq, id, action: 'click', button }))
  renameSync(`${target}.tmp`, target)
  return seq
}

export async function answerDialog(dir: string, id: string, button: string, signal?: AbortSignal, timeoutMs = ANSWER_MS): Promise<{ ok: boolean; error?: string }> {
  const status = modalStatus(dir)
  if (!status || !(status.dialogs ?? []).some((x) => x?.id === id)) return { ok: true }
  const seq = writeCmd(dir, status, id, button)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline && !signal?.aborted) {
    const now = modalStatus(dir)
    if (!now) return { ok: true }
    const acked = (Number(now.lastCmd?.seq) || 0) >= seq
    const gone = !(now.dialogs ?? []).some((x) => x?.id === id)
    if (acked && gone) return { ok: true }
    if (acked && now.lastCmd?.outcome && !['clicked', 'closed'].includes(now.lastCmd.outcome))
      return { ok: false, error: `Unity didn't take the answer (${now.lastCmd.outcome}).` }
    await sleep(300, signal)
  }
  return { ok: false, error: `Unity didn't close the dialog within ${Math.round(timeoutMs / 1000)} s.` }
}
