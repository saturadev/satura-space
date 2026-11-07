import { BugIndicatingError, onUnexpectedError } from 'monaco-editor/esm/vs/base/common/errors.js'

export function assertFn(condition: () => boolean): void {
  if (!condition()) {
    condition()
    onUnexpectedError(new BugIndicatingError('Assertion Failed'))
  }
}

export function checkAdjacentItems<T>(items: readonly T[], predicate: (item1: T, item2: T) => boolean): boolean {
  let i = 0
  while (i < items.length - 1) {
    const a = items[i]
    const b = items[i + 1]
    if (!predicate(a, b)) {
      return false
    }
    i++
  }
  return true
}
