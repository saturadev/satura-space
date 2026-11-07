import { parentPort, workerData } from 'node:worker_threads'
import { startSandbox } from './sandbox/vm'

const input = workerData as { code: string; bootstrap: string; init?: string }
const port = parentPort

const sandbox = startSandbox(input.code, input.bootstrap, (msg) => port?.postMessage(msg), input.init)
port?.on('message', (msg: { t?: string; json?: string }) => {
  if (msg?.t === 'reply' && typeof msg.json === 'string') sandbox.deliver(msg.json)
})
