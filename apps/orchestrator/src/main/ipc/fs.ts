import { BrowserWindow, ipcMain, shell, webContents } from 'electron'
import { access, copyFile, cp, lstat, mkdir, open, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { constants, watch, type FSWatcher } from 'node:fs'
import { basename, dirname, extname, isAbsolute, join } from 'node:path'
import { homedir } from 'node:os'
import type { DirEntry, FsReadFileResult, FsPathInfo, FsTrashResult, FsMoveResult, FsRenameResult, FsWriteResult } from '@shared/api'
import { versionStamp } from '@shared/version-stamp'
import { atomicWriteFile } from '../safe-fs'
import { registerFsListFiles } from './fs-list-files'
import { registerFsSearch } from './fs-search'
import { registerFsWatchDirs } from './fs-watch-dirs'
import { toNativePath } from './native-path'
import { onRendererReset } from '../window/renderer-reset'
import { censusTrack } from '@shared/census'

const MAX_TEXT_BYTES = 50 * 1024 * 1024

const IMAGE_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

export function assertAbsolute(p: unknown): string {
  if (typeof p !== 'string' || !p || !isAbsolute(p)) {
    throw new Error(`fs: expected an absolute path, got ${String(p)}`)
  }
  return p
}

function resolveDir(p: unknown): string {
  if (p === '' || p == null) return homedir()
  return assertAbsolute(p)
}

export function normalizeInputPath(input: unknown): string {
  if (typeof input !== 'string') return ''
  let p = input.trim()
  if (p.length >= 2 && ((p[0] === '"' && p.at(-1) === '"') || (p[0] === "'" && p.at(-1) === "'"))) {
    p = p.slice(1, -1)
  }
  p = p.replace(/\\ /g, ' ')
  if (p === '~') p = homedir()
  else if (p.startsWith('~/')) p = join(homedir(), p.slice(2))
  return isAbsolute(p) ? p : ''
}

function looksBinary(buf: Buffer): boolean {
  const n = Math.min(buf.length, 8000)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

async function readHead(file: string, bytes: number): Promise<Buffer> {
  const fh = await open(file, 'r')
  try {
    const buf = Buffer.alloc(bytes)
    const { bytesRead } = await fh.read(buf, 0, bytes, 0)
    return buf.subarray(0, bytesRead)
  } finally {
    await fh.close()
  }
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

async function entryExists(p: string): Promise<boolean> {
  try {
    await lstat(p)
    return true
  } catch {
    return false
  }
}

async function sameEntryOtherCase(src: string, dest: string): Promise<boolean> {
  if (src === dest || src.toLowerCase() !== dest.toLowerCase()) return false
  try {
    const [a, b] = await Promise.all([lstat(src), lstat(dest)])
    return a.dev === b.dev && a.ino === b.ino
  } catch {
    return false
  }
}

async function moveMetaAlong(src: string, dest: string): Promise<void> {
  if (src.endsWith('.meta') || !(await pathExists(`${src}.meta`))) return
  if ((await entryExists(`${dest}.meta`)) && !(await sameEntryOtherCase(`${src}.meta`, `${dest}.meta`))) {
    console.log(`[fs] kept ${src}.meta where it is: ${dest}.meta already exists`)
    return
  }
  try {
    await rename(`${src}.meta`, `${dest}.meta`)
  } catch (err) {
    console.log(`[fs] could not move ${src}.meta: ${(err as Error).message}`)
  }
}

const LOCK_CODES = new Set(['EBUSY', 'EPERM', 'EACCES', 'ENOTEMPTY'])

function isLockError(err: unknown): boolean {
  const e = err as { code?: string; message?: string } | null
  if (e?.code && LOCK_CODES.has(e.code)) return true
  const msg = (e?.message ?? '').toLowerCase()
  return (
    msg.includes('being used by another process') ||
    msg.includes('used by another process') ||
    msg.includes('locked') ||
    msg.includes('access is denied') ||
    msg.includes('resource busy') ||
    msg.includes('permission denied')
  )
}

async function duplicateTarget(p: string, isDir: boolean): Promise<string> {
  const dir = dirname(p)
  const ext = isDir ? '' : extname(p)
  const base = isDir ? basename(p) : basename(p, ext)
  let candidate = join(dir, `${base} copy${ext}`)
  let n = 2
  while (await pathExists(candidate)) {
    candidate = join(dir, `${base} copy ${n}${ext}`)
    n++
  }
  return candidate
}

const writeChains = new Map<string, Promise<unknown>>()

function oneWriteAtATime<T>(file: string, run: () => Promise<T>): Promise<T> {
  const prev = writeChains.get(file) ?? Promise.resolve()
  const next = prev.then(run, run)
  const tail = next.catch(() => undefined)
  writeChains.set(file, tail)
  void tail.then(() => {
    if (writeChains.get(file) === tail) writeChains.delete(file)
  })
  return next
}

async function currentText(file: string): Promise<string | null | undefined> {
  let buf: Buffer
  try {
    const s = await stat(file)
    if (s.isDirectory() || s.size > MAX_TEXT_BYTES) return undefined
    buf = await readFile(file)
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw e
  }
  return looksBinary(buf) ? undefined : buf.toString('utf8')
}

export async function writeTextFile(file: string, content: string, expected?: string): Promise<FsWriteResult> {
  if (typeof content !== 'string') throw new Error('fs: expected text content')
  return oneWriteAtATime(file, async () => {
    if (typeof expected === 'string') {
      const now = await currentText(file)
      if (now !== null) {
        const stamp = now === undefined ? '' : versionStamp(now)
        if (stamp !== expected) {
          console.log(`[fs] refused to save ${file}: it changed on disk since the edit began (based on ${expected}, disk is ${stamp || 'not text'})`)
          return now === undefined ? { ok: false, code: 'conflict', stamp } : { ok: false, code: 'conflict', stamp, disk: now }
        }
      }
    }
    await atomicWriteFile(file, content)
    return { ok: true, stamp: versionStamp(content) }
  })
}

function announcePathMoved(from: string, to: string): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('fs:pathMoved', { from, to })
}

export async function renameEntry(src: string, dest: string): Promise<FsRenameResult> {
  if (src === dest) return { ok: true }
  if ((await entryExists(dest)) && !(await sameEntryOtherCase(src, dest))) {
    console.log(`[fs] refused to rename ${src} to ${dest}: the destination already exists`)
    return { ok: false, code: 'exists' }
  }
  try {
    await rename(src, dest)
  } catch (err) {
    if (isLockError(err)) return { ok: false, code: 'locked' }
    return { ok: false, code: 'error', message: (err as Error)?.message }
  }
  await moveMetaAlong(src, dest)
  return { ok: true }
}

export async function duplicateEntry(src: string): Promise<string> {
  const isDir = (await stat(src)).isDirectory()
  const target = await duplicateTarget(src, isDir)
  if (isDir) await cp(src, target, { recursive: true, force: false, errorOnExist: true })
  else await copyFile(src, target, constants.COPYFILE_EXCL)
  return target
}

interface FileWatch {
  watcher: FSWatcher | null
  timer: ReturnType<typeof setTimeout> | null
  retry: ReturnType<typeof setTimeout> | null
  probe: ReturnType<typeof setInterval> | null
}

const WATCH_PROBE_MS = 5000

const fileWatchers = new Map<number, Map<string, FileWatch>>()
censusTrack('fs.fileWatchers', fileWatchers)

function stopFileWatch(wcId: number, watchId: string): void {
  const m = fileWatchers.get(wcId)
  const w = m?.get(watchId)
  if (!m || !w) return
  if (w.timer) clearTimeout(w.timer)
  if (w.retry) clearTimeout(w.retry)
  if (w.probe) clearInterval(w.probe)
  try {
    w.watcher?.close()
  } catch {
  }
  m.delete(watchId)
  if (m.size === 0) fileWatchers.delete(wcId)
}

export function registerFsHandlers(): void {
  ipcMain.handle('fs:readDir', async (_e, dirPath: string): Promise<DirEntry[]> => {
    const dir = resolveDir(dirPath)
    try {
      const entries = await readdir(dir, { withFileTypes: true })
      return entries
        .map((d) => ({
          name: d.name,
          path: join(dir, d.name).replace(/\\/g, '/'),
          isDirectory: d.isDirectory()
        }))
        .sort((a, b) =>
          a.isDirectory === b.isDirectory
            ? a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
            : a.isDirectory
              ? -1
              : 1
        )
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EPERM' || code === 'EACCES') return []
      throw e
    }
  })

  ipcMain.handle('fs:readFile', async (_e, filePath: string): Promise<FsReadFileResult> => {
    const file = assertAbsolute(filePath)
    const ext = extname(file).toLowerCase()
    const imageMime = IMAGE_MIME[ext]
    const readError = (e: unknown): FsReadFileResult => {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT' || code === 'EISDIR') {
        return { content: '', isBinary: false, notFound: true }
      }
      throw new Error(
        code === 'EACCES' ? 'Permission denied reading this file.' : (e as Error).message
      )
    }

    let size: number
    try {
      const s = await stat(file)
      if (s.isDirectory()) return { content: '', isBinary: false, notFound: true }
      size = s.size
    } catch (e) {
      return readError(e)
    }

    if (size > MAX_TEXT_BYTES) {
      return { content: '', isBinary: false, tooLarge: true, byteLength: size }
    }

    if (!imageMime || ext === '.svg') {
      let head: Buffer
      try {
        head = await readHead(file, 8000)
      } catch (e) {
        return readError(e)
      }
      if (looksBinary(head)) {
        return { content: '', isBinary: true, byteLength: size }
      }
    }

    let buf: Buffer
    try {
      buf = await readFile(file)
    } catch (e) {
      return readError(e)
    }

    if (buf.length > MAX_TEXT_BYTES) {
      return { content: '', isBinary: false, tooLarge: true, byteLength: buf.length }
    }

    if (imageMime && ext !== '.svg') {
      return {
        content: '',
        isBinary: true,
        isImage: true,
        mimeType: imageMime,
        dataUrl: `data:${imageMime};base64,${buf.toString('base64')}`
      }
    }
    if (looksBinary(buf)) {
      return { content: '', isBinary: true, byteLength: buf.length }
    }
    return { content: buf.toString('utf8'), isBinary: false, byteLength: buf.length }
  })

  ipcMain.handle('fs:statPath', async (_e, inputPath: string): Promise<FsPathInfo> => {
    const resolved = normalizeInputPath(inputPath)
    if (!resolved) return { resolved: '', exists: false, isFile: false, isDirectory: false }
    try {
      const s = await stat(resolved)
      return {
        resolved,
        exists: true,
        isFile: s.isFile(),
        isDirectory: s.isDirectory(),
        size: s.size
      }
    } catch {
      return { resolved, exists: false, isFile: false, isDirectory: false }
    }
  })

  ipcMain.handle(
    'fs:writeFile',
    async (_e, args: { filePath: string; content: string; expected?: string }): Promise<FsWriteResult> =>
      writeTextFile(assertAbsolute(args?.filePath), args.content, typeof args.expected === 'string' ? args.expected : undefined)
  )

  ipcMain.handle('fs:createFile', async (_e, filePath: string): Promise<void> => {
    await writeFile(assertAbsolute(filePath), '', { flag: 'wx' })
  })

  ipcMain.handle('fs:createDir', async (_e, dirPath: string): Promise<void> => {
    await mkdir(assertAbsolute(dirPath), { recursive: true })
  })

  ipcMain.handle(
    'fs:rename',
    async (_e, args: { oldPath: string; newPath: string }): Promise<FsRenameResult> => {
      const src = assertAbsolute(args?.oldPath)
      const dest = assertAbsolute(args?.newPath)
      const res = await renameEntry(src, dest)
      if (res.ok && src !== dest) announcePathMoved(src, dest)
      return res
    }
  )

  ipcMain.handle('fs:move', async (_e, args: { oldPath: string; newPath: string }): Promise<FsMoveResult> => {
    const src = assertAbsolute(args?.oldPath)
    const dest = assertAbsolute(args?.newPath)
    if (src === dest) return { ok: true }
    if (dest === src || dest.startsWith(src + '/') || dest.startsWith(src + '\\')) {
      return { ok: false, code: 'error', message: 'Cannot move a folder into itself.' }
    }
    if (await entryExists(dest)) return { ok: false, code: 'exists' }
    try {
      await rename(src, dest)
      await moveMetaAlong(src, dest)
      announcePathMoved(src, dest)
      return { ok: true }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EXDEV') {
        try {
          await cp(src, dest, { recursive: true, force: false, errorOnExist: true })
          await shell.trashItem(toNativePath(src))
          announcePathMoved(src, dest)
          return { ok: true }
        } catch (err2) {
          if (isLockError(err2)) return { ok: false, code: 'locked' }
          return { ok: false, code: 'error', message: (err2 as Error)?.message }
        }
      }
      if (isLockError(err)) return { ok: false, code: 'locked' }
      return { ok: false, code: 'error', message: (err as Error)?.message }
    }
  })

  ipcMain.handle('fs:trash', async (_e, p: string): Promise<FsTrashResult> => {
    const target = toNativePath(assertAbsolute(p))
    try {
      await shell.trashItem(target)
      if (process.platform === 'win32' && (await pathExists(target))) {
        return { ok: false, code: 'locked' }
      }
      const meta = `${target}.meta`
      if (!target.endsWith('.meta') && (await pathExists(meta))) await shell.trashItem(meta).catch(() => {})
      return { ok: true }
    } catch (err) {
      if (isLockError(err)) return { ok: false, code: 'locked' }
      return { ok: false, code: 'error', message: (err as Error)?.message }
    }
  })

  ipcMain.handle('fs:duplicate', async (_e, p: string): Promise<string> => duplicateEntry(assertAbsolute(p)))

  ipcMain.on('fs:watch:start', (e, args: { watchId?: string; filePath?: string }) => {
    const wcId = e.sender.id
    const watchId = args?.watchId
    const filePath = args?.filePath
    if (!watchId || typeof filePath !== 'string' || !isAbsolute(filePath)) return
    let m = fileWatchers.get(wcId)
    if (!m) {
      m = new Map()
      fileWatchers.set(wcId, m)
      onRendererReset(e.sender, 'fs:watch', () => {
        const own = fileWatchers.get(wcId)
        if (own) for (const id of [...own.keys()]) stopFileWatch(wcId, id)
      })
    }
    stopFileWatch(wcId, watchId)
    const dir = dirname(filePath)
    const target = basename(filePath)
    const entry: FileWatch = { watcher: null, timer: null, retry: null, probe: null }
    m.set(watchId, entry)
    const isCurrent = (): boolean => fileWatchers.get(wcId)?.get(watchId) === entry
    const fire = (): void => {
      if (entry.timer) clearTimeout(entry.timer)
      entry.timer = setTimeout(() => {
        const wc = webContents.fromId(wcId)
        if (wc && !wc.isDestroyed()) wc.send('fs:watch:changed', { watchId })
      }, 80)
    }
    const scheduleRestart = (): void => {
      if (entry.retry) return
      entry.retry = setTimeout(() => {
        entry.retry = null
        if (!isCurrent()) return
        start()
        fire()
      }, 1000)
    }
    const start = (): void => {
      let w: FSWatcher
      try {
        w = watch(dir, (_evt, fname) => {
          if (!fname || fname.toString() === target) fire()
        })
      } catch {
        scheduleRestart()
        return
      }
      w.on('error', () => {
        try {
          w.close()
        } catch {
        }
        if (entry.watcher === w) entry.watcher = null
        if (isCurrent()) scheduleRestart()
      })
      entry.watcher = w
    }
    start()
    entry.probe = setInterval(() => {
      const w = entry.watcher
      if (!w) return
      stat(dir).catch(() => {
        if (entry.watcher !== w) return
        try {
          w.close()
        } catch {
        }
        entry.watcher = null
        if (isCurrent()) scheduleRestart()
      })
    }, WATCH_PROBE_MS)
  })

  ipcMain.on('fs:watch:stop', (e, args: { watchId?: string }) => {
    if (args?.watchId) stopFileWatch(e.sender.id, args.watchId)
  })

  registerFsListFiles()
  registerFsSearch()
  registerFsWatchDirs()
}
