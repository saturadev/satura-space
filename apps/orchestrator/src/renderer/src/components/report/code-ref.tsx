import { Children, Fragment, cloneElement, isValidElement, useEffect, useState, type ReactElement, type ReactNode } from 'react'
import { findCodeRefs, type CodeRefResolution } from '@shared/report-code'
import type { ReportApi, ReportBridge } from './report-context'
import { useReport } from './report-context'

const resolved = new Map<string, CodeRefResolution>()
const waiting = new Map<string, Set<(r: CodeRefResolution) => void>>()
const queued = new Map<string, { scope: string; file: string; root: string; refs: Set<string>; bridge: ReportBridge }>()
let flushTimer = 0

const bridgeIds = new WeakMap<ReportBridge, number>()

let nextBridge = 0

function scopeOf(api: ReportApi): string {
  const b = api.host.bridge
  if (!b) return api.host.file
  let id = bridgeIds.get(b)
  if (id === undefined) bridgeIds.set(b, (id = ++nextBridge))
  return `${id}:${api.host.file}`
}

function cacheKey(file: string, ref: string): string {
  return `${file}\n${ref}`
}

function flush(): void {
  flushTimer = 0
  const jobs = [...queued.values()]
  queued.clear()
  for (const job of jobs) {
    const refs = [...job.refs]
    void job.bridge.codeRefs(job.file, job.root || undefined, refs).then(
      (map) => {
        for (const ref of refs) {
          const r = map[ref] ?? { ref, status: 'missing' as const }
          const key = cacheKey(job.scope, ref)
          resolved.set(key, r)
          for (const cb of waiting.get(key) ?? []) cb(r)
          waiting.delete(key)
        }
      },
      () => {
        for (const ref of refs) waiting.delete(cacheKey(job.scope, ref))
      }
    )
  }
}

export function forgetCodeRefs(file: string): void {
  for (const key of [...resolved.keys()]) if (key.startsWith(`${file}\n`)) resolved.delete(key)
}

export function forgetBridgeCodeRefs(bridge: ReportBridge): void {
  const id = bridgeIds.get(bridge)
  if (id === undefined) return
  for (const key of [...resolved.keys()]) if (key.startsWith(`${id}:`)) resolved.delete(key)
}

function request(api: ReportApi, ref: string, cb: (r: CodeRefResolution) => void): () => void {
  const scope = scopeOf(api)
  const key = cacheKey(scope, ref)
  let set = waiting.get(key)
  if (!set) waiting.set(key, (set = new Set()))
  set.add(cb)
  const job = queued.get(scope) ?? { scope, file: api.host.file, root: api.host.root, refs: new Set<string>(), bridge: api.bridge }
  job.refs.add(ref)
  queued.set(scope, job)
  if (!flushTimer) flushTimer = window.setTimeout(flush, 0)
  return () => {
    set.delete(cb)
  }
}

export function useCodeRef(api: ReportApi, ref: string): CodeRefResolution | null {
  const key = cacheKey(scopeOf(api), ref)
  const [res, setRes] = useState<CodeRefResolution | null>(() => resolved.get(key) ?? null)
  useEffect(() => {
    const hit = resolved.get(key)
    if (hit) {
      setRes(hit)
      return
    }
    setRes(null)
    const done = api.host.store.begin()
    const off = request(api, ref, (r) => {
      setRes(r)
      done()
    })
    return () => {
      off()
      done()
    }
  }, [api, key, ref])
  return res
}

export function CodeRef({
  path,
  line,
  endLine,
  children
}: {
  path: string
  line?: number
  endLine?: number
  children?: ReactNode
}): ReactElement {
  const api = useReport()
  const ref = String(path ?? '').trim()
  const res = useCodeRef(api, ref)
  const label = children ?? `${ref}${line ? `:${line}${endLine && endLine > line ? `-${endLine}` : ''}` : ''}`
  if (res?.status === 'missing') {
    return (
      <span className="rk-cref missing" title={`${ref} isn't in this project`} data-code-ref={ref} data-code-ref-status="missing">
        {label}
      </span>
    )
  }
  return (
    <button
      type="button"
      className="rk-cref"
      data-code-ref={ref}
      data-code-ref-status={res?.status ?? 'pending'}
      title={res?.status === 'ambiguous' ? `${res.candidates?.length ?? 0} files match` : res?.rel ?? ref}
      onClick={(e) => {
        e.stopPropagation()
        e.preventDefault()
        api.host.showCode({ ref, line, endLine })
      }}
    >
      {label}
    </button>
  )
}

export function linkifyText(text: string, keyBase = 'c'): ReactNode {
  const found = findCodeRefs(text)
  if (!found.length) return text
  const out: ReactNode[] = []
  let last = 0
  found.forEach((m, i) => {
    if (m.start > last) out.push(text.slice(last, m.start))
    out.push(
      <CodeRef key={`${keyBase}${i}`} path={m.path} line={m.line} endLine={m.endLine}>
        {text.slice(m.start, m.end)}
      </CodeRef>
    )
    last = m.end
  })
  if (last < text.length) out.push(text.slice(last))
  return out
}

export function linkify(node: ReactNode, depth = 0): ReactNode {
  if (typeof node === 'string') return linkifyText(node)
  if (depth > 3 || node == null || typeof node === 'boolean' || typeof node === 'number') return node
  if (Array.isArray(node)) return Children.map(node, (c) => linkify(c, depth + 1))
  if (isValidElement(node) && (node.type === Fragment || typeof node.type === 'string')) {
    const props = node.props as { children?: ReactNode }
    if (props.children == null || node.type === 'code' || node.type === 'pre') return node
    return cloneElement(node as ReactElement<{ children?: ReactNode }>, undefined, linkify(props.children, depth + 1))
  }
  return node
}

interface MdNode {
  type: string
  value?: string
  url?: string
  children?: MdNode[]
}

const SKIP = new Set(['link', 'linkReference', 'code', 'definition', 'html'])

function linkNodes(node: MdNode): void {
  if (!node.children) return
  const next: MdNode[] = []
  for (const child of node.children) {
    if ((child.type === 'text' || child.type === 'inlineCode') && child.value) {
      const found = findCodeRefs(child.value)
      if (child.type === 'inlineCode') {
        const only = found.length === 1 && found[0].start === 0 && found[0].end === child.value.length ? found[0] : null
        if (only) next.push({ type: 'link', url: codeHref(only.path, only.line, only.endLine), children: [child] })
        else next.push(child)
        continue
      }
      let last = 0
      for (const m of found) {
        if (m.start > last) next.push({ type: 'text', value: child.value.slice(last, m.start) })
        next.push({ type: 'link', url: codeHref(m.path, m.line, m.endLine), children: [{ type: 'text', value: child.value.slice(m.start, m.end) }] })
        last = m.end
      }
      if (last < child.value.length) next.push(last ? { type: 'text', value: child.value.slice(last) } : child)
      continue
    }
    if (!SKIP.has(child.type)) linkNodes(child)
    next.push(child)
  }
  node.children = next
}

export const CODE_HREF = '#satura-code:'

export function codeHref(path: string, line?: number, endLine?: number): string {
  return `${CODE_HREF}${encodeURIComponent(path)}${line ? `:${line}` : ''}${endLine ? `-${endLine}` : ''}`
}

export function parseCodeHref(href: string): { path: string; line?: number; endLine?: number } | null {
  if (!href.startsWith(CODE_HREF)) return null
  const m = /^(.*?)(?::(\d+)(?:-(\d+))?)?$/.exec(href.slice(CODE_HREF.length))
  if (!m) return null
  return { path: decodeURIComponent(m[1]), line: m[2] ? Number(m[2]) : undefined, endLine: m[3] ? Number(m[3]) : undefined }
}

export function remarkCodeRefs() {
  return (tree: MdNode): void => linkNodes(tree)
}
