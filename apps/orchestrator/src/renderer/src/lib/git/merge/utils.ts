import { ArrayQueue, CompareResult } from './core/arrays'

export function* leftJoin<TLeft, TRight>(
  left: Iterable<TLeft>,
  right: readonly TRight[],
  compare: (left: TLeft, right: TRight) => CompareResult,
): IterableIterator<{ left: TLeft; rights: TRight[] }> {
  const rightQueue = new ArrayQueue(right)
  for (const leftElement of left) {
    rightQueue.takeWhile((rightElement) => CompareResult.isGreaterThan(compare(leftElement, rightElement)))
    const equals = rightQueue.takeWhile((rightElement) => CompareResult.isNeitherLessOrGreaterThan(compare(leftElement, rightElement)))
    yield { left: leftElement, rights: equals || [] }
  }
}

export function* join<TLeft, TRight>(
  left: Iterable<TLeft>,
  right: readonly TRight[],
  compare: (left: TLeft, right: TRight) => CompareResult,
): IterableIterator<{ left?: TLeft; rights: TRight[] }> {
  const rightQueue = new ArrayQueue(right)
  for (const leftElement of left) {
    const skipped = rightQueue.takeWhile((rightElement) => CompareResult.isGreaterThan(compare(leftElement, rightElement)))
    if (skipped) {
      yield { rights: skipped }
    }
    const equals = rightQueue.takeWhile((rightElement) => CompareResult.isNeitherLessOrGreaterThan(compare(leftElement, rightElement)))
    yield { left: leftElement, rights: equals || [] }
  }
}

export function elementAtOrUndefined<T>(arr: T[], index: number): T | undefined {
  return arr[index]
}

export function setFields<T extends {}>(obj: T, fields: Partial<T>): T {
  return Object.assign(obj, fields)
}

export function deepMerge<T extends {}>(source1: T, source2: Partial<T>): T {
  const result = {} as any as T
  for (const key in source1) {
    result[key] = source1[key]
  }
  for (const key in source2) {
    const source2Value = source2[key]
    if (typeof result[key] === 'object' && source2Value && typeof source2Value === 'object') {
      result[key] = deepMerge<any>(result[key], source2Value)
    } else {
      result[key] = source2Value as any
    }
  }
  return result
}
