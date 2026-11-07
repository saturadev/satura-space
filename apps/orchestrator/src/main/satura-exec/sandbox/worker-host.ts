import { Worker } from 'node:worker_threads'
import type { ScriptHost } from '../runner'
import type { SandboxMessage } from './vm'

const WORKER_HEAP_MB = 256
const live = new Set<Worker>()

export async function terminateAllScriptWorkers(): Promise<void> {
  const all = [...live]
  live.clear()
  await Promise.allSettled(all.map((w) => w.terminate()))
}

export function workerHost(workerFile: string, code: string, bootstrap: string, init = '{}'): ScriptHost {
  const worker = new Worker(workerFile, {
    workerData: { code, bootstrap, init },
    env: {},
    stdout: true,
    stderr: true,
    resourceLimits: { maxOldGenerationSizeMb: WORKER_HEAP_MB }
  })
  live.add(worker)
  worker.once('exit', () => live.delete(worker))
  worker.stdout.resume()
  worker.stderr.resume()
  let ended = false
  return {
    onMessage: (listener) => worker.on('message', (msg: SandboxMessage) => listener(msg)),
    onExit: (listener) => {
      worker.on('error', (e) => {
        if (ended) return
        if ((e as { code?: string }).code !== 'ERR_WORKER_OUT_OF_MEMORY') return listener(e)
        const oom = new Error(`The script ran out of memory: a script gets ${WORKER_HEAP_MB} MB. Keep less data in variables at once.`)
        oom.name = 'ScriptOutOfMemory'
        listener(oom)
      })
      worker.on('exit', () => {
        if (!ended) listener()
      })
    },
    send: (msg) => worker.postMessage(msg),
    terminate: () => {
      ended = true
      live.delete(worker)
      void worker.terminate()
    }
  }
}
