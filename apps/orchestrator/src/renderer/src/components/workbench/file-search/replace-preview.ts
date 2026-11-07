import type { SearchMatch } from '@shared/api'
import { buildReplacement } from '@shared/replace-template'

export interface ReplaceContext {
  regex: RegExp | null
  template: string
  preserveCase: boolean
}

export function replacementForMatch(match: SearchMatch, ctx: ReplaceContext): string | null {
  const re = ctx.regex
  if (!re) return null
  re.lastIndex = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(match.lineText)) !== null) {
    if (m.index === match.matchStart) return buildReplacement(ctx.template, m, ctx.preserveCase)
    if (m[0].length === 0) re.lastIndex++
  }
  return null
}
