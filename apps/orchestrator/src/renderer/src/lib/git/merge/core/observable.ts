import type { IDisposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
import { toDisposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
import type { IObservable, IReader, ITransaction, DebugOwner } from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
import { derived } from 'monaco-editor/esm/vs/base/common/observableInternal/observables/derived.js'
import { observableSignal } from 'monaco-editor/esm/vs/base/common/observableInternal/observables/observableSignal.js'
import { KeepAliveObserver } from 'monaco-editor/esm/vs/base/common/observableInternal/utils/utils.js'

export type {
  IObservable,
  IObservableWithChange,
  IReader,
  IReaderWithStore,
  ISettableObservable,
  ITransaction
} from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
export { observableValue } from 'monaco-editor/esm/vs/base/common/observableInternal/observables/observableValue.js'
export { derived, derivedOpts } from 'monaco-editor/esm/vs/base/common/observableInternal/observables/derived.js'
export {
  autorun,
  autorunHandleChanges,
  autorunOpts,
  autorunWithStore
} from 'monaco-editor/esm/vs/base/common/observableInternal/reactions/autorun.js'
export { transaction } from 'monaco-editor/esm/vs/base/common/observableInternal/transaction.js'
export { observableSignal } from 'monaco-editor/esm/vs/base/common/observableInternal/observables/observableSignal.js'
export { observableSignalFromEvent } from 'monaco-editor/esm/vs/base/common/observableInternal/observables/observableSignalFromEvent.js'
export { observableFromEvent } from 'monaco-editor/esm/vs/base/common/observableInternal/observables/observableFromEvent.js'
export { constObservable } from 'monaco-editor/esm/vs/base/common/observableInternal/observables/constObservable.js'
export { waitForState } from 'monaco-editor/esm/vs/base/common/observableInternal/utils/utilsCancellation.js'

export function keepObserved<T>(observable: IObservable<T>): IDisposable {
  const o = new KeepAliveObserver(false, undefined)
  observable.addObserver(o)
  return toDisposable(() => {
    observable.removeObserver(o)
  })
}

export function derivedObservableWithWritableCache<T>(owner: DebugOwner, computeFn: (reader: IReader, lastValue: T | undefined) => T): IObservable<T>
  & { clearCache(transaction: ITransaction): void; setCache(newValue: T | undefined, tx: ITransaction | undefined): void } {
  let lastValue: T | undefined = undefined
  const onChange = observableSignal('derivedObservableWithWritableCache')
  const observable = derived(owner, (reader) => {
    onChange.read(reader)
    lastValue = computeFn(reader, lastValue)
    return lastValue
  })
  return Object.assign(observable, {
    clearCache: (tx: ITransaction) => {
      lastValue = undefined
      onChange.trigger(tx)
    },
    setCache: (newValue: T | undefined, tx: ITransaction | undefined) => {
      lastValue = newValue
      onChange.trigger(tx)
    }
  })
}
