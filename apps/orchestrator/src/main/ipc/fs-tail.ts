import { ipcMain } from 'electron'
import { open } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import type { FsReadFileFromResult } from '@shared/api'

const MAX_TEXT_BYTES = 50 * 1024 * 1024
const SIG_BYTES = 64
const SNIFF_BYTES = 8000

function completeUtf8Length(buf: Buffer): number {
  let i = buf.length - 1
  let trailing = 0
  while (i >= 0 && trailing < 3 && (buf[i] & 0xc0) === 0x80) {
    i--
    trailing++
  }
  if (i < 0) return buf.length
  const lead = buf[i]
  const need = lead >= 0xf0 ? 4 : lead >= 0xe0 ? 3 : lead >= 0xc0 ? 2 : 1
  return trailing + 1 >= need ? buf.length : i
}

function hasNul(buf: Buffer): boolean {
  const n = Math.min(buf.length, SNIFF_BYTES)
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true
  return false
}

type FileHandle = Awaited<ReturnType<typeof open>>

async function readTail(fh: FileHandle, end: number): Promise<Buffer> {
  const len = Math.min(SIG_BYTES, end)
  if (len <= 0) return Buffer.alloc(0)
  const buf = Buffer.alloc(len)
  const { bytesRead } = await fh.read(buf, 0, len, end - len)
  return buf.subarray(0, bytesRead)
}

async function tailSig(fh: FileHandle, end: number): Promise<string> {
  return (await readTail(fh, end)).toString('base64')
}

async function tailMatches(fh: FileHandle, from: number, sig: unknown): Promise<boolean> {
  if (from <= 0 || typeof sig !== 'string') return true
  return (await readTail(fh, from)).equals(Buffer.from(sig, 'base64'))
}

const EMPTY = { text: '', size: 0, next: 0, reset: false, sig: '' }

export function registerFsTailHandlers(): void {
  ipcMain.handle(
    'fs:readFileFrom',
    async (
      _e,
      filePath: unknown,
      offset: unknown,
      sig: unknown
    ): Promise<FsReadFileFromResult> => {
      if (typeof filePath !== 'string' || !filePath || !isAbsolute(filePath)) {
        throw new Error(`fs: expected an absolute path, got ${String(filePath)}`)
      }
      const from = typeof offset === 'number' && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 0
      let fh: FileHandle
      try {
        fh = await open(filePath, 'r')
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code
        if (code === 'ENOENT' || code === 'EISDIR') return { ...EMPTY, notFound: true }
        throw e
      }
      try {
        const s = await fh.stat()
        if (s.isDirectory()) return { ...EMPTY, notFound: true }
        const size = s.size
        if (size > MAX_TEXT_BYTES) return { ...EMPTY, size, tooLarge: true }
        const reset = size < from || !(await tailMatches(fh, from, sig))
        const start = reset ? 0 : from
        const length = size - start
        if (length <= 0) return { text: '', size, next: start, reset, sig: await tailSig(fh, start) }
        if (start === 0) {
          const head = Buffer.alloc(Math.min(length, SNIFF_BYTES))
          const { bytesRead } = await fh.read(head, 0, head.length, 0)
          if (hasNul(head.subarray(0, bytesRead))) return { ...EMPTY, size, isBinary: true }
        }
        const buf = Buffer.alloc(length)
        const { bytesRead } = await fh.read(buf, 0, length, start)
        const chunk = buf.subarray(0, bytesRead)
        let end = completeUtf8Length(chunk)
        if (end > 0 && chunk[end - 1] === 0x0d) end--
        const next = start + end
        return { text: chunk.toString('utf8', 0, end), size, next, reset, sig: await tailSig(fh, next) }
      } finally {
        await fh.close()
      }
    }
  )
}
