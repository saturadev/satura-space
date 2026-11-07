import { app, session } from 'electron'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { APP_CACHE_IDS, type AppCache, type AppCacheId, type AppCaches, type AppCachesCleared } from '@shared/app-caches'
import { cacheDir, clearPhoneVideoKinds, phoneVideoKinds, type PhoneVideoKind } from './remote/phone-video'
import { clearPhoneVideoStills, phoneVideoStills } from './remote/phone-video-still'

const PHONE_KINDS: Partial<Record<AppCacheId, PhoneVideoKind>> = { 'phone-versions': 'versions', 'phone-1080': 'r1080', 'phone-720': 'r720', 'phone-480': 'r480' }
const GPU_DIRS = ['GPUCache', 'DawnGraphiteCache', 'DawnWebGPUCache', 'GraphiteDawnCache', 'GPUPersistentCache', 'ShaderCache']

const mb = (n: number): string => `${(n / 1e6).toFixed(1)} MB`

async function dirSize(dir: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = join(d, e.name)
      if (e.isDirectory()) await walk(p)
      else if (e.isFile()) {
        const st = await stat(p).catch(() => null)
        if (st) {
          bytes += st.size
          files++
        }
      }
    }
  }
  await walk(dir)
  return { bytes, files }
}

export async function appCaches(): Promise<AppCaches> {
  const data = app.getPath('userData')
  const [kinds, stills, web, code, gpu] = await Promise.all([
    phoneVideoKinds(),
    phoneVideoStills(),
    session.defaultSession.getCacheSize().catch(() => 0),
    dirSize(join(data, 'Code Cache')),
    Promise.all(GPU_DIRS.map((d) => dirSize(join(data, d))))
  ])
  const caches: AppCache[] = APP_CACHE_IDS.map((id) => {
    const kind = PHONE_KINDS[id]
    if (kind) return { id, bytes: kinds[kind].bytes, files: kinds[kind].files, clearable: true }
    if (id === 'phone-stills') return { id, bytes: stills.totalBytes, files: stills.count, clearable: true }
    if (id === 'web') return { id, bytes: web, files: 0, clearable: true }
    if (id === 'code') return { id, ...code, clearable: true }
    return { id, bytes: gpu.reduce((n, g) => n + g.bytes, 0), files: gpu.reduce((n, g) => n + g.files, 0), clearable: false }
  })
  return { caches, total: caches.reduce((n, c) => n + c.bytes, 0), phoneDir: cacheDir(), dataDir: data }
}

export async function clearAppCaches(ids: AppCacheId[]): Promise<AppCachesCleared> {
  const before = await appCaches()
  const wanted = before.caches.filter((c) => c.clearable && ids.includes(c.id)).map((c) => c.id)
  const kinds = wanted.map((id) => PHONE_KINDS[id]).filter((k): k is PhoneVideoKind => !!k)
  if (kinds.length) await clearPhoneVideoKinds(kinds)
  if (wanted.includes('phone-stills')) await clearPhoneVideoStills()
  if (wanted.includes('web')) await session.defaultSession.clearCache()
  if (wanted.includes('code')) await session.defaultSession.clearCodeCaches({})
  const after = await appCaches()
  const freed = Math.max(0, before.total - after.total)
  console.log(`[storage] deleted ${wanted.join(', ') || 'nothing'}: app caches ${mb(before.total)} -> ${mb(after.total)} (${after.caches.map((c) => `${c.id} ${mb(c.bytes)}`).join(', ')})`)
  return { ...after, cleared: wanted, freed }
}
