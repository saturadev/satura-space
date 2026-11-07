export interface SourcePos {
  line: number
  column: number
}

interface BodyRange {
  startOffset: number
  endOffset: number
  start: SourcePos
  end: SourcePos
}

interface RawBody {
  startOffset: number
  endOffset: number
}

const KEYWORD_BEFORE_PAREN = new Set([
  'if',
  'else',
  'for',
  'foreach',
  'while',
  'switch',
  'catch',
  'using',
  'lock',
  'fixed',
  'return',
  'yield',
  'await',
  'in',
  'is',
  'as',
  'new',
  'throw',
  'when',
  'where',
  'and',
  'or',
  'not'
])

const ACCESSOR_KEYWORDS = new Set(['get', 'set', 'init', 'add', 'remove'])

const STATEMENT_BLOCK_KEYWORDS = new Set([
  'if',
  'else',
  'for',
  'foreach',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'try',
  'catch',
  'finally',
  'lock',
  'fixed',
  'unsafe',
  'using',
  'checked',
  'unchecked'
])

interface Stripped {
  code: string
  identAt: (offset: number) => string | null
  prevSignificant: (offset: number) => string
  prevWordEndingAt: (offset: number) => { word: string; start: number } | null
}

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_]/.test(ch)
}

function isIdentStart(ch: string): boolean {
  return /[A-Za-z_]/.test(ch)
}

function stripNonCode(src: string): string {
  const out = new Array<string>(src.length)
  let i = 0
  const n = src.length
  while (i < n) {
    const ch = src[i]
    const next = i + 1 < n ? src[i + 1] : ''
    if (ch === '/' && next === '/') {
      while (i < n && src[i] !== '\n') {
        out[i] = src[i] === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    if (ch === '/' && next === '*') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        out[i] = src[i] === '\n' ? '\n' : ' '
        i++
      }
      if (i < n) {
        out[i] = ' '
        out[i + 1] = ' '
        i += 2
      }
      continue
    }
    if (ch === '@' && next === '"') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      while (i < n) {
        if (src[i] === '"' && src[i + 1] === '"') {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          continue
        }
        if (src[i] === '"') {
          out[i] = ' '
          i++
          break
        }
        out[i] = src[i] === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    if (ch === '$' && next === '"') {
      out[i] = ' '
      out[i + 1] = ' '
      i += 2
      let depth = 0
      while (i < n) {
        const c = src[i]
        if (c === '\\' && depth === 0) {
          out[i] = ' '
          out[i + 1] = src[i + 1] === '\n' ? '\n' : ' '
          i += 2
          continue
        }
        if (c === '{' && src[i + 1] === '{' && depth === 0) {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          continue
        }
        if (c === '}' && src[i + 1] === '}' && depth === 0) {
          out[i] = ' '
          out[i + 1] = ' '
          i += 2
          continue
        }
        if (c === '{' && depth === 0) {
          depth = 1
          out[i] = src[i]
          i++
          continue
        }
        if (depth > 0) {
          if (c === '{') depth++
          else if (c === '}') depth--
          out[i] = src[i]
          i++
          continue
        }
        if (c === '"') {
          out[i] = ' '
          i++
          break
        }
        out[i] = c === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    if (ch === '"') {
      out[i] = ' '
      i++
      while (i < n) {
        if (src[i] === '\\') {
          out[i] = ' '
          out[i + 1] = src[i + 1] === '\n' ? '\n' : ' '
          i += 2
          continue
        }
        if (src[i] === '"') {
          out[i] = ' '
          i++
          break
        }
        out[i] = src[i] === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    if (ch === "'") {
      out[i] = ' '
      i++
      while (i < n) {
        if (src[i] === '\\') {
          out[i] = ' '
          out[i + 1] = src[i + 1] === '\n' ? '\n' : ' '
          i += 2
          continue
        }
        if (src[i] === "'") {
          out[i] = ' '
          i++
          break
        }
        out[i] = src[i] === '\n' ? '\n' : ' '
        i++
      }
      continue
    }
    out[i] = ch
    i++
  }
  return out.join('')
}

function makeStripped(src: string): Stripped {
  const code = stripNonCode(src)
  return {
    code,
    identAt(offset) {
      if (offset < 0 || offset >= code.length || !isIdentStart(code[offset])) return null
      let end = offset
      while (end < code.length && isIdentChar(code[end])) end++
      return code.slice(offset, end)
    },
    prevSignificant(offset) {
      let j = offset - 1
      while (j >= 0 && /\s/.test(code[j])) j--
      return j >= 0 ? code[j] : ''
    },
    prevWordEndingAt(offset) {
      let j = offset - 1
      while (j >= 0 && /\s/.test(code[j])) j--
      if (j < 0 || !isIdentChar(code[j])) return null
      let start = j
      while (start >= 0 && isIdentChar(code[start])) start--
      start++
      if (!isIdentStart(code[start])) return null
      return { word: code.slice(start, j + 1), start }
    }
  }
}

function matchParenBackward(code: string, closeIdx: number): number {
  let depth = 0
  for (let j = closeIdx; j >= 0; j--) {
    const c = code[j]
    if (c === ')') depth++
    else if (c === '(') {
      depth--
      if (depth === 0) return j
    }
  }
  return -1
}

function precededByLambdaArrow(code: string, openIdx: number): boolean {
  let j = openIdx - 1
  while (j >= 0 && /\s/.test(code[j])) j--
  return j >= 1 && code[j] === '>' && code[j - 1] === '='
}

function classifyOpenBrace(s: Stripped, openIdx: number): boolean {
  const code = s.code
  const prev = s.prevSignificant(openIdx)

  if (prev === ')') {
    const closeParen = (() => {
      let j = openIdx - 1
      while (j >= 0 && /\s/.test(code[j])) j--
      return j
    })()
    const openParen = matchParenBackward(code, closeParen)
    if (openParen < 0) return false
    const before = s.prevWordEndingAt(openParen)
    if (before && KEYWORD_BEFORE_PAREN.has(before.word)) return false
    if (before && STATEMENT_BLOCK_KEYWORDS.has(before.word)) return false
    return true
  }

  if (prev === '>' && precededByLambdaArrow(code, openIdx)) return false

  const word = s.prevWordEndingAt(openIdx)
  if (word && ACCESSOR_KEYWORDS.has(word.word)) return true

  return false
}

function isStateMachineBody(code: string, openIdx: number, closeIdx: number): boolean {
  if (/\byield\b/.test(code.slice(openIdx + 1, closeIdx))) return true
  let j = openIdx - 1
  while (j >= 0 && code[j] !== ';' && code[j] !== '{' && code[j] !== '}') j--
  return /\basync\b/.test(code.slice(j + 1, openIdx))
}

function findRawBodies(s: Stripped): RawBody[] {
  const code = s.code
  const n = code.length
  const bodies: RawBody[] = []
  const stack: { idx: number; isBody: boolean }[] = []
  let insideBodyDepth = 0

  for (let i = 0; i < n; i++) {
    const c = code[i]
    if (c === '{') {
      const isBody = insideBodyDepth === 0 && classifyOpenBrace(s, i)
      stack.push({ idx: i, isBody })
      if (isBody) insideBodyDepth++
      else if (insideBodyDepth > 0) insideBodyDepth++
    } else if (c === '}') {
      const top = stack.pop()
      if (!top) continue
      if (insideBodyDepth > 0) insideBodyDepth--
      if (top.isBody && !isStateMachineBody(code, top.idx, i)) {
        bodies.push({ startOffset: top.idx, endOffset: i })
      }
    }
  }
  return bodies
}

function buildLineStarts(src: string): number[] {
  const starts = [0]
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '\n') starts.push(i + 1)
  }
  return starts
}

function posAt(lineStarts: number[], offset: number): SourcePos {
  let lo = 0
  let hi = lineStarts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (lineStarts[mid] <= offset) lo = mid
    else hi = mid - 1
  }
  return { line: lo + 1, column: offset - lineStarts[lo] + 1 }
}

export function findHotReloadableRanges(src: string): BodyRange[] {
  if (!src) return []
  const s = makeStripped(src)
  const raw = findRawBodies(s)
  const lineStarts = buildLineStarts(src)
  const ranges: BodyRange[] = []
  for (const b of raw) {
    const innerStart = b.startOffset + 1
    const innerEnd = b.endOffset
    if (innerEnd < innerStart) continue
    ranges.push({
      startOffset: innerStart,
      endOffset: innerEnd,
      start: posAt(lineStarts, innerStart),
      end: posAt(lineStarts, innerEnd)
    })
  }
  ranges.sort((a, b) => a.startOffset - b.startOffset)
  return ranges
}

export function rangeFullyInsideBody(
  ranges: BodyRange[],
  startOffset: number,
  endOffset: number
): boolean {
  for (const r of ranges) {
    if (startOffset >= r.startOffset && endOffset <= r.endOffset) return true
  }
  return false
}
