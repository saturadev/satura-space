import { readdir, readFile } from 'node:fs/promises'
import { dirname, join, posix, relative, resolve, sep } from 'node:path'
import { PlayableError } from './project'

const runtimeFiles: Record<string, string> = import.meta.glob('./runtime/*.js', { query: '?raw', import: 'default', eager: true })
const toolFiles: Record<string, string> = import.meta.glob('./tools/*.js', { query: '?raw', import: 'default', eager: true })

const strip = (files: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(files).map(([k, v]) => [k.split('/').pop()!, v]))

export const RUNTIME: Record<string, string> = strip(runtimeFiles)
export const TOOLS: Record<string, string> = strip(toolFiles)

async function live(sourceDir: string | null, dir: string, fallback: Record<string, string>): Promise<Record<string, string>> {
  if (!sourceDir) return fallback
  const names = await readdir(join(sourceDir, dir)).catch(() => null)
  if (!names) return fallback
  const out: Record<string, string> = {}
  for (const name of names.filter((n) => n.endsWith('.js')).sort()) out[name] = await readFile(join(sourceDir, dir, name), 'utf8')
  return out
}

export const runtimeSources = (sourceDir: string | null): Promise<Record<string, string>> => live(sourceDir, 'runtime', RUNTIME)
export const toolSources = (sourceDir: string | null): Promise<Record<string, string>> => live(sourceDir, 'tools', TOOLS)

const IMPORT = /^import\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"];?[ \t]*$/gm
const EXPORT = /^export\s+(?=(?:const|let|var|class|function|async\s+function)\b)/gm
const TOP = /^(?:class|function|const|let|var|async\s+function)\s+([A-Za-z_$][\w$]*)/gm
const VIRTUAL = 'playables:'

export interface BundleResult {
  code: string
  files: { file: string; bytes: number }[]
}

export function runtimeBytes(runtime: Record<string, string> = RUNTIME): number {
  return Object.values(runtime).reduce((n, s) => n + Buffer.byteLength(s), 0)
}

export async function bundle(entry: string, base: string, runtime: Record<string, string> = RUNTIME, extra: string[] = []): Promise<BundleResult> {
  const modules: string[] = []
  const files: { file: string; bytes: number }[] = []
  const seen = new Set<string>()
  const names = new Map<string, string>()

  const resolveSpec = (from: string, spec: string): string => {
    if (spec === 'playables' || spec === 'playables/index.js') return VIRTUAL + 'index.js'
    if (spec.startsWith('playables/')) return VIRTUAL + spec.slice('playables/'.length)
    if (from.startsWith(VIRTUAL)) return VIRTUAL + posix.normalize(posix.join(posix.dirname(from.slice(VIRTUAL.length)), spec))
    if (!spec.startsWith('.')) throw new PlayableError(`${label(from)} imports '${spec}'. Only 'playables' and relative paths are allowed.`, 'bundle')
    const full = resolve(dirname(from), spec)
    const r = relative(base, full)
    if (r.startsWith('..')) throw new PlayableError(`${label(from)} imports ${spec}, which is outside ${base}.`, 'bundle')
    return full
  }

  const label = (file: string): string => (file.startsWith(VIRTUAL) ? `runtime/${file.slice(VIRTUAL.length)}` : relative(base, file).split(sep).join('/'))

  const load = async (file: string): Promise<string> => {
    if (file.startsWith(VIRTUAL)) {
      const text = runtime[file.slice(VIRTUAL.length)]
      if (text === undefined) throw new PlayableError(`There is no runtime module ${file.slice(VIRTUAL.length)}.`, 'bundle')
      return text
    }
    const text = await readFile(file, 'utf8').catch(() => null)
    if (text === null) throw new PlayableError(`${label(file)} is missing.`, 'bundle')
    return text
  }

  const visit = async (file: string): Promise<void> => {
    if (seen.has(file)) return
    seen.add(file)
    let source = (await load(file)).replace(/\r\n/g, '\n')
    for (const match of [...source.matchAll(IMPORT)]) await visit(resolveSpec(file, match[1]))
    source = source.replace(IMPORT, '').replace(EXPORT, '')
    if (/^(?:import|export)\b/m.test(source)) throw new PlayableError(`${label(file)} uses module syntax the packer does not support (one import per line, export only on declarations).`, 'bundle')
    for (const match of source.matchAll(TOP)) {
      const other = names.get(match[1])
      if (other) throw new PlayableError(`${match[1]} is declared at the top level of both ${label(file)} and ${other}. Every top-level name is shared in the packed file, so rename one.`, 'bundle')
      names.set(match[1], label(file))
    }
    files.push({ file: label(file), bytes: Buffer.byteLength(source) })
    modules.push(source)
  }

  await visit(VIRTUAL + 'index.js')
  for (const name of extra) if (runtime[name] !== undefined) await visit(VIRTUAL + name)
  await visit(entry)
  const code = modules
    .join('\n')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .join('\n')
  if (code.includes('</script')) throw new PlayableError('The script contains a closing script tag.', 'bundle')
  return { code, files }
}
