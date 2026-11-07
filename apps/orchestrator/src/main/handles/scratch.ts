import { app } from 'electron'
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { insideRoot } from '../open-roots'
import { defineHandle, type HandleCtx } from './registry'

export type ResourceKind = 'dir' | 'fake' | 'relay' | 'socket'

export interface Resource {
  id: string
  kind: ResourceKind
  label: string
  owner: string
  created: number
  touched: number
  info(): Record<string, unknown>
  close(): Promise<unknown>
}

const IDLE_MS = 30 * 60_000
const resources = new Map<string, Resource>()
const counters = new Map<string, number>()
let sweeper: ReturnType<typeof setInterval> | null = null

export function jailRoot(): string {
  const root = join(tmpdir(), 'satura-handles')
  mkdirSync(root, { recursive: true })
  return realpathSync(root)
}

export function inJail(p: string): boolean {
  return typeof p === 'string' && isAbsolute(p) && insideRoot(jailRoot(), p)
}

export function jailed(p: unknown, what: string): string {
  const s = String(p ?? '')
  if (!inJail(s)) throw new Error(`${what} must be inside ${jailRoot()} (a scratch.dir root), got ${s || 'nothing'}.`)
  return resolve(s)
}

export function ownerOf(p: Record<string, unknown>, ctx: HandleCtx): string {
  return p.keep === true ? 'kept' : ctx.owner
}

function nextId(kind: string): string {
  const n = (counters.get(kind) ?? 0) + 1
  counters.set(kind, n)
  return `${kind}-${n}`
}

function sweep(): void {
  const now = Date.now()
  for (const r of resources.values()) if (r.owner === 'kept' && now - r.touched > IDLE_MS) void closeResource(r.id).catch(() => undefined)
}

export function addResource(kind: ResourceKind, owner: string, label: string, info: () => Record<string, unknown>, close: () => Promise<unknown>): Resource {
  const r: Resource = { id: nextId(kind), kind, label, owner, created: Date.now(), touched: Date.now(), info, close }
  resources.set(r.id, r)
  if (!sweeper) {
    sweeper = setInterval(sweep, 60_000)
    sweeper.unref()
  }
  console.log(`[handle] scratch: opened ${r.id} (${label}) for ${owner}`)
  return r
}

export function getResource(id: unknown, kind: ResourceKind): Resource {
  const want = String(id ?? '').trim()
  const r = want ? resources.get(want) : [...resources.values()].filter((x) => x.kind === kind).pop()
  if (!r || r.kind !== kind) {
    const open = [...resources.values()].filter((x) => x.kind === kind).map((x) => x.id).join(', ') || 'none'
    throw new Error(want ? `There is no open ${kind} ${want}. Open ${kind}s: ${open}.` : `No ${kind} is open. Start one first.`)
  }
  r.touched = Date.now()
  return r
}

export async function closeResource(id: string): Promise<Record<string, unknown>> {
  const r = resources.get(id)
  if (!r) return { id, closed: false, error: 'not open' }
  resources.delete(id)
  try {
    const out = await r.close()
    console.log(`[handle] scratch: closed ${id}`)
    return { id, kind: r.kind, closed: true, ...(out && typeof out === 'object' ? (out as Record<string, unknown>) : {}) }
  } catch (e) {
    return { id, kind: r.kind, closed: true, error: (e as Error).message }
  }
}

export function releaseRun(run: number): void {
  const owner = `run ${run}`
  const mine = [...resources.values()].filter((r) => r.owner === owner)
  if (!mine.length) return
  const order: ResourceKind[] = ['socket', 'relay', 'fake', 'dir']
  void (async () => {
    for (const kind of order) for (const r of mine.filter((x) => x.kind === kind)) await closeResource(r.id)
  })()
}

function closeAllSync(): void {
  for (const r of resources.values()) {
    if (r.kind === 'dir') {
      const root = String(r.info().root ?? '')
      if (inJail(root)) rmSync(root, { recursive: true, force: true })
    } else void r.close().catch(() => undefined)
  }
  resources.clear()
}

if (!app.isPackaged) app.on('will-quit', closeAllSync)

export interface TreeEntry {
  path: string
  kind: 'file' | 'dir' | 'link' | 'other'
  size?: number
  mode?: string
  link?: string
  text?: string
  base64?: string
}

const MAX_TREE = 600
const MAX_TEXT = 32 * 1024

export function treeOf(root: string, opts: { read?: boolean; under?: string } = {}): TreeEntry[] {
  const out: TreeEntry[] = []
  const walk = (dir: string): void => {
    let names: string[]
    try {
      names = readdirSync(dir).sort()
    } catch {
      return
    }
    for (const name of names) {
      if (out.length >= MAX_TREE) return
      const full = join(dir, name)
      const rel = relative(root, full).split(sep).join('/')
      let st
      try {
        st = lstatSync(full)
      } catch {
        continue
      }
      const mode = (st.mode & 0o777).toString(8)
      if (st.isSymbolicLink()) out.push({ path: rel, kind: 'link', link: readlinkSync(full) })
      else if (st.isDirectory()) {
        out.push({ path: rel, kind: 'dir', mode })
        walk(full)
      } else if (st.isFile()) {
        const e: TreeEntry = { path: rel, kind: 'file', size: st.size, mode }
        if (opts.read !== false && st.size <= MAX_TEXT) {
          const buf = readFileSync(full)
          const text = buf.toString('utf8')
          if (!buf.includes(0) && Buffer.from(text, 'utf8').equals(buf)) e.text = text
          else e.base64 = buf.toString('base64')
        }
        out.push(e)
      } else out.push({ path: rel, kind: 'other' })
    }
  }
  walk(opts.under ? join(root, opts.under) : root)
  return out
}

function inside(root: string, rel: string, what: string): string {
  const full = resolve(root, rel)
  const r = relative(root, full)
  if (!r || r.startsWith('..') || isAbsolute(r)) throw new Error(`${what} ${rel} is not inside the scratch dir.`)
  return full
}

function fileBody(v: unknown): string | Buffer {
  if (typeof v === 'string') return v
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.base64 === 'string') return Buffer.from(o.base64, 'base64')
    if ('json' in o) return `${JSON.stringify(o.json, null, 2)}\n`
  }
  return JSON.stringify(v)
}

function sqliteFile(file: string, tables: Record<string, unknown>): void {
  rmSync(file, { force: true })
  const db = new DatabaseSync(file)
  try {
    for (const [table, raw] of Object.entries(tables)) {
      const rows = Array.isArray(raw) ? (raw as Record<string, unknown>[]) : []
      const cols = [...new Set(rows.flatMap((r) => Object.keys(r ?? {})))]
      if (!/^\w+$/.test(table) || cols.some((c) => !/^\w+$/.test(c))) throw new Error(`sqlite table and column names must be words: ${table}`)
      db.exec(`CREATE TABLE ${table} (${(cols.length ? cols : ['id']).join(', ')})`)
      if (!cols.length) continue
      const insert = db.prepare(`INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      for (const r of rows) insert.run(...cols.map((c) => { const v = r?.[c]; return v === undefined || v === null ? null : typeof v === 'object' ? JSON.stringify(v) : (v as string | number) }))
    }
  } finally {
    db.close()
  }
}

export function makeScratch(owner: string, label: string): { root: string; resource: Resource } {
  const root = realpathSync(mkdtempSync(join(jailRoot(), 'scratch-')))
  const resource = addResource('dir', owner, label, () => ({ root }), async () => {
    rmSync(root, { recursive: true, force: true })
    return { root }
  })
  return { root, resource }
}

export function scratchFor(p: Record<string, unknown>, ctx: HandleCtx, label: string): { root: string; id: string; created: boolean } {
  const given = String(p.root ?? '').trim()
  if (given) {
    const owned = [...resources.values()].find((r) => r.kind === 'dir' && String(r.info().root) === resolve(given))
    if (!owned) throw new Error(`${given} is not an open scratch dir. scratch.list shows them; pass root: '' for a new one.`)
    owned.touched = Date.now()
    return { root: resolve(given), id: owned.id, created: false }
  }
  const made = makeScratch(ownerOf(p, ctx), label)
  return { root: made.root, id: made.resource.id, created: true }
}

export function applyLayout(root: string, p: Record<string, unknown>): string[] {
  const done: string[] = []
  for (const rel of Array.isArray(p.remove) ? p.remove.map(String) : []) {
    rmSync(inside(root, rel, 'remove'), { recursive: true, force: true })
    done.push(`removed ${rel}`)
  }
  for (const rel of Array.isArray(p.dirs) ? p.dirs.map(String) : []) {
    mkdirSync(inside(root, rel, 'dir'), { recursive: true })
    done.push(`dir ${rel}`)
  }
  for (const [rel, body] of Object.entries((p.files ?? {}) as Record<string, unknown>)) {
    const file = inside(root, rel, 'file')
    mkdirSync(dirname(file), { recursive: true })
    rmSync(file, { force: true })
    writeFileSync(file, fileBody(body))
    done.push(`file ${rel}`)
  }
  for (const [rel, tables] of Object.entries((p.sqlite ?? {}) as Record<string, unknown>)) {
    const file = inside(root, rel, 'sqlite')
    mkdirSync(dirname(file), { recursive: true })
    sqliteFile(file, (tables ?? {}) as Record<string, unknown>)
    done.push(`sqlite ${rel}`)
  }
  for (const [rel, target] of Object.entries((p.links ?? {}) as Record<string, unknown>)) {
    const link = inside(root, rel, 'link')
    const t = String(target ?? '')
    const resolved = resolve(dirname(link), t)
    if (!t || !insideRoot(jailRoot(), resolved)) throw new Error(`link ${rel} -> ${t} points outside ${jailRoot()}. Point links at another path in the scratch dir, like ../outside/secret.txt.`)
    mkdirSync(dirname(link), { recursive: true })
    rmSync(link, { force: true })
    symlinkSync(t, link)
    done.push(`link ${rel} -> ${t}`)
  }
  for (const [rel, mode] of Object.entries((p.modes ?? {}) as Record<string, unknown>)) {
    chmodSync(inside(root, rel, 'mode'), parseInt(String(mode), 8))
    done.push(`mode ${rel} ${String(mode)}`)
  }
  return done
}

defineHandle({
  name: 'scratch.dir',
  side: 'main',
  agentOnly: true,
  description:
    'Makes or edits a scratch dir under the temp folder (satura-handles/scratch-*, not a Unity scratchpad) for handles that need files: paths.guard, fn.call on modules that touch the disk, hooks.install, mcp.call, relay.start. root: "" makes a new one, root: <path> edits an open one. files maps a relative path to text, {json} or {base64}; dirs lists folders; links maps a relative path to a symlink target (relative or absolute, but it must stay inside the temp jail, so point "escape" links at a sibling folder like outside/); sqlite maps a relative path to {table: [rows]} and builds that database; modes maps a path to an octal mode; remove deletes paths first. A dir made inside an exec script is deleted when the script ends; keep: true keeps it until scratch.close or 30 idle minutes. Returns id, root (real path), what was done and the tree (path, kind, size, mode, link target, text or base64 of files up to 32 KB; read: false leaves contents out).',
  params: { root: '', files: {}, dirs: [] as string[], links: {}, sqlite: {}, modes: {}, remove: [] as string[], read: true, keep: false },
  async run(p, ctx) {
    const s = scratchFor(p, ctx, 'scratch dir')
    const done = applyLayout(s.root, p)
    for (const line of done) ctx.log(`${s.id}: ${line}`)
    return { id: s.id, root: s.root, created: s.created, done, tree: treeOf(s.root, { read: p.read !== false }) }
  }
})

defineHandle({
  name: 'scratch.list',
  side: 'main',
  agentOnly: true,
  description:
    'Lists what the scratch handles hold open: dirs (scratch.dir, hooks.install homes), fakes (fake.start), relays (relay.start) and relay sockets (relay.ws), each with id, kind, label, owner (run N = closed when that exec script ends, kept = kept until scratch.close or 30 idle minutes), age and details such as root, port or pid.',
  params: {},
  async run() {
    const now = Date.now()
    return [...resources.values()].map((r) => ({ id: r.id, kind: r.kind, label: r.label, owner: r.owner, ageS: Math.round((now - r.created) / 1000), idleS: Math.round((now - r.touched) / 1000), ...r.info() }))
  }
})

defineHandle({
  name: 'scratch.close',
  side: 'main',
  agentOnly: true,
  description:
    'Closes scratch resources: id closes one, kind closes every open one of that kind (dir, fake, relay, socket), neither closes all. A relay stops with SIGTERM and returns its exit code, signal and last log lines; a socket closes; a fake stops serving; a dir is deleted. Returns what was closed.',
  params: { id: '', kind: '' },
  async run(p) {
    const id = String(p.id ?? '').trim()
    const kind = String(p.kind ?? '').trim()
    const pick = id ? [...resources.values()].filter((r) => r.id === id) : [...resources.values()].filter((r) => !kind || r.kind === kind)
    if (id && !pick.length) throw new Error(`There is no open scratch resource ${id}.`)
    const order: ResourceKind[] = ['socket', 'relay', 'fake', 'dir']
    const out: Record<string, unknown>[] = []
    for (const k of order) for (const r of pick.filter((x) => x.kind === k)) out.push(await closeResource(r.id))
    return out
  }
})
