import * as React from 'react'
import * as JsxRuntime from 'react/jsx-runtime'
import { Component, type ComponentType, type ErrorInfo, type ReactNode } from 'react'
import type { ReportCompileResult } from '@shared/report-compile'
import { kit, RawCell, RawTable } from './kit'

const SHADOWED = [
  'window',
  'globalThis',
  'self',
  'top',
  'parent',
  'frames',
  'opener',
  'document',
  'location',
  'navigator',
  'process',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'localStorage',
  'sessionStorage',
  'indexedDB',
  'postMessage',
  'importScripts',
  'api',
  'Function',
  'Reflect'
]

const BLOCKED_TAGS = new Set(['style', 'link', 'script', 'iframe', 'meta', 'base', 'object', 'embed', 'frame', 'frameset'])

function guard(type: unknown, props: unknown): unknown {
  if (typeof type === 'string' && BLOCKED_TAGS.has(type.toLowerCase())) throw new Error(`<${type}> isn't allowed in a report.`)
  if (props && typeof props === 'object' && 'dangerouslySetInnerHTML' in props) {
    const { dangerouslySetInnerHTML: _drop, ...rest } = props as Record<string, unknown>
    return rest
  }
  return props
}

type JsxFn = (type: unknown, props: unknown, key?: unknown) => unknown

const RAW_TAGS: Record<string, unknown> = { table: RawTable, td: RawCell('td'), th: RawCell('th') }

function swap(type: unknown): unknown {
  return typeof type === 'string' ? RAW_TAGS[type] ?? type : type
}

const jsxShim = Object.freeze({
  Fragment: JsxRuntime.Fragment,
  jsx: (type: unknown, props: unknown, key?: unknown) => (JsxRuntime.jsx as unknown as JsxFn)(swap(type), guard(type, props), key),
  jsxs: (type: unknown, props: unknown, key?: unknown) => (JsxRuntime.jsxs as unknown as JsxFn)(swap(type), guard(type, props), key)
})

const reactShim = Object.freeze({
  ...React,
  createElement: (type: unknown, props: unknown, ...children: unknown[]) =>
    (React.createElement as unknown as (...a: unknown[]) => unknown)(swap(type), guard(type, props), ...children)
})

const kitModule = Object.freeze({ ...kit })

function requireWith(modules?: Record<string, unknown>): (name: string) => unknown {
  return (name: string): unknown => {
    if (name === 'react') return reactShim
    if (name === 'react/jsx-runtime' || name === 'react/jsx-dev-runtime') return jsxShim
    if (name === '@satura/report') return kitModule
    if (modules && Object.prototype.hasOwnProperty.call(modules, name)) return modules[name]
    const allowed = ["'react'", "'@satura/report'", ...Object.keys(modules ?? {}).map((m) => `'${m}'`)]
    throw new Error(`This file can import only from ${allowed.join(', ')}, not '${name}'.`)
  }
}

export function build(body: string, url: string): (...args: unknown[]) => unknown {
  return new Function(
    'require',
    'module',
    'exports',
    ...SHADOWED,
    `return (function () {\n${body}\n}).call(undefined)\n//# sourceURL=${url}`
  ) as (...args: unknown[]) => unknown
}

export interface Loaded {
  Component?: ComponentType
  error?: string
  exports?: Record<string, unknown>
}

export interface Mapper {
  shown: string
  map: (text: string) => string
}

export function evaluate(
  res: ReportCompileResult,
  mapper: Mapper,
  url: string,
  opts?: { modules?: Record<string, unknown>; returns?: string }
): Loaded {
  const module = { exports: {} as Record<string, unknown> }
  try {
    build(res.code ?? '', url)(requireWith(opts?.modules), module, module.exports, ...SHADOWED.map(() => undefined))
  } catch (e) {
    return { error: describe(e, mapper) }
  }
  const C = module.exports.default
  const isComponent = typeof C === 'function' || (!!C && typeof C === 'object' && '$$typeof' in (C as object))
  if (!isComponent) return { error: `The default export is not a component. Export a function that returns ${opts?.returns ?? '<Report>'}.` }
  return { Component: C as ComponentType, exports: module.exports }
}

export function describe(e: unknown, mapper: Mapper, componentStack?: string): string {
  const err = e instanceof Error ? e : new Error(typeof e === 'string' ? e : JSON.stringify(e))
  const shown = mapper.shown
  const head = `${err.name}: ${err.message}`
  const stack = err.stack && err.stack.includes(err.message) ? err.stack : err.stack ? `${head}\n${err.stack}` : head
  const lines = mapper
    .map(stack)
    .split('\n')
    .filter((l, i) => i === 0 || !(/^\s+at /.test(l) || /^[^\s@]*@\S+:\d+:\d+$/.test(l)) || l.includes(shown))
    .slice(0, 12)
  const comp: string[] = []
  for (const raw of mapper.map(componentStack ?? '').split('\n')) {
    const l = raw.trim()
    if (!l) continue
    if (/^at (ReportBoundary|Rendered|TileBoundary)\b/.test(l)) break
    comp.push(l.includes(shown) ? l : l.replace(/\s*\(.*\)$/, ''))
  }
  return [...lines, ...(comp.length ? ['', 'Component stack:', ...comp.slice(0, 10).map((l) => `  ${l}`)] : [])].join('\n')
}

export class ReportBoundary extends Component<
  { children: ReactNode; onError: (text: string) => void; mapper: Mapper; onRetry: () => void },
  { error: string | null }
> {
  state = { error: null as string | null }

  static getDerivedStateFromError(): { error: string } {
    return { error: '' }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    const text = describe(error, this.props.mapper, info.componentStack ?? undefined)
    this.setState({ error: text })
    this.props.onError(text)
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children
    return <RuntimeError text={this.state.error} onRetry={this.props.onRetry} />
  }
}

export function RuntimeError({ text, onRetry }: { text: string; onRetry?: () => void }) {
  return (
    <div className="rk-error">
      <div className="rk-error-box">
        <h2 className="rk-error-title">This report crashed while rendering</h2>
        <p className="rk-error-hint">Fix report.tsx and save it. The panel reloads by itself.</p>
        <pre className="rk-error-pre" data-report-error>
          {text}
        </pre>
        {onRetry && (
          <div>
            <button
              type="button"
              onClick={onRetry}
              className="rounded border border-white/15 px-2 py-0.5 text-xs text-zinc-300 hover:bg-white/10 hover:text-white"
            >
              Try again
            </button>
          </div>
        )}
      </div>
    </div>
  )
}
