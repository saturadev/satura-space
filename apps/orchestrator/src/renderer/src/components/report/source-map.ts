const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_INDEX = new Map([...B64].map((c, i) => [c, i]))

type Segment = [number, number, number]

function decodeVlq(text: string): number[] {
  const out: number[] = []
  let value = 0
  let shift = 0
  for (const ch of text) {
    const digit = B64_INDEX.get(ch)
    if (digit === undefined) continue
    value += (digit & 31) << shift
    if (digit & 32) shift += 5
    else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1)
      value = 0
      shift = 0
    }
  }
  return out
}

export class LineMap {
  private lines: Segment[][] = []

  constructor(mapJson: string | undefined) {
    if (!mapJson) return
    let mappings = ''
    try {
      mappings = String((JSON.parse(mapJson) as { mappings?: string }).mappings ?? '')
    } catch {
      return
    }
    let srcLine = 0
    let srcCol = 0
    for (const line of mappings.split(';')) {
      let genCol = 0
      const segs: Segment[] = []
      for (const part of line.split(',')) {
        if (!part) continue
        const v = decodeVlq(part)
        genCol += v[0]
        if (v.length >= 4) {
          srcLine += v[2]
          srcCol += v[3]
          segs.push([genCol, srcLine, srcCol])
        }
      }
      this.lines.push(segs)
    }
  }

  original(line: number, column: number): { line: number; column: number } | null {
    const segs = this.lines[line - 1]
    if (!segs || !segs.length) return null
    let best = segs[0]
    for (const s of segs) {
      if (s[0] <= column - 1) best = s
      else break
    }
    return { line: best[1] + 1, column: best[2] + 1 }
  }
}

let functionLineOffset: number | null = null

export function evalLineOffset(build: (body: string, url: string) => () => unknown): number {
  if (functionLineOffset !== null) return functionLineOffset
  try {
    build('throw new Error("probe")', 'satura-report-probe.js')()
  } catch (e) {
    const m = /satura-report-probe\.js:(\d+):\d+/.exec((e as Error).stack ?? '')
    functionLineOffset = m ? Number(m[1]) - 1 : 0
  }
  return functionLineOffset ?? 0
}

export function mapStack(text: string, sourceUrl: string, shown: string, map: LineMap, offset: number): string {
  if (!text) return ''
  const escaped = sourceUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const re = new RegExp(`${escaped}:(\\d+):(\\d+)`, 'g')
  return text.replace(re, (_all, l: string, c: string) => {
    const pos = map.original(Number(l) - offset, Number(c))
    return pos ? `${shown}:${pos.line}:${pos.column}` : shown
  })
}
