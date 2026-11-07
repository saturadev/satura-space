import { unsavedCount, type TunerUnsaved } from '@shared/tuner'
import { requestChoice, requestConfirm, type ConfirmAnchor, type ConfirmFile, type ConfirmProject } from '../confirm/confirm-store'
import { censusTrack } from '@shared/census'
import { useWorldStore } from '../unity/world-store'
import { markTunerReload, markTunerSaving } from './tuner-loading'
import { useAppStore } from '../../store'

interface UnsavedEntry {
  projectPath: string
  session: string
  unsaved: TunerUnsaved
  playing: boolean
  asset?: string | null
  at: number
}

const entries = new Map<string, UnsavedEntry>()
censusTrack('unsaved.entries', entries)

export function setTunerUnsaved(tabId: string, entry: Omit<UnsavedEntry, 'at'> | null): void {
  if (!entry) entries.delete(tabId)
  else entries.set(tabId, { ...entry, at: Date.now() })
}

function pendingFor(projectPath: string): [string, UnsavedEntry][] {
  const out: [string, UnsavedEntry][] = []
  for (const [tabId, e] of entries) if (e.projectPath === projectPath && unsavedCount(e.unsaved) > 0) out.push([tabId, e])
  return out
}

export function tunerUnsavedFor(projectPath: string): UnsavedEntry | null {
  let best: UnsavedEntry | null = null
  for (const [, e] of pendingFor(projectPath)) if (!best || e.at > best.at) best = e
  return best
}

export function confirmCloseTunerTab(tabId: string, anchor?: ConfirmAnchor | null): Promise<boolean> {
  const e = entries.get(tabId)
  if (!e || unsavedCount(e.unsaved) === 0 || coveredElsewhere(tabId, e)) return Promise.resolve(true)
  return resolveTunerUnsaved(e.projectPath, 'close', anchor, tabId)
}

function unsavedItems(u: TunerUnsaved): string[] {
  return [...u.scenes, ...u.prefabs, ...u.assets.map((a) => a.path)]
}

function coveredElsewhere(tabId: string, e: UnsavedEntry): boolean {
  const others = new Set<string>()
  for (const [id, x] of pendingFor(e.projectPath)) if (id !== tabId) for (const item of unsavedItems(x.unsaved)) others.add(item)
  return unsavedItems(e.unsaved).every((item) => others.has(item))
}

export function tunerUnsavedProjects(): string[] {
  const out: string[] = []
  for (const e of entries.values()) if (!out.includes(e.projectPath) && tunerUnsavedFor(e.projectPath)) out.push(e.projectPath)
  return out
}

export function fileName(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash >= 0 ? path.slice(slash + 1) : path
}

export function sceneName(path: string): string {
  return fileName(path).replace(/\.unity$/, '')
}

export function unsavedLines(u: TunerUnsaved): string[] {
  const lines: string[] = []
  for (const s of u.scenes) lines.push(`Scene ${sceneName(s)}`)
  for (const p of u.prefabs) lines.push(`Prefab ${fileName(p).replace(/\.prefab$/, '')}`)
  for (const a of u.assets) lines.push(`${fileName(a.path)}${a.created ? ' (new)' : ''}`)
  return lines
}

export function unsavedFiles(u: TunerUnsaved): ConfirmFile[] {
  return [
    ...u.scenes.map((s): ConfirmFile => ({ kind: 'scene', name: sceneName(s) || 'Untitled' })),
    ...u.prefabs.map((p): ConfirmFile => ({ kind: 'prefab', name: fileName(p).replace(/\.prefab$/, '') })),
    ...u.assets.map((a): ConfirmFile => ({ kind: 'asset', name: fileName(a.path), note: a.created ? 'new' : undefined }))
  ]
}

function sceneFiles(scenes: string[]): ConfirmFile[] {
  return scenes.map((s) => ({ kind: 'scene', name: sceneName(s) || 'Untitled' }))
}

export function projectInfo(projectPath: string): ConfirmProject {
  const s = useAppStore.getState()
  const detail = projectPath.replace(/^\/Users\/[^/]+/, '~')
  for (const [workspaceId, list] of Object.entries(s.worktreesByWorkspace)) {
    if (!list.some((w) => w.path === projectPath)) continue
    const name = s.workspaces.find((w) => w.id === workspaceId)?.name
    if (name) return { name, detail }
  }
  return { name: fileName(projectPath), detail }
}

export function unsavedShort(u: TunerUnsaved): string {
  const lines = unsavedLines(u)
  if (lines.length === 0) return ''
  const names = [
    ...u.scenes.map(sceneName),
    ...u.prefabs.map((p) => fileName(p).replace(/\.prefab$/, '')),
    ...u.assets.map((a) => fileName(a.path))
  ]
  return names.length > 2 ? `${names.slice(0, 2).join(', ')} +${names.length - 2}` : names.join(', ')
}

export type UnsavedReason = 'close' | 'quit' | 'scene'

const TITLES: Record<UnsavedReason, string> = {
  close: 'Save changes before closing the Tuner?',
  quit: 'Save changes before quitting?',
  scene: 'Save changes before switching scenes?'
}

export async function resolveTunerUnsaved(
  projectPath: string,
  reason: UnsavedReason,
  anchor?: ConfirmAnchor | null,
  onlyTab?: string
): Promise<boolean> {
  const own = onlyTab ? entries.get(onlyTab) : null
  const pending: [string, UnsavedEntry][] = onlyTab ? (own ? [[onlyTab, own]] : []) : pendingFor(projectPath)
  if (pending.length === 0) return true
  const seen = new Set<string>()
  const files = pending.flatMap(([, x]) => unsavedFiles(x.unsaved)).filter((f) => {
    const key = `${f.kind}:${f.name}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  const playing = pending.some(([, x]) => x.playing)
  const tail = playing
    ? 'You made these changes in Edit Mode. Saving or discarding them stops Play Mode first. If you don’t save them, they’re lost.'
    : `If you don’t save, Unity reloads ${files.length === 1 ? 'it' : 'them'} from disk.`
  const choice = await requestChoice({
    title: TITLES[reason],
    project: projectInfo(projectPath),
    files,
    message: tail,
    confirmLabel: 'Save',
    secondaryLabel: 'Discard',
    cancelLabel: 'Cancel',
    danger: false,
    anchor
  })
  if (choice === 'cancel') return false
  const save = choice === 'confirm'
  const errors: string[] = []
  for (const [tabId, x] of pending) {
    const r = save ? await markTunerSaving(projectPath, window.api.tuner.save(projectPath, x.session, x.playing)) : await markTunerReload(projectPath, window.api.tuner.discard(projectPath, x.session, x.playing))
    const cur = entries.get(tabId)
    if (cur) entries.set(tabId, { ...cur, unsaved: r.ok ? r.data.unsaved : (r.data?.unsaved ?? cur.unsaved) })
    if (!r.ok && !errors.includes(r.error)) errors.push(r.error)
  }
  if (errors.length === 0) return true
  await requestConfirm({
    title: save ? 'Could not save' : 'Could not discard the changes',
    message: errors.join('\n'),
    confirmLabel: 'OK',
    hideCancel: true,
    danger: false
  })
  return false
}

export function editorUnsavedScenes(skip: string[]): { projectPath: string; scene: string }[] {
  const out: { projectPath: string; scene: string }[] = []
  for (const [projectPath, w] of Object.entries(useWorldStore.getState().worlds)) {
    if (skip.includes(projectPath)) continue
    const inst = Object.values(w.observed.instances).find((i) => i.role === 'primary' && i.alive && i.sceneDirty)
    if (inst) out.push({ projectPath, scene: inst.scene })
  }
  return out
}

export async function resolveEditorUnsaved(projectPath: string, scene: string): Promise<boolean> {
  const choice = await requestChoice({
    title: TITLES.quit,
    project: projectInfo(projectPath),
    files: sceneFiles([scene]),
    message: 'If you don’t save, Unity reloads it from disk.',
    confirmLabel: 'Save',
    secondaryLabel: 'Discard',
    cancelLabel: 'Cancel',
    danger: false
  })
  if (choice === 'cancel') return false
  const save = choice === 'confirm'
  const r = save ? await markTunerSaving(projectPath, window.api.tuner.saveScene(projectPath)) : await markTunerReload(projectPath, window.api.tuner.discardScene(projectPath))
  if (r.ok) return true
  await requestConfirm({
    title: save ? 'Could not save' : 'Could not discard the changes',
    message: r.error,
    confirmLabel: 'OK',
    hideCancel: true,
    danger: false
  })
  return false
}

export async function discardSceneChanges(projectPath: string, anchor?: ConfirmAnchor | null): Promise<boolean> {
  const e = tunerUnsavedFor(projectPath)
  const files = e ? unsavedFiles(e.unsaved) : []
  const ok = await requestConfirm({
    title: 'Discard the unsaved scene changes?',
    project: projectInfo(projectPath),
    files: files.length ? files : undefined,
    message: 'Unity reloads the scene from disk. You can’t undo this.',
    confirmLabel: 'Discard',
    danger: true,
    anchor
  })
  if (!ok) return false
  const res = await markTunerReload(projectPath, window.api.tuner.discardScene(projectPath))
  for (const [tabId, x] of entries) if (x.projectPath === projectPath) entries.set(tabId, { ...x, unsaved: res.ok ? res.data.unsaved : (res.data?.unsaved ?? x.unsaved) })
  if (res.ok) return true
  await requestConfirm({
    title: 'Could not discard the changes',
    message: res.error,
    confirmLabel: 'OK',
    hideCancel: true,
    danger: false
  })
  return false
}

export function editorDirtyScenes(projectPath: string): string[] {
  const w = useWorldStore.getState().worlds[projectPath]
  const inst = w ? Object.values(w.observed.instances).find((i) => i.role === 'primary' && i.alive && i.sceneDirty) : undefined
  if (!inst) return []
  const list = (inst.dirtyScenes || inst.scene || '').split('\n').filter(Boolean)
  return list.length ? list : ['']
}

export async function resolveSceneSwitch(projectPath: string, anchor?: ConfirmAnchor | null): Promise<boolean> {
  if (tunerUnsavedFor(projectPath)) return resolveTunerUnsaved(projectPath, 'scene', anchor)
  const scenes = editorDirtyScenes(projectPath)
  if (scenes.length === 0) return true
  const choice = await requestChoice({
    title: TITLES.scene,
    project: projectInfo(projectPath),
    files: sceneFiles(scenes),
    message: `If you don’t save, Unity reloads ${scenes.length === 1 ? 'it' : 'them'} from disk.`,
    confirmLabel: 'Save',
    secondaryLabel: 'Discard',
    cancelLabel: 'Cancel',
    danger: false,
    anchor
  })
  if (choice === 'cancel') return false
  const save = choice === 'confirm'
  const r = save ? await markTunerSaving(projectPath, window.api.tuner.saveScene(projectPath)) : await markTunerReload(projectPath, window.api.tuner.discardScene(projectPath))
  if (r.ok) return true
  await requestConfirm({
    title: save ? 'Could not save' : 'Could not discard the changes',
    message: r.error,
    confirmLabel: 'OK',
    hideCancel: true,
    danger: false
  })
  return false
}
