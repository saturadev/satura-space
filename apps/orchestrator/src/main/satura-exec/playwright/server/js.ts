import { getExceptionMessage, releaseObject } from './crProtocolHelper'

import type { CRSession, Protocol } from './cdp'
import type { Frame } from './frames'
import type { InjectedScript } from './injectedTypes'

type Unboxed<Arg> = Arg extends JSHandle<infer T>
  ? T
  : Arg extends [infer A0, infer A1, infer A2]
    ? [Unboxed<A0>, Unboxed<A1>, Unboxed<A2>]
    : Arg extends [infer A0, infer A1]
      ? [Unboxed<A0>, Unboxed<A1>]
      : Arg extends object
        ? { [Key in keyof Arg]: Unboxed<Arg[Key]> }
        : Arg

export type Func1<Arg, R> = string | ((arg: Unboxed<Arg>) => R | Promise<R>)

export class JavaScriptErrorInEvaluate extends Error {}

export function isJavaScriptErrorInEvaluate(error: unknown): boolean {
  return error instanceof JavaScriptErrorInEvaluate
}

const STALE_CONTEXT = [
  'Cannot find context with specified id',
  'Execution context was destroyed',
  'Could not find object with given id',
  'Cannot find default execution context',
  'Inspected target navigated or closed'
]

export function isStaleContextError(error: unknown): boolean {
  const message = (error as Error)?.message ?? ''
  return STALE_CONTEXT.some((m) => message.includes(m))
}

type CallArgument = { value?: unknown; objectId?: string; unserializableValue?: string }

function packArgs(args: unknown[]): { json: string; handles: string[] } {
  const handles: string[] = []
  const pack = (v: unknown): unknown => {
    if (v instanceof JSHandle) {
      if (!v._objectId) return { __v: v.rawValue() ?? null }
      handles.push(v._objectId)
      return { __h: handles.length - 1 }
    }
    if (v === undefined) return { __u: 1 }
    if (Array.isArray(v)) return v.map(pack)
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {}
      for (const [k, x] of Object.entries(v)) out[k] = pack(x)
      return { __o: out }
    }
    return v
  }
  return { json: JSON.stringify(args.map(pack)), handles }
}

const REVIVE = `function __revive(v, hs) {
  if (Array.isArray(v)) return v.map(x => __revive(x, hs));
  if (v && typeof v === 'object') {
    if ('__h' in v) return hs[v.__h];
    if ('__u' in v) return undefined;
    if ('__v' in v) return v.__v;
    const o = {};
    for (const k of Object.keys(v.__o)) o[k] = __revive(v.__o[k], hs);
    return o;
  }
  return v;
}`

function functionSource(fn: Func1<any, any> | ((...args: any[]) => any)): string {
  return typeof fn === 'string' ? fn : fn.toString()
}

export class ExecutionContext {
  private _injected: JSHandle<InjectedScript> | null = null

  constructor(
    readonly session: CRSession,
    readonly contextId: number,
    readonly frame: Frame,
    private _injectedSource: string | null
  ) {}

  async injectedScript(): Promise<JSHandle<InjectedScript>> {
    if (this._injected) return this._injected
    if (this._injectedSource === null) throw new Error('This world has no injected script')
    const expression = `globalThis.__saturaInstance || (globalThis.__saturaInstance = (() => {\n${this._injectedSource}\n;return globalThis.__saturaCreate(globalThis);\n})())`
    const res = await this.session.send('Runtime.evaluate', {
      expression,
      contextId: this.contextId,
      returnByValue: false
    })
    if (res.exceptionDetails) throw new Error(getExceptionMessage(res.exceptionDetails))
    this._injected = new JSHandle(this, res.result.objectId)
    return this._injected
  }

  async evaluateExpression(expression: string): Promise<unknown> {
    const res = await this.session.send('Runtime.evaluate', {
      expression,
      contextId: this.contextId,
      returnByValue: true,
      awaitPromise: true
    })
    if (res.exceptionDetails) throw new JavaScriptErrorInEvaluate(getExceptionMessage(res.exceptionDetails))
    return res.result?.value
  }

  async evaluate<Arg, R>(fn: Func1<Arg, R>, arg?: Arg): Promise<R> {
    const remote = await this._call(fn, [arg], true)
    return remote.value as R
  }

  async evaluateHandle<Arg, R>(fn: Func1<Arg, R>, arg?: Arg): Promise<JSHandle<R>> {
    return this._wrap(await this._call(fn, [arg], false))
  }

  async _call(
    fn: Func1<any, any> | ((...args: any[]) => any),
    args: unknown[],
    returnByValue: boolean
  ): Promise<Protocol.Runtime.RemoteObject> {
    const { json, handles } = packArgs(args)
    const functionDeclaration = `async function(__json, ...__hs) {
  ${REVIVE}
  const __args = JSON.parse(__json).map(x => __revive(x, __hs));
  return await (${functionSource(fn)})(...__args);
}`
    const callArgs: CallArgument[] = [{ value: json }, ...handles.map((objectId) => ({ objectId }))]
    const res = await this.session.send('Runtime.callFunctionOn', {
      functionDeclaration,
      executionContextId: this.contextId,
      arguments: callArgs,
      returnByValue,
      awaitPromise: true,
      userGesture: true
    })
    if (res.exceptionDetails) throw new JavaScriptErrorInEvaluate(getExceptionMessage(res.exceptionDetails))
    return res.result as Protocol.Runtime.RemoteObject
  }

  _wrap<R>(remote: Protocol.Runtime.RemoteObject): JSHandle<R> {
    if (remote.subtype === 'node' && remote.objectId) return this.frame._createElementHandle(this, remote.objectId) as any
    return new JSHandle<R>(this, remote.objectId, remote.value)
  }
}

export class JSHandle<T = any> {
  readonly _context: ExecutionContext
  readonly _objectId: string | undefined
  private _value: unknown
  _disposed = false

  constructor(context: ExecutionContext, objectId: string | undefined, value?: unknown) {
    this._context = context
    this._objectId = objectId
    this._value = value
  }

  rawValue(): unknown {
    return this._value
  }

  async evaluate<R, Arg = undefined>(fn: (handle: T, arg: Arg) => R | Promise<R>, arg?: Arg): Promise<R> {
    const remote = await this._context._call(fn, [this, arg], true)
    return remote.value as R
  }

  async evaluateHandle<R, Arg = undefined>(fn: (handle: T, arg: Arg) => R | Promise<R>, arg?: Arg): Promise<JSHandle<R>> {
    return this._context._wrap(await this._context._call(fn, [this, arg], false))
  }

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    if (this._objectId) void releaseObject(this._context.session, this._objectId)
  }
}
