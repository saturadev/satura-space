const OSC_START = '\x1b]'
const TITLE_RE = /\x1b\]([012]);([^\x07\x1b]*)(?:\x07|\x1b\\)/g
const MAX_TAIL = 2048

export class TerminalTitleTracker {
  private tails = new Map<string, string>()
  private last = new Map<string, string>()

  push(pane: string, data: string): string[] {
    const tail = this.tails.get(pane) ?? ''
    if (!tail && !data.includes(OSC_START)) return []
    const text = tail + data
    const out: string[] = []
    let end = 0
    TITLE_RE.lastIndex = 0
    for (let m = TITLE_RE.exec(text); m; m = TITLE_RE.exec(text)) {
      end = TITLE_RE.lastIndex
      if (m[1] === '1') continue
      if (this.last.get(pane) === m[2]) continue
      this.last.set(pane, m[2])
      out.push(m[2])
    }
    const open = text.lastIndexOf(OSC_START)
    const rest = open >= end ? text.slice(open) : ''
    if (rest && rest.length <= MAX_TAIL && !/[\x07]|\x1b\\/.test(rest)) this.tails.set(pane, rest)
    else this.tails.delete(pane)
    return out
  }

  current(pane: string): string {
    return this.last.get(pane) ?? ''
  }

  forget(pane: string): void {
    this.tails.delete(pane)
    this.last.delete(pane)
  }
}
