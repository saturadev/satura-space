import { useEffect } from 'react'
import { useAppStore } from '../../store'
import { chordKey } from './chord-key'
import { IS_MAC, focusedPaneKind, focusedPanePtyId, focusedTabId, focusedTerminalRunsAgent } from './shortcuts'
import { isUnityPlaying, requestConsoleFind, requestUnityPlayToggle, requestViewerFind } from './pane-actions'
import { useFilePickerStore } from '../file-picker/file-picker-store'

const isIncrease = (e: KeyboardEvent): boolean =>
  e.key === '=' || e.key === '+' || e.code === 'Equal' || e.code === 'NumpadAdd'
const isDecrease = (e: KeyboardEvent): boolean =>
  e.key === '-' || e.key === '_' || e.code === 'Minus' || e.code === 'NumpadSubtract'
const isReset = (e: KeyboardEvent): boolean =>
  e.key === '0' || e.code === 'Digit0' || e.code === 'Numpad0'

const DOUBLE_SHIFT_MS = 400

export function useGlobalHotkeys(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return

    let lastShiftUpAt = 0
    let shiftArmed = false

    const openQuickOpen = (): void => useAppStore.getState().openQuickOpen()

    const onKey = (e: KeyboardEvent): void => {
      if (e.repeat) return
      if (useFilePickerStore.getState().request) {
        shiftArmed = false
        return
      }

      if (e.key === 'Shift' && !e.ctrlKey && !e.metaKey && !e.altKey) {
        shiftArmed = true
        return
      }
      shiftArmed = false

      const mod = IS_MAC ? e.metaKey : e.ctrlKey
      if (!mod || e.altKey) return

      const s = useAppStore.getState()
      const pane = focusedPaneKind(s)
      const key = chordKey(e)

      const playerPane = pane === 'unity-instance-player' || pane === 'unity-scratchpad'
      const playerPtyId = playerPane ? focusedPanePtyId(s) : null
      const gameOwnsKeys = !!playerPtyId && isUnityPlaying(playerPtyId)

      if (!gameOwnsKeys && e.shiftKey && key === 'f') {
        return handle(e, openFindInFiles)
      }

      if (playerPane) {
        if (key === 'p' && playerPtyId && requestUnityPlayToggle(playerPtyId, e.shiftKey)) {
          return handle(e, () => {})
        }
        return
      }

      const inReport = e.target instanceof Element && !!e.target.closest('[data-viewer-report], [data-dashboard-panel]')
      if (inReport && !e.shiftKey) {
        if (isIncrease(e)) return handle(e, () => s.adjustReportZoom(+1))
        if (isDecrease(e)) return handle(e, () => s.adjustReportZoom(-1))
        if (isReset(e)) return handle(e, () => s.adjustReportZoom('reset'))
      }

      if ((pane === 'file-viewer' || pane === 'dashboard') && key === 'f' && !e.shiftKey) {
        const tabId = focusedTabId(s)
        if (tabId && requestViewerFind(tabId)) return handle(e, () => {})
      }

      const fontTarget =
        pane === 'terminal' ? 'terminal' : pane === 'file-viewer' ? 'editor' : null
      if (fontTarget && !e.shiftKey) {
        if (isIncrease(e)) return handle(e, () => s.adjustFontSize(fontTarget, +1))
        if (isDecrease(e)) return handle(e, () => s.adjustFontSize(fontTarget, -1))
        if (isReset(e)) return handle(e, () => s.adjustFontSize(fontTarget, 'reset'))
      }

      if (focusedTerminalRunsAgent(s)) return

      if (key === 'b' && !e.shiftKey && !(e.target instanceof Element && e.target.closest('.monaco-editor'))) {
        return handle(e, () => s.toggleSidebar())
      }

      if (pane === 'unity-console' && key === 'f' && !e.shiftKey) {
        const ptyId = focusedPanePtyId(s)
        if (ptyId && requestConsoleFind(ptyId)) return handle(e, () => {})
      }
    }

    const onKeyUp = (e: KeyboardEvent): void => {
      if (useFilePickerStore.getState().request) {
        shiftArmed = false
        return
      }
      if (e.key !== 'Shift' || !shiftArmed) {
        shiftArmed = false
        return
      }
      shiftArmed = false
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const s = useAppStore.getState()
      const shiftPane = focusedPaneKind(s)
      if (shiftPane === 'unity-instance-player' || shiftPane === 'unity-scratchpad') {
        const ptyId = focusedPanePtyId(s)
        if (ptyId && isUnityPlaying(ptyId)) {
          lastShiftUpAt = 0
          return
        }
      }
      const now = Date.now()
      if (now - lastShiftUpAt <= DOUBLE_SHIFT_MS) {
        lastShiftUpAt = 0
        openQuickOpen()
      } else {
        lastShiftUpAt = now
      }
    }

    const onPointer = (): void => {
      shiftArmed = false
      lastShiftUpAt = 0
    }

    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKeyUp, true)
    window.addEventListener('pointerdown', onPointer, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      window.removeEventListener('keyup', onKeyUp, true)
      window.removeEventListener('pointerdown', onPointer, true)
    }
  }, [enabled])
}

function handle(e: KeyboardEvent, run: () => void): void {
  e.preventDefault()
  e.stopImmediatePropagation()
  run()
}

function openFindInFiles(): void {
  const s = useAppStore.getState()
  const wsId = s.activeWorkspaceId
  if (!wsId) return
  const worktree = (s.worktreesByWorkspace[wsId] ?? [])[0]
  if (!worktree) return
  s.setSidebarOpen(true)
  s.requestExplorerSearch(worktree.id)
}
