import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const PLUGIN_API = 1
const ASYNC_HOOKS = new Set(['authorize', 'iceFor', 'route', 'close'])
const SYNC_HOOKS = new Set(['onUsage', 'onTurnUsage', 'canUse', 'allowance', 'phoneAccess', 'status'])
const DEFAULT_TIMEOUT_MS = 6000

function timeout(ms, name) {
  let timer
  const p = new Promise((_, fail) => {
    timer = setTimeout(() => fail(new Error(`plugin ${name} took over ${ms} ms`)), ms)
  })
  return { p, clear: () => clearTimeout(timer) }
}

export async function loadPlugin(path, ctx) {
  const empty = { name: null, enabled: false, has: () => false, call: async (_n, _a, fallback) => fallback, callSync: (_n, _a, fallback) => fallback, closeNow: () => {}, status: () => null }
  if (!path) return empty
  const file = resolve(path)
  const mod = await import(pathToFileURL(file).href)
  const make = typeof mod.default === 'function' ? mod.default : typeof mod.createPlugin === 'function' ? mod.createPlugin : null
  if (!make) throw new Error(`${file} exports no createPlugin function`)
  const hooks = (await make({ ...ctx, api: PLUGIN_API })) ?? {}
  if (Number(hooks.api ?? PLUGIN_API) !== PLUGIN_API) throw new Error(`${file} speaks plugin api ${hooks.api}, this relay speaks ${PLUGIN_API}`)
  const errors = { count: 0, last: null }
  const fail = (name, e) => {
    errors.count++
    errors.last = `${name}: ${String(e?.message ?? e).slice(0, 200)}`
    ctx.logLimited?.(`plugin-${name}`, 'plugin hook failed', { hook: name, error: String(e?.message ?? e).slice(0, 300) })
  }

  function has(name) {
    return typeof hooks[name] === 'function'
  }

  async function call(name, args, fallback, ms = DEFAULT_TIMEOUT_MS) {
    if (!ASYNC_HOOKS.has(name) || !has(name)) return fallback
    const t = timeout(ms, name)
    try {
      const v = await Promise.race([Promise.resolve().then(() => hooks[name](...args)), t.p])
      return v === undefined ? fallback : v
    } catch (e) {
      fail(name, e)
      return fallback
    } finally {
      t.clear()
    }
  }

  function callSync(name, args, fallback) {
    if (!SYNC_HOOKS.has(name) || !has(name)) return fallback
    try {
      const v = hooks[name](...args)
      return v === undefined ? fallback : v
    } catch (e) {
      fail(name, e)
      return fallback
    }
  }

  let closed = false
  function closeNow() {
    if (closed || !has('close')) return
    closed = true
    try {
      hooks.close()
    } catch (e) {
      fail('close', e)
    }
  }

  return {
    name: String(hooks.name ?? file).slice(0, 80),
    enabled: true,
    has,
    call,
    callSync,
    closeNow,
    status: () => ({ name: String(hooks.name ?? file).slice(0, 80), errors: errors.count, lastError: errors.last, ...(callSync('status', [], null) ?? {}) })
  }
}
