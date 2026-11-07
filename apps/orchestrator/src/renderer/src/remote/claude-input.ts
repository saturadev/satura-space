import type { Terminal } from '@xterm/xterm'
import { postToShell } from './shell-bus'

export interface InputRows {
  first: number
  last: number
  start: number
  col: number
  end: number
  caretX: number
  caretY: number
}

export interface InputBox {
  bx: number
  bw: number
  x: number
  y: number
  w: number
  h: number
  caretX: number
  caretY: number
  cw: number
  ch: number
  clipTop: number
  clipBottom: number
  font: string
  size: number
  weight: string
  spacing: number
  fg: string
  bg: string
  caret: string
  rows: [number, number]
}

const RULE_RE = /^\s*[╭╰]?─{8,}[╮╯]?\s*$/u
const PROMPT_RE = /^(\s*│?\s*)[❯›>](?:\s|$)/u
const MORE_RE = /^\s*│?\s/u
const MISS_MS = 450
const IMAGE_WAIT_MS = 4000

function textAt(term: Terminal, y: number): string {
  return term.buffer.active.getLine(y)?.translateToString(true) ?? ''
}

function cursorShown(term: Terminal): boolean {
  const core = (term as unknown as { _core?: { coreService?: { isCursorHidden?: boolean } } })._core
  return core?.coreService?.isCursorHidden === false
}

function inverseCell(term: Terminal, first: number, last: number, col: number, end: number): [number, number] | null {
  const buf = term.buffer.active
  for (let y = first; y <= last; y++) {
    const line = buf.getLine(y)
    for (let x = col; line && x < end; x++) if (line.getCell(x)?.isInverse()) return [x, y]
  }
  return null
}

function caretOf(term: Terminal, first: number, last: number, col: number, end: number): [number, number] {
  const buf = term.buffer.active
  const cy = buf.baseY + buf.cursorY
  if (cursorShown(term) && cy >= first && cy <= last && buf.cursorX >= col) return [Math.min(buf.cursorX, end), cy]
  return inverseCell(term, first, last, col, end) ?? [col, first]
}

export function findClaudeInput(term: Terminal): InputRows | null {
  const top = term.buffer.active.baseY
  for (let below = top + term.rows - 1; below > top + 1; below--) {
    const rule = textAt(term, below)
    if (!RULE_RE.test(rule)) continue
    for (let y = below - 1; y > top; y--) {
      const text = textAt(term, y)
      if (RULE_RE.test(text)) break
      const m = PROMPT_RE.exec(text)
      if (m && RULE_RE.test(textAt(term, y - 1))) {
        const boxed = /╯\s*$/u.test(rule)
        const col = m[1].length + 2
        const start = rule.length - rule.trimStart().length + (boxed ? 2 : 0)
        const end = rule.trimEnd().length - (boxed ? 2 : 0)
        if (end <= col || start > col) break
        const cy = term.buffer.active.baseY + term.buffer.active.cursorY
        if (cursorShown(term) && (cy < y || cy >= below)) return null
        const [caretX, caretY] = caretOf(term, y, below - 1, col, end)
        return { first: y, last: below - 1, start, col, end, caretX, caretY }
      }
      if (text && !MORE_RE.test(text)) break
    }
  }
  return null
}

function imagesInInput(term: Terminal): number {
  const rows = findClaudeInput(term)
  if (!rows) return -1
  let text = ''
  for (let y = rows.first; y <= rows.last; y++) text += textAt(term, y)
  return text.match(/\[Image #\d+\]/g)?.length ?? 0
}

export async function pasteImagePaths(term: Terminal | undefined, paths: string[], write: (data: string) => Promise<unknown>): Promise<void> {
  for (const p of paths) {
    const had = term ? imagesInInput(term) : -1
    await write(term?.modes.bracketedPasteMode ? `\x1b[200~${p}\x1b[201~ ` : `${p} `)
    const until = performance.now() + IMAGE_WAIT_MS
    let now = had
    while (term && had >= 0 && (now = imagesInInput(term)) <= had && performance.now() < until) await new Promise((r) => setTimeout(r, 80))
    console.info(`[terminal] pasted ${p} ${had < 0 ? 'as a path, no Claude input box on screen' : now > had ? "and Claude's input shows it as an image" : `but Claude's input didn't show an image in ${IMAGE_WAIT_MS} ms`}`)
  }
}

let measureCtx: CanvasRenderingContext2D | null = null
const advances = new Map<string, number>()

function advance(font: string): number {
  const known = advances.get(font)
  if (known !== undefined) return known
  measureCtx ??= document.createElement('canvas').getContext('2d')
  if (!measureCtx) return 0
  measureCtx.font = font
  const w = measureCtx.measureText('M'.repeat(40)).width / 40
  if (document.fonts?.status !== 'loading') advances.set(font, w)
  return w
}

function px(n: number): number {
  return Math.round(n * 100) / 100
}

export function inputBoxOf(term: Terminal, rows: InputRows): InputBox | null {
  const el = term.element
  const screen = el?.querySelector<HTMLElement>('.xterm-screen')
  const panel = el?.closest<HTMLElement>('[data-phone-panel]')
  if (!el || !screen || !panel || term.rows <= 0 || term.cols <= 0) return null
  const r = screen.getBoundingClientRect()
  const p = panel.getBoundingClientRect()
  if (r.width < 1 || r.height < 1) return null
  const cw = r.width / term.cols
  const ch = r.height / term.rows
  const vy = term.buffer.active.viewportY
  const rowTop = (y: number): number => r.top + (y - vy) * ch
  const scale = screen.offsetWidth > 0 ? r.width / screen.offsetWidth : 1
  const o = term.options
  const size = (o.fontSize ?? 14) * scale
  const weight = String(o.fontWeight ?? '400')
  const font = String(o.fontFamily ?? 'monospace')
  const theme = o.theme ?? {}
  return {
    bx: px(r.left + rows.start * cw),
    bw: px((rows.end - rows.start) * cw),
    x: px(r.left + rows.col * cw),
    y: px(rowTop(rows.first)),
    w: px((rows.end - rows.col) * cw),
    h: px((rows.last - rows.first + 1) * ch),
    caretX: px(r.left + rows.caretX * cw),
    caretY: px(rowTop(rows.caretY)),
    cw: px(cw),
    ch: px(ch),
    clipTop: px(Math.max(p.top, r.top)),
    clipBottom: px(Math.min(p.bottom, r.bottom)),
    font,
    size: px(size),
    weight,
    spacing: px(cw - advance(`${weight} ${size}px ${font}`)),
    fg: theme.foreground ?? '#d9dce1',
    bg: theme.background ?? '#1a1c20',
    caret: theme.cursor ?? theme.foreground ?? '#e5e7eb',
    rows: [rows.first - vy, rows.last - vy]
  }
}

export function trackClaudeInput(ptyId: string, term: Terminal, host: HTMLElement): () => void {
  let frame = 0
  let missTimer = 0
  let missSince = 0
  let last = ''
  let disposed = false
  const post = (box: InputBox | null): void => {
    const text = JSON.stringify(box)
    if (text === last) return
    const was = last
    last = text
    if (!box !== (!was || was === 'null')) console.info(`[terminal] ${ptyId} ${box ? `Claude's input box at rows ${box.rows[0]}-${box.rows[1]}` : "no Claude input box on screen"}`)
    postToShell({ type: 'inputBox', ptyId, box })
  }
  const run = (): void => {
    frame = 0
    if (disposed) return
    const rows = findClaudeInput(term)
    const box = rows ? inputBoxOf(term, rows) : null
    if (box) {
      missSince = 0
      window.clearTimeout(missTimer)
      post(box)
      return
    }
    if (!last || last === 'null') return post(null)
    const now = performance.now()
    if (!missSince) missSince = now
    const left = MISS_MS - (now - missSince)
    if (left <= 0) return post(null)
    window.clearTimeout(missTimer)
    missTimer = window.setTimeout(schedule, left)
  }
  const schedule = (): void => {
    if (!frame && !disposed) frame = requestAnimationFrame(run)
  }
  const subs = [term.onRender(schedule), term.onCursorMove(schedule), term.onScroll(schedule), term.onResize(schedule)]
  const mo = new MutationObserver(schedule)
  if (term.element) mo.observe(term.element, { attributes: true, attributeFilter: ['style'] })
  const screen = term.element?.querySelector('.xterm-screen')
  if (screen) mo.observe(screen, { attributes: true, attributeFilter: ['style'] })
  const ro = new ResizeObserver(schedule)
  ro.observe(host)
  const panel = host.closest('[data-phone-panel]')
  if (panel) ro.observe(panel)
  const vv = window.visualViewport
  window.addEventListener('resize', schedule)
  vv?.addEventListener('resize', schedule)
  vv?.addEventListener('scroll', schedule)
  document.fonts?.addEventListener('loadingdone', schedule)
  schedule()
  return () => {
    disposed = true
    cancelAnimationFrame(frame)
    window.clearTimeout(missTimer)
    for (const s of subs) s.dispose()
    mo.disconnect()
    ro.disconnect()
    window.removeEventListener('resize', schedule)
    vv?.removeEventListener('resize', schedule)
    vv?.removeEventListener('scroll', schedule)
    document.fonts?.removeEventListener('loadingdone', schedule)
    post(null)
  }
}
