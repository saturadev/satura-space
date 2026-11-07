import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { access, lstat, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import {
  isValidBasename,
  type PickerEntry,
  type PickerListing,
  type PickerMkdirResult,
  type PickerNativeOptions,
  type PickerPlace,
  type PickerPlaces,
  type PickerStat
} from '@shared/file-picker'
import { toNativePath } from './native-path'

const STAT_BATCH = 96
const WINDOWS = process.platform === 'win32'

function slashes(p: string): string {
  return WINDOWS ? p.replace(/\\/g, '/') : p
}

function absolute(p: unknown): string | null {
  if (typeof p !== 'string' || !p.trim()) return null
  const native = toNativePath(p.trim())
  return isAbsolute(native) ? resolve(native) : null
}

async function unityVersion(dir: string): Promise<string | undefined> {
  try {
    const text = await readFile(join(dir, 'ProjectSettings', 'ProjectVersion.txt'), 'utf8')
    await access(join(dir, 'Assets'))
    return /m_EditorVersion:\s*(\S+)/.exec(text)?.[1] ?? 'Unity'
  } catch {
    return undefined
  }
}

function errorText(code: string | undefined): string {
  if (code === 'ENOENT') return 'This folder does not exist.'
  if (code === 'ENOTDIR') return 'This is not a folder.'
  if (code === 'EACCES' || code === 'EPERM') return 'Satura Space has no permission to read this folder.'
  return 'This folder could not be read.'
}

async function listDir(dirArg: unknown, opts: { unity?: boolean } | undefined): Promise<PickerListing> {
  const dir = absolute(dirArg)
  if (!dir) return { dir: slashes(String(dirArg ?? '')), entries: [], error: 'Enter an absolute path.' }
  let names: string[]
  try {
    names = await readdir(dir)
  } catch (e) {
    return { dir: slashes(dir), entries: [], error: errorText((e as NodeJS.ErrnoException).code) }
  }
  const entries: PickerEntry[] = []
  for (let i = 0; i < names.length; i += STAT_BATCH) {
    const batch = await Promise.all(
      names.slice(i, i + STAT_BATCH).map(async (name): Promise<PickerEntry | null> => {
        const full = join(dir, name)
        const s = await stat(full).catch(() => lstat(full).catch(() => null))
        if (!s) return null
        const isDir = s.isDirectory()
        const entry: PickerEntry = {
          name,
          path: slashes(full),
          isDir,
          size: isDir ? 0 : s.size,
          mtime: s.mtimeMs,
          hidden: name.startsWith('.')
        }
        if (isDir && opts?.unity) {
          const version = await unityVersion(full)
          if (version) entry.unity = version
        }
        return entry
      })
    )
    for (const e of batch) if (e) entries.push(e)
  }
  return { dir: slashes(dir), entries }
}

async function statPath(p: unknown): Promise<PickerStat> {
  const target = absolute(p)
  if (!target) return { exists: false, isDir: false }
  try {
    const s = await stat(target)
    return { exists: true, isDir: s.isDirectory() }
  } catch {
    return { exists: false, isDir: false }
  }
}

async function makeDir(parent: unknown, name: unknown): Promise<PickerMkdirResult> {
  const dir = absolute(parent)
  const n = typeof name === 'string' ? name.trim() : ''
  if (!dir) return { ok: false, error: 'Enter an absolute path.' }
  if (!isValidBasename(n, WINDOWS)) return { ok: false, error: 'That folder name is not allowed.' }
  const target = join(dir, n)
  try {
    await mkdir(target)
    return { ok: true, path: slashes(target) }
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return { ok: false, error: `${n} already exists.` }
    if (code === 'EACCES' || code === 'EPERM') return { ok: false, error: 'No permission to create a folder here.' }
    return { ok: false, error: e instanceof Error ? e.message : String(e) }
  }
}

function placePath(name: 'desktop' | 'documents' | 'downloads'): string | null {
  try {
    const p = app.getPath(name)
    return existsSync(p) ? slashes(p) : null
  } catch {
    return null
  }
}

async function volumes(): Promise<PickerPlace[]> {
  if (WINDOWS) {
    const out: PickerPlace[] = []
    for (let c = 67; c <= 90; c++) {
      const drive = `${String.fromCharCode(c)}:/`
      if (existsSync(drive)) out.push({ label: `${String.fromCharCode(c)}:`, path: drive, kind: 'volume' })
    }
    return out
  }
  const out: PickerPlace[] = [{ label: process.platform === 'darwin' ? 'Computer' : 'File system', path: '/', kind: 'volume' }]
  const roots = process.platform === 'darwin' ? ['/Volumes'] : [`/media/${process.env.USER ?? ''}`, '/mnt']
  for (const root of roots) {
    const names = await readdir(root).catch(() => [] as string[])
    for (const name of names) {
      if (name.startsWith('.')) continue
      const full = join(root, name)
      const l = await lstat(full).catch(() => null)
      if (!l || l.isSymbolicLink()) continue
      if (l.isDirectory()) out.push({ label: name, path: full, kind: 'volume' })
    }
  }
  return out
}

async function places(): Promise<PickerPlaces> {
  const home = slashes(homedir())
  const list: PickerPlace[] = [{ label: 'Home', path: home, kind: 'home' }]
  const named: [PickerPlace['kind'], 'desktop' | 'documents' | 'downloads', string][] = [
    ['desktop', 'desktop', 'Desktop'],
    ['documents', 'documents', 'Documents'],
    ['downloads', 'downloads', 'Downloads']
  ]
  for (const [kind, key, label] of named) {
    const p = placePath(key)
    if (p) list.push({ label, path: p, kind })
  }
  return { home, windows: WINDOWS, places: list, volumes: await volumes() }
}

async function nativePick(win: BrowserWindow | null, opts: PickerNativeOptions): Promise<string[] | null> {
  const filters = opts.filters?.map((f) => ({ name: f.name, extensions: f.extensions }))
  if (opts.mode === 'save') {
    const o: Electron.SaveDialogOptions = { title: opts.title, buttonLabel: opts.confirmLabel, defaultPath: opts.defaultPath, filters }
    const res = win ? await dialog.showSaveDialog(win, o) : await dialog.showSaveDialog(o)
    return res.canceled || !res.filePath ? null : [res.filePath]
  }
  const properties: Electron.OpenDialogOptions['properties'] =
    opts.mode === 'openFolder' ? ['openDirectory', 'createDirectory'] : ['openFile']
  if (opts.multiple) properties.push('multiSelections')
  const o: Electron.OpenDialogOptions = { title: opts.title, buttonLabel: opts.confirmLabel, defaultPath: opts.defaultPath, filters, properties }
  const res = win ? await dialog.showOpenDialog(win, o) : await dialog.showOpenDialog(o)
  return res.canceled || res.filePaths.length === 0 ? null : res.filePaths
}

export function registerDialogHandlers(): void {
  ipcMain.handle('picker:places', () => places())
  ipcMain.handle('picker:list', (_e, dir: string, opts?: { unity?: boolean }) => listDir(dir, opts))
  ipcMain.handle('picker:stat', (_e, p: string) => statPath(p))
  ipcMain.handle('picker:mkdir', (_e, parent: string, name: string) => makeDir(parent, name))
  ipcMain.handle('dialog:native', (event, opts: PickerNativeOptions) =>
    nativePick(BrowserWindow.fromWebContents(event.sender), opts ?? { mode: 'openFolder' })
  )
}
