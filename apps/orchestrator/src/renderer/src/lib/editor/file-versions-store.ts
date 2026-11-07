import { create } from 'zustand'
import { useAppStore } from '../../store'
import { pathBasename } from '../path'
import { decideEdit, versionStamp, type EditRequest, type VersionSource } from './file-versions'

export interface VersionsConflict {
  file: string
  kind: 'disk' | 'push'
  from: VersionSource
  by: 'mac' | 'phone' | null
  key: string
  auto: boolean
  tabId: string
  diskStamp: string
}

interface VersionsState {
  disk: Record<string, VersionsConflict>
  push: Record<string, VersionsConflict>
  open: string | null
  compare: { file: string; tabId: string } | null
  dismissed: Record<string, true>
}

export const useFileVersions = create<VersionsState>(() => ({ disk: {}, push: {}, open: null, compare: null, dismissed: {} }))

export interface RemoteFileSink {
  edit(file: string, prev: string, text: string, local: string | null): void
  save(file: string, text: string): Promise<boolean>
  keep(c: VersionsConflict): Promise<void>
  take(c: VersionsConflict): Promise<void>
  macVersion(file: string): string | undefined
}

let sink: RemoteFileSink | null = null

export function setRemoteFileSink(next: RemoteFileSink | null): void {
  sink = next
}

export function remoteFileSink(): RemoteFileSink | null {
  return sink
}

export function thisDevice(): 'mac' | 'phone' {
  return sink ? 'phone' : 'mac'
}

export function conflictFor(file: string): VersionsConflict | null {
  const s = useFileVersions.getState()
  return s.push[file] ?? s.disk[file] ?? null
}

function maybeOpen(c: VersionsConflict): void {
  const s = useFileVersions.getState()
  if (!c.auto || s.dismissed[c.key] || s.open) return
  console.info(`[versions] ${pathBasename(c.file)} has two versions (${c.kind}, the other one ${c.from}), asking on this ${thisDevice()}`)
  useFileVersions.setState({ open: c.file })
}

function settle(file: string): void {
  const s = useFileVersions.getState()
  if (s.push[file] || s.disk[file]) return
  if (s.open === file || s.compare?.file === file) useFileVersions.setState({ open: s.open === file ? null : s.open, compare: s.compare?.file === file ? null : s.compare })
}

export function reportDiskConflict(tabId: string, file: string, c: VersionsConflict | null): void {
  const s = useFileVersions.getState()
  const cur = s.disk[file]
  if (!c) {
    if (!cur || cur.tabId !== tabId) return
    const disk = { ...s.disk }
    delete disk[file]
    useFileVersions.setState({ disk })
    settle(file)
    return
  }
  if (cur && cur.key === c.key && cur.auto === c.auto) return
  useFileVersions.setState({ disk: { ...s.disk, [file]: c } })
  maybeOpen(c)
}

export function reportPushConflict(file: string, c: VersionsConflict | null): void {
  const s = useFileVersions.getState()
  if (!c) {
    if (!s.push[file]) return
    const push = { ...s.push }
    delete push[file]
    useFileVersions.setState({ push })
    settle(file)
    return
  }
  useFileVersions.setState({ push: { ...s.push, [file]: c } })
  maybeOpen(c)
}

export function openVersions(file: string): void {
  if (conflictFor(file)) useFileVersions.setState({ open: file })
}

export function decideLater(file: string): void {
  const c = conflictFor(file)
  const s = useFileVersions.getState()
  console.info(`[versions] ${pathBasename(file)}: decide later`)
  useFileVersions.setState({ open: s.open === file ? null : s.open, dismissed: c ? { ...s.dismissed, [c.key]: true } : s.dismissed })
}

export function showCompare(file: string): void {
  const c = conflictFor(file)
  if (!c) return
  console.info(`[versions] ${pathBasename(file)}: compare`)
  useFileVersions.setState({ open: null, compare: { file, tabId: c.tabId } })
}

export function closeCompare(): void {
  useFileVersions.setState({ compare: null })
}

export async function keepMine(file: string): Promise<void> {
  const c = conflictFor(file)
  if (!c) return
  console.info(`[versions] ${pathBasename(file)}: keep this ${thisDevice()}'s version over ${c.from}`)
  useFileVersions.setState({ open: null, compare: null })
  if (sink) return sink.keep(c)
  const meta = useAppStore.getState().draftMetaByPath[file]
  useAppStore.getState().setDraftMeta(file, { base: c.diskStamp, by: meta?.by ?? 'mac' })
}

export async function takeOther(file: string): Promise<void> {
  const c = conflictFor(file)
  if (!c) return
  console.info(`[versions] ${pathBasename(file)}: take the other version (${c.from}) on this ${thisDevice()}`)
  useFileVersions.setState({ open: null, compare: null })
  if (sink) return sink.take(c)
  useAppStore.getState().setDraft(file, null)
}

const savedHere = new Map<string, string>()

export function noteSavedOnMac(file: string, text: string): void {
  savedHere.set(file, versionStamp(text))
}

async function diskText(file: string): Promise<string> {
  const res = await window.api.fs.readFile(file)
  if (res.notFound) return ''
  if (res.isBinary || res.isImage || res.tooLarge) throw new Error(`${pathBasename(file)} is not a text file the editor can change`)
  return res.content
}

export type FileVersionsOp = 'edit' | 'save' | 'keep' | 'take'

export type FileVersionsReply =
  | { ok: true; stamp: string }
  | { ok: false; theirs: string; from: VersionSource; stamp: string }

export async function runFileVersionsCall(op: FileVersionsOp, req: EditRequest & { seen?: string }): Promise<FileVersionsReply> {
  const file = String(req.file ?? '')
  if (!file) throw new Error('No file')
  const disk = await diskText(file)
  const s = useAppStore.getState()
  const draft = s.draftsByPath[file]
  const meta = s.draftMetaByPath[file]
  const name = pathBasename(file)
  if (op === 'keep' || op === 'take') {
    const current = draft ?? disk
    if (req.seen !== versionStamp(current)) {
      console.info(`[versions] phone's ${op} on ${name} refused: the Mac's copy changed since the phone saw it`)
      return { ok: false, theirs: current, from: draft !== undefined ? 'mac' : 'disk', stamp: versionStamp(current) }
    }
    if (op === 'take') s.setDraft(file, null)
    else if (draft !== undefined) s.setDraftMeta(file, { base: versionStamp(disk), by: 'phone' })
    console.info(`[versions] phone chose ${op === 'take' ? 'the version on disk' : 'the unsaved edits'} for ${name}`)
    return { ok: true, stamp: versionStamp(op === 'take' ? disk : current) }
  }
  const decision = decideEdit(
    { file, base: String(req.base ?? ''), text: String(req.text ?? ''), force: !!req.force, ...(typeof req.seen === 'string' ? { seen: req.seen } : {}) },
    { draft, disk, meta, savedHere: savedHere.get(file) === versionStamp(disk) }
  )
  if (decision.kind === 'conflict') {
    console.info(`[versions] phone's ${op} of ${name} is based on another version than the Mac's (${decision.from}), the phone asks which to keep`)
    return { ok: false, theirs: decision.theirs, from: decision.from, stamp: versionStamp(decision.theirs) }
  }
  if (op === 'save') {
    const text = String(req.text ?? '')
    const res = await window.api.fs.writeFile(file, text, { expected: versionStamp(disk) })
    if (!res.ok) {
      const theirs = res.disk ?? ''
      console.info(`[versions] phone's save of ${name} refused: the file changed on disk while the save was on its way, the phone asks which to keep`)
      return { ok: false, theirs, from: 'disk', stamp: versionStamp(theirs) }
    }
    noteSavedOnMac(file, text)
    if (useAppStore.getState().draftsByPath[file] === draft) useAppStore.getState().setDraft(file, null)
    console.info(`[versions] saved ${name} from the phone (${text.length} chars)`)
    return { ok: true, stamp: versionStamp(text) }
  }
  if (decision.kind === 'apply') {
    useAppStore.getState().setDraft(file, decision.draft, decision.meta ?? undefined)
    if (req.force) console.info(`[versions] phone kept its version of ${name}, the Mac's copy now shows it`)
  }
  return { ok: true, stamp: versionStamp(req.text) }
}
