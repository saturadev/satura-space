export const SATURA_PACKAGE = /^com\.saturaspace\./

export type ManifestCleanup =
  | { ok: true; text: string; removed: string[]; reformatted: boolean }
  | { ok: false; error: string }

type Json = Record<string, unknown>

function isObject(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function indentOf(text: string): string {
  return /\n([ \t]+)"/.exec(text)?.[1] ?? '  '
}

function dropLines(text: string, test: (line: string) => boolean): string {
  return text
    .split(/(?<=\n)/)
    .filter((line) => !test(line))
    .join('')
}

function dropTestables(text: string): string {
  const prop = '"testables"\\s*:\\s*\\[[^\\]]*\\]'
  const withNext = new RegExp(`${prop}\\s*,\\s*`)
  if (withNext.test(text)) return text.replace(withNext, '')
  return text.replace(new RegExp(`,\\s*${prop}`), '')
}

export function stripSaturaPackages(text: string): ManifestCleanup {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  if (!isObject(json)) return { ok: false, error: 'the top level is not a JSON object' }
  const removed: string[] = []
  const want: Json = { ...json }
  const deps = json.dependencies
  if (isObject(deps)) {
    const kept: Json = {}
    for (const [name, spec] of Object.entries(deps)) {
      if (SATURA_PACKAGE.test(name)) removed.push(`dependencies "${name}": ${JSON.stringify(spec)}`)
      else kept[name] = spec
    }
    want.dependencies = kept
  }
  const testables = json.testables
  let allTestablesOurs = false
  if (Array.isArray(testables)) {
    const kept = testables.filter((t) => !(typeof t === 'string' && SATURA_PACKAGE.test(t)))
    for (const t of testables) if (!kept.includes(t)) removed.push(`testables "${t}"`)
    allTestablesOurs = kept.length === 0 && testables.length > 0
    if (allTestablesOurs) delete want.testables
    else want.testables = kept
  }
  if (!removed.length) return { ok: true, text, removed, reformatted: false }

  const quotedOurs = /^\s*"com\.saturaspace\.[^"\\]*"/
  let next = dropLines(text, (line) => quotedOurs.test(line) && /^\s*"[^"]*"\s*(:\s*"(?:[^"\\]|\\.)*"\s*)?,?\s*$/.test(line))
  if (allTestablesOurs) next = dropTestables(next)
  next = next.replace(/,(\s*[}\]])/g, '$1')
  let same = false
  try {
    same = JSON.stringify(JSON.parse(next)) === JSON.stringify(want)
  } catch {
    same = false
  }
  if (same) return { ok: true, text: next, removed, reformatted: false }
  return { ok: true, text: JSON.stringify(want, null, indentOf(text)) + (text.endsWith('\n') ? '\n' : ''), removed, reformatted: true }
}
