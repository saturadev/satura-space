import { parentPort } from 'node:worker_threads'
import { compileSource } from './compile-core'

parentPort?.on('message', (m: { id: number; file: string; source: string; root?: string }) => {
  compileSource(m.file, m.source, m.root).then(
    (result) => parentPort?.postMessage({ id: m.id, result }),
    (e: unknown) => parentPort?.postMessage({ id: m.id, error: e instanceof Error ? (e.stack ?? e.message) : String(e) })
  )
})
