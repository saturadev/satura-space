import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { linkLookup } from '@shared/remote-term'
import {
  findFileLinksInRows,
  findUrlLinksInRows,
  resolveTerminalPath,
  type LinkRow,
  type RowLink
} from './terminal-file-paths'
import { isLinkActivation } from './terminal-links'
import { openFileInApp } from '../editor/open-file'

const ROW_WINDOW = 12

function readRow(term: Terminal, line: IBufferLine): LinkRow {
  const cell = term.buffer.active.getNullCell()
  let text = ''
  const cells: number[] = []
  for (let x = 0; x < line.length; x++) {
    line.getCell(x, cell)
    if (cell.getWidth() === 0) continue
    const chars = cell.getChars() || ' '
    for (let i = 0; i < chars.length; i++) {
      text += chars[i]
      cells.push(x)
    }
  }
  return { text, cells, wrapped: line.isWrapped }
}

async function openFileLink(
  ptyId: string,
  cwd: string | undefined,
  link: RowLink,
  event: MouseEvent
): Promise<void> {
  const target = resolveTerminalPath(link.path, cwd)
  if (!target) return
  const info = await window.api.fs.statPath(target)
  if (!info.exists || !info.isFile) return
  if (event.shiftKey) {
    await window.api.shell.showItemInFolder(info.resolved)
    return
  }
  openFileInApp({
    file: info.resolved,
    line: link.line,
    column: link.column,
    ptyId,
    preview: true,
    source: 'terminal'
  })
}

export function createFilePathLinkProvider(
  term: Terminal,
  ptyId: string,
  getCwd: () => string | undefined
): ILinkProvider {
  return {
    provideLinks(bufferLineNumber, callback) {
      const buffer = term.buffer.active
      const y = bufferLineNumber - 1
      const from = Math.max(0, y - ROW_WINDOW)
      const to = Math.min(buffer.length - 1, y + ROW_WINDOW)
      const rows: LinkRow[] = []
      for (let r = from; r <= to; r++) {
        const line = buffer.getLine(r)
        rows.push(line ? readRow(term, line) : { text: '', cells: [], wrapped: false })
      }
      const links: ILink[] = []
      for (const link of findFileLinksInRows(rows, term.cols)) {
        const startRow = link.start.row + from
        const endRow = link.end.row + from
        if (y < startRow || y > endRow) continue
        links.push({
          range: {
            start: { x: link.start.x + 1, y: startRow + 1 },
            end: { x: link.end.x + 1, y: endRow + 1 }
          },
          text: link.path,
          decorations: { pointerCursor: true, underline: true },
          activate: (event) => {
            if (!isLinkActivation(event)) return
            void openFileLink(ptyId, getCwd(), link, event).catch(() => {})
          }
        })
      }
      callback(links.length ? links : undefined)
    }
  }
}

export type TerminalLinkHit = { kind: 'url'; url: string } | { kind: 'file'; path: string; line?: number; column?: number }

function rowsAround(term: Terminal, y: number): { rows: LinkRow[]; from: number } {
  const buffer = term.buffer.active
  const from = Math.max(0, y - ROW_WINDOW)
  const to = Math.min(buffer.length - 1, y + ROW_WINDOW)
  const rows: LinkRow[] = []
  for (let r = from; r <= to; r++) {
    const line = buffer.getLine(r)
    rows.push(line ? readRow(term, line) : { text: '', cells: [], wrapped: false })
  }
  return { rows, from }
}

function covers(link: RowLink, from: number, y: number, x: number): boolean {
  const top = link.start.row + from
  const bottom = link.end.row + from
  if (y < top || y > bottom) return false
  if (y === top && x < link.start.x) return false
  return !(y === bottom && x > link.end.x)
}

function oscLinkAt(term: Terminal, y: number, x: number): TerminalLinkHit | null {
  const cell = term.buffer.active.getLine(y)?.getCell(x) as unknown as { hasExtendedAttrs?: () => number; extended?: { urlId?: number } } | undefined
  const id = cell?.hasExtendedAttrs?.() ? cell.extended?.urlId : 0
  const uri = id ? linkLookup(term)?.(id)?.uri : undefined
  if (!uri) return null
  if (/^https?:\/\//i.test(uri)) return { kind: 'url', url: uri }
  if (/^file:\/\//i.test(uri)) {
    try {
      return { kind: 'file', path: decodeURIComponent(new URL(uri).pathname) }
    } catch {
      return null
    }
  }
  return uri.startsWith('/') ? { kind: 'file', path: uri } : null
}

export function terminalLinkAt(term: Terminal, y: number, x: number): TerminalLinkHit | null {
  const { rows, from } = rowsAround(term, y)
  const urls = findUrlLinksInRows(rows, term.cols)
  const files = findFileLinksInRows(rows, term.cols)
  for (const at of [x, x - 1, x + 1]) {
    if (at < 0 || at >= term.cols) continue
    const osc = oscLinkAt(term, y, at)
    if (osc) return osc
    const url = urls.find((l) => covers(l, from, y, at))
    if (url) return { kind: 'url', url: url.path }
    const file = files.find((l) => covers(l, from, y, at))
    if (file) return { kind: 'file', path: file.path, line: file.line, column: file.column }
  }
  return null
}
