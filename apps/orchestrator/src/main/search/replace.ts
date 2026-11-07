import { readFile, writeFile } from 'node:fs/promises'
import type { ReplaceRequest, ReplaceResult } from '@shared/api'
import { buildSearchRegex } from '@shared/search-regex'
import { buildReplacement } from '@shared/replace-template'

export async function runReplace(req: ReplaceRequest): Promise<ReplaceResult> {
  const re = buildSearchRegex(req)
  if (!re) return { filesChanged: 0, replacements: 0 }

  let filesChanged = 0
  let replacements = 0

  for (const target of req.targets) {
    const wanted = target.matches ? new Set(target.matches.map((m) => `${m.line}:${m.column}`)) : null

    let content: string
    try {
      content = await readFile(target.filePath, 'utf8')
    } catch {
      continue
    }

    const lines = content.split('\n')
    let fileChanged = false

    for (let i = 0; i < lines.length; i++) {
      const lineNo = i + 1
      const line = lines[i]
      re.lastIndex = 0
      let rebuilt = ''
      let last = 0
      let lineChanged = false
      let m: RegExpExecArray | null

      while ((m = re.exec(line)) !== null) {
        const startCol = m.index + 1
        if (!wanted || wanted.has(`${lineNo}:${startCol}`)) {
          rebuilt += line.slice(last, m.index) + buildReplacement(req.replace, m, req.preserveCase)
          last = m.index + m[0].length
          replacements++
          lineChanged = true
        }
        if (m[0].length === 0) re.lastIndex++
      }

      if (lineChanged) {
        lines[i] = rebuilt + line.slice(last)
        fileChanged = true
      }
    }

    if (fileChanged) {
      await writeFile(target.filePath, lines.join('\n'), 'utf8')
      filesChanged++
    }
  }

  return { filesChanged, replacements }
}
