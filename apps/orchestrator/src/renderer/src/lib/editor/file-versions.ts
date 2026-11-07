import type { DraftMeta } from '@shared/api'
import { versionStamp } from '@shared/version-stamp'

export type VersionSource = 'mac' | 'mac-save' | 'disk'

export interface EditRequest {
  file: string
  base: string
  text: string
  force?: boolean
  seen?: string
}

export type EditDecision =
  | { kind: 'same' }
  | { kind: 'apply'; draft: string | null; meta: DraftMeta | null }
  | { kind: 'conflict'; theirs: string; from: VersionSource }

export interface PushConflict {
  id: number
  from: VersionSource
  stamp?: string
}

export interface PendingEdit {
  base: string
  text: string
  local: string | null
  sending: string | null
  conflict: PushConflict | null
}

export { versionStamp }

export function minimalEdit(from: string, to: string): { start: number; end: number; text: string } | null {
  if (from === to) return null
  const max = Math.min(from.length, to.length)
  let head = 0
  while (head < max && from.charCodeAt(head) === to.charCodeAt(head)) head++
  let tail = 0
  while (tail < max - head && from.charCodeAt(from.length - 1 - tail) === to.charCodeAt(to.length - 1 - tail)) tail++
  return { start: head, end: from.length - tail, text: to.slice(head, to.length - tail) }
}

export function hasDiskConflict(draft: string | undefined, disk: string, meta: DraftMeta | undefined): boolean {
  return draft !== undefined && draft !== disk && !!meta && meta.base !== versionStamp(disk)
}

export function decideEdit(
  req: EditRequest,
  mac: { draft: string | undefined; disk: string; meta: DraftMeta | undefined; savedHere: boolean }
): EditDecision {
  const current = mac.draft ?? mac.disk
  const diskMoved = hasDiskConflict(mac.draft, mac.disk, mac.meta)
  if (req.text === current && !diskMoved) return { kind: 'same' }
  const seen = (theirs: string): boolean => !!req.force && req.seen === versionStamp(theirs)
  const diskFrom: VersionSource = mac.savedHere ? 'mac-save' : 'disk'
  if (req.base !== versionStamp(current) && !seen(current)) {
    return { kind: 'conflict', theirs: current, from: mac.draft !== undefined ? 'mac' : diskFrom }
  }
  if (diskMoved && !seen(mac.disk)) return { kind: 'conflict', theirs: mac.disk, from: diskFrom }
  if (req.text === mac.disk) return { kind: 'apply', draft: null, meta: null }
  const base = !diskMoved && mac.draft !== undefined && mac.meta ? mac.meta.base : versionStamp(mac.disk)
  return { kind: 'apply', draft: req.text, meta: { base, by: 'phone' } }
}

export class PendingEdits {
  private edits = new Map<string, PendingEdit>()
  private nextConflict = 1

  get(file: string): PendingEdit | undefined {
    return this.edits.get(file)
  }

  files(): string[] {
    return [...this.edits.keys()]
  }

  edit(file: string, prev: string, text: string, local: string | null): PendingEdit {
    const cur = this.edits.get(file)
    if (cur) {
      cur.text = text
      cur.local = local
      return cur
    }
    const fresh: PendingEdit = { base: versionStamp(prev), text, local, sending: null, conflict: null }
    this.edits.set(file, fresh)
    return fresh
  }

  toSend(file: string, force = false): { base: string; text: string; seen?: string } | null {
    const p = this.edits.get(file)
    if (!p || p.sending !== null || (p.conflict && !force)) return null
    p.sending = p.text
    return force && p.conflict?.stamp ? { base: p.base, text: p.text, seen: p.conflict.stamp } : { base: p.base, text: p.text }
  }

  acked(file: string): boolean {
    const p = this.edits.get(file)
    if (!p || p.sending === null) return false
    const sent = p.sending
    p.sending = null
    p.conflict = null
    p.base = versionStamp(sent)
    if (p.text !== sent) return true
    this.edits.delete(file)
    return false
  }

  failed(file: string): void {
    const p = this.edits.get(file)
    if (p) p.sending = null
  }

  rejected(file: string, from: VersionSource, stamp?: string): PushConflict | null {
    const p = this.edits.get(file)
    if (!p) return null
    p.sending = null
    p.conflict = stamp === undefined ? { id: this.nextConflict++, from } : { id: this.nextConflict++, from, stamp }
    return p.conflict
  }

  settleWith(file: string, macVersion: string): boolean {
    const p = this.edits.get(file)
    if (!p || p.sending !== null || p.text !== macVersion) return false
    this.edits.delete(file)
    return true
  }

  drop(file: string): void {
    this.edits.delete(file)
  }

  overlay(drafts: Record<string, string>): Record<string, string> {
    if (this.edits.size === 0) return drafts
    const out = { ...drafts }
    for (const [file, p] of this.edits) {
      if (p.local === null) delete out[file]
      else out[file] = p.local
    }
    return out
  }

  save(): Record<string, { base: string; text: string; local: string | null }> {
    const out: Record<string, { base: string; text: string; local: string | null }> = {}
    for (const [file, p] of this.edits) out[file] = { base: p.base, text: p.text, local: p.local }
    return out
  }

  restore(saved: unknown): number {
    if (!saved || typeof saved !== 'object') return 0
    let n = 0
    for (const [file, v] of Object.entries(saved as Record<string, unknown>)) {
      const e = v as { base?: unknown; text?: unknown; local?: unknown }
      if (typeof e?.base !== 'string' || typeof e.text !== 'string' || (e.local !== null && typeof e.local !== 'string')) continue
      if (this.edits.has(file)) continue
      this.edits.set(file, { base: e.base, text: e.text, local: e.local as string | null, sending: null, conflict: null })
      n++
    }
    return n
  }
}

export interface VersionNames {
  mine: { label: string; note: string }
  theirs: { label: string; note: string }
  keep: string
  take: string
}

export function versionNames(device: 'mac' | 'phone', kind: 'disk' | 'push', from: VersionSource, by: 'mac' | 'phone' | null): VersionNames {
  const own = by === null || by === device
  const mine =
    kind === 'push'
      ? { label: 'Your edits on this phone', note: 'not on the desktop yet' }
      : device === 'phone'
        ? { label: own ? 'Your unsaved edits' : 'The unsaved edits', note: own ? 'made on this phone' : 'made on the desktop' }
        : { label: own ? 'Your unsaved edits' : 'The unsaved edits', note: own ? 'in this editor' : 'made on the phone' }
  const theirs =
    from === 'mac'
      ? { label: 'The desktop’s unsaved edits', note: 'typed on the desktop in the meantime' }
      : from === 'mac-save'
        ? { label: 'The version saved on the desktop', note: 'on disk now' }
        : { label: 'The version on disk', note: 'changed by an agent or another app' }
  return {
    mine,
    theirs,
    keep: kind === 'push' || own ? 'Keep my edits' : 'Keep the unsaved edits',
    take: from === 'mac' ? 'Use the desktop’s edits' : from === 'mac-save' ? 'Use the saved version' : 'Use the version on disk'
  }
}
