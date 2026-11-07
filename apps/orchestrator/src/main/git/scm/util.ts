import { normalize, sep } from 'node:path'

export const isMacintosh = process.platform === 'darwin'
export const isWindows = process.platform === 'win32'

function normalizePath(path: string): string {
  if (isWindows || isMacintosh) {
    path = path.toLowerCase()
  }

  if (/[/\\]$/.test(path)) {
    path = path.substring(0, path.length - 1)
  }

  return normalize(path)
}

export function isDescendant(parent: string, descendant: string): boolean {
  if (parent === descendant) {
    return true
  }

  parent = normalizePath(parent)
  descendant = normalizePath(descendant)

  if (parent.charAt(parent.length - 1) !== sep) {
    parent += sep
  }

  return descendant.startsWith(parent)
}

export function pathEquals(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b)
}

export function relativePathWithNoFallback(from: string, to: string): string | undefined {
  if (from.charAt(from.length - 1) !== sep) {
    from += sep
  }

  if (isDescendant(from, to) && from.length < to.length) {
    return to.substring(from.length)
  }

  return undefined
}

export function* splitInChunks(array: string[], maxChunkLength: number): IterableIterator<string[]> {
  let current: string[] = []
  let length = 0

  for (const value of array) {
    let newLength = length + value.length

    if (newLength > maxChunkLength && current.length > 0) {
      yield current
      current = []
      newLength = value.length
    }

    current.push(value)
    length = newLength
  }

  if (current.length > 0) {
    yield current
  }
}

export function* splitGroupsInChunks(groups: string[][], maxChunkItems: number, maxChunkLength: number): IterableIterator<string[]> {
  let current: string[] = []
  let length = 0

  for (const group of groups) {
    const groupLength = group.reduce((sum, value) => sum + value.length + 1, 0)

    if (current.length > 0 && (current.length + group.length > maxChunkItems || length + groupLength > maxChunkLength)) {
      yield current
      current = []
      length = 0
    }

    current.push(...group)
    length += groupLength
  }

  if (current.length > 0) {
    yield current
  }
}

export function timeout(millis: number): Promise<void> {
  return new Promise((c) => setTimeout(c, millis))
}

export namespace Versions {
  type VersionComparisonResult = -1 | 0 | 1

  export interface Version {
    major: number
    minor: number
    patch: number
    pre?: string
  }

  export function compare(v1: string | Version, v2: string | Version): VersionComparisonResult {
    if (typeof v1 === 'string') {
      v1 = fromString(v1)
    }
    if (typeof v2 === 'string') {
      v2 = fromString(v2)
    }

    if (v1.major > v2.major) { return 1 }
    if (v1.major < v2.major) { return -1 }

    if (v1.minor > v2.minor) { return 1 }
    if (v1.minor < v2.minor) { return -1 }

    if (v1.patch > v2.patch) { return 1 }
    if (v1.patch < v2.patch) { return -1 }

    if (v1.pre === undefined && v2.pre !== undefined) { return 1 }
    if (v1.pre !== undefined && v2.pre === undefined) { return -1 }

    if (v1.pre !== undefined && v2.pre !== undefined) {
      return v1.pre.localeCompare(v2.pre) as VersionComparisonResult
    }

    return 0
  }

  export function from(major: string | number, minor: string | number, patch?: string | number, pre?: string): Version {
    return {
      major: typeof major === 'string' ? parseInt(major, 10) : major,
      minor: typeof minor === 'string' ? parseInt(minor, 10) : minor,
      patch: patch === undefined || patch === null ? 0 : typeof patch === 'string' ? parseInt(patch, 10) : patch,
      pre: pre
    }
  }

  export function fromString(version: string): Version {
    const [ver, pre] = version.split('-')
    const [major, minor, patch] = ver.split('.')
    return from(major, minor, patch, pre)
  }
}
