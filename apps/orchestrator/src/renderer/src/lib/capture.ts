import { create } from 'zustand'

interface CaptureState {
  on: boolean
  name: string
  replace: [string, string][]
}

export const useCapture = create<CaptureState>(() => ({ on: false, name: '', replace: [] }))

export function captureText(text: string): string {
  const { on, replace } = useCapture.getState()
  if (!on || !replace.length) return text
  let out = text
  for (const [from, to] of replace) if (out.includes(from)) out = out.split(from).join(to)
  return out
}

const deviceBox = typeof ResizeObserverEntry === 'undefined' ? undefined : Object.getOwnPropertyDescriptor(ResizeObserverEntry.prototype, 'devicePixelContentBoxSize')

function emulatedDeviceBox(on: boolean): void {
  if (!deviceBox) return
  if (!on) {
    Object.defineProperty(ResizeObserverEntry.prototype, 'devicePixelContentBoxSize', deviceBox)
    return
  }
  Object.defineProperty(ResizeObserverEntry.prototype, 'devicePixelContentBoxSize', {
    configurable: true,
    enumerable: deviceBox.enumerable,
    get(this: ResizeObserverEntry) {
      const box = this.contentBoxSize[0]
      const dpr = window.devicePixelRatio || 1
      return [{ inlineSize: Math.round(box.inlineSize * dpr), blockSize: Math.round(box.blockSize * dpr) }]
    }
  })
}

export function setCapture(next: CaptureState): void {
  const root = document.documentElement
  if (next.on) root.setAttribute('data-capture', '')
  else root.removeAttribute('data-capture')
  emulatedDeviceBox(next.on)
  useCapture.setState(next)
}
