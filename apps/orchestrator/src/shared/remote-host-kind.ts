export type HostOs = 'macos' | 'windows' | 'linux' | 'other'
export type HostForm = 'laptop' | 'all-in-one' | 'compact' | 'tower' | 'desktop' | 'unknown'
export type HostPicture = 'mac-laptop' | 'imac' | 'mac-box' | 'mac-tower' | 'win-laptop' | 'win-desktop' | 'linux-laptop' | 'linux-desktop' | 'generic'

export interface HostKind {
  os: HostOs
  form: HostForm
  model: string
}

const OSES: HostOs[] = ['macos', 'windows', 'linux', 'other']
const FORMS: HostForm[] = ['laptop', 'all-in-one', 'compact', 'tower', 'desktop', 'unknown']
const CHASSIS: [HostForm, number[]][] = [
  ['laptop', [8, 9, 10, 11, 12, 14, 18, 21, 30, 31, 32]],
  ['all-in-one', [13]],
  ['compact', [6, 15, 16, 34, 35, 36]],
  ['tower', [7, 17, 23, 24, 25, 28, 29]],
  ['desktop', [3, 4, 5]]
]

export function cleanHostKind(raw: unknown): HostKind | null {
  const r = (raw ?? {}) as Partial<HostKind>
  if (!OSES.includes(r.os as HostOs)) return null
  return { os: r.os as HostOs, form: FORMS.includes(r.form as HostForm) ? (r.form as HostForm) : 'unknown', model: typeof r.model === 'string' ? r.model.replace(/[\u0000-\u001f]/g, '').trim().slice(0, 60) : '' }
}

export function macFormOf(name: string): HostForm {
  const n = name.toLowerCase().replace(/\s+/g, '')
  return n.startsWith('macbook') ? 'laptop' : n.startsWith('imac') ? 'all-in-one' : n.startsWith('macmini') || n.startsWith('macstudio') ? 'compact' : n.startsWith('macpro') ? 'tower' : 'unknown'
}

export function chassisFormOf(types: number[], pcSystemType = 0): HostForm {
  if (pcSystemType === 2) return 'laptop'
  return CHASSIS.find(([, ids]) => types.some((t) => ids.includes(t)))?.[0] ?? (pcSystemType ? 'desktop' : 'unknown')
}

export function hostPicture(k: HostKind | null | undefined): HostPicture {
  if (k?.os === 'macos') return k.form === 'laptop' ? 'mac-laptop' : k.form === 'all-in-one' ? 'imac' : k.form === 'compact' ? 'mac-box' : k.form === 'tower' ? 'mac-tower' : 'generic'
  if (k?.os === 'windows') return k.form === 'laptop' ? 'win-laptop' : 'win-desktop'
  if (k?.os === 'linux') return k.form === 'laptop' ? 'linux-laptop' : 'linux-desktop'
  return 'generic'
}

export function hostKindLabel(k: HostKind | null | undefined): string {
  if (!k) return ''
  if (k.model) return k.model
  const form = k.form === 'unknown' ? 'desktop' : k.form === 'compact' ? 'mini PC' : k.form
  return k.os === 'macos' ? 'Mac' : k.os === 'other' ? form.charAt(0).toUpperCase() + form.slice(1) : `${k.os === 'windows' ? 'Windows' : 'Linux'} ${form}`
}
