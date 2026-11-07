import type { MonacoKit } from '../lib/editor/monaco-kit'
import { call } from './channel'

let chunkBase: string | null = null
let job: Promise<MonacoKit> | null = null

export function setChunkBase(base: string | null): void {
  chunkBase = base
}

function loadScript(src: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const s = document.createElement('script')
    s.src = src
    s.onload = () => resolve()
    s.onerror = () => reject(new Error(`${src.split('/').pop()} did not load`))
    document.head.appendChild(s)
  })
}

export function loadMonacoKit(): Promise<MonacoKit> {
  job ??= (async () => {
    const g = globalThis as { __saturaMonacoKit?: MonacoKit }
    if (!g.__saturaMonacoKit) {
      if (chunkBase) await loadScript(`${chunkBase}monaco.js`)
      else new Function(await call<string>('chunk', ['monaco']))()
    }
    if (!g.__saturaMonacoKit) throw new Error('The diff view did not start')
    return g.__saturaMonacoKit
  })().catch((e: unknown) => {
    job = null
    throw e
  })
  return job
}
