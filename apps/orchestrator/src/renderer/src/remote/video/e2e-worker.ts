import { openFrame, videoFrameKey } from '@shared/remote-video-e2e'

interface Options {
  id: string
  secret: Uint8Array
  salt: Uint8Array
}

interface Transformer {
  readable: ReadableStream<RTCEncodedVideoFrame>
  writable: WritableStream<RTCEncodedVideoFrame>
  options: Options
  sendKeyFrameRequest?: () => Promise<void>
}

const FAIL_STREAK = 30
const ASK_GAP_MS = 300

const scope = self as unknown as {
  onrtctransform: ((e: { transformer: Transformer }) => void) | null
  postMessage: (m: unknown) => void
  addEventListener: (type: 'message', cb: (e: MessageEvent) => void) => void
}

scope.onrtctransform = (e) => {
  const t = e.transformer
  const { id, secret, salt } = t.options
  const key = videoFrameKey(secret, salt)
  let streak = 0
  let askedAt = 0
  const ask = (why: string): void => {
    const now = performance.now()
    if (now - askedAt < ASK_GAP_MS || !t.sendKeyFrameRequest) return
    askedAt = now
    t.sendKeyFrameRequest().then(
      () => scope.postMessage({ t: 'asked', id, why }),
      () => {}
    )
  }
  scope.addEventListener('message', (m) => {
    if (m.data?.t === 'key' && m.data.id === id) ask(String(m.data.why ?? 'asked'))
  })
  void t.readable
    .pipeThrough(
      new TransformStream<RTCEncodedVideoFrame, RTCEncodedVideoFrame>({
        async transform(f, ctl) {
          const opened = await openFrame(await key, new Uint8Array(f.data))
          if (!opened) {
            streak++
            scope.postMessage({ t: 'failed', id, streak, stuck: streak === FAIL_STREAK })
            ask('a frame failed to decrypt')
            return
          }
          streak = 0
          f.data = opened.data.buffer as ArrayBuffer
          scope.postMessage({ t: 'frame', id, rtp: f.getMetadata().rtpTimestamp, cap: opened.captureMs, key: f.type === 'key' })
          ctl.enqueue(f)
        }
      })
    )
    .pipeTo(t.writable)
    .catch(() => {})
}
