import type { Terminal } from '@xterm/xterm'
import type { ThemeId } from '@shared/types'
import { terminalThemeFor } from './terminal-themes'
import { censusTrack } from '@shared/census'

const hosts = new Map<string, HTMLDivElement>()
censusTrack('terminal-registry.hosts', hosts)
const refitters = new Map<string, () => void>()
censusTrack('terminal-registry.refitters', refitters)
const terminals = new Map<string, Terminal>()
censusTrack('terminal-registry.terminals', terminals)

let parking: HTMLDivElement | null = null
function getParking(): HTMLDivElement {
  if (!parking) {
    parking = document.createElement('div')
    parking.style.cssText = 'position:absolute;left:-99999px;top:0;width:800px;height:600px;overflow:hidden;'
    document.body.appendChild(parking)
  }
  return parking
}

export function getTerminalHost(ptyId: string): HTMLDivElement {
  let el = hosts.get(ptyId)
  if (!el) {
    el = document.createElement('div')
    el.dataset.ptyId = ptyId
    el.style.width = '100%'
    el.style.height = '100%'
    hosts.set(ptyId, el)
    getParking().appendChild(el)
  }
  return el
}

export function registerRefit(ptyId: string, fn: () => void): () => void {
  refitters.set(ptyId, fn)
  return () => {
    if (refitters.get(ptyId) === fn) refitters.delete(ptyId)
  }
}

export function requestRefit(ptyId: string): void {
  refitters.get(ptyId)?.()
}

export function registerTerminalInstance(ptyId: string, term: Terminal): () => void {
  terminals.set(ptyId, term)
  return () => {
    if (terminals.get(ptyId) === term) terminals.delete(ptyId)
  }
}

export function getTerminalInstance(ptyId: string): Terminal | undefined {
  return terminals.get(ptyId)
}

export function paintTerminalInset(term: Terminal): void {
  if (term.element) term.element.style.backgroundColor = term.options.theme?.background ?? ''
}

export function retintTerminals(themeId: ThemeId): void {
  const theme = terminalThemeFor(themeId)
  for (const term of terminals.values()) {
    term.options.theme = theme
    paintTerminalInset(term)
  }
}

export function remeasureTerminals(): void {
  window.dispatchEvent(new Event('resize'))
  for (const term of terminals.values()) {
    const core = (term as unknown as { _core?: { _renderService?: { handleDevicePixelRatioChange?: () => void } } })._core
    core?._renderService?.handleDevicePixelRatioChange?.()
  }
  for (const fn of refitters.values()) fn()
}

export function findTerminalContainingElement(node: Node | null): Terminal | undefined {
  if (!node) return undefined
  for (const term of terminals.values()) {
    const el = term.element
    if (el && el.contains(node)) return term
  }
  return undefined
}

export function parkTerminalHost(ptyId: string): void {
  const el = hosts.get(ptyId)
  if (!el) return
  const park = getParking()
  if (el.parentElement !== park) park.appendChild(el)
}

export function releaseTerminalHost(ptyId: string): void {
  const el = hosts.get(ptyId)
  if (el?.parentElement) el.parentElement.removeChild(el)
  hosts.delete(ptyId)
  refitters.delete(ptyId)
  terminals.delete(ptyId)
}

interface Visibility {
  isIntersecting?: boolean
  intersectionRatio: number
}

interface PausableRenderService {
  _isPaused?: boolean
  _needsFullRefresh?: boolean
  _needsSelectionRefresh?: boolean
  _selectionState?: { start: unknown; end: unknown; columnSelectMode: boolean }
  handleSelectionChanged?: (start: unknown, end: unknown, columnSelectMode: boolean) => void
  _handleIntersectionChange?: (entry: Visibility) => void
  _pausedResizeTask?: { set(task: () => void): void; flush(): void }
}

const OFF_SCREEN: Visibility = { isIntersecting: false, intersectionRatio: 0 }
const ON_SCREEN: Visibility = { isIntersecting: true, intersectionRatio: 1 }

export function pauseRenderingWhileHidden(term: Terminal): (hidden: boolean) => void {
  const rs = (term as unknown as { _core?: { _renderService?: PausableRenderService } })._core?._renderService
  const selectionChanged = rs?.handleSelectionChanged
  const intersectionChange = rs?._handleIntersectionChange
  const resizeTask = rs?._pausedResizeTask
  if (!rs || !resizeTask || typeof selectionChanged !== 'function' || typeof intersectionChange !== 'function' || !rs._selectionState) return () => {}
  let hidden = false
  let seen: Visibility = ON_SCREEN
  rs.handleSelectionChanged = function (this: PausableRenderService, start, end, columnSelectMode) {
    if (!this._isPaused || !this._selectionState) return selectionChanged.call(this, start, end, columnSelectMode)
    this._selectionState.start = start
    this._selectionState.end = end
    this._selectionState.columnSelectMode = columnSelectMode
    this._needsSelectionRefresh = true
    this._needsFullRefresh = true
  }
  let pendingResize: (() => void) | null = null
  resizeTask.set = (task) => {
    pendingResize = task
  }
  resizeTask.flush = () => {
    const task = pendingResize
    pendingResize = null
    task?.()
  }
  rs._handleIntersectionChange = function (this: PausableRenderService, entry) {
    seen = entry
    intersectionChange.call(this, hidden ? OFF_SCREEN : entry)
  }
  return (next) => {
    if (next === hidden) return
    hidden = next
    intersectionChange.call(rs, hidden ? OFF_SCREEN : seen)
  }
}
