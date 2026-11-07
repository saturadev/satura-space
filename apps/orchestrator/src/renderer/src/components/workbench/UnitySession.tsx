import { useEffect, useRef } from 'react'
import {
  getUnityHost,
  getUnityCanvas,
  getUnityTextInput,
  releaseUnityHost,
  registerHintResend,
  unregisterHintResend
} from '../../lib/unity/unity-registry'
import {
  makeInputState,
  startInputLoop,
  MOD_ALT,
  MOD_ALTGR,
  MOD_CAPS,
  MOD_CTRL,
  MOD_META,
  MOD_NUM,
  MOD_SHIFT
} from '../../lib/unity/input-sender'
import { codeToUnityKey, MODIFIER_KEYS } from '../../lib/unity/keymap'
import { IS_MAC } from '../../lib/shortcuts/shortcuts'
import type { UnityCursorEvent } from '@shared/api'
import { useUnityRetry } from '../../lib/unity/unity-retry'
import { useWorldStore, markFramesLive, clearFramesLive } from '../../lib/unity/world-store'
import { setSessionStatus, clearSessionStatus, getSessionStatus } from '../../lib/unity/session-status'
import {
  setMetrics,
  clearMetrics,
  recordFrame,
  recordSample,
  resetPerfHistory,
  getMetrics
} from '../../lib/unity/unity-metrics'
import { CLONE_SEP, sessionOwnerPtyId } from '../../lib/unity/instance-ids'
import { watchDevicePixelRatio } from '../../lib/unity/device-pixel-ratio'
import { useAppStore } from '../../store'
import { paneRenderSize, type PixelSize } from '@shared/unity/stream-size'

const PING_STALE_MS = 5000

export function UnitySession({
  sessionId,
  worldId,
  projectPath,
  active
}: {
  sessionId: string
  worldId: string
  projectPath: string
  active: boolean
}): null {
  const retry = useUnityRetry(sessionId)
  const activeRef = useRef(active)
  const liveRef = useRef(false)
  const resendHintRef = useRef<() => void>(() => {})
  const cursorWantedRef = useRef(false)

  const isClone = sessionId.includes(CLONE_SEP)
  const primaryPtyId = sessionOwnerPtyId(sessionId)
  const workspaceVisible = useAppStore((s) => {
    const ws = s.activeWorkspaceId
    return ws != null && (s.tabsByWorkspace[ws] ?? []).some((t) => t.ptyId === primaryPtyId)
  })
  const workspaceVisibleRef = useRef(workspaceVisible)

  const savedVolume = useAppStore((s) => s.settings?.unityPlayerVolume ?? 1)
  const savedMuted = useAppStore((s) => s.settings?.unityPlayerMuted ?? false)

  const lifecycle = useWorldStore((s) => s.worlds[projectPath]?.observed.instances[worldId]?.lifecycle)
  const lifecycleRef = useRef(lifecycle)
  lifecycleRef.current = lifecycle
  const desired = useWorldStore((s) => s.worlds[projectPath]?.desired.instances[worldId])
  const projectStopped = useWorldStore((s) => s.worlds[projectPath]?.desired.stopped === true)
  const muted = desired?.muted ?? (isClone ? true : savedMuted)
  const volume = desired?.volume ?? savedVolume

  useEffect(() => {
    getUnityHost(sessionId)
    return () => releaseUnityHost(sessionId)
  }, [sessionId])

  useEffect(() => {
    const host = getUnityHost(sessionId)
    let lastSent = ''
    let debounce: number | null = null
    let intersecting = false

    const viewSize = (): PixelSize => {
      const rect = host.getBoundingClientRect()
      return paneRenderSize(rect.width, rect.height, window.devicePixelRatio || 1)
    }
    const onScreen = (): boolean => {
      if (!workspaceVisibleRef.current) return false
      const rect = host.getBoundingClientRect()
      if (rect.width <= 0 || rect.height <= 0) return false
      const vw = window.innerWidth || document.documentElement.clientWidth
      const vh = window.innerHeight || document.documentElement.clientHeight
      return rect.right > 0 && rect.bottom > 0 && rect.left < vw && rect.top < vh
    }
    const send = (fromDom = false): void => {
      const visible =
        (fromDom ? onScreen() : intersecting) &&
        workspaceVisibleRef.current &&
        document.visibilityState === 'visible'
      if (fromDom) intersecting = visible
      const { width, height } = visible ? viewSize() : { width: 0, height: 0 }
      const key = `${visible}|${width}x${height}`
      if (key === lastSent) return
      lastSent = key
      window.api.unity.viewHint(sessionId, { visible, width, height })
    }
    const sendDebounced = (): void => {
      if (debounce != null) window.clearTimeout(debounce)
      debounce = window.setTimeout(() => send(), 300)
    }

    const io = new IntersectionObserver((entries) => {
      intersecting = entries[entries.length - 1]?.isIntersecting ?? false
      send()
    })
    io.observe(host)
    const ro = new ResizeObserver(sendDebounced)
    ro.observe(host)
    const onVisibility = (): void => send()
    document.addEventListener('visibilitychange', onVisibility)
    resendHintRef.current = () => {
      lastSent = ''
      send(true)
    }
    const resend = (): void => resendHintRef.current()
    registerHintResend(sessionId, resend)
    const stopDpr = watchDevicePixelRatio(resend)
    send()

    return () => {
      resendHintRef.current = () => {}
      stopDpr()
      unregisterHintResend(sessionId, resend)
      if (debounce != null) window.clearTimeout(debounce)
      io.disconnect()
      ro.disconnect()
      document.removeEventListener('visibilitychange', onVisibility)
      window.api.unity.viewHint(sessionId, { visible: false, width: 0, height: 0 })
    }
  }, [sessionId])

  useEffect(() => {
    if (workspaceVisibleRef.current === workspaceVisible) return
    workspaceVisibleRef.current = workspaceVisible
    resendHintRef.current()
  }, [workspaceVisible])

  useEffect(() => {
    const host = getUnityHost(sessionId)
    const input = makeInputState()
    liveRef.current = false

    let stopped = false
    let retryTimer: number | null = null
    const tryStart = (): void => {
      if (stopped) return
      void window.api.unity.start({ id: sessionId, projectPath }).then((r) => {
        if (stopped) return
        if (r.ok) {
          setSessionStatus(sessionId, { standalone: false, error: null, hub: null, inputGate: null })
          resendHintRef.current()
          return
        }
        if (r.stopped) return
        if (r.inputGate) {
          setSessionStatus(sessionId, { inputGate: r.inputGate })
          console.log(`[unity] start refused: Input System only (activeInputHandler=${r.inputGate.handler}, package ${r.inputGate.packageMissing ? 'missing' : 'present'})`)
        } else if (r.hub) {
          setSessionStatus(sessionId, { hub: r.hub })
          if (isClone) retryTimer = window.setTimeout(tryStart, 1500)
        } else if (r.standalone) {
          setSessionStatus(sessionId, { standalone: true })
        } else if (isClone) {
          retryTimer = window.setTimeout(tryStart, 1500)
        } else {
          setSessionStatus(sessionId, { error: r.error ?? 'Unity failed to start' })
          console.log(`[unity] start failed: ${r.error}`)
        }
      })
    }
    setMetrics(sessionId, { fps: 0, ping: -1 })
    resetPerfHistory(sessionId)
    tryStart()

    let frames = 0
    const markLive = (): void => {
      markFramesLive(sessionId, projectPath, worldId)
      if (liveRef.current) return
      liveRef.current = true
      window.api.unity.markLive(sessionId)
    }
    const offInputGate = isClone
      ? () => {}
      : window.api.unity.onInputGate((e) => {
          if (e.projectPath !== projectPath) return
          setSessionStatus(sessionId, { inputGate: e.problem })
          console.log(`[unity] launch refused: Input System only (activeInputHandler=${e.problem.handler})`)
        })
    const offSharedFrame = window.api.unity.onSharedFrame((id, dt) => {
      if (id !== sessionId) return
      frames++
      recordFrame(sessionId, performance.now(), dt)
      markLive()
      if (getSessionStatus(sessionId).error) setSessionStatus(sessionId, { error: null })
      if (getSessionStatus(sessionId).inputGate) setSessionStatus(sessionId, { inputGate: null })
    })
    const offSharedError = window.api.unity.onSharedError((e) => {
      if (e.id !== sessionId) return
      setSessionStatus(sessionId, { error: e.message })
    })
    const fpsTimer = window.setInterval(() => {
      setMetrics(sessionId, { fps: frames })
      recordSample(sessionId, frames, getMetrics(sessionId).ping)
      frames = 0
    }, 1000)

    const stopSender = startInputLoop((p) => window.api.unity.sendInput(sessionId, JSON.stringify(p)), input, sessionId)
    const pendingPings = new Map<number, number>()
    let pingId = 0
    const offPong = window.api.unity.onPong((e) => {
      if (e.id !== sessionId) return
      const t = pendingPings.get(e.pingId)
      if (t != null) {
        pendingPings.delete(e.pingId)
        setMetrics(sessionId, { ping: Math.round(performance.now() - t) })
      }
    })
    const pingTimer = window.setInterval(() => {
      const now = performance.now()
      for (const [id, t] of pendingPings) {
        if (now - t > PING_STALE_MS) pendingPings.delete(id)
      }
      const pid = ++pingId
      pendingPings.set(pid, performance.now())
      window.api.unity.ping(sessionId, pid)
    }, 1000)

    let lastHostClickAt = 0
    let relockUntil = 0
    let relockTimer: number | null = null
    let escPulseTimer: number | null = null
    let lastMods = 0
    let composing = false
    let hostFocused = host.contains(document.activeElement)
    let allowHide = false
    let cursorCss = ''
    let lastCursor: UnityCursorEvent | null = null
    const text = getUnityTextInput(sessionId)
    const round = (v: number): number => Math.round(v * 100000) / 100000
    const modsOf = (e: KeyboardEvent | MouseEvent): number => {
      let m = 0
      if (e.shiftKey) m |= MOD_SHIFT
      if (e.ctrlKey) m |= MOD_CTRL
      if (e.altKey) m |= MOD_ALT
      if (e.metaKey) m |= MOD_META
      if (e.getModifierState?.('CapsLock')) m |= MOD_CAPS
      if (e.getModifierState?.('AltGraph')) m |= MOD_ALTGR
      if (e.getModifierState?.('NumLock')) m |= MOD_NUM
      return m
    }
    const pushText = (s: string, t: number): void => {
      if (s) input.push({ k: 'tx', t, s, m: lastMods })
    }
    const tryPointerLock = (): void => {
      try {
        const r = host.requestPointerLock() as unknown as { catch?: (f: () => void) => void }
        r?.catch?.(() => {})
      } catch {
      }
    }
    const stopRelock = (): void => {
      if (relockTimer != null) {
        window.clearInterval(relockTimer)
        relockTimer = null
      }
    }
    const pursuePointerLock = (): void => {
      relockUntil = performance.now() + 5000
      tryPointerLock()
      if (relockTimer != null) return
      relockTimer = window.setInterval(() => {
        if (
          !cursorWantedRef.current ||
          document.pointerLockElement === host ||
          !host.contains(document.activeElement) ||
          performance.now() > relockUntil
        ) {
          stopRelock()
          return
        }
        if (document.hasFocus()) tryPointerLock()
      }, 250)
    }
    const applyCursor = (): void => {
      const e = lastCursor
      let css = ''
      if (e && !e.locked) {
        if (!e.visible && allowHide && input.focus) css = 'none'
        else if (e.image) css = `url("${e.image.url}") ${e.image.x} ${e.image.y}, auto`
      }
      if (css === cursorCss) return
      cursorCss = css
      host.style.cursor = css
    }
    let nativeDeltas = false
    void window.api.unity.mouseDeltaAvailable().then((ok) => {
      nativeDeltas = ok
    })
    const offMouseDelta = window.api.unity.onMouseDelta((e) => {
      if (!input.locked || !nativeDeltas) return
      input.dx += e.dx
      input.dy += e.dy
      input.push({ k: 'mm', t: performance.now(), x: 0.5, y: 0.5, dx: e.dx, dy: e.dy, m: lastMods })
    })
    const offCursor = window.api.unity.onCursor((e) => {
      if (e.id !== sessionId) return
      cursorWantedRef.current = e.locked
      lastCursor = e
      applyCursor()
      if (
        e.locked &&
        document.hasFocus() &&
        performance.now() - lastHostClickAt < 3000 &&
        document.pointerLockElement !== host
      )
        pursuePointerLock()
      if (!e.locked && document.pointerLockElement === host) document.exitPointerLock()
    })

    const contentBox = (): { offX: number; offY: number; w: number; h: number; scale: number } | null => {
      const canvas = getUnityCanvas(sessionId)
      if (!canvas.width) return null
      const rect = canvas.getBoundingClientRect()
      const scale = Math.min(rect.width / canvas.width, rect.height / canvas.height)
      const w = canvas.width * scale
      const h = canvas.height * scale
      return { offX: rect.left + (rect.width - w) / 2, offY: rect.top + (rect.height - h) / 2, w, h, scale }
    }
    const place = (e: MouseEvent): { x: number; y: number } => {
      if (input.locked) return { x: 0.5, y: 0.5 }
      const cb = contentBox()
      if (cb && cb.w > 0 && cb.h > 0) {
        input.mx = round((e.clientX - cb.offX) / cb.w)
        input.my = round((e.clientY - cb.offY) / cb.h)
      }
      return { x: input.mx, y: input.my }
    }
    const inContent = (p: { x: number; y: number }): boolean => p.x >= 0 && p.x < 1 && p.y >= 0 && p.y < 1
    const printable = (e: KeyboardEvent): boolean =>
      [...e.key].length === 1 && !e.metaKey && !(e.ctrlKey && !e.altKey)
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return
      const key = codeToUnityKey(e.code)
      const textual = printable(e)
      if (!key && !textual) return
      if (!textual) e.preventDefault()
      lastMods = modsOf(e)
      if (key) {
        const r = e.repeat && input.keys.has(key) ? 1 : 0
        input.keys.add(key)
        if (key === 'Escape') {
          allowHide = false
          applyCursor()
        }
        input.push({ k: 'kd', t: e.timeStamp, c: key, r, m: lastMods })
      }
      if (textual && e.target !== text) {
        e.preventDefault()
        pushText(e.key, e.timeStamp)
      }
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      const key = codeToUnityKey(e.code)
      lastMods = modsOf(e)
      if (!key) return
      e.preventDefault()
      if (input.keys.delete(key)) input.push({ k: 'ku', t: e.timeStamp, c: key, m: lastMods })
      if (IS_MAC && (key === 'LeftCommand' || key === 'RightCommand')) {
        for (const k of [...input.keys]) {
          if (MODIFIER_KEYS.has(k)) continue
          input.keys.delete(k)
          input.push({ k: 'ku', t: e.timeStamp, c: k, m: lastMods })
        }
      }
    }
    const onCompositionStart = (): void => {
      composing = true
    }
    const onCompositionEnd = (e: CompositionEvent): void => {
      composing = false
      pushText(e.data, e.timeStamp)
      text.value = ''
    }
    const onTextInput = (e: Event): void => {
      const ie = e as InputEvent
      if (ie.isComposing || composing) return
      if ((ie.inputType === 'insertText' || ie.inputType === 'insertReplacementText') && ie.data)
        pushText(ie.data, ie.timeStamp)
      text.value = ''
    }
    const onMouseMove = (e: MouseEvent): void => {
      lastMods = modsOf(e)
      if (input.locked) {
        if (nativeDeltas) return
        input.dx += e.movementX
        input.dy += e.movementY
        input.push({ k: 'mm', t: e.timeStamp, x: 0.5, y: 0.5, dx: e.movementX, dy: e.movementY, m: lastMods })
        return
      }
      const p = place(e)
      input.dx += e.movementX
      input.dy += e.movementY
      input.push({ k: 'mm', t: e.timeStamp, x: p.x, y: p.y, dx: e.movementX, dy: e.movementY, m: lastMods })
    }
    const buttonBit = (button: number): number => {
      switch (button) {
        case 0:
          return 1
        case 2:
          return 2
        case 1:
          return 4
        case 3:
          return 8
        case 4:
          return 16
        default:
          return 0
      }
    }
    const bitIndex = (bit: number): number => Math.log2(bit)
    const onPointerDown = (e: PointerEvent): void => {
      if (e.pointerType !== 'mouse' || document.pointerLockElement === host) return
      try {
        host.setPointerCapture(e.pointerId)
      } catch {
      }
    }
    const onMouseDown = (e: MouseEvent): void => {
      host.focus()
      lastHostClickAt = performance.now()
      if (cursorWantedRef.current && document.pointerLockElement !== host) pursuePointerLock()
      const bit = buttonBit(e.button)
      if (!bit) return
      lastMods = modsOf(e)
      const p = place(e)
      if (inContent(p) && lifecycleRef.current === 'playing') {
        allowHide = true
        applyCursor()
      }
      input.btn |= bit
      input.push({ k: 'md', t: e.timeStamp, b: bitIndex(bit), x: p.x, y: p.y, n: Math.max(1, e.detail), m: lastMods })
    }
    const onMouseUp = (e: MouseEvent): void => {
      const bit = buttonBit(e.button)
      if (!bit) return
      lastMods = modsOf(e)
      const p = place(e)
      input.btn &= ~bit
      input.push({ k: 'mu', t: e.timeStamp, b: bitIndex(bit), x: p.x, y: p.y, n: Math.max(1, e.detail), m: lastMods })
    }
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault()
      lastMods = modsOf(e)
      const norm = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? host.clientHeight : 1
      const dx = e.deltaX * norm
      const dy = e.deltaY * norm
      input.sx += dx / 120
      input.sy -= dy / 120
      const legacy = e as WheelEvent & { wheelDeltaX?: number; wheelDeltaY?: number }
      const p = place(e)
      input.push({
        k: 'wh',
        t: e.timeStamp,
        x: p.x,
        y: p.y,
        dx: round(dx),
        dy: round(dy),
        wx: legacy.wheelDeltaX ?? -dx * 1.2,
        wy: legacy.wheelDeltaY ?? -dy * 1.2,
        m: lastMods
      })
    }
    const onContextMenu = (e: Event): void => e.preventDefault()
    const onPointerLockChange = (): void => {
      const locked = document.pointerLockElement === host
      const hadLock = input.locked
      input.locked = locked
      if (locked !== hadLock) window.api.unity.setPointerLocked(sessionId, locked)
      input.wake()
      if (locked) {
        stopRelock()
        return
      }
      if (hadLock && cursorWantedRef.current && !input.keys.has('Escape')) {
        const t = performance.now()
        input.keys.add('Escape')
        input.push({ k: 'kd', t, c: 'Escape', r: 0, m: lastMods })
        allowHide = false
        applyCursor()
        if (escPulseTimer != null) window.clearTimeout(escPulseTimer)
        escPulseTimer = window.setTimeout(() => {
          escPulseTimer = null
          if (input.keys.delete('Escape')) input.push({ k: 'ku', t: performance.now(), c: 'Escape', m: lastMods })
        }, 90)
      }
    }
    const releaseAll = (): void => {
      const t = performance.now()
      for (const k of input.keys) input.push({ k: 'ku', t, c: k, m: 0 })
      for (let bit = 1; bit <= 16; bit <<= 1) {
        if (input.btn & bit) input.push({ k: 'mu', t, b: bitIndex(bit), x: input.mx, y: input.my, n: 1, m: 0 })
      }
      input.keys.clear()
      input.btn = 0
      input.dx = 0
      input.dy = 0
      input.sx = 0
      input.sy = 0
      lastMods = 0
      if (input.locked) window.api.unity.setPointerLocked(sessionId, false)
      input.locked = false
      input.wake()
    }
    const syncFocus = (): void => {
      const v = hostFocused && document.hasFocus()
      if (v === input.focus) return
      if (!v) {
        releaseAll()
        allowHide = false
      }
      input.focus = v
      input.push({ k: 'fo', t: performance.now(), v: v ? 1 : 0 })
      applyCursor()
    }
    const onFocusIn = (): void => {
      hostFocused = true
      syncFocus()
    }
    const onFocusOut = (e: FocusEvent): void => {
      if (e.relatedTarget instanceof Node && host.contains(e.relatedTarget)) return
      hostFocused = false
      composing = false
      stopRelock()
      if (document.pointerLockElement === host) document.exitPointerLock()
      syncFocus()
    }
    const onWindowBlur = (): void => {
      releaseAll()
      syncFocus()
    }
    const onWindowFocus = (): void => {
      if (activeRef.current) host.focus()
      syncFocus()
    }
    host.addEventListener('keydown', onKeyDown)
    host.addEventListener('keyup', onKeyUp)
    host.addEventListener('mousemove', onMouseMove)
    host.addEventListener('pointerdown', onPointerDown)
    host.addEventListener('mousedown', onMouseDown)
    host.addEventListener('mouseup', onMouseUp)
    host.addEventListener('wheel', onWheel, { passive: false })
    host.addEventListener('contextmenu', onContextMenu)
    host.addEventListener('focusin', onFocusIn)
    host.addEventListener('focusout', onFocusOut)
    text.addEventListener('compositionstart', onCompositionStart)
    text.addEventListener('compositionend', onCompositionEnd)
    text.addEventListener('input', onTextInput)
    window.addEventListener('blur', onWindowBlur)
    window.addEventListener('focus', onWindowFocus)
    document.addEventListener('pointerlockchange', onPointerLockChange)
    syncFocus()

    return () => {
      stopped = true
      stopRelock()
      if (escPulseTimer != null) window.clearTimeout(escPulseTimer)
      if (retryTimer) window.clearTimeout(retryTimer)
      offSharedFrame()
      offInputGate()
      offSharedError()
      offPong()
      offCursor()
      offMouseDelta()
      cursorWantedRef.current = false
      host.style.cursor = ''
      if (document.pointerLockElement === host) document.exitPointerLock()
      if (input.locked) window.api.unity.setPointerLocked(sessionId, false)
      window.api.unity.dropShared(sessionId)
      stopSender()
      window.clearInterval(fpsTimer)
      window.clearInterval(pingTimer)
      host.removeEventListener('keydown', onKeyDown)
      host.removeEventListener('keyup', onKeyUp)
      host.removeEventListener('mousemove', onMouseMove)
      host.removeEventListener('pointerdown', onPointerDown)
      host.removeEventListener('mousedown', onMouseDown)
      host.removeEventListener('mouseup', onMouseUp)
      host.removeEventListener('wheel', onWheel)
      host.removeEventListener('contextmenu', onContextMenu)
      host.removeEventListener('focusin', onFocusIn)
      host.removeEventListener('focusout', onFocusOut)
      text.removeEventListener('compositionstart', onCompositionStart)
      text.removeEventListener('compositionend', onCompositionEnd)
      text.removeEventListener('input', onTextInput)
      window.removeEventListener('blur', onWindowBlur)
      window.removeEventListener('focus', onWindowFocus)
      document.removeEventListener('pointerlockchange', onPointerLockChange)
      clearSessionStatus(sessionId)
      clearMetrics(sessionId)
      clearFramesLive(sessionId, projectPath, worldId)
    }
  }, [sessionId, worldId, projectPath, retry, isClone, projectStopped])

  useEffect(() => {
    if (lifecycle !== 'editmode') return
    window.api.unity.dropShared(sessionId)
    cursorWantedRef.current = false
    if (document.pointerLockElement === getUnityHost(sessionId)) document.exitPointerLock()
  }, [lifecycle, sessionId])

  useEffect(() => {
    if (lifecycle == null || lifecycle === 'init' || lifecycle === 'launching') return
    const v = muted ? 0 : volume
    window.api.unity.sendInput(sessionId, JSON.stringify({ mute: muted ? 1 : 0 }))
    window.api.unity.sendInput(sessionId, JSON.stringify({ volume: Math.round(v * 100) }))
  }, [volume, muted, lifecycle, sessionId])

  useEffect(() => {
    activeRef.current = active
    if (active) getUnityHost(sessionId).focus()
  }, [active, sessionId])

  return null
}
