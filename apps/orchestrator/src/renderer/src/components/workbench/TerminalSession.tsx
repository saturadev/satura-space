import { useEffect, useRef } from 'react'
import { DEFAULT_TERMINAL_FONT_SIZE } from '@shared/types'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import { buildDefaultTerminalOptions } from '../../lib/terminal/terminal-options'
import { attachTerminalClipboard } from '../../lib/terminal/clipboard'
import { attachOsc52Clipboard } from '../../lib/terminal/osc52-clipboard'
import { pasteFilePaths } from '../../lib/terminal/paste-file-paths'
import { createTerminalLinkHandler, activateWebLink } from '../../lib/terminal/terminal-links'
import { createFilePathLinkProvider } from '../../lib/terminal/terminal-file-links'
import { createTerminalWriter, type TerminalWriter } from '../../lib/terminal/output-scheduler'
import { createReplayGuard, restoreSerializedBuffer } from '../../lib/terminal/replay-guard'
import { registerTerminalSnapshot, consumeTerminalSnapshot } from '../../lib/terminal/serialize'
import { takePendingCommand } from '../../lib/terminal/pending-commands'
import { agentLaunchEnvFor, agentRelaunchCommandFor } from '../../lib/terminal/agent-relaunch'
import { markPtyAttached, resolveAgentRelaunch } from '../../lib/claude-sessions/launch-restore'
import { useAppStore } from '../../store'
import { isMobileLayout } from '../../lib/mobile/mobile-back'
import { captureText } from '../../lib/capture'
import {
  getTerminalHost,
  registerRefit,
  registerTerminalInstance,
  requestRefit,
  releaseTerminalHost,
  pauseRenderingWhileHidden,
  paintTerminalInset
} from '../../lib/terminal/terminal-registry'
import { debugLog } from '@shared/debug-log'

const INTERACTIVE_WINDOW_MS = 100

export function TerminalSession({
  ptyId,
  cwd,
  active,
  focused
}: {
  ptyId: string
  cwd?: string
  active: boolean
  focused: boolean
}) {
  const writerRef = useRef<TerminalWriter | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const activeRef = useRef(active)
  const cwdRef = useRef(cwd)
  cwdRef.current = cwd
  const webglCtlRef = useRef<{ load: () => void; dispose: () => void } | null>(null)
  const setHiddenRef = useRef<((hidden: boolean) => void) | null>(null)
  const fontSize = useAppStore((s) => s.settings?.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE)

  useEffect(() => {
    const host = getTerminalHost(ptyId)

    const initialFontSize =
      useAppStore.getState().settings?.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE
    const term = new Terminal(buildDefaultTerminalOptions(initialFontSize))
    const fit = new FitAddon()
    const serialize = new SerializeAddon()
    const unicode11 = new Unicode11Addon()
    term.loadAddon(fit)
    term.loadAddon(serialize)
    term.loadAddon(unicode11)
    term.loadAddon(new WebLinksAddon(activateWebLink))
    term.options.linkHandler = createTerminalLinkHandler(ptyId)
    const fileLinks = term.registerLinkProvider(
      createFilePathLinkProvider(term, ptyId, () => cwdRef.current)
    )
    term.unicode.activeVersion = '11'
    term.open(host)
    paintTerminalInset(term)
    const setHidden = pauseRenderingWhileHidden(term)
    setHidden(!activeRef.current)
    setHiddenRef.current = setHidden

    let webgl: WebglAddon | null = null
    let webglGaveUp = false
    let webglRetries = 0
    let webglRetryTimer: number | null = null
    let webglVerifyTimer: number | null = null
    const disposeWebgl = (): void => {
      if (webglVerifyTimer != null) {
        window.clearTimeout(webglVerifyTimer)
        webglVerifyTimer = null
      }
      if (!webgl) return
      try {
        webgl.dispose()
      } catch {
      }
      webgl = null
    }
    const webglDead = (): boolean => {
      for (const canvas of host.querySelectorAll<HTMLCanvasElement>('.xterm-screen canvas')) {
        const gl = canvas.getContext('webgl2')
        if (gl) return gl.isContextLost()
      }
      return true
    }
    const retryWebgl = (): void => {
      disposeWebgl()
      if (webglRetries >= 3) {
        webglGaveUp = true
        term.refresh(0, Math.max(0, term.rows - 1))
        return
      }
      webglRetries++
      if (webglRetryTimer != null) window.clearTimeout(webglRetryTimer)
      webglRetryTimer = window.setTimeout(() => {
        webglRetryTimer = null
        loadWebgl()
        term.refresh(0, Math.max(0, term.rows - 1))
      }, 500)
    }
    const scheduleWebglVerify = (): void => {
      if (webglVerifyTimer != null) window.clearTimeout(webglVerifyTimer)
      webglVerifyTimer = window.setTimeout(() => {
        webglVerifyTimer = null
        if (!webgl) return
        if (!webglDead()) {
          webglRetries = 0
          return
        }
        console.warn('[terminal] webgl context dead after load — retrying')
        retryWebgl()
      }, 2000)
    }
    const loadWebgl = (): void => {
      if (webglGaveUp || webgl || !activeRef.current) return
      let addon: WebglAddon | null = null
      try {
        addon = new WebglAddon()
        addon.onContextLoss(() => {
          if (webgl !== addon) return
          retryWebgl()
        })
        term.loadAddon(addon)
        webgl = addon
        scheduleWebglVerify()
      } catch {
        try {
          addon?.dispose()
        } catch {
        }
        retryWebgl()
      }
    }
    webglCtlRef.current = {
      load: loadWebgl,
      dispose: () => {
        if (webglRetryTimer != null) {
          window.clearTimeout(webglRetryTimer)
          webglRetryTimer = null
        }
        webglRetries = 0
        disposeWebgl()
      }
    }
    loadWebgl()
    const onHostGlContextEvent = (e: Event): void => {
      const target = e.target
      if (!(target instanceof HTMLCanvasElement) || !host.contains(target)) return
      if (!webgl) return
      retryWebgl()
    }
    host.addEventListener('webglcontextlost', onHostGlContextEvent, true)
    host.addEventListener('webglcontextrestored', onHostGlContextEvent, true)
    const offGpuReset = window.api.window.onGpuReset(() => {
      if (webglRetryTimer != null) {
        window.clearTimeout(webglRetryTimer)
        webglRetryTimer = null
      }
      webglRetries = 0
      webglGaveUp = false
      disposeWebgl()
      loadWebgl()
      term.refresh(0, Math.max(0, term.rows - 1))
    })

    termRef.current = term

    const detachClipboard = attachTerminalClipboard(term, (data) => window.api.pty.write(ptyId, data))
    const detachOsc52 = attachOsc52Clipboard(term, ptyId)

    const onDragOver = (e: DragEvent): void => {
      if (!e.dataTransfer?.types.includes('Files')) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }
    const onDrop = (e: DragEvent): void => {
      const files = Array.from(e.dataTransfer?.files ?? [])
      if (!files.length) return
      e.preventDefault()
      e.stopPropagation()
      term.focus()
      const paths = files.map((f) => window.api.ui.getPathForFile(f)).filter(Boolean)
      pasteFilePaths(term, paths)
    }
    host.addEventListener('dragover', onDragOver)
    host.addEventListener('drop', onDrop)

    let lastCols = 0
    let lastRows = 0
    let refitRaf: number | null = null
    let ptyReady = false
    const inputBeforeSpawn: string[] = []
    const side = isMobileLayout() ? 'phone' : 'desktop'
    let foreign: { cols: number; rows: number } | null = null
    const applyScale = (): void => {
      const el = term.element
      if (!el) return
      const screen = el.querySelector<HTMLElement>('.xterm-screen')
      const width = screen?.offsetWidth ?? 0
      const room = host.clientWidth
      const scale = foreign && width > room && room > 0 ? room / width : 1
      el.style.transformOrigin = scale < 1 ? '0 0' : ''
      el.style.transform = scale < 1 ? `scale(${scale})` : ''
    }
    const applyFit = (): void => {
      if (side === 'phone' && (host.clientWidth < 40 || host.clientHeight < 40)) return
      let dims: { cols: number; rows: number } | undefined
      try {
        dims = fit.proposeDimensions()
      } catch {
        return
      }
      if (!dims || !(dims.cols > 0) || !(dims.rows > 0)) return
      const target = foreign ?? dims
      if (term.cols !== target.cols || term.rows !== target.rows) term.resize(target.cols, target.rows)
      if (dims.cols !== lastCols || dims.rows !== lastRows) {
        lastCols = dims.cols
        lastRows = dims.rows
        if (ptyReady) window.api.pty.resize(ptyId, dims.cols, dims.rows)
        if (side === 'phone') debugLog(`[terminal] ${ptyId} fits ${dims.cols}x${dims.rows} on this phone, xterm ${term.cols}x${term.rows}, host ${host.clientWidth}x${host.clientHeight} of page ${window.innerWidth}x${window.innerHeight}${foreign ? `, owner grid ${foreign.cols}x${foreign.rows}` : ''}`)
      }
      if (side === 'phone') host.dataset.grid = `${term.cols}x${term.rows}`
      applyScale()
      term.refresh(0, Math.max(0, term.rows - 1))
    }
    let settleTimer: number | null = null
    const scheduleRefit = (): void => {
      if (!activeRef.current) return
      if (side === 'phone') {
        if (settleTimer != null) window.clearTimeout(settleTimer)
        settleTimer = window.setTimeout(() => {
          settleTimer = null
          applyFit()
        }, 140)
        return
      }
      if (refitRaf != null) return
      refitRaf = requestAnimationFrame(() => {
        refitRaf = null
        applyFit()
      })
    }
    applyFit()

    const guard = createReplayGuard(term)
    const writer = createTerminalWriter({ write: (d) => term.write(captureText(d)) }, (n) =>
      window.api.pty.ackData(ptyId, n)
    )
    writer.setForeground(active)
    writerRef.current = writer

    const unregisterSnapshot = registerTerminalSnapshot(ptyId, term, serialize, () => writer.flush())
    const unregisterRefit = registerRefit(ptyId, scheduleRefit)
    const unregisterTerminalInstance = registerTerminalInstance(ptyId, term)

    let lastInputAt = 0
    const offData = window.api.pty.onData((e) => {
      if (e.id !== ptyId) return
      writer.write(e.data, { latencySensitive: Date.now() - lastInputAt < INTERACTIVE_WINDOW_MS })
    })
    const offExit = window.api.pty.onExit((e) => {
      if (e.id !== ptyId) return
      writer.write('\r\n\x1b[2m[process exited]\x1b[0m')
      useAppStore.getState().markPtyExited(ptyId)
    })
    const onFontsLoaded = (): void => {
      const size = term.options.fontSize ?? initialFontSize
      term.options.fontSize = size + 1
      term.options.fontSize = size
      lastCols = 0
      lastRows = 0
      applyFit()
    }
    if (side === 'phone') document.fonts?.addEventListener('loadingdone', onFontsLoaded)
    const offOwner = window.api.pty.onSizeOwner((e) => {
      if (e.id !== ptyId) return
      if (e.owner === side) {
        const was = foreign
        foreign = null
        if (was || e.cols == null) {
          debugLog(`[terminal] ${ptyId} size owner is this ${side} again`)
          lastCols = 0
          lastRows = 0
          applyFit()
        }
        return
      }
      if (e.cols == null || e.rows == null) return
      if (foreign?.cols === e.cols && foreign.rows === e.rows) return
      debugLog(`[terminal] ${ptyId} sized by the ${e.owner}: ${e.cols}x${e.rows}`)
      foreign = { cols: e.cols, rows: e.rows }
      applyFit()
    })
    const inputSub = term.onData((d) => {
      if (guard.isReplaying()) return
      lastInputAt = Date.now()
      if (ptyReady) window.api.pty.write(ptyId, d)
      else inputBeforeSpawn.push(d)
    })
    const titleSub = term.onTitleChange((title) => {
      useAppStore.getState().setTabGeneratedLabel(ptyId, title)
    })

    const shell = useAppStore.getState().settings?.terminalShell || undefined
    const env = agentLaunchEnvFor(ptyId)
    void window.api.pty.spawn({ id: ptyId, cols: term.cols, rows: term.rows, cwd, shell, env }).then((res) => {
      if (res?.error) {
        writer.write(
          `\r\n\x1b[31m[terminal unavailable: ${res.error}]\x1b[0m\r\n\x1b[2mRestart the terminal daemon in Settings, then reopen this tab.\x1b[0m`
        )
        useAppStore.getState().markPtyExited(ptyId)
        return
      }
      ptyReady = true
      if (inputBeforeSpawn.length) window.api.pty.write(ptyId, inputBeforeSpawn.splice(0).join(''))
      lastCols = 0
      lastRows = 0
      applyFit()
      const local = consumeTerminalSnapshot(ptyId)
      if (res?.attached) {
        markPtyAttached(ptyId)
        const snapshot = res.snapshot || local
        if (snapshot) {
          restoreSerializedBuffer(guard, snapshot, { reattached: true })
        }
        setTimeout(() => {
          const { cols, rows } = term
          if (cols > 1 && rows > 1) {
            window.api.pty.resize(ptyId, cols, rows - 1)
            window.api.pty.resize(ptyId, cols, rows)
          }
        }, 60)
      } else {
        const pending = takePendingCommand(ptyId)
        const relaunching = pending == null && agentRelaunchCommandFor(ptyId) != null
        if (relaunching) {
          guard.replay('\x1b[2J\x1b[3J\x1b[H')
        } else if (local) {
          restoreSerializedBuffer(guard, local)
        }
        const command = pending != null
          ? Promise.resolve(pending)
          : relaunching
            ? resolveAgentRelaunch(ptyId)
            : Promise.resolve(null)
        void command.then((relaunch) => {
          if (!relaunch) return
          const ready = cwd
            ? window.api.unity.ensureProjectEnv(cwd).catch(() => {})
            : Promise.resolve()
          void ready.then(() => window.api.pty.write(ptyId, relaunch + '\r'))
        })
      }
    })

    const ro = new ResizeObserver(() => scheduleRefit())
    ro.observe(host)

    return () => {
      ro.disconnect()
      host.removeEventListener('dragover', onDragOver)
      host.removeEventListener('drop', onDrop)
      host.removeEventListener('webglcontextlost', onHostGlContextEvent, true)
      host.removeEventListener('webglcontextrestored', onHostGlContextEvent, true)
      if (refitRaf != null) cancelAnimationFrame(refitRaf)
      if (settleTimer != null) window.clearTimeout(settleTimer)
      if (webglRetryTimer != null) window.clearTimeout(webglRetryTimer)
      webglCtlRef.current = null
      offGpuReset()
      disposeWebgl()
      offData()
      offExit()
      offOwner()
      document.fonts?.removeEventListener('loadingdone', onFontsLoaded)
      inputSub.dispose()
      titleSub.dispose()
      unregisterSnapshot()
      unregisterRefit()
      unregisterTerminalInstance()
      detachClipboard()
      detachOsc52()
      fileLinks.dispose()
      writer.dispose()
      term.dispose()
      releaseTerminalHost(ptyId)
      writerRef.current = null
      termRef.current = null
      setHiddenRef.current = null
    }
  }, [ptyId, cwd])

  useEffect(() => {
    activeRef.current = active
    writerRef.current?.setForeground(active)
    if (active) {
      webglCtlRef.current?.load()
      setHiddenRef.current?.(false)
      requestRefit(ptyId)
      if (!isMobileLayout()) termRef.current?.focus()
    } else {
      setHiddenRef.current?.(true)
      webglCtlRef.current?.dispose()
    }
  }, [active, ptyId])

  useEffect(() => {
    if (!focused) return
    termRef.current?.focus()
    const onWindowFocus = (): void => {
      termRef.current?.focus()
    }
    window.addEventListener('focus', onWindowFocus)
    return () => window.removeEventListener('focus', onWindowFocus)
  }, [focused, ptyId])

  useEffect(() => {
    const term = termRef.current
    if (!term || term.options.fontSize === fontSize) return
    term.options.fontSize = fontSize
    requestRefit(ptyId)
  }, [fontSize, ptyId])

  return null
}
