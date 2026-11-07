export interface FnModuleInfo {
  module: string
  io: string | null
}

export interface FnCallSpec {
  module: string
  fn: string
  args: unknown[]
  construct: boolean
  then: { call: string; args: unknown[] }[]
}

export interface FnFake {
  index: number
  calls: unknown[][]
}

export interface FnGraphRules {
  ioPackage(spec: string): boolean
  ioSource(text: string): string | null
  alias: Record<string, string>
}

const IMPORT_RE = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?(?:[\w*$\s{},]*?\s+from\s+)?['"]([^'"\n]+)['"]|\bimport\(\s*['"]([^'"\n]+)['"]\s*\)/g
const EXTS = ['.ts', '.tsx', '/index.ts', '/index.tsx', '']

export function normalizePath(p: string): string {
  const out: string[] = []
  for (const part of p.replace(/\\/g, '/').split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') out.pop()
    else out.push(part)
  }
  return out.join('/')
}

export function globKeyPath(base: string, key: string): string {
  return normalizePath(`${base}/${key}`)
}

export function moduleName(path: string): string {
  return path.replace(/\.(tsx?|mjs|js)$/, '')
}

function dirOf(path: string): string {
  const i = path.lastIndexOf('/')
  return i < 0 ? '' : path.slice(0, i)
}

function resolveSpec(from: string, spec: string, known: Set<string>, alias: Record<string, string>): string | null | 'package' {
  let base: string | null = null
  if (spec.startsWith('./') || spec.startsWith('../')) base = normalizePath(`${dirOf(from)}/${spec}`)
  else {
    for (const [prefix, target] of Object.entries(alias)) {
      if (spec === prefix || spec.startsWith(`${prefix}/`)) base = normalizePath(`${target}${spec.slice(prefix.length)}`)
    }
    if (base === null) return 'package'
  }
  for (const ext of EXTS) if (known.has(`${base}${ext}`)) return `${base}${ext}`
  return null
}

export function importsOf(text: string): { spec: string; typeOnly: boolean }[] {
  const out: { spec: string; typeOnly: boolean }[] = []
  IMPORT_RE.lastIndex = 0
  for (let m = IMPORT_RE.exec(text); m; m = IMPORT_RE.exec(text)) {
    const spec = m[3] ?? m[4]
    if (spec) out.push({ spec, typeOnly: !!m[2] })
  }
  return out
}

export function purityGraph(sources: Record<string, string>, rules: FnGraphRules): Map<string, string | null> {
  const known = new Set(Object.keys(sources))
  const deps = new Map<string, string[]>()
  const reason = new Map<string, string | null>()
  for (const [path, text] of Object.entries(sources)) {
    const own: string[] = []
    let io = rules.ioSource(text)
    for (const { spec, typeOnly } of importsOf(text)) {
      if (typeOnly || spec.includes('?')) continue
      const hit = resolveSpec(path, spec, known, rules.alias)
      if (hit === 'package') {
        if (!io && rules.ioPackage(spec)) io = `imports ${spec}`
      } else if (hit === null) {
        if (!io) io = `imports ${spec}, which is not in the registry`
      } else own.push(hit)
    }
    deps.set(path, own)
    reason.set(path, io)
  }
  for (let changed = true; changed; ) {
    changed = false
    for (const [path, list] of deps) {
      if (reason.get(path)) continue
      const bad = list.find((d) => reason.get(d))
      if (bad) {
        reason.set(path, `imports ${moduleName(bad)} (${reason.get(bad)})`.slice(0, 300))
        changed = true
      }
    }
  }
  return reason
}

export function findModule(names: string[], want: string): string[] {
  const w = moduleName(normalizePath(want.trim().replace(/^@shared\//, 'src/shared/').replace(/^@renderer\//, 'src/renderer/src/')))
  if (!w) return []
  const bare = (n: string): string[] => [moduleName(n), moduleName(n).replace(/\/index$/, '')]
  const exact = names.filter((n) => bare(n).includes(w))
  if (exact.length) return exact
  const tail = names.filter((n) => bare(n).some((b) => b.endsWith(`/${w}`)))
  const files = tail.filter((n) => moduleName(n).endsWith(`/${w}`))
  return files.length ? files : tail
}

function fakeFn(spec: Record<string, unknown>, fakes: FnFake[]): (...args: unknown[]) => unknown {
  const record: FnFake = { index: fakes.length, calls: [] }
  fakes.push(record)
  const byArgs = spec.byArgs && typeof spec.byArgs === 'object' ? (spec.byArgs as Record<string, unknown>) : {}
  return (...args: unknown[]) => {
    const plain = args.map((a) => encodeValue(a))
    record.calls.push(plain)
    const key = JSON.stringify(plain)
    if (key in byArgs) return decodeValue(byArgs[key], fakes)
    if (typeof spec.throws === 'string') throw new Error(spec.throws)
    if (typeof spec.template === 'string') {
      const strs = args.map((a) => String(a))
      return spec.template.replace(/\{(\d+|\*)\}/g, (_m, i: string) => (i === '*' ? strs.join('/') : (strs[Number(i)] ?? '')))
    }
    return decodeValue(spec.returns, fakes)
  }
}

export function decodeValue(v: unknown, fakes: FnFake[]): unknown {
  if (Array.isArray(v)) return v.map((x) => decodeValue(x, fakes))
  if (!v || typeof v !== 'object') return v
  const o = v as Record<string, unknown>
  const keys = Object.keys(o)
  if (keys.length === 1 || (keys.length === 2 && 'flags' in o)) {
    if ('$undefined' in o) return undefined
    if ('$number' in o) return Number(o.$number)
    if ('$bigint' in o) return BigInt(String(o.$bigint))
    if ('$date' in o) return new Date(String(o.$date))
    if ('$regexp' in o) return new RegExp(String(o.$regexp), typeof o.flags === 'string' ? o.flags : '')
    if ('$map' in o && Array.isArray(o.$map)) return new Map((o.$map as unknown[][]).map(([k, x]) => [decodeValue(k, fakes), decodeValue(x, fakes)]))
    if ('$set' in o && Array.isArray(o.$set)) return new Set((o.$set as unknown[]).map((x) => decodeValue(x, fakes)))
    if ('$fn' in o) return fakeFn(o.$fn && typeof o.$fn === 'object' ? (o.$fn as Record<string, unknown>) : {}, fakes)
    if ('$literal' in o) return o.$literal
  }
  const out: Record<string, unknown> = {}
  for (const k of keys) out[k] = decodeValue(o[k], fakes)
  return out
}

export function encodeValue(v: unknown, depth = 0, seen: Set<object> = new Set()): unknown {
  if (v === undefined) return { $undefined: true }
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return v
  if (typeof v === 'number') return Number.isFinite(v) ? (Object.is(v, -0) ? 0 : v) : { $number: String(v) }
  if (typeof v === 'bigint') return { $bigint: v.toString() }
  if (typeof v === 'symbol') return { $symbol: v.toString() }
  if (typeof v === 'function') return { $function: v.name || 'anonymous' }
  if (depth > 24) return { $cut: 'too deep' }
  const o = v as object
  if (seen.has(o)) return { $cycle: true }
  seen.add(o)
  try {
    if (o instanceof Date) return { $date: Number.isNaN(o.getTime()) ? 'Invalid Date' : o.toISOString() }
    if (o instanceof RegExp) return { $regexp: o.source, flags: o.flags }
    if (o instanceof Error) return { $error: { name: o.name, message: o.message, ...('code' in o ? { code: encodeValue((o as { code: unknown }).code, depth + 1, seen) } : {}) } }
    if (o instanceof Map) return { $map: [...o.entries()].slice(0, 2000).map(([k, x]) => [encodeValue(k, depth + 1, seen), encodeValue(x, depth + 1, seen)]) }
    if (o instanceof Set) return { $set: [...o].slice(0, 2000).map((x) => encodeValue(x, depth + 1, seen)) }
    if (ArrayBuffer.isView(o)) {
      const bytes = new Uint8Array(o.buffer, o.byteOffset, o.byteLength)
      return { $bytes: bytes.length, head: [...bytes.slice(0, 64)] }
    }
    if (Array.isArray(o)) return o.slice(0, 5000).map((x) => encodeValue(x, depth + 1, seen))
    const out: Record<string, unknown> = {}
    const name = Object.getPrototypeOf(o)?.constructor?.name
    if (name && name !== 'Object') out.$class = name
    for (const [k, x] of Object.entries(o)) out[k] = encodeValue(x, depth + 1, seen)
    return out
  } finally {
    seen.delete(o)
  }
}

export function exportsOf(mod: Record<string, unknown>): { name: string; kind: string; params?: string }[] {
  return Object.keys(mod)
    .sort()
    .map((name) => {
      const v = mod[name]
      if (typeof v !== 'function') return { name, kind: v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v }
      const text = Function.prototype.toString.call(v)
      const isClass = /^class\b/.test(text)
      const m = /^[^(]*\(([^)]*)\)/.exec(text) ?? /^(?:async\s+)?([\w$]+)\s*=>/.exec(text)
      return { name, kind: isClass ? 'class' : 'function', params: (m?.[1] ?? '').replace(/\s+/g, ' ').trim().slice(0, 200) }
    })
}

export async function runFnCall(mod: Record<string, unknown>, spec: FnCallSpec, timeoutMs: number): Promise<{ value: unknown; steps: unknown[]; fakes: FnFake[] }> {
  const fakes: FnFake[] = []
  const path = spec.fn.split('.').filter(Boolean)
  if (!path.length) throw new Error('Pass fn: the export to call, like "parseFrame" or "Klass.method".')
  let owner: unknown = undefined
  let target: unknown = mod
  for (const part of path) {
    if (target === null || target === undefined) throw new Error(`${spec.module} has no ${spec.fn}.`)
    owner = target
    target = (target as Record<string, unknown>)[part]
  }
  if (target === undefined) {
    const names = Object.keys(mod).slice(0, 60).join(', ')
    throw new Error(`${spec.module} has no export ${spec.fn}. It exports: ${names || 'nothing'}.`)
  }
  const deadline = <T>(work: Promise<T> | T, what: string): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    return Promise.race([
      Promise.resolve(work),
      new Promise<T>((_r, reject) => {
        timer = setTimeout(() => reject(new Error(`${what} did not settle within ${timeoutMs} ms.`)), timeoutMs)
      })
    ]).finally(() => clearTimeout(timer))
  }
  const args = spec.args.map((a) => decodeValue(a, fakes))
  let value: unknown
  if (typeof target !== 'function') {
    if (args.length || spec.construct) throw new Error(`${spec.fn} is a ${typeof target}, not a function.`)
    value = target
  } else if (spec.construct) {
    value = new (target as new (...a: unknown[]) => unknown)(...args)
  } else {
    value = await deadline((target as (...a: unknown[]) => unknown).apply(owner === mod ? undefined : owner, args), spec.fn)
  }
  const steps: unknown[] = []
  for (const step of spec.then) {
    const method = value && typeof value === 'object' ? (value as Record<string, unknown>)[step.call] : undefined
    if (typeof method !== 'function') throw new Error(`The result has no method ${step.call}.`)
    const out = await deadline((method as (...a: unknown[]) => unknown).apply(value, step.args.map((a) => decodeValue(a, fakes))), step.call)
    steps.push({ call: step.call, value: encodeValue(out), after: encodeValue(value) })
  }
  return { value, steps, fakes }
}

export function fnSpec(p: Record<string, unknown>): FnCallSpec {
  const args = p.args === undefined || p.args === null ? [] : Array.isArray(p.args) ? p.args : [p.args]
  const then = Array.isArray(p.then)
    ? p.then.map((s) => {
        const o = (s ?? {}) as Record<string, unknown>
        return { call: String(o.call ?? ''), args: Array.isArray(o.args) ? o.args : [] }
      })
    : []
  return { module: String(p.module ?? '').trim(), fn: String(p.fn ?? '').trim(), args, construct: p.new === true, then }
}

export const FN_ARGS_HELP =
  'args is a JSON array. Special values: {"$undefined":true}, {"$number":"NaN"}, {"$bigint":"9"}, {"$date":"<iso>"}, {"$regexp":"src","flags":"g"}, {"$map":[[k,v]]}, {"$set":[...]}, {"$literal":{...}} for an object that would otherwise read as one of these, and {"$fn":{"returns":v,"byArgs":{"<json of encoded args>":v},"template":"/x/{0}/{*}","throws":"msg"}} for a callback, whose calls come back in fakes. Values come back encoded the same way, plus $function, $class, $error, $bytes and $cycle.'
