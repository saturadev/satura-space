import type { IBufferCell, IBufferLine, Terminal } from '@xterm/headless'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

type TerminalWithOscLinks = Terminal & {
  _core?: {
    _oscLinkService?: {
      getLinkData: (linkId: number) => { uri?: string } | undefined
    }
  }
}

type CellWithOscLink = {
  extended?: { urlId?: number }
  hasExtendedAttrs?: () => boolean
}

export function collectHeadlessOscLinkRanges(
  terminal: Terminal,
  scrollbackRows: number | undefined,
  restoredLinks: TerminalOscLinkRange[] = [],
  scanBuffer = true
): TerminalOscLinkRange[] {
  const service = (terminal as TerminalWithOscLinks)._core?._oscLinkService
  if (!service) {
    return []
  }
  const buffer = terminal.buffer.active
  const startRow =
    scrollbackRows === undefined ? 0 : Math.max(0, buffer.length - terminal.rows - scrollbackRows)
  const ranges: TerminalOscLinkRange[] = []
  const cell = buffer.getNullCell()
  for (let row = scanBuffer ? startRow : buffer.length; row < buffer.length; row += 1) {
    const line = buffer.getLine(row)
    if (!line) {
      continue
    }
    const lineLength = Math.min(terminal.cols, line.length)
    let currentUrlId = 0
    let currentStart = -1
    for (let col = 0; col <= lineLength; col += 1) {
      const urlId = col < lineLength ? getOscLinkIdAtCell(line, col, cell) : 0
      if (urlId === currentUrlId) {
        continue
      }
      if (currentUrlId && currentStart >= 0) {
        const uri = service.getLinkData(currentUrlId)?.uri
        if (uri) {
          ranges.push({ row: row - startRow, startCol: currentStart, endCol: col, uri })
        }
      }
      currentUrlId = urlId
      currentStart = urlId ? col : -1
    }
  }
  for (const link of restoredLinks) {
    if (link.row < startRow || link.row >= buffer.length) {
      continue
    }
    const startCol = Math.max(0, Math.min(terminal.cols, link.startCol))
    const endCol = Math.max(0, Math.min(terminal.cols, link.endCol))
    if (startCol >= endCol) {
      continue
    }
    ranges.push({
      row: link.row - startRow,
      startCol,
      endCol,
      uri: link.uri
    })
  }
  return dedupeOscLinkRanges(ranges)
}

function dedupeOscLinkRanges(ranges: TerminalOscLinkRange[]): TerminalOscLinkRange[] {
  const seen = new Set<string>()
  return ranges.filter((range) => {
    const key = `${range.row}:${range.startCol}:${range.endCol}:${range.uri}`
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })
}

function getOscLinkIdAtCell(line: IBufferLine, col: number, reuse: IBufferCell): number {
  const cell = line.getCell(col, reuse) as CellWithOscLink | undefined
  return cell?.hasExtendedAttrs?.() && cell.extended?.urlId ? cell.extended.urlId : 0
}
