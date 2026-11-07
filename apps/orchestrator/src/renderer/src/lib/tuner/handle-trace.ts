export interface HandleTraceFrame {
  seq: number
  selected: string
  rectTransform: boolean
  kind: string
}

let frames: HandleTraceFrame[] | null = null
let seq = 0

export function handleTraceStart(): void {
  frames = []
  seq = 0
}

export function handleTraceOn(): boolean {
  return frames !== null
}

export function handleTraceRecord(selected: string, rectTransform: boolean, kind: string): void {
  if (!frames || frames.length > 5000) return
  frames.push({ seq: ++seq, selected, rectTransform, kind })
}

export function handleTraceStop(): HandleTraceFrame[] {
  const out = frames ?? []
  frames = null
  return out
}
