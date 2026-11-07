type CopyListener = (text: string) => void

const listeners = new Set<CopyListener>()
let held = ''
let installed = false

export function demoCopied(): string {
  return held
}

export function demoCopy(text: string): Promise<void> {
  held = text
  ;(window as unknown as { __copied?: string }).__copied = text
  for (const l of listeners) l(text)
  return Promise.resolve()
}

export function onDemoCopy(fn: CopyListener): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

function textOf(items: ClipboardItem[]): Promise<string> {
  const item = items[0]
  if (!item || !item.types.includes('text/plain')) return Promise.resolve('')
  return item.getType('text/plain').then((b) => b.text())
}

export function installDemoClipboard(): void {
  if (installed || typeof navigator === 'undefined') return
  installed = true
  const fake = {
    writeText: (text: string) => demoCopy(String(text)),
    readText: () => Promise.resolve(held),
    write: (items: ClipboardItem[]) => textOf(items).then(demoCopy),
    read: () => Promise.resolve([] as ClipboardItem[]),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false
  }
  try {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, get: () => fake })
  } catch {
    return
  }
  const exec = document.execCommand.bind(document)
  document.execCommand = (cmd: string, ui?: boolean, value?: string): boolean => {
    const c = cmd.toLowerCase()
    if (c === 'copy' || c === 'cut') {
      void demoCopy(window.getSelection()?.toString() ?? '')
      return true
    }
    return exec(cmd, ui, value)
  }
  const block = (e: ClipboardEvent): void => {
    e.preventDefault()
    const el = e.target as HTMLInputElement | null
    const field = el && typeof el.selectionStart === 'number' && typeof el.value === 'string'
    void demoCopy(field ? el.value.slice(el.selectionStart ?? 0, el.selectionEnd ?? 0) : (window.getSelection()?.toString() ?? ''))
  }
  document.addEventListener('copy', block, true)
  document.addEventListener('cut', block, true)
}
