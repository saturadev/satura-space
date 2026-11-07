import { readFile, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import ts from 'typescript'
import type * as TS from 'typescript'

const LEGACY_INDEX = '.sessions.json'
const SESSION_ID = /^[\w.:-]{1,128}$/
const queues = new Map<string, Promise<unknown>>()
const migrating = new Map<string, Promise<void>>()

function reportTag(source: string): TS.JsxOpeningElement | TS.JsxSelfClosingElement | null {
  const sf = ts.createSourceFile('report.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
  let found: TS.JsxOpeningElement | TS.JsxSelfClosingElement | null = null
  const visit = (node: TS.Node): void => {
    if (found) return
    if ((ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) && node.tagName.getText(sf) === 'Report') {
      found = node
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return found
}

function attrValue(tag: TS.JsxOpeningElement | TS.JsxSelfClosingElement, name: string): string | null | undefined {
  for (const a of tag.attributes.properties) {
    if (!ts.isJsxAttribute(a) || a.name.getText() !== name) continue
    const init = a.initializer
    if (!init) return null
    if (ts.isStringLiteral(init)) return init.text
    if (ts.isJsxExpression(init) && init.expression && ts.isStringLiteralLike(init.expression)) return init.expression.text
    return null
  }
  return undefined
}

export function withReportSession(source: string, session: string): { source: string; session: string } | null {
  const tag = reportTag(source)
  if (!tag) return null
  const had = attrValue(tag, 'session')
  if (had !== undefined) return had ? { source, session: had } : null
  const props = tag.attributes.properties
  const first = props[0]
  const last = props[props.length - 1]
  const at = last ? last.end : tag.tagName.end
  let insert = ` session="${session}"`
  if (first) {
    const start = first.getStart()
    const lineStart = source.lastIndexOf('\n', start - 1) + 1
    if (source.slice(tag.tagName.end, start).includes('\n')) insert = `\n${source.slice(lineStart, start)}session="${session}"`
  }
  return { source: source.slice(0, at) + insert + source.slice(at), session }
}

function queued<T>(key: string, job: () => Promise<T>): Promise<T> {
  const run = (queues.get(key) ?? Promise.resolve()).then(job)
  const tail = run.catch(() => null)
  queues.set(key, tail)
  void tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

export function stampReportSession(file: string, session: string): Promise<{ session: string; wrote: boolean } | null> {
  if (!SESSION_ID.test(session)) return Promise.resolve(null)
  return queued(file.replace(/\\/g, '/'), async () => {
    const source = await readFile(file, 'utf8')
    const next = withReportSession(source, session)
    if (!next) return null
    if (next.source === source) return { session: next.session, wrote: false }
    await writeFile(file, next.source)
    return { session: next.session, wrote: true }
  })
}

export function migrateSessionIndex(base: string): Promise<void> {
  const busy = migrating.get(base)
  if (busy) return busy
  const run = (async () => {
    const index = join(base, LEGACY_INDEX)
    if (!(await stat(index).catch(() => null))) return
    let raw: unknown = null
    try {
      raw = JSON.parse(await readFile(index, 'utf8'))
    } catch {
      raw = null
    }
    let moved = 0
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      for (const [key, v] of Object.entries(raw as Record<string, { session?: unknown }>)) {
        const session = typeof v?.session === 'string' ? v.session : ''
        if (!session || key.includes('..')) continue
        const res = await stampReportSession(join(base, key), session).catch(() => null)
        if (res?.wrote) moved++
      }
    }
    await unlink(index).catch(() => undefined)
    console.log(`[report] moved ${moved} session link${moved === 1 ? '' : 's'} from ${LEGACY_INDEX} into the reports and deleted it`)
  })().finally(() => migrating.delete(base))
  migrating.set(base, run)
  return run
}
