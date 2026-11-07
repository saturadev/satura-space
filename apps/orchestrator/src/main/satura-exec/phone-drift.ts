import { phonePanel, toPhones } from '../remote/host'
import { describeDriftSpot, type PhoneDriftAnswer, type PhoneDriftCue } from '@shared/drift-spot'

const ANSWERS_MAX = 32
const answers = new Map<string, string | null>()

export function phoneDriftOn(): boolean {
  return phonePanel().connected
}

export function sendPhoneDrift(cue: PhoneDriftCue, log: (line: string) => void): boolean {
  const panel = phonePanel()
  if (!panel.connected) return false
  const n = toPhones('tuner:drift', [cue])
  const away = panel.workspace?.id !== cue.workspace ? `, the phone shows ${panel.workspace ? `workspace ${panel.workspace.name}` : 'no workspace'}` : panel.tab ? `, the phone shows ${panel.tab.label || panel.tab.kind}` : ''
  log(`drift on the phone #${cue.seq}: ${cue.op}${cue.text ? ` "${cue.text}"` : ''}${cue.spot !== undefined ? ` at ${describeDriftSpot(cue.spot)}` : ''}${cue.search ? `, search "${cue.search}"` : ''}, sent to ${n} phone${n === 1 ? '' : 's'}${away}`)
  return n > 0
}

export function notePhoneDriftAnswer(raw: unknown): void {
  const a = (raw ?? {}) as Partial<PhoneDriftAnswer>
  if (typeof a.run !== 'number' || typeof a.seq !== 'number') return
  answers.set(`${a.run}:${a.seq}`, typeof a.label === 'string' ? a.label : null)
  while (answers.size > ANSWERS_MAX) answers.delete(answers.keys().next().value as string)
}

export function takePhoneDriftAnswer(run: number, seq: number): { label: string | null } | null {
  const key = `${run}:${seq}`
  if (!answers.has(key)) return null
  const label = answers.get(key) ?? null
  answers.delete(key)
  return { label }
}
