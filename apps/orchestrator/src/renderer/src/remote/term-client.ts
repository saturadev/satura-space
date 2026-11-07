import type { Terminal } from '@xterm/xterm'
import { TERM_EMPTY, unpackTerm, applyFrame, insertScrollback, newPainted, paintState, type TermMacMsg, type TermPhoneMsg, type TermState } from '@shared/remote-term'
import { onTermLink, onTermText, sendTermText, termLinkOpen } from './video/link'
import { wsTransport } from './ws-transport'

export interface ScreenHooks {
  onBytes?: (n: number) => void
  onExit?: (code: number) => void
  onError?: (message: string) => void
  onTitle?: (title: string) => void
  onGrid?: (cols: number, rows: number) => void
}

export interface ScreenClient {
  input: (data: string) => void
  dispose: () => void
}

const KEY_RETRY_MS = 400

function send(msg: TermPhoneMsg): void {
  if (termLinkOpen() && sendTermText(JSON.stringify(msg))) return
  wsTransport.send('remote:term', msg)
}

export function openScreen(id: string, term: Terminal, hooks: ScreenHooks = {}): ScreenClient {
  let current: TermState = TERM_EMPTY
  const states = new Map<number, TermState>()
  let painted = newPainted()
  let queued = false
  let lastKeyAsk = 0
  let epoch = -1
  let disposed = false
  let link = termLinkOpen()
  let sbGrid: { cols: number; rows: number; seq: number } | null = null

  const grid = (cols: number, rows: number): void => {
    if (cols <= 0 || rows <= 0 || (term.cols === cols && term.rows === rows)) return
    term.resize(cols, rows)
    painted = newPainted()
    hooks.onGrid?.(cols, rows)
  }

  const paint = (): void => {
    queued = false
    if (disposed || current.seq === 0) return
    if (sbGrid && sbGrid.seq === current.seq && (sbGrid.cols !== current.cols || sbGrid.rows !== current.rows)) return
    grid(current.cols, current.rows)
    const out = paintState(painted, current)
    if (out) term.write(out)
  }

  const schedule = (): void => {
    if (queued) return
    queued = true
    queueMicrotask(paint)
  }

  const askKey = (): void => {
    const t = performance.now()
    if (t - lastKeyAsk < KEY_RETRY_MS) return
    lastKeyAsk = t
    send({ t: 'key', id })
  }

  const onFrame = (f: Extract<TermMacMsg, { t: 'f' }>): void => {
    if (f.seq <= current.seq) {
      if (current.seq) send({ t: 'ack', id, seq: current.seq })
      return
    }
    const base = f.base === 0 ? TERM_EMPTY : states.get(f.base)
    if (!base) {
      askKey()
      return
    }
    const next = applyFrame(base, f)
    states.set(next.seq, next)
    for (const k of states.keys()) if (k < f.base) states.delete(k)
    current = next
    send({ t: 'ack', id, seq: next.seq })
    schedule()
  }

  const onMessage = (m: TermMacMsg): void => {
    if (!m || m.id !== id || disposed) return
    if (m.t === 'f') return onFrame(m)
    if (m.t === 'sb') {
      if (m.reset) {
        term.write('\x1bc')
        painted = newPainted()
        epoch = m.epoch
      } else if (m.epoch !== epoch) return
      grid(m.cols, m.rows)
      sbGrid = { cols: m.cols, rows: m.rows, seq: current.seq }
      const out = insertScrollback(painted, m.lines)
      if (out) term.write(out)
      if (m.reset || m.lines.length) schedule()
      return
    }
    if (m.t === 'title') return hooks.onTitle?.(m.title)
    if (m.t === 'exit') return hooks.onExit?.(m.code)
    if (m.t === 'error') hooks.onError?.(m.message)
  }

  const onText = (text: string): void => {
    hooks.onBytes?.(text.length)
    let m: TermMacMsg
    try {
      m = JSON.parse(unpackTerm(text)) as TermMacMsg
    } catch {
      return
    }
    onMessage(m)
  }

  const offDc = onTermText(onText)
  const offWs = wsTransport.on('remote:term', (m: TermMacMsg) => {
    hooks.onBytes?.(JSON.stringify(m).length)
    onMessage(m)
  })
  const offLink = onTermLink((open) => {
    if (open === link) return
    link = open
    console.info(`[terminal] ${id} screen updates over ${open ? 'the WebRTC data channel' : 'the relay websocket'}`)
  })
  console.info(`[terminal] ${id} screen updates over ${link ? 'the WebRTC data channel' : 'the relay websocket'}`)
  const onVisibility = (): void => {
    if (disposed) return
    if (document.visibilityState === 'hidden') {
      send({ t: 'close', id })
      return
    }
    current = TERM_EMPTY
    states.clear()
    send({ t: 'open', id })
  }
  document.addEventListener('visibilitychange', onVisibility)
  send({ t: 'open', id })

  return {
    input: (data) => send({ t: 'in', id, data }),
    dispose: () => {
      disposed = true
      document.removeEventListener('visibilitychange', onVisibility)
      offDc()
      offWs()
      offLink()
      send({ t: 'close', id })
    }
  }
}
