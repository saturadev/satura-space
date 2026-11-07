import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs'
import { join, extname, relative, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const __dir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(__dir, '..', '..', '..')

const WRITE = process.argv.includes('--write')
const positional = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const roots = (positional.length ? positional : ['apps', 'packages']).map((p) =>
  isAbsolute(p) ? p : resolve(repoRoot, p),
)

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.venv', 'venv', '__pycache__', '.next', 'out',
  'dist', 'build', 'reference', 'Library', 'Temp', 'obj', 'bin', '.turbo',
  'coverage', '.playwright-mcp', '.cache',
])

const LANG_BY_EXT = {
  '.ts': 'ts', '.tsx': 'ts', '.mts': 'ts', '.cts': 'ts',
  '.js': 'ts', '.jsx': 'ts', '.mjs': 'ts', '.cjs': 'ts',
  '.cs': 'cs',
  '.py': 'py', '.pyi': 'py',
}

const CODING_RE = /coding[:=]\s*[-\w.]+/
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'do', 'else', 'yield', 'await', 'case', 'throw', 'with', 'default',
])

function isWordChar(c) {
  return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c === '_' || c === '$'
}

function stripComments(src, lang) {
  const isTs = lang === 'ts'
  const isCs = lang === 'cs'
  const isPy = lang === 'py'
  const n = src.length
  let i = 0
  let out = ''

  function peekLine(from) {
    let j = from
    while (j < n && src[j] !== '\n') j++
    return src.slice(from, j)
  }
  function copyLine() {
    while (i < n && src[i] !== '\n') { out += src[i]; i++ }
    if (i < n) { out += '\n'; i++ }
  }

  function skipQuoted(quote) {
    out += quote; i++
    while (i < n) {
      const c = src[i]
      if (c === '\\') { out += c + (src[i + 1] ?? ''); i += 2; continue }
      if (c === '\n') { out += c; i++; return }
      out += c; i++
      if (c === quote) return
    }
  }

  function skipTemplate() {
    out += '`'; i++
    while (i < n) {
      const c = src[i]
      if (c === '\\') { out += c + (src[i + 1] ?? ''); i += 2; continue }
      if (c === '`') { out += c; i++; return }
      if (c === '$' && src[i + 1] === '{') {
        out += '${'; i += 2
        scanCode(true)
        if (i < n && src[i] === '}') { out += '}'; i++ }
        continue
      }
      out += c; i++
    }
  }

  function skipRegex() {
    out += '/'; i++
    let inClass = false
    while (i < n) {
      const c = src[i]
      if (c === '\\') { out += c + (src[i + 1] ?? ''); i += 2; continue }
      if (c === '\n') return
      if (c === '[') { inClass = true; out += c; i++; continue }
      if (c === ']') { inClass = false; out += c; i++; continue }
      out += c; i++
      if (c === '/' && !inClass) break
    }
    while (i < n && /[a-z]/i.test(src[i])) { out += src[i]; i++ }
  }

  function regexAllowed() {
    let j = out.length - 1
    while (j >= 0 && /\s/.test(out[j])) j--
    if (j < 0) return true
    const ch = out[j]
    if (isWordChar(ch)) {
      let k = j
      while (k >= 0 && isWordChar(out[k])) k--
      return REGEX_KEYWORDS.has(out.slice(k + 1, j + 1))
    }
    if (ch === ')' || ch === ']' || ch === '.' || ch === '`' || ch === '"' || ch === "'") return false
    if ((ch === '+' || ch === '-') && out[j - 1] === ch) return false
    return true
  }

  function skipCsVerbatim(interp) {
    out += '"'; i++
    while (i < n) {
      const c = src[i]
      if (c === '"') {
        if (src[i + 1] === '"') { out += '""'; i += 2; continue }
        out += '"'; i++; return
      }
      if (interp && c === '{') {
        if (src[i + 1] === '{') { out += '{{'; i += 2; continue }
        out += '{'; i++; scanCode(true); if (i < n && src[i] === '}') { out += '}'; i++ }; continue
      }
      if (interp && c === '}' && src[i + 1] === '}') { out += '}}'; i += 2; continue }
      out += c; i++
    }
  }

  function skipCsInterpolated() {
    out += '"'; i++
    while (i < n) {
      const c = src[i]
      if (c === '\\') { out += c + (src[i + 1] ?? ''); i += 2; continue }
      if (c === '"') { out += '"'; i++; return }
      if (c === '\n') { out += c; i++; return }
      if (c === '{') {
        if (src[i + 1] === '{') { out += '{{'; i += 2; continue }
        out += '{'; i++; scanCode(true); if (i < n && src[i] === '}') { out += '}'; i++ }; continue
      }
      if (c === '}' && src[i + 1] === '}') { out += '}}'; i += 2; continue }
      out += c; i++
    }
  }

  function skipPyString(quote) {
    if (src[i + 1] === quote && src[i + 2] === quote) {
      out += quote + quote + quote; i += 3
      while (i < n) {
        const c = src[i]
        if (c === '\\') { out += c + (src[i + 1] ?? ''); i += 2; continue }
        if (c === quote && src[i + 1] === quote && src[i + 2] === quote) {
          out += quote + quote + quote; i += 3; return
        }
        out += c; i++
      }
      return
    }
    out += quote; i++
    while (i < n) {
      const c = src[i]
      if (c === '\\') { out += c + (src[i + 1] ?? ''); i += 2; continue }
      if (c === '\n') { out += c; i++; return }
      out += c; i++
      if (c === quote) return
    }
  }

  function lineComment() {
    while (i < n && src[i] !== '\n') i++
    const lastNl = out.lastIndexOf('\n')
    const lineContent = out.slice(lastNl + 1)
    if (lineContent.trim() === '') {
      out = out.slice(0, lastNl + 1)
      if (i < n && src[i] === '\n') i++
    } else {
      out = out.slice(0, lastNl + 1) + lineContent.trimEnd()
    }
  }

  function blockComment() {
    const start = i
    i += 2
    while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++
    i += 2
    const newlines = (src.slice(start, i).match(/\n/g) ?? []).length
    const lastNl = out.lastIndexOf('\n')
    const lineContent = out.slice(lastNl + 1)
    if (lineContent.trim() === '') {
      out = out.slice(0, lastNl + 1)
      while (i < n && (src[i] === ' ' || src[i] === '\t')) i++
      if (i < n && src[i] === '\n') i++
      if (newlines > 1) out += '\n'.repeat(newlines - 1)
    } else {
      out = out.slice(0, lastNl + 1) + lineContent.trimEnd()
      if (newlines > 0) out += '\n'.repeat(newlines)
    }
  }

  function scanCode(inHole) {
    let braceDepth = 0
    while (i < n) {
      const c = src[i]

      if (inHole) {
        if (c === '{') { braceDepth++; out += c; i++; continue }
        if (c === '}') {
          if (braceDepth === 0) return
          braceDepth--; out += c; i++; continue
        }
      }

      if (c === '"' || c === "'") {
        if (isCs && c === '"') { skipQuoted('"'); continue }
        if (isPy) { skipPyString(c); continue }
        skipQuoted(c); continue
      }

      if (isTs && c === '`') { skipTemplate(); continue }

      if (isCs && c === '@') {
        if (src[i + 1] === '"') { out += '@'; i++; skipCsVerbatim(false); continue }
        if (src[i + 1] === '$' && src[i + 2] === '"') { out += '@$'; i += 2; skipCsVerbatim(true); continue }
      }
      if (isCs && c === '$') {
        if (src[i + 1] === '"') { out += '$'; i++; skipCsInterpolated(); continue }
        if (src[i + 1] === '@' && src[i + 2] === '"') { out += '$@'; i += 2; skipCsVerbatim(true); continue }
      }

      if ((isTs || isCs) && c === '/' && src[i + 1] === '/') {
        if (isTs && src[i + 2] === '/') {
          const lineStart = out.slice(out.lastIndexOf('\n') + 1)
          if (lineStart.trim() === '' && /^\/\/\/\s*<(reference|amd-)/.test(peekLine(i))) {
            while (i < n && src[i] !== '\n') { out += src[i]; i++ }
            continue
          }
        }
        lineComment(); continue
      }
      if ((isTs || isCs) && c === '/' && src[i + 1] === '*') { blockComment(); continue }
      if (isPy && c === '#') { lineComment(); continue }

      if (isTs && c === '/' && regexAllowed()) { skipRegex(); continue }

      out += c; i++
    }
  }

  for (let line = 0; line < 2 && i < n; line++) {
    const text = peekLine(i)
    const trimmed = text.trimStart()
    const keep =
      (line === 0 && trimmed.startsWith('#!')) ||
      (isPy && trimmed.startsWith('#') && CODING_RE.test(text))
    if (!keep) break
    copyLine()
  }

  scanCode(false)
  return out.replace(/\n{3,}/g, '\n\n')
}

function walk(dir, acc) {
  let entries
  try { entries = readdirSync(dir) } catch { return acc }
  for (const name of entries) {
    if (EXCLUDE_DIRS.has(name)) continue
    const full = join(dir, name)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) walk(full, acc)
    else if (LANG_BY_EXT[extname(name)]) acc.push(full)
  }
  return acc
}

const files = []
for (const root of roots) {
  let st
  try { st = statSync(root) } catch { continue }
  if (st.isDirectory()) walk(root, files)
  else if (LANG_BY_EXT[extname(root)]) files.push(root)
}

const counts = {}
let changed = 0
for (const f of files) {
  const lang = LANG_BY_EXT[extname(f)]
  const src = readFileSync(f, 'utf8')
  const stripped = stripComments(src, lang)
  if (stripped !== src) {
    changed++
    counts[lang] = (counts[lang] ?? 0) + 1
    if (WRITE) writeFileSync(f, stripped)
    else console.log(`  ${relative(repoRoot, f)}`)
  }
}

const breakdown = Object.entries(counts).map(([l, c]) => `${l}:${c}`).join('  ') || 'none'
if (WRITE) {
  console.log(`Stripped comments from ${changed}/${files.length} files.  (${breakdown})`)
} else {
  console.log(`\nDry run: ${changed}/${files.length} files would change.  (${breakdown})  Run with --write to apply.`)
}
