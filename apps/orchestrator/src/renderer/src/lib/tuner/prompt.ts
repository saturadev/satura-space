import { TUNER_EDIT_STATE, type TunerEdit, type TunerObject, type TunerOverride, type TunerStateInfo, type TunerUnsaved } from '@shared/tuner'

const TRANSFORM_FIELDS: Record<string, string> = {
  m_LocalPosition: 'localPosition',
  m_LocalRotation: 'localEulerAngles',
  m_LocalScale: 'localScale'
}

const RECT_FIELDS: Record<string, string> = {
  m_AnchoredPosition: 'anchoredPosition',
  m_SizeDelta: 'sizeDelta',
  m_AnchorMin: 'anchorMin',
  m_AnchorMax: 'anchorMax',
  m_Pivot: 'pivot'
}

function isTransform(type: string): boolean {
  return type === 'Transform' || type === 'UnityEngine.Transform' || type === 'RectTransform' || type === 'UnityEngine.RectTransform'
}

export function hasTransform(o: TunerObject): boolean {
  return o.components.some((c) => isTransform(c.type))
}

export function hasMoveTool(o: TunerObject): boolean {
  return hasTransform(o)
}

function prettyField(field: string): string {
  return field.replace(/\.Array\.data\[(\d+)\]/g, '[$1]').replace(/\.Array\.size$/, '.size')
}

function overrideLabel(o: Pick<TunerOverride, 'component' | 'field'>): string {
  if (isTransform(o.component)) {
    const rect = RECT_FIELDS[o.field]
    if (rect) return `RectTransform.${rect}`
    if (o.field === 'm_LocalPosition.z') return 'RectTransform.localPosition.z'
    const mapped = TRANSFORM_FIELDS[o.field]
    if (mapped) return `${o.component.endsWith('RectTransform') ? 'RectTransform' : 'Transform'}.${mapped}`
  }
  return `${o.component}.${prettyField(o.field)}`
}

export function overrideSubject(o: Pick<TunerOverride, 'path' | 'runtime'>): string {
  const rt = o.runtime
  if (!rt) return o.path
  if (rt.prefab) return `prefab ${rt.prefab}${rt.child ? ` child ${rt.child}` : ''} (spawned as ${o.path})`
  if (rt.copyOf) return `${o.path} (created at runtime as a copy of ${rt.copyOf})`
  return `${o.path} (created at runtime, source unknown)`
}

export function describeOverride(o: TunerOverride): string {
  return `${overrideSubject(o)} ${overrideLabel(o)} ${o.before} -> ${o.after}`
}

function describeEdit(e: TunerEdit): string {
  switch (e.kind) {
    case 'added':
      return `added ${e.path}${e.after ? ` (${e.after})` : ''}`
    case 'duplicated':
      return `duplicated ${e.before} as ${e.path}`
    case 'deleted':
      return `deleted ${e.path}`
    case 'moved':
      return `moved ${e.before} to ${e.after}`
    case 'componentAdded':
      return `added a ${e.component} component to ${e.path}`
    case 'componentRemoved':
      return `removed the ${e.component} component from ${e.path}`
    default:
      return `${e.path} ${editLabel(e)} ${e.before} -> ${e.after}${editWhere(e)}`
  }
}

function editLabel(e: TunerEdit): string {
  const cut = e.component.indexOf('/')
  if (cut <= 0 || !e.label) return overrideLabel(e)
  return `${e.component.slice(0, cut)} \u203a ${e.component.slice(cut + 1)} \u203a ${e.label}`
}

function editWhere(e: TunerEdit): string {
  const cut = e.component.indexOf('/')
  if (cut <= 0 || !e.label) return ''
  const member = prettyField(e.field.replace(/\.m_Value(\..*)?$/, '').replace(/\.m_OverrideState$/, '.overrideState'))
  const code = `${e.type || e.component.slice(cut + 1).replace(/\s+/g, '')}.${member}`
  return ` (${code}${e.asset ? ` in ${e.asset}` : ''})`
}

export function countChanges(overrides: TunerOverride[] | undefined, state?: string): number {
  if (!overrides) return 0
  if (state == null) return overrides.length
  return overrides.filter((o) => o.state === state).length
}

const PLAY_LEAD = 'Play Mode values, not saved yet, apply them in the scene'
const PLAY_LEAD_PREFAB = 'Play Mode values, not saved yet, apply them in the scene and the prefabs named below'

function stateGroups(states: Pick<TunerStateInfo, 'name' | 'label'>[], overrides: TunerOverride[]): string {
  const known = new Set(states.map((s) => s.name))
  const groups: string[] = []
  const order = [...states, ...[...new Set(overrides.map((o) => o.state))].filter((n) => !known.has(n)).map((name) => ({ name, label: name }))]
  for (const st of order) {
    const list = overrides.filter((o) => o.state === st.name)
    if (list.length === 0) continue
    groups.push(`State "${st.label || st.name}": ${list.map(describeOverride).join('; ')}.`)
  }
  return groups.join(' ')
}

export function mergeUnsaved(a: TunerUnsaved, b: TunerUnsaved): TunerUnsaved {
  const uniq = (x: string[], y: string[]): string[] => [...new Set([...x, ...y])]
  const assets = new Map(a.assets.map((x) => [x.path, x]))
  for (const x of b.assets) if (!assets.has(x.path)) assets.set(x.path, x)
  return { scenes: uniq(a.scenes, b.scenes), prefabs: uniq(a.prefabs, b.prefabs), assets: [...assets.values()] }
}

function touchedFiles(touched: TunerUnsaved, unsaved: TunerUnsaved): string[] {
  const all = mergeUnsaved(touched, unsaved)
  const state = (open: boolean): string => (open ? 'not saved yet' : 'saved')
  return [
    ...all.scenes.map((p) => `scene ${p} (${state(unsaved.scenes.includes(p))})`),
    ...all.prefabs.map((p) => `prefab ${p} (${state(unsaved.prefabs.includes(p))})`),
    ...all.assets.map((a) => `${a.created ? 'new asset' : 'asset'} ${a.path} (${state(unsaved.assets.some((u) => u.path === a.path))})`)
  ]
}

export function buildChangesMessage(
  view: string,
  states: Pick<TunerStateInfo, 'name' | 'label'>[],
  overrides: TunerOverride[],
  opts: { playing: boolean; unsaved: TunerUnsaved; touched?: TunerUnsaved; where?: string; edits?: TunerEdit[] }
): string {
  const parts = [`Tuner "${view}"${opts.where ? ` ${opts.where}` : ''} — the user's changes.`]
  const play = overrides.filter((o) => o.state !== TUNER_EDIT_STATE)
  const edit = overrides.filter((o) => o.state === TUNER_EDIT_STATE)
  if (play.length) {
    const lead = play.some((o) => o.runtime?.prefab) ? PLAY_LEAD_PREFAB : PLAY_LEAD
    parts.push(states.length <= 1 ? `${lead}: ${play.map(describeOverride).join('; ')}.` : `${lead}. ${stateGroups(states, play)}`)
  }
  if (edit.length) parts.push(`${opts.playing ? 'Asset edits, already saved' : 'Edit Mode changes'}: ${edit.map(describeOverride).join('; ')}.`)
  const edits = opts.edits ?? []
  const savedEdits = edits.filter((e) => e.saved)
  const openEdits = edits.filter((e) => !e.saved)
  if (savedEdits.length) parts.push(`Edit Mode changes, saved: ${savedEdits.map(describeEdit).join('; ')}.`)
  if (openEdits.length) parts.push(`Edit Mode changes, not saved yet: ${openEdits.map(describeEdit).join('; ')}.`)
  const files = touchedFiles(opts.touched ?? NO_CHANGES, opts.unsaved)
  if (files.length) parts.push(edits.length ? `Files: ${files.join(', ')}.` : `Edited in Edit Mode: ${files.join(', ')}. Read the current values from Unity.`)
  if (!play.length && !edit.length && !edits.length && !files.length) parts.push('No values changed.')
  return parts.join(' ')
}

const NO_CHANGES: TunerUnsaved = { scenes: [], prefabs: [], assets: [] }

export interface AskDriftPhone {
  fromPhone: boolean
  device: string
  shows?: string
}

export interface AskDriftContext {
  where?: string
  guide?: string
  selected?: string[]
  asset?: string
  mode?: 'play' | 'edit'
  state?: string
  phone?: AskDriftPhone | null
}

function askDriftContext(c: AskDriftContext): string {
  const sel = (c.selected ?? []).filter(Boolean)
  const subject = sel.length ? `They have ${sel.map((p) => `"${p}"`).join(', ')} selected` : ''
  const asset = c.asset ? `${subject ? ' and are' : 'They are'} looking at ${c.asset}` : ''
  const mode = c.mode === 'play' ? `Play Mode${c.state ? `, state "${c.state}"` : ''}` : c.mode === 'edit' ? 'Edit Mode' : ''
  const tail = mode ? `${subject || asset ? ', in ' : 'They are in '}${mode}` : ''
  const all = `${subject}${asset}${tail}`
  return all ? ` ${all}.` : ''
}

function askDriftPhoneNote(p: AskDriftPhone | null | undefined): string {
  if (!p) return ''
  if (p.fromPhone) return ` They asked from Satura Remote on their ${p.device}, which shows this Tuner. Drift shows the same steps on the phone.`
  return p.shows ? ` Satura Remote on their ${p.device} ${p.shows}.` : ''
}

export function buildAskDriftMessage(view: string, text: string, context: AskDriftContext = {}): string {
  const ask = text.replace(/\s+/g, ' ').trim()
  const where = context.where ? ` ${context.where}` : ''
  return (
    `Tuner "${view}"${where} — the user asks Drift: ${ask}${/[.!?]$/.test(ask) ? '' : '.'}${askDriftContext(context)}${askDriftPhoneNote(context.phone)}` +
    ' Answer in this Tuner with satura_exec: drift.look to find out, then drift.show to show and explain. For a request, do it while Drift shows each step.' +
    (context.guide ? ` First read ${context.guide}.` : '')
  )
}

export function agentGuidePath(projectRoot: string): string {
  if (!projectRoot) return ''
  const sep = projectRoot.includes('\\') && !projectRoot.includes('/') ? '\\' : '/'
  return [projectRoot.replace(/[\\/]+$/, ''), 'Packages', 'com.saturaspace.engine', 'Documentation~', 'agent-guide.md'].join(sep)
}

export interface ChangeIndex {
  objects: Set<string>
  components: Set<string>
  fields: Map<string, TunerOverride>
}

export function buildChangeIndex(overrides: TunerOverride[] | undefined, state: string | readonly string[] | undefined): ChangeIndex {
  const ix: ChangeIndex = { objects: new Set(), components: new Set(), fields: new Map() }
  const only = state == null ? null : new Set(typeof state === 'string' ? [state] : state)
  for (const o of overrides ?? []) {
    if (only && !only.has(o.state)) continue
    ix.objects.add(o.id)
    ix.components.add(`${o.id}|${o.component}`)
    ix.fields.set(`${o.id}|${o.component}|${o.field}`, o)
  }
  return ix
}

export function findPropertyChange(ix: ChangeIndex, id: string, component: string | null, path: string): TunerOverride | null {
  let parent: TunerOverride | null = null
  for (const o of ix.fields.values()) {
    if (o.id !== id || (component != null && o.component !== component)) continue
    if (o.field === path || o.field.startsWith(`${path}.`)) return o
    if (path.startsWith(`${o.field}.`)) parent = o
  }
  return parent
}
