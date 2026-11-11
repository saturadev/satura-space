import vm from 'node:vm'

export const SCRIPT_FILE = 'satura_exec.js'

export type SandboxMessage = Record<string, unknown> & { t: string }

export interface Sandbox {
  deliver(json: string): void
}

function compileFailure(e: unknown, lines: number): SandboxMessage {
  const error = e as Error
  let stack = typeof error?.stack === 'string' ? error.stack.split('\n    at ')[0] : String(e)
  let message = error?.message ?? String(e)
  const at = /^satura_exec\.js:(\d+)/.exec(stack)
  if (at && Number(at[1]) > lines) {
    stack = ''
    message = `${message} at the end of the script: a bracket, quote or template literal is probably left open`
  }
  return { t: 'done', ok: false, name: error?.name ?? 'SyntaxError', message, stack }
}

function pluginModules(init: string): { name: string; code?: string; error?: string }[] {
  try {
    const rows = (JSON.parse(init) as { projectPlugins?: unknown }).projectPlugins
    return Array.isArray(rows) ? rows.filter((r) => r && typeof r.name === 'string') : []
  } catch {
    return []
  }
}

export function startSandbox(code: string, bootstrap: string, post: (msg: SandboxMessage) => void, init = '{}'): Sandbox {
  const context = vm.createContext(Object.create(null), {
    name: 'satura_exec',
    codeGeneration: { strings: false, wasm: false }
  })
  const sandbox = context as Record<string, unknown>
  sandbox.__saturaHost = (json: string): void => {
    try {
      post(JSON.parse(String(json)) as SandboxMessage)
    } catch {
    }
  }
  sandbox.__saturaInit = init
  vm.runInContext(bootstrap, context, { filename: 'satura-api.js' })
  const deliver = sandbox.__saturaDeliver as (json: string) => void
  const start = sandbox.__saturaStart as (fn: unknown) => void
  const addModule = sandbox.__saturaModule as (name: string, load: unknown, error: string) => void
  vm.runInContext('delete globalThis.__saturaDeliver; delete globalThis.__saturaStart; delete globalThis.__saturaHost; delete globalThis.__saturaInit; delete globalThis.__saturaModule', context)
  for (const m of pluginModules(init)) {
    if (!m.code) {
      addModule(m.name, null, m.error ?? '')
      continue
    }
    try {
      addModule(m.name, new vm.Script(`(function (exports) {\n${m.code}\n})`, { filename: `.sspace/plugins/${m.name}/exec.js`, lineOffset: -1 }).runInContext(context), '')
    } catch (e) {
      addModule(m.name, null, `.sspace/plugins/${m.name}/exec.ts did not load: ${(e as Error)?.message ?? String(e)}`)
    }
  }
  let fn: unknown
  try {
    const script = new vm.Script(`(async () => {\n${code}\n})`, { filename: SCRIPT_FILE, lineOffset: -1 })
    fn = script.runInContext(context)
  } catch (e) {
    post(compileFailure(e, code.split('\n').length))
    return { deliver: () => {} }
  }
  start(fn)
  return { deliver: (json) => deliver(json) }
}
