export type PickerMode = 'openFile' | 'openFolder' | 'save'

export type PickerSortKey = 'name' | 'size' | 'modified'

export interface PickerFilter {
  name: string
  extensions: string[]
}

export interface PickerEntry {
  name: string
  path: string
  isDir: boolean
  size: number
  mtime: number
  hidden: boolean
  unity?: string
}

export interface PickerListing {
  dir: string
  entries: PickerEntry[]
  error?: string
}

export interface PickerPlace {
  label: string
  path: string
  kind: 'home' | 'desktop' | 'documents' | 'downloads' | 'volume'
}

export interface PickerPlaces {
  home: string
  windows: boolean
  places: PickerPlace[]
  volumes: PickerPlace[]
}

export interface PickerStat {
  exists: boolean
  isDir: boolean
}

export interface PickerNativeOptions {
  mode: PickerMode
  title?: string
  confirmLabel?: string
  defaultPath?: string
  filters?: PickerFilter[]
  multiple?: boolean
}

export type PickerMkdirResult = { ok: true; path: string } | { ok: false; error: string }

const WINDOWS_INVALID_FILE_CHARS = /[\\/:\*\?"<>\|]/g
const UNIX_INVALID_FILE_CHARS = /[/]/g
const WINDOWS_FORBIDDEN_NAMES = /^(con|prn|aux|clock\$|nul|lpt[0-9]|com[0-9])(\.(.*?))?$/i

export function isValidBasename(name: string | null | undefined, isWindowsOS: boolean): boolean {
  const invalidFileChars = isWindowsOS ? WINDOWS_INVALID_FILE_CHARS : UNIX_INVALID_FILE_CHARS
  if (!name || name.length === 0 || /^\s+$/.test(name)) return false
  invalidFileChars.lastIndex = 0
  if (invalidFileChars.test(name)) return false
  if (isWindowsOS && WINDOWS_FORBIDDEN_NAMES.test(name)) return false
  if (name === '.' || name === '..') return false
  if (isWindowsOS && name[name.length - 1] === '.') return false
  if (isWindowsOS && name.length !== name.trim().length) return false
  if (name.length > 255) return false
  return true
}

export function equalsIgnoreCase(a: string, b: string): boolean {
  return a.length === b.length && a.toLowerCase() === b.toLowerCase()
}

export function startsWithIgnoreCase(value: string, prefix: string): boolean {
  return value.length >= prefix.length && value.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
}

export function endsWithSep(s: string): boolean {
  return /[\/\\]$/.test(s)
}

export function toSlashes(p: string): string {
  return p.replace(/\\/g, '/')
}

export function rootOf(p: string): string {
  const s = toSlashes(p)
  const drive = /^[a-zA-Z]:/.exec(s)
  if (drive) return `${drive[0].toUpperCase()}/`
  const unc = /^\/\/[^/]+\/[^/]+/.exec(s)
  if (unc) return `${unc[0]}/`
  return '/'
}

export function isAbsolutePath(p: string, windows: boolean): boolean {
  const s = toSlashes(p)
  if (windows) return /^[a-zA-Z]:\//.test(s) || /^[a-zA-Z]:$/.test(s) || s.startsWith('//')
  return s.startsWith('/')
}

export function normalizePath(p: string): string {
  const s = toSlashes(p)
  const root = rootOf(s)
  const rest = s.slice(/^[a-zA-Z]:/.test(s) ? 2 : root === '/' ? 0 : root.length - 1)
  const out: string[] = []
  for (const part of rest.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return root + out.join('/')
}

export function isRoot(p: string): boolean {
  return normalizePath(p) === rootOf(p)
}

export function joinPath(dir: string, name: string): string {
  return normalizePath(`${toSlashes(dir).replace(/\/+$/, '')}/${name}`)
}

export function withSep(p: string): string {
  return endsWithSep(p) ? toSlashes(p) : `${toSlashes(p)}/`
}

export function basenameOf(p: string): string {
  const n = normalizePath(p)
  if (n === rootOf(n)) return ''
  return n.slice(n.lastIndexOf('/') + 1)
}

export function parentOf(p: string): string | null {
  const n = normalizePath(p)
  const root = rootOf(n)
  if (n === root) return null
  const i = n.lastIndexOf('/')
  return i < root.length ? root : n.slice(0, i)
}

export function pathSegments(p: string): { label: string; path: string }[] {
  const n = normalizePath(p)
  const root = rootOf(n)
  const out = [{ label: root === '/' ? '/' : root.replace(/\/$/, ''), path: root }]
  let cur = root
  for (const part of n.slice(root.length).split('/').filter(Boolean)) {
    cur = joinPath(cur, part)
    out.push({ label: part, path: cur })
  }
  return out
}

export function expandTilde(value: string, home: string): string {
  if (value.length > 0 && value[0] === '~') return joinPath(home, value.substring(1))
  return value
}

export function resolveInput(value: string, dir: string, home: string, windows: boolean): string {
  const v = value.trim()
  if (!v) return normalizePath(dir)
  if (v[0] === '~') return expandTilde(v, home)
  if (isAbsolutePath(v, windows)) return normalizePath(v)
  return joinPath(dir, v)
}

export interface InputPlan {
  folder: string
  query: string
  rewrite?: string
}

export function planInput(value: string, dir: string, home: string, windows: boolean): InputPlan {
  const v = toSlashes(value)
  if (v === '~' || v.startsWith('~/')) {
    const rewrite = v === '~' ? withSep(home) : expandTilde(v, home) + (endsWithSep(v) ? '/' : '')
    const tail = planInput(rewrite, dir, home, windows)
    return { ...tail, rewrite }
  }
  const resolved = resolveInput(v, dir, home, windows)
  if (!v.trim() || endsWithSep(v) || /\/\.\.?$/.test(v) || v === '.' || v === '..') return { folder: resolved, query: '' }
  return { folder: parentOf(resolved) ?? resolved, query: basenameOf(resolved) }
}

export function displayPath(folder: string, query = ''): string {
  return withSep(normalizePath(folder)) + query
}

export function fileMatchesFilter(name: string, filter: PickerFilter | null | undefined): boolean {
  if (!filter) return true
  for (const ext of filter.extensions) {
    if (ext === '*' || name.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) return true
  }
  return false
}

export interface EntryFilter {
  mode: PickerMode
  query?: string
  showHidden?: boolean
  filter?: PickerFilter | null
}

export function filterEntries(entries: PickerEntry[], opts: EntryFilter): PickerEntry[] {
  const q = (opts.query ?? '').toLowerCase()
  return entries.filter((e) => {
    if (!opts.showHidden && e.hidden && !(q && e.name.toLowerCase().startsWith(q))) return false
    if (!e.isDir && opts.mode === 'openFolder') return false
    if (!e.isDir && !fileMatchesFilter(e.name, opts.filter)) return false
    if (q && !e.name.toLowerCase().includes(q)) return false
    return true
  })
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function sortEntries(entries: PickerEntry[], key: PickerSortKey, desc: boolean): PickerEntry[] {
  const sign = desc ? -1 : 1
  return [...entries].sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
    let d = 0
    if (key === 'size' && !a.isDir) d = a.size - b.size
    else if (key === 'modified') d = a.mtime - b.mtime
    if (d === 0) d = collator.compare(a.name, b.name)
    if (d === 0) d = a.name < b.name ? -1 : a.name > b.name ? 1 : 0
    return d * sign
  })
}

export function bestMatchIndex(entries: PickerEntry[], query: string): number {
  if (!query) return -1
  const exact = entries.findIndex((e) => equalsIgnoreCase(e.name, query))
  if (exact >= 0) return exact
  const prefix = entries.findIndex((e) => startsWithIgnoreCase(e.name, query))
  if (prefix >= 0) return prefix
  return entries.findIndex((e) => e.name.toLowerCase().includes(query.toLowerCase()))
}

export interface TabCycle {
  base: string
  index: number
}

export interface TabResult {
  text: string
  isDir: boolean
  done: boolean
  cycle: TabCycle | null
}

function commonPrefix(names: string[]): string {
  let p = names[0] ?? ''
  for (const n of names.slice(1)) {
    let i = 0
    while (i < p.length && i < n.length && p[i].toLowerCase() === n[i].toLowerCase()) i++
    p = p.slice(0, i)
  }
  return p
}

export function tabComplete(query: string, entries: PickerEntry[], cycle: TabCycle | null, back = false): TabResult | null {
  if (cycle) {
    const list = entries.filter((e) => startsWithIgnoreCase(e.name, cycle.base))
    if (list.length === 0) return null
    const index = (cycle.index + (back ? list.length - 1 : 1)) % list.length
    return { text: list[index].name, isDir: list[index].isDir, done: false, cycle: { base: cycle.base, index } }
  }
  const matches = entries.filter((e) => startsWithIgnoreCase(e.name, query))
  if (matches.length === 0) return null
  if (matches.length === 1) return { text: matches[0].name, isDir: matches[0].isDir, done: true, cycle: null }
  const prefix = commonPrefix(matches.map((m) => m.name))
  if (prefix.length > query.length) return { text: prefix, isDir: false, done: false, cycle: null }
  const index = back ? matches.length - 1 : 0
  return { text: matches[index].name, isDir: matches[index].isDir, done: false, cycle: { base: query, index } }
}

export function addPostfix(path: string, filters: PickerFilter[] | undefined, active: PickerFilter | null): string {
  if (!filters || filters.length === 0 || endsWithSep(path)) return path
  const name = basenameOf(path)
  const dot = name.lastIndexOf('.')
  const currentExt = dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
  for (const f of filters) {
    for (const ext of f.extensions) {
      if (ext === '*' || ext.toLowerCase() === currentExt) return path
    }
  }
  const ext = (active ?? filters[0]).extensions.find((e) => e !== '*')
  return ext ? `${path}.${ext}` : path
}

export type PickVerdict =
  | { kind: 'ok' }
  | { kind: 'error'; message: string }
  | { kind: 'confirm'; title: string; message: string; confirmLabel: string; createParent?: boolean }

export function validatePick(
  mode: PickerMode,
  path: string,
  target: PickerStat | null,
  parent: PickerStat | null,
  windows: boolean
): PickVerdict {
  if (!path) return { kind: 'error', message: 'Enter a valid path.' }
  if (mode === 'save') {
    const name = basenameOf(path)
    if (target?.exists && target.isDir) return { kind: 'error', message: 'A folder with that name already exists. Use a different file name.' }
    if (target?.exists) return { kind: 'confirm', title: `Replace ${name}?`, message: `${name} already exists. Replacing it overwrites its contents.`, confirmLabel: 'Replace' }
    if (!isValidBasename(name, windows)) return { kind: 'error', message: 'Enter a valid file name.' }
    const parentName = basenameOf(parentOf(path) ?? '')
    if (!parent?.exists) return { kind: 'confirm', title: 'Create the folder?', message: `The folder ${parentName} does not exist. Create it and save there?`, confirmLabel: 'Create', createParent: true }
    if (!parent.isDir) return { kind: 'error', message: 'Enter a path that exists.' }
    return { kind: 'ok' }
  }
  if (!target?.exists) return { kind: 'error', message: 'That path does not exist.' }
  if (target.isDir && mode === 'openFile') return { kind: 'error', message: 'Select a file.' }
  if (!target.isDir && mode === 'openFolder') return { kind: 'error', message: 'Select a folder.' }
  return { kind: 'ok' }
}

export function toNativeSeparators(p: string, windows: boolean): string {
  return windows ? p.replace(/\//g, '\\') : p
}

export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = bytes / 1000
  let i = 0
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000
    i++
  }
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`
}
