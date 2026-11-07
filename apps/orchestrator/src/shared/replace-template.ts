
type CaseMode = 'none' | 'upper' | 'lower'

export function buildReplacement(
  template: string,
  match: RegExpMatchArray,
  preserveCase?: boolean
): string {
  let out = ''
  let mode: CaseMode = 'none'
  let oneShot: 'upper' | 'lower' | null = null

  const emit = (text: string): void => {
    for (const ch of text) {
      let c = ch
      if (oneShot) {
        c = oneShot === 'upper' ? ch.toUpperCase() : ch.toLowerCase()
        oneShot = null
      } else if (mode === 'upper') {
        c = ch.toUpperCase()
      } else if (mode === 'lower') {
        c = ch.toLowerCase()
      }
      out += c
    }
  }

  for (let i = 0; i < template.length; i++) {
    const ch = template[i]

    if (ch === '\\') {
      const next = template[i + 1]
      if (next === 'U') { mode = 'upper'; i++; continue }
      if (next === 'L') { mode = 'lower'; i++; continue }
      if (next === 'E') { mode = 'none'; oneShot = null; i++; continue }
      if (next === 'u') { oneShot = 'upper'; i++; continue }
      if (next === 'l') { oneShot = 'lower'; i++; continue }
      if (next === 'n') { emit('\n'); i++; continue }
      if (next === 't') { emit('\t'); i++; continue }
      if (next === 'r') { emit('\r'); i++; continue }
      if (next === '\\') { emit('\\'); i++; continue }
      if (next !== undefined) { emit(next); i++; continue }
      emit('\\')
      continue
    }

    if (ch === '$') {
      const next = template[i + 1]
      if (next === '$') { emit('$'); i++; continue }
      if (next === '&' || next === '0') { emit(match[0] ?? ''); i++; continue }
      if (next === '{') {
        const close = template.indexOf('}', i + 2)
        if (close > 0) {
          const num = Number(template.slice(i + 2, close))
          if (Number.isInteger(num)) {
            emit(match[num] ?? '')
            i = close
            continue
          }
        }
      }
      const digits = /^\d{1,2}/.exec(template.slice(i + 1))
      if (digits) {
        emit(match[Number(digits[0])] ?? '')
        i += digits[0].length
        continue
      }
      emit('$')
      continue
    }

    emit(ch)
  }

  return preserveCase ? applyPreserveCase(match[0] ?? '', out) : out
}

function applyPreserveCase(original: string, replacement: string): string {
  if (!original || !replacement) return replacement
  const hasUpper = original.toLowerCase() !== original
  const hasLower = original.toUpperCase() !== original
  if (hasUpper && !hasLower) return replacement.toUpperCase()
  if (hasLower && !hasUpper) return replacement.toLowerCase()
  if (
    original[0] === original[0].toUpperCase() &&
    original.slice(1) === original.slice(1).toLowerCase()
  ) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1)
  }
  return replacement
}
