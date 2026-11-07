import { watch, readFileSync, readdirSync, rmSync, mkdirSync, type FSWatcher } from 'node:fs'
import { readFile, readdir, stat, writeFile, unlink } from 'node:fs/promises'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createHash } from 'node:crypto'
import { SSPACE_DIR, ensureSspaceDirSync } from '../sspace'

const WATCH_ROOTS = ['Assets', 'Packages', 'ProjectSettings'] as const

const IGNORED_ANY_DEPTH = /(^|\/)(Library|\.git|\.sspace|~)(\/|$)/i

const IGNORED_AT_ROOT = /^(Temp|Logs|obj|Build)(\/|$)/i

function isIgnoredProjectPath(relPath: string): boolean {
  const norm = relPath.replace(/\\/g, '/').replace(/^\.\//, '')
  return IGNORED_ANY_DEPTH.test(norm) || IGNORED_AT_ROOT.test(norm)
}

const ORCHESTRATOR_PACKAGE = /(^|\/)Packages\/com\.saturaspace\./i

const COMPILE_EXT = /\.(cs|asmdef|asmref|rsp)$/i

const FS_SYNC_DIR = 'fs-sync'
const FS_SYNC_TIMEOUT_MS = 300
const ROOT_MARKER = /^\.satura-fs-sync-(b\d+)~$/

export type SyncMode = 'sspace' | 'roots'

function isDirtyRelevant(relPath: string | null | undefined): boolean {
  if (!relPath) return true
  const norm = relPath.replace(/\\/g, '/')
  const base = norm.slice(norm.lastIndexOf('/') + 1)
  if (base.startsWith('.') || base.endsWith('~') || base.endsWith('.tmp')) return false
  if (isIgnoredProjectPath(norm)) return false
  if (ORCHESTRATOR_PACKAGE.test(norm)) return false
  return true
}

export async function changedSince(projectPath: string, sinceMs: number, maxEntries = 60000): Promise<string | null> {
  const stack: string[] = [...WATCH_ROOTS]
  let seen = 0
  while (stack.length) {
    const rel = stack.pop()!
    let entries
    try {
      entries = await readdir(join(projectPath, rel), { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      const child = `${rel}/${e.name}`
      if (!isDirtyRelevant(child)) continue
      if (++seen > maxEntries) return null
      if (e.isDirectory()) {
        stack.push(child)
        continue
      }
      try {
        if ((await stat(join(projectPath, child))).mtimeMs > sinceMs) return child
      } catch {
        continue
      }
    }
  }
  return null
}

function externalLocalPackages(projectPath: string): string[] {
  let deps: Record<string, unknown>
  try {
    deps = JSON.parse(readFileSync(join(projectPath, 'Packages', 'manifest.json'), 'utf8'))?.dependencies ?? {}
  } catch {
    return []
  }
  const out: string[] = []
  for (const spec of Object.values(deps)) {
    if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
    const raw = spec.slice(5).replace(/^\/\/(?=\/)/, '')
    const abs = resolve(join(projectPath, 'Packages'), raw)
    const rel = relative(projectPath, abs)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) continue
    if (/\.(tgz|tar\.gz)$/i.test(abs)) continue
    out.push(abs)
  }
  return out
}

function isCompileRelevant(relPath: string | null | undefined): boolean {
  if (!relPath) return false
  if (!isDirtyRelevant(relPath)) return false
  return COMPILE_EXT.test(relPath.replace(/\\/g, '/'))
}

async function hashFile(absPath: string): Promise<string | null> {
  try {
    return createHash('sha1').update(await readFile(absPath)).digest('hex')
  } catch {
    return null
  }
}

export class AssetRefreshWatcher {
  private readonly watchers: FSWatcher[] = []
  private readonly hashes = new Map<string, string>()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  private readonly changed = new Set<string>()
  private readonly pending = new Set<string>()
  private seeding: Promise<void> = Promise.resolve()
  private seeded = true
  private readonly touchedWhileSeeding = new Set<string>()
  private checking: Promise<void> | null = null
  private rootsWatched = false
  private syncWatcher: FSWatcher | null = null
  private syncSeq = 0
  private readonly syncWaits = new Map<string, (ok: boolean) => void>()
  private readonly rootWaits = new Map<string, Set<string>>()

  onAnyChange: ((relPath: string | null) => void) | null = null
  onWatchError: (() => void) | null = null

  constructor(
    private readonly projectPath: string,
    private readonly onRefresh: (relPaths: string[]) => void,
    private readonly debounceMs = 400,
    readonly syncMode: SyncMode = process.platform === 'win32' ? 'roots' : 'sspace'
  ) {}

  start(): void {
    this.seeded = false
    this.seeding = this.seed().finally(() => {
      this.seeded = true
    })
    for (const root of WATCH_ROOTS) {
      try {
        const w = watch(join(this.projectPath, root), { recursive: true }, (_evt, fname) => {
          const name = fname ? fname.toString().replace(/\\/g, '/') : null
          if (name && this.onRootMarker(root, name)) return
          this.onFileEvent(name ? `${root}/${name}` : null)
        })
        w.on('error', () => this.onWatchError?.())
        this.watchers.push(w)
      } catch (e) {
        console.log(`[unity] asset watch ${root} failed: ${(e as Error).message}`)
        this.onWatchError?.()
      }
    }
    if (this.watchers.length === 0) this.onWatchError?.()
    this.rootsWatched = this.watchers.length === WATCH_ROOTS.length
    for (const dir of externalLocalPackages(this.projectPath)) {
      try {
        const w = watch(dir, { recursive: true }, (_evt, fname) => {
          if (this.disposed) return
          const rel = fname ? `Packages/external/${fname.toString().replace(/\\/g, '/')}` : null
          if (isDirtyRelevant(rel)) this.onAnyChange?.(rel)
        })
        w.on('error', () => this.onWatchError?.())
        this.watchers.push(w)
      } catch (e) {
        console.log(`[unity] asset watch ${dir} failed: ${(e as Error).message}`)
        this.onWatchError?.()
      }
    }
    this.startSync()
  }

  canSync(): boolean {
    return this.rootsWatched && !this.disposed
  }

  private onRootMarker(root: string, name: string): boolean {
    const m = ROOT_MARKER.exec(name)
    if (!m) return false
    const left = this.rootWaits.get(m[1])
    if (left) {
      left.delete(root)
      if (left.size === 0) this.syncWaits.get(m[1])?.(true)
    }
    return true
  }

  private clearRootMarkers(): void {
    for (const root of WATCH_ROOTS) {
      try {
        for (const f of readdirSync(join(this.projectPath, root)))
          if (ROOT_MARKER.test(f)) rmSync(join(this.projectPath, root, f), { force: true })
      } catch {
      }
    }
  }

  private syncDir(): string {
    return join(this.projectPath, SSPACE_DIR, FS_SYNC_DIR)
  }

  private startSync(): boolean {
    if (!this.canSync()) return false
    if (this.syncMode === 'roots') {
      this.clearRootMarkers()
      return true
    }
    if (this.syncWatcher) return true
    const dir = this.syncDir()
    try {
      ensureSspaceDirSync(join(this.projectPath, SSPACE_DIR))
      mkdirSync(dir, { recursive: true })
      for (const f of readdirSync(dir)) rmSync(join(dir, f), { force: true })
      const w = watch(dir, (_evt, fname) => {
        const done = fname ? this.syncWaits.get(fname.toString()) : undefined
        if (done) done(true)
      })
      w.on('error', () => this.dropSync(w))
      this.syncWatcher = w
      return true
    } catch (e) {
      console.log(`[unity] fs sync watch failed: ${(e as Error).message}`)
      return false
    }
  }

  private dropSync(w: FSWatcher | null): void {
    if (!w || this.syncWatcher !== w) return
    this.syncWatcher = null
    try {
      w.close()
    } catch {
    }
  }

  sync(timeoutMs = FS_SYNC_TIMEOUT_MS): Promise<boolean> {
    if (this.syncMode === 'roots') return this.syncRoots(timeoutMs)
    if (!this.syncWatcher) {
      this.startSync()
      return Promise.resolve(false)
    }
    if (!this.canSync()) return Promise.resolve(false)
    const w = this.syncWatcher
    const name = `b${++this.syncSeq}`
    const file = join(this.syncDir(), name)
    return new Promise<boolean>((resolveSync) => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.syncWaits.delete(name)
        void unlink(file).catch(() => undefined)
        resolveSync(ok)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.syncWaits.set(name, finish)
      writeFile(file, '').catch(() => {
        this.dropSync(w)
        finish(false)
      })
    })
  }

  private syncRoots(timeoutMs: number): Promise<boolean> {
    if (!this.canSync()) return Promise.resolve(false)
    const name = `b${++this.syncSeq}`
    const files = WATCH_ROOTS.map((root) => join(this.projectPath, root, `.satura-fs-sync-${name}~`))
    this.rootWaits.set(name, new Set(WATCH_ROOTS))
    return new Promise<boolean>((resolveSync) => {
      let settled = false
      const finish = (ok: boolean): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.syncWaits.delete(name)
        this.rootWaits.delete(name)
        for (const f of files) void unlink(f).catch(() => undefined)
        resolveSync(ok)
      }
      const timer = setTimeout(() => finish(false), timeoutMs)
      this.syncWaits.set(name, finish)
      for (const f of files) writeFile(f, '').catch(() => finish(false))
    })
  }

  private async seed(): Promise<void> {
    for (const root of WATCH_ROOTS) {
      if (this.disposed) return
      await this.walkSeed(join(this.projectPath, root), root)
    }
  }

  private async walkSeed(dir: string, rel: string): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (this.disposed) return
      if (e.name.startsWith('.')) continue
      const childRel = `${rel}/${e.name}`
      if (e.isDirectory()) {
        if (isIgnoredProjectPath(childRel) || ORCHESTRATOR_PACKAGE.test(`Packages/${e.name}`)) continue
        await this.walkSeed(join(dir, e.name), childRel)
      } else if (isCompileRelevant(childRel)) {
        const h = await hashFile(join(dir, e.name))
        if (h) this.hashes.set(childRel, h)
      }
    }
  }

  onFileEvent(relPath: string | null): void {
    if (this.disposed) return
    if (isDirtyRelevant(relPath)) this.onAnyChange?.(relPath)
    if (!isCompileRelevant(relPath)) return
    this.pending.add(relPath!)
    if (!this.seeded) this.touchedWhileSeeding.add(relPath!)
    if (!this.checking) this.checking = this.drainPending()
  }

  private async drainPending(): Promise<void> {
    try {
      await this.seeding
      while (this.pending.size > 0 && !this.disposed) {
        const batch = [...this.pending]
        this.pending.clear()
        let any = false
        for (const rel of batch) {
          const h = await hashFile(join(this.projectPath, rel))
          if (this.disposed) return
          const touched = this.touchedWhileSeeding.delete(rel)
          if (h === null) {
            if (!this.hashes.delete(rel) && !touched) continue
          } else {
            if (this.hashes.get(rel) === h && !touched) continue
            this.hashes.set(rel, h)
          }
          this.changed.add(rel)
          any = true
        }
        if (any) this.scheduleFlush()
      }
    } finally {
      this.checking = null
    }
  }

  private scheduleFlush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.disposed) return
      const batch = [...this.changed]
      this.changed.clear()
      this.onRefresh(batch)
    }, this.debounceMs)
  }

  stop(): void {
    this.disposed = true
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const w of this.watchers) {
      try {
        w.close()
      } catch {
      }
    }
    this.watchers.length = 0
    this.dropSync(this.syncWatcher)
    for (const done of [...this.syncWaits.values()]) done(false)
    this.syncWaits.clear()
    this.rootWaits.clear()
    this.hashes.clear()
    this.changed.clear()
    this.pending.clear()
    this.touchedWhileSeeding.clear()
  }
}
