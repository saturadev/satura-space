import type { PreloadApi } from '@shared/api'

type Fn = (...args: never[]) => unknown
type Namespace = keyof PreloadApi
type Method<N extends Namespace> = {
  [M in keyof PreloadApi[N]]: PreloadApi[N][M] extends Fn ? M : never
}[keyof PreloadApi[N]]

export const PASS = Symbol('pass')

type Handler = (...args: unknown[]) => unknown
const handlers = new Map<string, Handler[]>()
const listeners = new Map<string, Set<Handler>>()
const missed = new Set<string>()

export function handle<N extends Namespace, M extends Method<N>>(
  ns: N,
  method: M,
  fn: (...args: Parameters<Extract<PreloadApi[N][M], Fn>>) => ReturnType<Extract<PreloadApi[N][M], Fn>> | typeof PASS
): () => void {
  const key = `${ns}.${String(method)}`
  const list = handlers.get(key) ?? []
  list.push(fn as Handler)
  handlers.set(key, list)
  return () => {
    const i = list.indexOf(fn as Handler)
    if (i >= 0) list.splice(i, 1)
  }
}

export function emit<N extends Namespace, M extends Method<N>>(
  ns: N,
  method: M,
  ...args: Parameters<Extract<Parameters<Extract<PreloadApi[N][M], Fn>>[0], Fn>>
): void {
  for (const cb of listeners.get(`${ns}.${String(method)}`) ?? []) cb(...args)
}

export function missedCalls(): string[] {
  return [...missed]
}

function subscribe(key: string, cb: Handler): () => void {
  const set = listeners.get(key) ?? new Set<Handler>()
  set.add(cb)
  listeners.set(key, set)
  return () => set.delete(cb)
}

function call(key: string, method: string, args: unknown[]): unknown {
  for (const fn of handlers.get(key) ?? []) {
    const r = fn(...args)
    if (r !== PASS) return r
  }
  if (/^on[A-Z]/.test(method) && typeof args[0] === 'function') return subscribe(key, args[0] as Handler)
  const tag = `${key}(${JSON.stringify(args).slice(0, 160)})`
  if (!missed.has(tag)) {
    missed.add(tag)
    console.debug('[landing-mock] unhandled', tag)
  }
  if (key.startsWith('gitScm.')) return Promise.resolve({ ok: false, error: { message: 'Not part of the demo' } })
  return Promise.resolve(undefined)
}

function namespace(ns: string): unknown {
  const fns = new Map<string, Handler>()
  return new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop !== 'string') return undefined
        let fn = fns.get(prop)
        if (!fn) {
          const key = `${ns}.${prop}`
          fn = (...args: unknown[]) => call(key, prop, args)
          fns.set(prop, fn)
        }
        return fn
      }
    }
  )
}

export function installMockApi(): void {
  ;(window as unknown as { __missed: () => string[] }).__missed = missedCalls
  const spaces = new Map<string, unknown>()
  window.api = new Proxy({} as PreloadApi, {
    get(_t, prop) {
      if (typeof prop !== 'string') return undefined
      let space = spaces.get(prop)
      if (!space) {
        space = namespace(prop)
        spaces.set(prop, space)
      }
      return space
    }
  })
}
