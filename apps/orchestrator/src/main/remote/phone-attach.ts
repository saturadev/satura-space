import { constants } from 'node:fs'
import { mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { attachPath } from './phone-policy'
import { ensureSspaceDir } from '../sspace'

const KEEP_MS = 24 * 60 * 60 * 1000
const MAX_BYTES = 32 * 1024 * 1024
const NOFOLLOW = constants.O_NOFOLLOW ?? 0

async function prune(dir: string): Promise<void> {
  const cut = Date.now() - KEEP_MS
  let gone = 0
  for (const name of await readdir(dir).catch(() => [] as string[])) {
    const p = join(dir, name)
    const st = await stat(p).catch(() => null)
    if (!st?.isFile() || st.mtimeMs > cut) continue
    await rm(p, { force: true })
    gone++
  }
  if (gone) console.log(`[remote] removed ${gone} phone images older than a day from ${dir}`)
}

export async function attachChunk(req: unknown): Promise<string> {
  const path = attachPath(req)
  const r = (req ?? {}) as { at?: unknown; total?: unknown; data?: unknown }
  const at = Number(r.at)
  const total = Number(r.total)
  const data = Buffer.from(typeof r.data === 'string' ? r.data : '', 'base64')
  if (!path || !Number.isInteger(at) || !Number.isInteger(total) || at < 0 || !data.length || at + data.length > total || total > MAX_BYTES) throw new Error("The desktop couldn't take that image")
  const part = `${path}.part`
  if (at === 0) {
    await ensureSspaceDir(dirname(dirname(path)))
    await mkdir(dirname(path), { recursive: true })
    await prune(dirname(path))
  }
  const fh = await open(part, (at === 0 ? constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC : constants.O_WRONLY) | NOFOLLOW, 0o600)
  try {
    await fh.write(data, 0, data.length, at)
  } finally {
    await fh.close()
  }
  if (at + data.length < total) return ''
  const size = (await stat(part)).size
  if (size !== total) throw new Error(`The image arrived with ${size} of ${total} bytes`)
  await rename(part, path)
  console.log(`[remote] phone image saved ${path} (${Math.round(total / 1024)} KB)`)
  return path
}
