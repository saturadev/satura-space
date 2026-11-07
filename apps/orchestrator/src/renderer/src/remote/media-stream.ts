import { channelOpen, readMediaRange } from './media-cache'

const AHEAD = 24
const SW_FILE = 'media-sw.js'
const KEEPALIVE_MS = 20_000
const KEEPALIVE_IDLE_MS = 40_000

interface ReadAsk {
  t: 'media-read'
  path: string
  start: number
  end: number
  first?: boolean
}

const listeners = new Set<() => void>()
const errorListeners = new Set<(path: string, error: string) => void>()
let ready = false
let scope = ''
let lastAnswer = 0
let keepTimer = 0

const nameOf = (path: string): string => path.split('/').slice(-2).join('/')
const mb = (n: number): string => (n / 1e6).toFixed(n < 1e7 ? 2 : 1)

function keepAlive(): void {
  lastAnswer = Date.now()
  if (keepTimer) return
  keepTimer = window.setInterval(() => {
    if (Date.now() - lastAnswer > KEEPALIVE_IDLE_MS) {
      window.clearInterval(keepTimer)
      keepTimer = 0
      return
    }
    void fetch(`${scope}media-stream/keepalive`, { cache: 'no-store' }).catch(() => {})
  }, KEEPALIVE_MS)
}

function answer(ask: ReadAsk, port: MessagePort): void {
  const started = performance.now()
  keepAlive()
  readMediaRange(ask.path, ask.start, ask.end + 1, { ahead: AHEAD }).then(
    (r) => {
      if (ask.first) console.info(`[media] stream ${nameOf(ask.path)} from ${mb(ask.start)} MB of ${mb(r.size)} MB, first bytes in ${Math.round(performance.now() - started)} ms ${channelOpen() ? 'over WebRTC' : 'over the relay'}`)
      const data = r.data.slice()
      port.postMessage({ ok: true, size: r.size, type: r.type, data: data.buffer }, [data.buffer])
    },
    (e: unknown) => {
      const error = e instanceof Error ? e.message : String(e)
      console.warn(`[media] stream ${nameOf(ask.path)} at ${mb(ask.start)} MB failed: ${error}`)
      for (const l of errorListeners) l(ask.path, error)
      port.postMessage({ ok: false, error })
    }
  )
}

function controlled(): boolean {
  return !!navigator.serviceWorker?.controller?.scriptURL.endsWith(`/${SW_FILE}`)
}

function update(): void {
  const now = controlled()
  if (now === ready) return
  ready = now
  console.info(`[media] ${now ? 'videos stream from the Mac as they play' : 'video streaming is off, videos download first'}`)
  for (const l of listeners) l()
}

export const mediaStream = {
  url(path: string): string | null {
    if (!ready || !scope) return null
    return `${scope}media-stream/${encodeURIComponent(path.split('/').pop() || 'media')}?p=${encodeURIComponent(path)}`
  },
  onChange(cb: () => void): () => void {
    listeners.add(cb)
    return () => listeners.delete(cb)
  },
  onError(cb: (path: string, error: string) => void): () => void {
    errorListeners.add(cb)
    return () => errorListeners.delete(cb)
  }
}

export function installMediaStream(): void {
  const sw = navigator.serviceWorker
  if (!sw || !window.isSecureContext) {
    console.info(`[media] no service worker here (${window.isSecureContext ? 'not supported' : 'not a secure page'}), videos download before they play`)
    return
  }
  scope = new URL('./', location.href).href
  sw.addEventListener('message', (e: MessageEvent) => {
    const ask = e.data as ReadAsk | null
    if (ask?.t !== 'media-read' || !e.ports[0]) return
    answer(ask, e.ports[0])
  })
  sw.addEventListener('controllerchange', update)
  update()
  sw.register(`./${SW_FILE}`, { scope: './' }).then(
    (reg) => {
      void reg.update().catch(() => {})
      void sw.ready.then(update)
    },
    (e: unknown) => console.warn(`[media] service worker failed: ${e instanceof Error ? e.message : String(e)}`)
  )
}
