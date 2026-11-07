let writer: ((text: string) => Promise<void> | void) | null = null

export function setClipboardWriter(next: ((text: string) => Promise<void> | void) | null): void {
  writer = next
}

export function writeClipboard(text: string): Promise<void> {
  if (writer) return Promise.resolve(writer(text))
  return Promise.resolve(window.api.ui.writeClipboardText(text))
}
