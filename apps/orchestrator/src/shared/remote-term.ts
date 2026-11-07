export interface TermHead {
  cols: number
  rows: number
  alt: boolean
  cx: number
  cy: number
  cursor: boolean
  modes: string
}

export interface TermState extends TermHead {
  seq: number
  lines: string[]
}

export interface TermFrame extends TermHead {
  t: 'f'
  id: string
  seq: number
  base: number
  set: [number, string][]
}

export type TermMacMsg =
  | TermFrame
  | { t: 'sb'; id: string; epoch: number; from: number; cols: number; rows: number; lines: string[]; reset?: boolean }
  | { t: 'title'; id: string; title: string }
  | { t: 'exit'; id: string; code: number }
  | { t: 'error'; id: string; message: string }

export type TermPhoneMsg =
  | { t: 'open'; id: string }
  | { t: 'close'; id: string }
  | { t: 'ack'; id: string; seq: number }
  | { t: 'key'; id: string }
  | { t: 'in'; id: string; data: string }

export function packTerm(json: string): string {
  return json.replace(/(?<!\\)((?:\\\\)*)\\u001b/g, '$1\ufdd0')
}

export function unpackTerm(text: string): string {
  return text.replace(/\ufdd0/g, '\\u001b')
}

export const TERM_EMPTY: TermState = { seq: 0, cols: 0, rows: 0, alt: false, cx: 0, cy: 0, cursor: true, modes: '', lines: [] }

export function sameHead(a: TermHead, b: TermHead): boolean {
  return a.cols === b.cols && a.rows === b.rows
}

export function diffState(base: TermState, next: TermState): [number, string][] {
  const full = !sameHead(base, next) || base.seq === 0
  const set: [number, string][] = []
  for (let y = 0; y < next.lines.length; y++) if (full || base.lines[y] !== next.lines[y]) set.push([y, next.lines[y]])
  return set
}

export function frameOf(id: string, base: TermState, next: TermState): TermFrame {
  const { cols, rows, alt, cx, cy, cursor, modes } = next
  return { t: 'f', id, seq: next.seq, base: base.seq === 0 || !sameHead(base, next) ? 0 : base.seq, set: diffState(base, next), cols, rows, alt, cx, cy, cursor, modes }
}

export function applyFrame(base: TermState, f: TermFrame): TermState {
  const lines = f.base === 0 ? new Array<string>(f.rows).fill('') : base.lines.slice(0, f.rows)
  while (lines.length < f.rows) lines.push('')
  for (const [y, text] of f.set) if (y >= 0 && y < f.rows) lines[y] = text
  return { seq: f.seq, cols: f.cols, rows: f.rows, alt: f.alt, cx: f.cx, cy: f.cy, cursor: f.cursor, modes: f.modes, lines }
}

export interface CellLike {
  getWidth(): number
  getChars(): string
  isBold(): number
  isItalic(): number
  isDim(): number
  isUnderline(): number
  isBlink(): number
  isInverse(): number
  isInvisible(): number
  isStrikethrough(): number
  isOverline(): number
  getFgColorMode(): number
  getBgColorMode(): number
  getFgColor(): number
  getBgColor(): number
  isFgRGB(): boolean
  isBgRGB(): boolean
  isFgPalette(): boolean
  isBgPalette(): boolean
  isFgDefault(): boolean
  isBgDefault(): boolean
}

export interface LineLike {
  getCell(x: number, cell?: any): CellLike | undefined
  readonly length: number
}

interface CellExt {
  fg?: number
  bg?: number
  extended?: { urlId: number; _ext?: number }
  hasExtendedAttrs?(): number
  getUnderlineStyle?(): number
  getUnderlineColor?(): number
  getUnderlineColorMode?(): number
}

const FG_UNDERLINE = 0x10000000
const CM_P16 = 0x1000000
const CM_P256 = 0x2000000
const CM_RGB = 0x3000000

function underlineStyleOf(cell: CellLike): number {
  const c = cell as CellLike & CellExt
  if (c.fg === undefined) return cell.isUnderline() ? 1 : 0
  if (!(c.fg & FG_UNDERLINE)) return 0
  if (!c.hasExtendedAttrs?.()) return 1
  if (c.extended?.urlId) return c.extended._ext === undefined ? 1 : (c.extended._ext & 0x1c000000) >> 26 || 1
  return c.getUnderlineStyle?.() || 1
}

function underlineColorOf(cell: CellLike): string {
  const c = cell as CellLike & CellExt
  if (!c.hasExtendedAttrs?.() || !c.getUnderlineColorMode || !c.getUnderlineColor) return ''
  const mode = c.getUnderlineColorMode()
  const v = c.getUnderlineColor()
  if (mode === CM_RGB) return `58;2;${(v >> 16) & 255};${(v >> 8) & 255};${v & 255}`
  if (mode === CM_P16 || mode === CM_P256) return `58;5;${v}`
  return ''
}

function color(cell: CellLike, fg: boolean): string {
  if (fg ? cell.isFgDefault() : cell.isBgDefault()) return ''
  const c = fg ? cell.getFgColor() : cell.getBgColor()
  if (fg ? cell.isFgRGB() : cell.isBgRGB()) return `${fg ? 38 : 48};2;${(c >> 16) & 255};${(c >> 8) & 255};${c & 255}`
  const p256 = (fg ? cell.getFgColorMode() : cell.getBgColorMode()) === CM_P256
  if (!p256 && c < 8) return String((fg ? 30 : 40) + c)
  if (!p256 && c < 16) return String((fg ? 90 : 100) + c - 8)
  return `${fg ? 38 : 48};5;${c}`
}

function sgrOf(cell: CellLike): string {
  const p: string[] = []
  if (cell.isBold()) p.push('1')
  if (cell.isDim()) p.push('2')
  if (cell.isItalic()) p.push('3')
  const ul = underlineStyleOf(cell)
  if (ul) p.push(ul === 1 ? '4' : `4:${ul}`)
  if (cell.isBlink()) p.push('5')
  if (cell.isInverse()) p.push('7')
  if (cell.isInvisible()) p.push('8')
  if (cell.isStrikethrough()) p.push('9')
  if (cell.isOverline()) p.push('53')
  const fg = color(cell, true)
  const bg = color(cell, false)
  if (fg) p.push(fg)
  if (bg) p.push(bg)
  const uc = underlineColorOf(cell)
  if (uc) p.push(uc)
  return p.join(';')
}

export type LinkLookup = (urlId: number) => { id?: string; uri: string } | undefined

function linkOf(cell: CellLike, links?: LinkLookup): string {
  const c = cell as CellLike & CellExt
  if (!links || !c.hasExtendedAttrs?.() || !c.extended?.urlId) return ''
  const l = links(c.extended.urlId)
  return l ? `${l.id ? 'id=' + l.id : ''};${l.uri}` : ''
}

export function serializeLine(line: LineLike | undefined, cols: number, scratch?: CellLike, links?: LinkLookup): string {
  if (!line) return ''
  let out = ''
  let pending = ''
  let skip = 0
  let erase = 0
  let eraseBg = ''
  let sgr = ''
  let link = ''
  let cell = scratch
  const setSgr = (next: string): void => {
    if (next === sgr) return
    out += `\x1b[0${next ? ';' + next : ''}m`
    sgr = next
  }
  const setLink = (next: string): void => {
    if (next === link) return
    out += `\x1b]8;${next || ';'}\x1b\\`
    link = next
  }
  const flushErase = (): void => {
    if (!erase) return
    setSgr(eraseBg)
    out += `\x1b[${erase}X\x1b[${erase}C`
    erase = 0
  }
  const flushPending = (): void => {
    if (skip) pending += `\x1b[${skip}C`
    skip = 0
    if (!pending) return
    setLink('')
    setSgr('')
    out += pending
    pending = ''
  }
  const n = Math.min(cols, line.length)
  for (let x = 0; x < n; x++) {
    cell = line.getCell(x, cell)
    if (!cell) break
    if (cell.getWidth() === 0) continue
    const chars = cell.getChars()
    if (chars === '') {
      const bg = color(cell, false)
      if (!bg) {
        flushErase()
        skip++
        continue
      }
      flushPending()
      if (erase && eraseBg !== bg) flushErase()
      eraseBg = bg
      erase++
      continue
    }
    const next = sgrOf(cell)
    const lk = linkOf(cell, links)
    if (chars === ' ' && next === '' && lk === '') {
      flushErase()
      if (skip) pending += `\x1b[${skip}C`
      skip = 0
      pending += ' '
      continue
    }
    flushErase()
    flushPending()
    setLink(lk)
    setSgr(next)
    out += chars
  }
  flushErase()
  setLink('')
  setSgr('')
  return out
}

function attrKey(cell: CellLike): string {
  const flags = [cell.isBold(), cell.isItalic(), cell.isDim(), cell.isBlink(), cell.isInverse(), cell.isInvisible(), cell.isStrikethrough(), cell.isOverline()].map((f) => (f ? 1 : 0)).join('')
  return `${flags} ${cell.getFgColorMode()}:${cell.getFgColor()} ${cell.getBgColorMode()}:${cell.getBgColor()}`
}

export interface CellDump {
  cols: number
  rows: number
  baseY: number
  length: number
  cursor: [number, number]
  lines: { y: number; cells: [string, number, string, number, string, string][] }[]
}

interface LinkSource {
  _core?: { _oscLinkService?: { getLinkData(id: number): { id?: string; uri: string } | undefined } }
}

export function dumpCells(term: ScreenSource & LinkSource, from = -2, count = 0): CellDump {
  const b = term.buffer.active as ScreenSource['buffer']['active'] & { length: number; cursorX: number; cursorY: number }
  const links = term._core?._oscLinkService
  const start = from === -1 ? 0 : from < 0 ? b.baseY : from
  const end = from === -1 ? b.length : from < 0 ? b.baseY + term.rows : Math.min(b.length, start + (count || term.rows))
  const lines: CellDump['lines'] = []
  let cell: CellLike | undefined
  for (let y = start; y < end; y++) {
    const line = b.getLine(y)
    const cells: CellDump['lines'][number]['cells'] = []
    for (let x = 0; line && x < term.cols; x++) {
      cell = line.getCell(x, cell)
      if (!cell) break
      const ext = cell as CellExt
      const url = ext.hasExtendedAttrs?.() && ext.extended?.urlId ?(links?.getLinkData(ext.extended.urlId)?.uri ?? '?') : ''
      cells.push([cell.getChars(), cell.getWidth(), attrKey(cell), underlineStyleOf(cell), underlineColorOf(cell), url])
    }
    lines.push({ y, cells })
  }
  return { cols: term.cols, rows: term.rows, baseY: b.baseY, length: b.length, cursor: [b.cursorX, b.cursorY], lines }
}

export interface ScreenSource {
  cols: number
  rows: number
  buffer: { active: { baseY: number; getLine(y: number): LineLike | undefined } }
}

export function linkLookup(term: unknown): LinkLookup | undefined {
  const service = (term as LinkSource)._core?._oscLinkService
  return service ? (id) => service.getLinkData(id) : undefined
}

export function captureLines(term: ScreenSource, scratch?: CellLike, links: LinkLookup | undefined = linkLookup(term)): string[] {
  const b = term.buffer.active
  const lines: string[] = new Array(term.rows)
  for (let y = 0; y < term.rows; y++) lines[y] = serializeLine(b.getLine(b.baseY + y), term.cols, scratch, links)
  return lines
}

const MOUSE_MODES: Record<string, number> = { x10: 9, vt200: 1000, drag: 1002, any: 1003 }

export interface ModeSource {
  applicationCursorKeysMode: boolean
  applicationKeypadMode: boolean
  bracketedPasteMode: boolean
  mouseTrackingMode: string
  sendFocusMode: boolean
}

export function encodeModes(m: ModeSource, mouseEncoding: string, cursorStyle: string, cursorBlink: boolean): string {
  return [m.applicationCursorKeysMode ? 1 : 0, m.applicationKeypadMode ? 1 : 0, m.bracketedPasteMode ? 1 : 0, MOUSE_MODES[m.mouseTrackingMode] ?? 0, mouseEncoding === 'SGR' ? 1 : mouseEncoding === 'SGR_PIXELS' ? 2 : 0, m.sendFocusMode ? 1 : 0, cursorStyle, cursorBlink ? 1 : 0].join(',')
}

export function modeSequences(modes: string): string {
  const [ck, kp, bp, mouse, enc, focus, style, blink] = modes.split(',')
  let s = `\x1b[?1${ck === '1' ? 'h' : 'l'}${kp === '1' ? '\x1b=' : '\x1b>'}\x1b[?2004${bp === '1' ? 'h' : 'l'}\x1b[?1004${focus === '1' ? 'h' : 'l'}`
  s += '\x1b[?9l\x1b[?1000l\x1b[?1002l\x1b[?1003l\x1b[?1006l\x1b[?1016l'
  if (mouse && mouse !== '0') s += `\x1b[?${mouse}h`
  if (enc === '1') s += '\x1b[?1006h'
  if (enc === '2') s += '\x1b[?1016h'
  const shape = style === 'underline' ? 3 : style === 'bar' ? 5 : 1
  s += `\x1b[${shape + (blink === '1' ? 0 : 1)} q`
  return s
}

export interface Painted {
  lines: (string | null)[]
  alt: boolean | null
  modes: string | null
}

export function newPainted(): Painted {
  return { lines: [], alt: null, modes: null }
}

export function paintState(p: Painted, s: TermState): string {
  let out = ''
  if (p.alt !== s.alt) {
    out += s.alt ? '\x1b[?1047h' : '\x1b[?1047l'
    p.alt = s.alt
    p.lines = []
  }
  out += '\x1b[?7l\x1b[?25l'
  for (let y = 0; y < s.rows; y++) {
    const text = s.lines[y] ?? ''
    if (p.lines[y] === text) continue
    out += `\x1b[${y + 1};1H\x1b[0m\x1b[2K${text}`
    p.lines[y] = text
  }
  p.lines.length = s.rows
  if (p.modes !== s.modes) {
    out += modeSequences(s.modes)
    p.modes = s.modes
  }
  out += `\x1b[0m\x1b[${s.cy + 1};${s.cx + 1}H${s.cursor ? '\x1b[?25h' : ''}`
  return out
}

export function insertScrollback(p: Painted, lines: string[]): string {
  if (!lines.length) return ''
  let out = p.alt ? '\x1b[?1047l' : ''
  out += '\x1b[?7l\x1b[r'
  for (const line of lines) out += `\x1b[1;1H\x1b[0m\x1b[2K${line}\x1b[0m\x1b[9999;1H\n`
  if (p.alt) out += '\x1b[?1047h'
  p.lines = []
  return out
}
