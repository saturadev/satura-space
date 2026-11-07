import { useEffect, useRef, useState } from 'react'
import { PHONE_MAX_TERMINAL_FONT, PHONE_MIN_TERMINAL_FONT, clampPhoneTerminalFont } from '@shared/types'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import '@xterm/xterm/css/xterm.css'
import { buildDefaultTerminalOptions } from '../lib/terminal/terminal-options'
import { useAppStore } from '../store'
import { phoneScales, setPhoneScale, usePhoneScales } from '../lib/mobile/phone-scales'
import { getTerminalHost, paintTerminalInset, registerRefit, registerTerminalInstance, releaseTerminalHost } from '../lib/terminal/terminal-registry'
import { openScreen } from './term-client'
import { attachTermPerf } from './term-perf'
import { trackClaudeInput } from './claude-input'

const SETTLE_MS = 140
const SYMBOL_FONT = 'Satura Term Symbols'
const SCALES_WAIT_MS = 1500

interface Pinchable {
  start: (mid: { x: number; y: number }) => void
  move: (k: number) => void
  end: (k: number) => void
  setFont: (px: number) => void
}

const pinchables = new Map<string, Pinchable>()

export function pinchTerminal(ptyId: string, phase: 'start' | 'move' | 'end', k: number, mid: { x: number; y: number }): void {
  const p = pinchables.get(ptyId)
  if (!p) return
  if (phase === 'start') p.start(mid)
  else if (phase === 'move') p.move(k)
  else p.end(k)
}

export function RemoteTerminalSession({ ptyId }: { ptyId: string }) {
  const scales = usePhoneScales()
  const [waited, setWaited] = useState(false)
  const ready = scales.loaded || waited
  const fontSize = scales.terminalFontSize
  const ctl = useRef<Pinchable | null>(null)

  useEffect(() => {
    if (scales.loaded) return
    const t = window.setTimeout(() => setWaited(true), SCALES_WAIT_MS)
    return () => window.clearTimeout(t)
  }, [scales.loaded])

  useEffect(() => {
    ctl.current?.setFont(fontSize)
  }, [fontSize])

  useEffect(() => {
    if (!ready) return
    const host = getTerminalHost(ptyId)
    const options = buildDefaultTerminalOptions(phoneScales().terminalFontSize)
    const term = new Terminal({ ...options, fontFamily: String(options.fontFamily).replace('"Menlo",', `"Menlo", "${SYMBOL_FONT}",`), cursorBlink: false })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.loadAddon(new Unicode11Addon())
    term.unicode.activeVersion = '11'
    term.open(host)
    if (term.textarea) term.textarea.disabled = true
    paintTerminalInset(term)
    let webgl: WebglAddon | null = null
    try {
      webgl = new WebglAddon()
      webgl.onContextLoss(() => {
        console.warn(`[terminal] ${ptyId} webgl context lost, drawing with the DOM renderer`)
        webgl?.dispose()
        webgl = null
      })
      term.loadAddon(webgl)
    } catch (e) {
      console.warn(`[terminal] ${ptyId} webgl unavailable: ${(e as Error).message}`)
      webgl = null
    }

    const core = (
      term as unknown as {
        _core?: {
          _renderService?: {
            dimensions?: { device?: { canvas?: { width: number; height: number } } }
            handleResize?: (cols: number, rows: number) => void
            handleDevicePixelRatioChange?: () => void
          }
        }
      }
    )._core
    let syncFrame = 0
    const syncCanvas = (): void => {
      cancelAnimationFrame(syncFrame)
      syncFrame = requestAnimationFrame(() => {
        const rs = core?._renderService
        const want = rs?.dimensions?.device?.canvas
        const canvas = host.querySelector<HTMLCanvasElement>('.xterm-screen > canvas:not([class])')
        if (!rs?.handleResize || !want?.width || !canvas || (canvas.width === want.width && canvas.height === want.height)) return
        console.info(`[terminal] ${ptyId} canvas ${canvas.width}x${canvas.height} out of step with ${want.width}x${want.height} at ${window.devicePixelRatio}x, resizing it`)
        rs.handleResize(term.cols, term.rows)
      })
    }

    let foreign: { cols: number; rows: number } | null = null
    let asked = { cols: 0, rows: 0 }
    let fitScale = 1
    let pinch: { k: number; ox: number; oy: number; from: number } | null = null
    const applyScale = (): void => {
      const el = term.element
      if (!el) return
      const width = el.querySelector<HTMLElement>('.xterm-screen')?.offsetWidth ?? 0
      const room = host.clientWidth
      fitScale = width > room && room > 0 ? room / width : 1
      const scale = fitScale * (pinch?.k ?? 1)
      el.style.transformOrigin = pinch ? `${pinch.ox}px ${pinch.oy}px` : scale < 1 ? '0 0' : ''
      el.style.transform = scale !== 1 ? `scale(${scale})` : ''
      host.dataset.grid = `${term.cols}x${term.rows}`
    }
    const applyFit = (): void => {
      if (host.clientWidth < 40 || host.clientHeight < 40) return
      let dims: { cols: number; rows: number } | undefined
      try {
        dims = fit.proposeDimensions()
      } catch {
        return
      }
      if (!dims || !(dims.cols > 0) || !(dims.rows > 0)) return
      if (dims.cols !== asked.cols || dims.rows !== asked.rows) {
        asked = { cols: dims.cols, rows: dims.rows }
        window.api.pty.resize(ptyId, dims.cols, dims.rows)
        console.info(`[terminal] ${ptyId} fits ${dims.cols}x${dims.rows} on this phone, host ${host.clientWidth}x${host.clientHeight}${foreign ? `, owner grid ${foreign.cols}x${foreign.rows}` : ''}`)
      }
      applyScale()
      syncCanvas()
    }
    let settle: number | null = null
    const scheduleRefit = (): void => {
      if (settle != null) window.clearTimeout(settle)
      settle = window.setTimeout(() => {
        settle = null
        applyFit()
      }, SETTLE_MS)
    }

    const perf = attachTermPerf(term, ptyId)
    const screen = openScreen(ptyId, term, {
      onBytes: (n) => perf.bytes(n),
      onGrid: () => applyScale(),
      onTitle: (title) => useAppStore.getState().setTabGeneratedLabel(ptyId, title),
      onExit: () => {
        term.write('\r\n\x1b[2m[process exited]\x1b[0m')
        useAppStore.getState().markPtyExited(ptyId)
      },
      onError: (message) => term.write(`\x1bc\x1b[2m${message}\x1b[0m`)
    })

    const unregisterRefit = registerRefit(ptyId, scheduleRefit)
    const unregisterInstance = registerTerminalInstance(ptyId, term)
    const inputSub = term.onData((d) => {
      screen.input(d)
    })
    const offOwner = window.api.pty.onSizeOwner((e) => {
      if (e.id !== ptyId) return
      foreign = e.owner === 'phone' || e.cols == null || e.rows == null ? null : { cols: e.cols, rows: e.rows }
      if (e.owner === 'phone') asked = { cols: 0, rows: 0 }
      applyFit()
    })
    const onFonts = (): void => {
      const size = term.options.fontSize ?? phoneScales().terminalFontSize
      term.options.fontSize = size + 1
      term.options.fontSize = size
      asked = { cols: 0, rows: 0 }
      applyFit()
    }
    const setFont = (px: number): void => {
      if (term.options.fontSize === px) return
      const was = term.options.fontSize
      const bottom = term.buffer.active.viewportY >= term.buffer.active.baseY
      term.options.fontSize = px
      asked = { cols: 0, rows: 0 }
      applyFit()
      if (bottom) term.scrollToBottom()
      console.info(`[terminal] ${ptyId} font ${was} -> ${px} px, asks for ${asked.cols}x${asked.rows}`)
    }
    const control: Pinchable = {
      start: (mid) => {
        const el = term.element
        const r = el?.getBoundingClientRect()
        const from = term.options.fontSize ?? phoneScales().terminalFontSize
        pinch = { k: 1, ox: r ? (mid.x - r.left) / fitScale : 0, oy: r ? (mid.y - r.top) / fitScale : 0, from }
        console.info(`[terminal] ${ptyId} pinch starts at ${from} px`)
      },
      move: (k) => {
        if (!pinch) return
        pinch.k = Math.max(PHONE_MIN_TERMINAL_FONT, Math.min(PHONE_MAX_TERMINAL_FONT, pinch.from * k)) / pinch.from
        applyScale()
      },
      end: (k) => {
        const p = pinch
        pinch = null
        if (!p) return
        const px = clampPhoneTerminalFont(p.from * k)
        console.info(`[terminal] ${ptyId} pinch ends at x${Math.round(k * 100) / 100}: ${p.from} -> ${px} px`)
        applyScale()
        setFont(px)
        setPhoneScale({ terminalFontSize: px }, px !== p.from)
      },
      setFont
    }
    ctl.current = control
    pinchables.set(ptyId, control)
    document.fonts?.addEventListener('loadingdone', onFonts)
    const untrackInput = trackClaudeInput(ptyId, term, host)
    const ro = new ResizeObserver(() => scheduleRefit())
    ro.observe(host)
    applyFit()

    let dpr = window.devicePixelRatio
    let dprQuery: MediaQueryList | null = null
    const onDpr = (): void => {
      if (window.devicePixelRatio === dpr) return
      console.info(`[terminal] ${ptyId} pixel ratio ${dpr} -> ${window.devicePixelRatio}, redrawing`)
      dpr = window.devicePixelRatio
      watchDpr()
      core?._renderService?.handleDevicePixelRatioChange?.()
      scheduleRefit()
      syncCanvas()
    }
    const watchDpr = (): void => {
      dprQuery?.removeEventListener('change', onDpr)
      dprQuery = window.matchMedia(`(resolution: ${dpr}dppx)`)
      dprQuery.addEventListener('change', onDpr)
    }
    watchDpr()
    window.addEventListener('resize', onDpr)

    return () => {
      if (pinchables.get(ptyId) === control) pinchables.delete(ptyId)
      if (ctl.current === control) ctl.current = null
      cancelAnimationFrame(syncFrame)
      dprQuery?.removeEventListener('change', onDpr)
      window.removeEventListener('resize', onDpr)
      ro.disconnect()
      untrackInput()
      if (settle != null) window.clearTimeout(settle)
      document.fonts?.removeEventListener('loadingdone', onFonts)
      offOwner()
      inputSub.dispose()
      screen.dispose()
      perf.dispose()
      unregisterRefit()
      unregisterInstance()
      webgl?.dispose()
      term.dispose()
      releaseTerminalHost(ptyId)
    }
  }, [ptyId, ready])

  return null
}
