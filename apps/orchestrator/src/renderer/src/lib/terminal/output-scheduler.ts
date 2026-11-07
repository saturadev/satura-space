
const BACKGROUND_FLUSH_DELAY_MS = 50
const BACKGROUND_DRAIN_INTERVAL_MS = 16
const HIGH_PRIORITY_DRAIN_INTERVAL_MS = 1
const BACKGROUND_CHUNK_CHARS = 16 * 1024
const MAX_WRITES_PER_DRAIN = 2
const HIGH_PRIORITY_MAX_WRITES_PER_DRAIN = 16
const LARGE_BACKLOG_CHARS = 512 * 1024
const SYNC_FOREGROUND_FLUSH_CHARS = 256 * 1024
const MAX_BACKGROUND_QUEUE_CHARS = 2 * 1024 * 1024
const MAX_BACKGROUND_QUEUE_CHUNKS = 4096
const BACKGROUND_BACKLOG_WARNING =
  '\x18\x1b[0m\r\n[Satura Space skipped hidden terminal output because the backlog exceeded 2 MB.]\r\n'

export interface SchedulerTarget {
  write(data: string): void
}

export interface TerminalWriter {
  write(data: string, opts?: { latencySensitive?: boolean }): void
  setForeground(foreground: boolean): void
  flush(): void
  dispose(): void
}

export function createTerminalWriter(
  target: SchedulerTarget,
  onConsumed?: (charCount: number) => void
): TerminalWriter {
  let foreground = true
  let highPriority = false
  let disposed = false
  let chunks: string[] = []
  let queuedChars = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const ack = (n: number): void => {
    if (n > 0) onConsumed?.(n)
  }

  const scheduleDrain = (delayMs: number): void => {
    if (disposed || timer) return
    timer = setTimeout(drain, delayMs)
  }

  const enqueue = (data: string): void => {
    for (let i = 0; i < data.length; i += BACKGROUND_CHUNK_CHARS) {
      chunks.push(data.slice(i, i + BACKGROUND_CHUNK_CHARS))
    }
    queuedChars += data.length
  }

  const replaceBacklogWithWarning = (): void => {
    ack(queuedChars)
    chunks = []
    queuedChars = 0
    target.write(BACKGROUND_BACKLOG_WARNING)
  }

  function drain(): void {
    timer = null
    if (disposed) return
    const maxWrites = highPriority ? HIGH_PRIORITY_MAX_WRITES_PER_DRAIN : MAX_WRITES_PER_DRAIN
    let writes = 0
    while (chunks.length > 0 && writes < maxWrites) {
      const chunk = chunks.shift() as string
      queuedChars -= chunk.length
      target.write(chunk)
      ack(chunk.length)
      writes++
    }
    if (queuedChars >= LARGE_BACKLOG_CHARS) highPriority = true
    if (chunks.length > 0) {
      scheduleDrain(
        highPriority ? HIGH_PRIORITY_DRAIN_INTERVAL_MS : BACKGROUND_DRAIN_INTERVAL_MS
      )
    } else {
      highPriority = false
    }
  }

  function flush(): void {
    if (disposed) return
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    while (chunks.length > 0) {
      const chunk = chunks.shift() as string
      queuedChars -= chunk.length
      target.write(chunk)
      ack(chunk.length)
    }
    queuedChars = 0
    highPriority = false
  }

  return {
    write(data, opts) {
      if (disposed || data.length === 0) return

      if (foreground && chunks.length === 0 && (opts?.latencySensitive || !highPriority)) {
        target.write(data)
        ack(data.length)
        return
      }

      if (foreground) {
        enqueue(data)
        if (queuedChars >= SYNC_FOREGROUND_FLUSH_CHARS) highPriority = true
        scheduleDrain(0)
        return
      }

      enqueue(data)
      if (queuedChars > MAX_BACKGROUND_QUEUE_CHARS || chunks.length > MAX_BACKGROUND_QUEUE_CHUNKS) {
        replaceBacklogWithWarning()
      }
      scheduleDrain(highPriority ? HIGH_PRIORITY_DRAIN_INTERVAL_MS : BACKGROUND_FLUSH_DELAY_MS)
    },

    setForeground(next) {
      foreground = next
      if (next && chunks.length > 0) scheduleDrain(0)
    },

    flush,

    dispose() {
      disposed = true
      if (timer) {
        clearTimeout(timer)
        timer = null
      }
      ack(queuedChars)
      chunks = []
      queuedChars = 0
    }
  }
}
