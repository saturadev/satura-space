import { app } from 'electron'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveResource } from '../bundled-resources'
import { syncTreeIncremental } from '../unity/engine-sync'

const PLUGINS_DIR = 'Plugins'
const GUIDE = join('Documentation~', 'agent-guide.md')
const GUIDE_DIR = join('Documentation~', 'agent-guide')

interface EnginePlugin {
  name: string
  title: string
  description: string
  unity: string | null
  guide: string | null
}

function pluginsRoot(): string {
  return app.isPackaged ? resolveResource('plugins') : join(app.getAppPath(), '..', '..', 'plugins')
}

function enginePlugins(): EnginePlugin[] {
  const root = pluginsRoot()
  if (!existsSync(root)) return []
  const out: EnginePlugin[] = []
  for (const e of readdirSync(root, { withFileTypes: true })) {
    if (!e.isDirectory()) continue
    const dir = join(root, e.name)
    let manifest: { title?: string; description?: string } = {}
    try {
      manifest = JSON.parse(readFileSync(join(dir, 'plugin.json'), 'utf8'))
    } catch {
      continue
    }
    out.push({
      name: e.name,
      title: manifest.title || e.name,
      description: manifest.description || '',
      unity: existsSync(join(dir, 'unity')) ? join(dir, 'unity') : null,
      guide: existsSync(join(dir, 'agent.md')) ? join(dir, 'agent.md') : null
    })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function enginePluginKeep(): string[] {
  return [PLUGINS_DIR, `${PLUGINS_DIR}.meta`, GUIDE, ...enginePlugins().filter((p) => p.guide).map((p) => join(GUIDE_DIR, `${p.name}.md`))]
}

async function writeIfChanged(path: string, text: string): Promise<boolean> {
  const have = await readFile(path, 'utf8').catch(() => null)
  if (have === text) return false
  await writeFile(path, text)
  return true
}

function guideWithPlugins(base: string, plugins: EnginePlugin[]): string {
  const rows = plugins.filter((p) => p.guide).map((p) => `| [${p.name}](agent-guide/${p.name}.md) | ${p.title}: ${p.description.replace(/\|/g, '\\|')} |`)
  if (!rows.length) return base
  return `${base.replace(/\s+$/, '')}\n\nPlugins add their own globals to \`satura_exec\`:\n\n| File | What's in it |\n|---|---|\n${rows.join('\n')}\n`
}

export async function syncEnginePlugins(engineSrc: string, dest: string): Promise<string[]> {
  const plugins = enginePlugins()
  const changed: string[] = []
  const pluginsDest = join(dest, PLUGINS_DIR)
  const withUnity = plugins.filter((p) => p.unity)
  if (withUnity.length) {
    await mkdir(pluginsDest, { recursive: true })
    for (const p of withUnity) {
      const r = await syncTreeIncremental(p.unity!, join(pluginsDest, p.name))
      changed.push(...[...r.copied, ...r.removed].map((f) => join(PLUGINS_DIR, p.name, f)))
    }
    const wanted = new Set(withUnity.flatMap((p) => [p.name, `${p.name}.meta`]))
    for (const e of await readdir(pluginsDest)) {
      if (wanted.has(e)) continue
      await rm(join(pluginsDest, e), { recursive: true, force: true })
      changed.push(join(PLUGINS_DIR, e))
    }
  } else if (existsSync(pluginsDest)) {
    await rm(pluginsDest, { recursive: true, force: true })
    await rm(`${pluginsDest}.meta`, { force: true })
    changed.push(PLUGINS_DIR)
  }
  const base = await readFile(join(engineSrc, GUIDE), 'utf8').catch(() => null)
  if (base !== null) {
    await mkdir(join(dest, GUIDE_DIR), { recursive: true })
    for (const p of plugins.filter((x) => x.guide)) {
      if (await writeIfChanged(join(dest, GUIDE_DIR, `${p.name}.md`), await readFile(p.guide!, 'utf8'))) changed.push(join(GUIDE_DIR, `${p.name}.md`))
    }
    if (await writeIfChanged(join(dest, GUIDE), guideWithPlugins(base, plugins))) changed.push(GUIDE)
  }
  return changed
}
