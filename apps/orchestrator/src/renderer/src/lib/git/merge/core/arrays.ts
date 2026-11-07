export function equals<T>(one: ReadonlyArray<T> | undefined, other: ReadonlyArray<T> | undefined, itemEquals: (a: T, b: T) => boolean = (a, b) => a === b): boolean {
  if (one === other) {
    return true
  }

  if (!one || !other) {
    return false
  }

  if (one.length !== other.length) {
    return false
  }

  for (let i = 0, len = one.length; i < len; i++) {
    if (!itemEquals(one[i], other[i])) {
      return false
    }
  }

  return true
}

export function concatArrays<T extends any[]>(...arrays: T): T[number][number][] {
  return ([] as T[number][number][]).concat(...arrays)
}

export type CompareResult = number

export namespace CompareResult {
  export function isLessThan(result: CompareResult): boolean {
    return result < 0
  }

  export function isLessThanOrEqual(result: CompareResult): boolean {
    return result <= 0
  }

  export function isGreaterThan(result: CompareResult): boolean {
    return result > 0
  }

  export function isNeitherLessOrGreaterThan(result: CompareResult): boolean {
    return result === 0
  }

  export const greaterThan = 1
  export const lessThan = -1
  export const neitherLessOrGreaterThan = 0
}

export type Comparator<T> = (a: T, b: T) => CompareResult

export function compareBy<TItem, TCompareBy>(selector: (item: TItem) => TCompareBy, comparator: Comparator<TCompareBy>): Comparator<TItem> {
  return (a, b) => comparator(selector(a), selector(b))
}

export function tieBreakComparators<TItem>(...comparators: Comparator<TItem>[]): Comparator<TItem> {
  return (item1, item2) => {
    for (const comparator of comparators) {
      const result = comparator(item1, item2)
      if (!CompareResult.isNeitherLessOrGreaterThan(result)) {
        return result
      }
    }
    return CompareResult.neitherLessOrGreaterThan
  }
}

export const numberComparator: Comparator<number> = (a, b) => a - b

export class ArrayQueue<T> {
  private readonly items: readonly T[]
  private firstIdx = 0
  private lastIdx: number

  constructor(items: readonly T[]) {
    this.items = items
    this.lastIdx = this.items.length - 1
  }

  get length(): number {
    return this.lastIdx - this.firstIdx + 1
  }

  takeWhile(predicate: (value: T) => boolean): T[] | null {
    let startIdx = this.firstIdx
    while (startIdx < this.items.length && predicate(this.items[startIdx])) {
      startIdx++
    }
    const result = startIdx === this.firstIdx ? null : this.items.slice(this.firstIdx, startIdx)
    this.firstIdx = startIdx
    return result
  }
}

export function findLast<T>(array: readonly T[], predicate: (item: T, index: number) => unknown, fromIndex = array.length - 1): T | undefined {
  const idx = findLastIdx(array, predicate, fromIndex)
  if (idx === -1) {
    return undefined
  }
  return array[idx]
}

export function findLastIdx<T>(array: readonly T[], predicate: (item: T, index: number) => unknown, fromIndex = array.length - 1): number {
  for (let i = fromIndex; i >= 0; i--) {
    const element = array[i]

    if (predicate(element, i)) {
      return i
    }
  }

  return -1
}
