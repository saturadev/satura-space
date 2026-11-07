import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative } from 'node:path'
import { worldStore } from '../unity/world-store'
import { defineHandle, sleep, TEST_PROJECT, type HandleCtx } from './registry'
import { editorWait, logSize, primaryOf, settled } from './unity'
import { guardDialogs } from './dialogs'

const SCRIPT_FILE = /\.(cs|asmdef|asmref)$/

function scriptsUnder(root: string): string[] {
  if (!existsSync(root)) return []
  const out: string[] = []
  const walk = (dir: string): void => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full)
      else if (SCRIPT_FILE.test(e.name)) out.push(relative(root, full))
    }
  }
  walk(root)
  return out
}

function safeDir(project: string, raw: unknown): string {
  const dir = normalize(String(raw ?? '').trim()).replace(/[\\/]+$/, '')
  if (!dir || isAbsolute(dir) || dir.startsWith('..')) throw new Error(`dir must be a folder inside the project, like 'Assets/HandleFixtures', got '${String(raw)}'.`)
  if (!/^(Assets|Packages)[\\/]./.test(dir)) throw new Error(`dir must be a subfolder of Assets or Packages, got '${dir}'.`)
  return join(project, dir)
}

async function refreshAndWait(ctx: HandleCtx, wait: boolean, timeoutS: number): Promise<Record<string, unknown> | null> {
  const pr = primaryOf(ctx.projectRoot)
  if (!pr) return null
  await guardDialogs(ctx, pr.project)
  const offset = logSize(pr.project)
  const desiredGen = (): number => worldStore.getWorld(pr.project).desired.instances[pr.id]?.refreshGen ?? 0
  const gen = desiredGen() + 1
  for (let tries = 0; tries < 20 && desiredGen() < gen; tries++) {
    if (tries) await sleep(250, ctx.signal)
    worldStore.setDesired(pr.project, { instances: { [pr.id]: { refreshGen: gen } } })
  }
  if (desiredGen() < gen) ctx.log('the editor saw no asset change, so it did not refresh')
  if (!wait) return { refreshGen: gen }
  return editorWait(ctx, pr.project, 'the editor to import and compile', () => {
    const obs = worldStore.getWorld(pr.project).observed.instances[pr.id]
    if ((obs?.refreshGen ?? 0) < gen && (worldStore.getWorld(pr.project).desired.instances[pr.id]?.refreshGen ?? 0) >= gen) return null
    return settled(pr, (l) => l === 'editmode' || l === 'playing', offset)
  }, timeoutS * 1000)
}

defineHandle({
  name: 'project.fixtures',
  side: 'main',
  description:
    `Writes files into a folder of the test project and refreshes the editor. files maps paths inside dir to their text, like {'Spin.cs': 'public class Spin ...'}. Scripts (.cs, .asmdef, .asmref) already in dir that are not in files get deleted, so the folder ends up holding exactly this set of scripts. Unchanged files are not rewritten. Waits for the import and compile when wait is true. Only runs on ${TEST_PROJECT}. Returns written, removed and the editor state after the refresh.`,
  params: { dir: 'Assets/HandleFixtures', files: {}, wait: true, timeout: 300 },
  async run(p, ctx) {
    const root = safeDir(ctx.writableProject(), p.dir)
    const files = p.files && typeof p.files === 'object' ? (p.files as Record<string, unknown>) : {}
    const written: string[] = []
    const removed: string[] = []
    for (const [rel, body] of Object.entries(files)) {
      const path = join(root, rel)
      if (relative(root, path).startsWith('..')) throw new Error(`${rel} points outside dir.`)
      const want = Buffer.from(String(body), 'utf8')
      if (existsSync(path) && readFileSync(path).equals(want)) continue
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, want)
      written.push(rel)
    }
    for (const rel of scriptsUnder(root)) {
      if (rel in files) continue
      rmSync(join(root, rel), { force: true })
      rmSync(join(root, `${rel}.meta`), { force: true })
      removed.push(rel)
    }
    const editor = written.length || removed.length ? await refreshAndWait(ctx, p.wait !== false, Number(p.timeout) || 300) : null
    return { dir: root, written, removed, editor }
  }
})

defineHandle({
  name: 'project.drop',
  side: 'main',
  description:
    `Deletes a folder of the test project (and its .meta) that project.fixtures wrote, then refreshes the editor and waits for the compile when wait is true. Only runs on ${TEST_PROJECT}. Returns whether the folder existed and the editor state.`,
  params: { dir: 'Assets/HandleFixtures', wait: true, timeout: 300 },
  async run(p, ctx) {
    const root = safeDir(ctx.writableProject(), p.dir)
    const existed = existsSync(root)
    rmSync(root, { recursive: true, force: true })
    rmSync(`${root}.meta`, { force: true })
    const editor = existed ? await refreshAndWait(ctx, p.wait !== false, Number(p.timeout) || 300) : null
    return { dir: root, existed, editor }
  }
})
