import type { Terminal } from '@xterm/xterm'

export interface MenuOption {
  key: string
  label: string
  selected: boolean
}

export interface TerminalScan {
  menu: MenuOption[]
  question: string
  spans: [number, number][]
}

interface Row {
  y: number
  text: string
  wrapped: boolean
}

interface Item {
  at: number
  n: number
  start: number
  dot: number
  labelCol: number
  label: string
}

const CURSOR_RE = /^(\s*)([❯›▶])\s+(\S.*?)\s*$/u
const ITEM_RE = /^([\s❯›▶↑↓]*?)(\d{1,2})([.)])\s+(\S.*)$/u
const NUMBER_RE = /^(\d{1,2})[.)]\s+(.+)$/
const FRAME_RE = /^[│┃|]|[│┃|]\s*$/gu
const MAX_ITEMS = 9
const MAX_NUMBERED = 20
const MAX_GAP = 2
const EMPTY: TerminalScan = { menu: [], question: '', spans: [] }

function clean(line: string): string {
  return line.replace(FRAME_RE, '').replace(/\s+$/, '')
}

function textStart(line: string): number {
  const m = CURSOR_RE.exec(line)
  if (m) return line.indexOf(m[3])
  return line.length - line.trimStart().length
}

function itemOf(rows: Row[], at: number): Item | null {
  const m = ITEM_RE.exec(rows[at].text)
  if (!m) return null
  const dot = m[1].length + m[2].length
  return { at, n: Number(m[2]), start: m[1].length, dot, labelCol: rows[at].text.length - m[4].length, label: m[4] }
}

function shortLabel(label: string): string {
  return label.replace(/\s{2,}.*$/, '').trim().slice(0, 48)
}

function questionAbove(rows: Row[], first: number): string {
  for (let i = first - 1; i >= 0 && i >= first - 4; i--) {
    const text = rows[i].text.trim()
    if (text) return text.slice(0, 160)
  }
  return ''
}

function scanNumbered(rows: Row[], cursor: number): TerminalScan | null {
  const head = itemOf(rows, cursor)
  if (!head) return null
  const sameColumn = (it: Item | null): it is Item => !!it && (it.dot === head.dot || it.start === head.start)
  const continues = (i: number): boolean => {
    const r = rows[i]
    if (r.wrapped) return true
    return r.text.length - r.text.trimStart().length >= head.labelCol
  }
  const items: Item[] = [head]
  const walk = (step: 1 | -1): void => {
    let want = head.n + step
    let gap = 0
    for (let i = cursor + step; i >= 0 && i < rows.length && want >= 1 && items.length < MAX_NUMBERED; i += step) {
      const it = itemOf(rows, i)
      if (sameColumn(it)) {
        if (it.n !== want) return
        if (step === 1) items.push(it)
        else items.unshift(it)
        want += step
        gap = 0
        continue
      }
      if (!rows[i].text.trim()) {
        if (++gap > MAX_GAP) return
        continue
      }
      if (!continues(i)) return
      gap = 0
    }
  }
  walk(-1)
  walk(1)
  if (items.length < 2) return null
  const selected = items.indexOf(head)
  const spans: [number, number][] = items.map((it, k) => {
    const limit = k + 1 < items.length ? items[k + 1].at : rows.length
    let end = it.at
    for (let i = it.at + 1; i < limit; i++) {
      if (!rows[i].text.trim()) continue
      if (k + 1 >= items.length && !continues(i)) break
      end = i
    }
    return [rows[it.at].y, rows[end].y]
  })
  const labelOf = (it: Item, k: number): string => {
    const first = it.label.split(/\s{2,}/)[0]
    const next = rows[it.at + 1]
    if (!next || (k + 1 < items.length && items[k + 1].at === it.at + 1)) return first
    if (next.text.length - next.text.trimStart().length !== it.labelCol) return first
    const more = next.text.trimStart().split(/\s{2,}/)[0]
    return more ? `${first} ${more}` : first
  }
  const menu = items.map((it, k) => ({
    key: it.n <= 9 ? String(it.n) : `pick:${k}:${selected}`,
    label: labelOf(it, k).slice(0, 48),
    selected: k === selected
  }))
  return { menu, question: questionAbove(rows, items[0].at), spans }
}

function scanPlain(rows: Row[], cursor: number, cols: number): TerminalScan {
  const lines = rows.map((r) => r.text)
  const indent = textStart(lines[cursor])
  const kind = (i: number): 'item' | 'more' | 'stop' => {
    const l = lines[i]
    if (!l || !l.trim()) return 'stop'
    if (rows[i].wrapped) return 'more'
    const start = textStart(l)
    if (l.slice(start).startsWith('⎿')) return 'stop'
    if (CURSOR_RE.test(l)) return start === indent ? 'item' : 'stop'
    if (l.slice(0, Math.min(start, indent)).trim() !== '') return 'stop'
    if (start === indent) return 'item'
    return start > indent ? 'more' : 'stop'
  }
  const items: number[] = [cursor]
  for (let i = cursor - 1; i >= 0 && items.length < MAX_ITEMS; i--) {
    const k = kind(i)
    if (k === 'stop') break
    if (k === 'item') items.unshift(i)
  }
  let last = cursor
  for (let i = cursor + 1; i < lines.length && items.length < MAX_ITEMS; i++) {
    const k = kind(i)
    if (k === 'stop') break
    if (k === 'item') items.push(i)
    last = i
  }
  if (items.length < 2) return EMPTY
  const labels = items.map((r) => lines[r].slice(indent).trim())
  const selected = items.indexOf(cursor)
  const numbers = labels.map((l) => Number(NUMBER_RE.exec(l)?.[1] ?? NaN))
  const numbered = numbers.every((n, i) => Number.isFinite(n) && (i === 0 || n === numbers[i - 1] + 1))
  if (!numbered && labels.some((l) => l.length >= cols - indent - 6)) return EMPTY
  const spans: [number, number][] = items.map((r, k) => [rows[r].y, rows[k + 1 < items.length ? items[k + 1] - 1 : last].y])
  const menu = labels.map((label, i) => ({
    key: numbered && numbers[i] <= 9 ? String(numbers[i]) : `pick:${i}:${selected}`,
    label: shortLabel(numbered ? (NUMBER_RE.exec(label)?.[2] ?? label) : label),
    selected: i === selected
  }))
  return { menu, question: questionAbove(rows, items[0]), spans }
}

function cursorVisible(term: Terminal): boolean {
  const core = (term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core
  return core?.coreService?.isCursorHidden === false
}

export function scanTerminal(term: Terminal | undefined): TerminalScan {
  if (!term || cursorVisible(term)) return EMPTY
  const buf = term.buffer.active
  const top = buf.viewportY
  const rows: Row[] = []
  for (let y = top; y < top + term.rows; y++) {
    const line = buf.getLine(y)
    rows.push({ y, text: clean(line?.translateToString(true) ?? ''), wrapped: !!line?.isWrapped })
  }
  let cursor = -1
  for (let i = rows.length - 1; i >= 0; i--) {
    if (CURSOR_RE.test(rows[i].text)) {
      cursor = i
      break
    }
  }
  if (cursor < 0) return EMPTY
  return scanNumbered(rows, cursor) ?? scanPlain(rows, cursor, term.cols)
}

export function menuItemAtRow(scan: TerminalScan | undefined, y: number): MenuOption | null {
  if (!scan) return null
  const k = scan.spans.findIndex(([a, b]) => y >= a && y <= b)
  return k >= 0 ? (scan.menu[k] ?? null) : null
}
