type ShellFn = (...args: any[]) => unknown
type ShellListener = (msg: Record<string, unknown>) => void

const fns: Record<string, ShellFn> = {}
let listener: ShellListener | null = null

export function postToShell(msg: Record<string, unknown>): void {
  try {
    listener?.(msg)
  } catch {
  }
}

export function onShellMessage(fn: ShellListener): void {
  listener = fn
}

export function exposeToShell(more: Record<string, ShellFn>): void {
  Object.assign(fns, more)
}

export function shellFn(name: string): ShellFn | undefined {
  return fns[name]
}
