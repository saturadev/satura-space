export namespace Protocol {
  export namespace Runtime {
    export interface RemoteObject {
      type: string
      subtype?: string
      className?: string
      value?: any
      unserializableValue?: string
      description?: string
      objectId?: string
    }
    export interface CallFrame {
      functionName: string
      url: string
      lineNumber: number
      columnNumber: number
    }
    export interface StackTrace {
      callFrames: CallFrame[]
    }
    export interface ExceptionDetails {
      text: string
      lineNumber: number
      columnNumber: number
      exception?: RemoteObject
      stackTrace?: StackTrace
    }
  }
  export namespace Input {
    export interface DragDataItem {
      mimeType: string
      data: string
      title?: string
      baseURL?: string
    }
    export interface DragData {
      items: DragDataItem[]
      files?: string[]
      dragOperationsMask: number
    }
    export interface dragInterceptedPayload {
      data: DragData
    }
  }
}

export interface CRSession {
  send(method: string, params?: Record<string, unknown>): Promise<any>
  _sendMayFail(method: string, params?: Record<string, unknown>): Promise<any | undefined>
  on(event: string, listener: (params: any) => void): void
  off(event: string, listener: (params: any) => void): void
}

export interface CRFrameLike {
  nonStallingEvaluateInExistingContext(expression: string, world: 'utility'): Promise<any>
}

export interface CRPage {
  _mainFrameSession: { _client: CRSession }
  _page: {
    safeNonStallingEvaluateInAllFrames(expression: string, world: 'utility'): Promise<void>
    frames(): CRFrameLike[]
  }
}

export interface DebuggerLike {
  isAttached(): boolean
  attach(protocolVersion?: string): void
  detach(): void
  sendCommand(method: string, params?: any): Promise<any>
  on(event: 'message', listener: (event: unknown, method: string, params: any) => void): unknown
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown
  removeListener(event: string, listener: (...args: any[]) => void): unknown
}

export class DebuggerSession implements CRSession {
  private _listeners = new Map<string, Set<(params: any) => void>>()
  private _closed = false
  private _onMessage = (_event: unknown, method: string, params: any): void => {
    for (const listener of this._listeners.get(method) ?? []) listener(params)
  }
  private _onDetach = (): void => {
    this._closed = true
  }

  constructor(private _debugger: DebuggerLike) {
    if (!_debugger.isAttached()) _debugger.attach('1.3')
    _debugger.on('message', this._onMessage)
    _debugger.on('detach', this._onDetach)
  }

  get closed(): boolean {
    return this._closed || !this._debugger.isAttached()
  }

  async send(method: string, params?: Record<string, unknown>): Promise<any> {
    if (this.closed) throw new Error('Target page, context or browser has been closed')
    return this._debugger.sendCommand(method, params ?? {})
  }

  async _sendMayFail(method: string, params?: Record<string, unknown>): Promise<any | undefined> {
    return this.send(method, params).catch(() => undefined)
  }

  on(event: string, listener: (params: any) => void): void {
    let set = this._listeners.get(event)
    if (!set) this._listeners.set(event, (set = new Set()))
    set.add(listener)
  }

  off(event: string, listener: (params: any) => void): void {
    this._listeners.get(event)?.delete(listener)
  }

  dispose(): void {
    this._debugger.removeListener('message', this._onMessage)
    this._debugger.removeListener('detach', this._onDetach)
    this._listeners.clear()
    if (!this._closed && this._debugger.isAttached()) {
      try {
        this._debugger.detach()
      } catch {
      }
    }
    this._closed = true
  }
}
