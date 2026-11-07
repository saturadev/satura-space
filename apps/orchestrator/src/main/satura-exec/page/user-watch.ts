import type { WorkspaceScope } from './scope'

type Win = Window & typeof globalThis

export interface UserEvent {
  kind: 'mouse' | 'key'
  type: string
  x?: number
  y?: number
  key?: string
  t: number
}

export interface ScriptEcho {
  kind: 'mouse' | 'key'
  x?: number
  y?: number
  key?: string
  t: number
}

const ECHO_MS = 1000
const MOVE_EVERY_MS = 40
const TYPES: Record<string, string> = { mousemove: 'mouseMove', mousedown: 'mouseDown', wheel: 'mouseWheel', keydown: 'keyDown' }

const same = (a: number | undefined, b: number | undefined): boolean => Math.abs((a ?? NaN) - (b ?? NaN)) <= 1

function isEcho(e: { kind: 'mouse' | 'key'; x?: number; y?: number; key?: string; t: number }, echoes: ScriptEcho[], pointer: { x: number; y: number } | null): boolean {
  if (e.kind === 'mouse') {
    if (pointer && same(pointer.x, e.x) && same(pointer.y, e.y)) return true
    return echoes.some((s) => s.kind === 'mouse' && e.t - s.t <= ECHO_MS && same(s.x, e.x) && same(s.y, e.y))
  }
  return echoes.some((s) => s.kind === 'key' && e.t - s.t <= ECHO_MS && s.key === e.key)
}

export class UserWatch {
  private _echoes: ScriptEcho[] = []
  private _pointer: { x: number; y: number } | null = null
  private _lastMove: { x: number; y: number } | null = null
  private _seen: UserEvent | null = null
  private _movedAt = 0

  constructor(
    win: Win,
    private readonly _scope: () => WorkspaceScope
  ) {
    for (const type of Object.keys(TYPES)) win.addEventListener(type, this._on, { capture: true, passive: true })
  }

  reset(): void {
    this._seen = null
  }

  script(method: string, p: Record<string, any>): void {
    const t = Date.now()
    this._echoes = this._echoes.filter((e) => t - e.t <= ECHO_MS)
    if (method === 'Input.dispatchMouseEvent') {
      this._pointer = { x: Number(p.x), y: Number(p.y) }
      this._echoes.push({ kind: 'mouse', x: Number(p.x), y: Number(p.y), t })
    } else if (method === 'Input.dispatchKeyEvent' && p.key) {
      this._echoes.push({ kind: 'key', key: String(p.key), t })
    }
  }

  take(): UserEvent | null {
    const seen = this._seen
    this._seen = null
    return seen
  }

  private readonly _on = (ev: Event): void => {
    if (!ev.isTrusted) return
    const scope = this._scope()
    if (!scope.id || !scope.active()) return
    const t = Date.now()
    const type = TYPES[ev.type] ?? ev.type
    if (ev.type === 'keydown') {
      const key = (ev as KeyboardEvent).key
      if (!isEcho({ kind: 'key', key, t }, this._echoes, null)) this._seen = { kind: 'key', type, key, t }
      return
    }
    const m = ev as MouseEvent
    const at = { x: m.clientX, y: m.clientY }
    if (ev.type === 'mousemove') {
      const still = !!this._lastMove && this._lastMove.x === at.x && this._lastMove.y === at.y
      this._lastMove = at
      if (still || t - this._movedAt < MOVE_EVERY_MS) return
    }
    if (isEcho({ kind: 'mouse', ...at, t }, this._echoes, this._pointer)) return
    const r = scope.info().rect
    if (r && (at.x < r.x || at.x > r.x + r.width || at.y < r.y || at.y > r.y + r.height)) return
    if (ev.type === 'mousemove') this._movedAt = t
    this._seen = { kind: 'mouse', type, x: at.x, y: at.y, t }
  }
}
