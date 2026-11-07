export interface CaptureState {
  width: number
  height: number
  scale: number
  hidden: boolean
  preset: string
}

let state: CaptureState | null = null

export function captureActive(): CaptureState | null {
  return state
}

export function setCaptureState(next: CaptureState | null): void {
  state = next
}
