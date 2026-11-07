export const MAX_SAFE_SMALL_INTEGER = 1 << 30

export const noBreakWhitespace = '\xa0'

export function splitLines(str: string): string[] {
  return str.split(/\r\n|\r|\n/)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

export function isDefined<T>(arg: T | null | undefined): arg is T {
  return !(arg === undefined || arg === null)
}
