
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export interface SearchRegexOptions {
  query: string
  regex?: boolean
  wholeWord?: boolean
  caseSensitive?: boolean
}

export function buildSearchRegex(opts: SearchRegexOptions): RegExp | null {
  if (!opts.query) return null
  try {
    let pattern = opts.regex ? opts.query : escapeRegExp(opts.query)
    if (opts.wholeWord) pattern = `\\b(?:${pattern})\\b`
    return new RegExp(pattern, opts.caseSensitive ? 'g' : 'gi')
  } catch {
    return null
  }
}
