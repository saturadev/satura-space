import { copyFile, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

export interface TreeSyncResult {
  copied: string[]
  removed: string[]
}

async function sameFile(a: string, b: string): Promise<boolean> {
  try {
    const [sa, sb] = await Promise.all([stat(a), stat(b)])
    if (!sb.isFile() || sa.size !== sb.size) return false
    const [ba, bb] = await Promise.all([readFile(a), readFile(b)])
    return ba.equals(bb)
  } catch {
    return false
  }
}

export async function syncTreeIncremental(
  src: string,
  dest: string,
  keepAtRoot: readonly string[] = []
): Promise<TreeSyncResult> {
  const result: TreeSyncResult = { copied: [], removed: [] }
  const walk = async (rel: string): Promise<void> => {
    const from = join(src, rel)
    const to = join(dest, rel)
    const entries = await readdir(from, { withFileTypes: true })
    const names = new Set(entries.map((e) => e.name))
    await mkdir(to, { recursive: true })
    for (const e of entries) {
      const r = join(rel, e.name)
      if (e.isDirectory()) {
        const existing = await stat(join(dest, r)).catch(() => null)
        if (existing && !existing.isDirectory()) await rm(join(dest, r), { force: true })
        await walk(r)
        continue
      }
      if (await sameFile(join(src, r), join(dest, r))) continue
      await rm(join(dest, r), { recursive: true, force: true })
      await copyFile(join(src, r), join(dest, r))
      result.copied.push(r)
    }
    for (const e of await readdir(to, { withFileTypes: true })) {
      if (names.has(e.name)) continue
      if (rel === '' && keepAtRoot.includes(e.name)) continue
      if (e.name.endsWith('.meta') && names.has(e.name.slice(0, -'.meta'.length))) continue
      await rm(join(to, e.name), { recursive: true, force: true })
      result.removed.push(join(rel, e.name))
    }
  }
  await walk('')
  return result
}
