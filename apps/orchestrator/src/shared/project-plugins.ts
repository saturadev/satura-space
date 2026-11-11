export const PLUGIN_GUIDE = 'Packages/com.saturaspace.engine/Documentation~/agent-guide/plugins.md'

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const API_NAMES = new Set(['list', 'open', 'read'])
const KEY_PREFIX = 'project:'

export interface ProjectPluginInfo {
  name: string
  title: string
  description: string
  dir: string
  panel: boolean
  exec: boolean
  guide: boolean
  problem: string | null
}

export function cleanProjectPath(project: string): string {
  return project.replace(/\\/g, '/').replace(/\/+$/, '')
}

export function projectPluginsDir(project: string): string {
  return `${cleanProjectPath(project)}/.sspace/plugins`
}

export function projectPluginFile(project: string, name: string, file: 'panel.tsx' | 'exec.ts' | 'plugin.json' | 'agent.md'): string {
  return `${projectPluginsDir(project)}/${name}/${file}`
}

export function projectPluginNameProblem(name: string, builtIn: Iterable<string>): string | null {
  if (name.length > 40 || !NAME.test(name)) return `"${name}" is not a plugin name: use lowercase letters, digits and dashes, like scene-stats.`
  if (API_NAMES.has(name)) return `"${name}" is taken by plugins.${name}(). Rename the folder.`
  if ([...builtIn].includes(name)) return `"${name}" is the name of a built-in plugin, so this one is not loaded. Rename the folder.`
  return null
}

export function projectPluginKey(name: string): string {
  return `${KEY_PREFIX}${name}`
}

export function projectPluginOfKey(key: string | null | undefined): string | null {
  return key && key.startsWith(KEY_PREFIX) ? key.slice(KEY_PREFIX.length) : null
}

export function projectPluginWidget(name: string): string {
  return `plugin.${name}`
}

export function projectPluginKindOf(file: string): 'panel' | 'exec' | null {
  const f = file.replace(/\\/g, '/')
  if (/\/\.sspace\/plugins\/[^/]+\/panel\.tsx$/.test(f)) return 'panel'
  if (/\/\.sspace\/plugins\/[^/]+\/exec\.ts$/.test(f)) return 'exec'
  return null
}

export function buildNewPluginPrompt(request: string): string {
  return [
    `Make a Satura Space project plugin for this project: ${request.trim()}`,
    `Read ${PLUGIN_GUIDE} first. A project plugin is one folder in .sspace/plugins/<name>/ with plugin.json and an optional panel.tsx, exec.ts and agent.md.`,
    "Write it, then open it with satura_exec plugins.open('<name>'), read the errors it returns and fix them until it opens clean. Check its functions from a script too."
  ].join('\n\n')
}

export function buildPluginAsk(opts: { name: string; title: string; question: string; snapshot: string }): string {
  return [
    `About the "${opts.title}" plugin panel (.sspace/plugins/${opts.name}/panel.tsx):`,
    opts.question.trim(),
    opts.snapshot ? `What the panel has now: ${opts.snapshot}` : '',
    `The plugin lives in .sspace/plugins/${opts.name}/ and ${PLUGIN_GUIDE} describes it. Edit the files, then check with satura_exec plugins.read('${opts.name}').`
  ]
    .filter(Boolean)
    .join('\n\n')
}
