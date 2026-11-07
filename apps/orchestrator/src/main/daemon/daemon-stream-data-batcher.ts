import type { Socket } from 'node:net'
import { encodeNdjson, NDJSON_MAX_LINE_BYTES } from './ndjson'

type StreamDataClient = {
  streamSocket: Socket | null
}

type QueueEntry = { sessionId: string; data: string; exitCode?: number }

type PendingStreamDataBatch = {
  timer: ReturnType<typeof setTimeout> | null
  queue: QueueEntry[]
  queuedChars: number
}

export const STREAM_BLOCKED_MAX_QUEUED_CHARS = 32 * 1024 * 1024

const STREAM_DATA_BATCH_INTERVAL_MS = 8

type EnqueueOptions = {
  flushImmediately?: boolean
  flushMaxChars?: number
}

type DaemonStreamDataBatcherOptions = {
  maxLineBytes?: number
  maxBlockedQueuedChars?: number
  log?: (message: string) => void
}

function encodeStreamDataEvent(sessionId: string, data: string): string {
  return encodeNdjson({
    type: 'event',
    event: 'data',
    sessionId,
    payload: { data }
  })
}

function encodeStreamExitEvent(sessionId: string, code: number): string {
  return encodeNdjson({
    type: 'event',
    event: 'exit',
    sessionId,
    payload: { code }
  })
}

function lineBytes(line: string): number {
  return Buffer.byteLength(line, 'utf8')
}

function streamDataEventLineBytes(sessionId: string, data: string): number {
  return lineBytes(encodeStreamDataEvent(sessionId, data))
}

const MAX_UTF8_BYTES_PER_CODE_UNIT = 3

function isHighSurrogate(value: number): boolean {
  return value >= 0xd800 && value <= 0xdbff
}

function isLowSurrogate(value: number): boolean {
  return value >= 0xdc00 && value <= 0xdfff
}

function clampToSafeSplitIndex(value: string, start: number, end: number): number {
  if (end <= start || end >= value.length) {
    return end
  }
  const prev = value.charCodeAt(end - 1)
  const next = value.charCodeAt(end)
  return isHighSurrogate(prev) && isLowSurrogate(next) ? end - 1 : end
}

function nextSafeSplitIndex(value: string, start: number): number {
  const next = Math.min(value.length, start + 1)
  if (
    next < value.length &&
    isHighSurrogate(value.charCodeAt(start)) &&
    isLowSurrogate(value.charCodeAt(next))
  ) {
    return next + 1
  }
  return next
}

function splitStreamDataForNdjson(sessionId: string, data: string, maxLineBytes: number): string[] {
  const chunks: string[] = []
  let start = 0
  while (start < data.length) {
    let low = start + 1
    let high = data.length
    let best = start

    while (low <= high) {
      const rawMid = Math.floor((low + high) / 2)
      const mid = clampToSafeSplitIndex(data, start, rawMid)
      if (mid <= start) {
        low = rawMid + 1
        continue
      }

      if (streamDataEventLineBytes(sessionId, data.slice(start, mid)) <= maxLineBytes) {
        best = mid
        low = rawMid + 1
      } else {
        high = rawMid - 1
      }
    }

    const end = best > start ? best : nextSafeSplitIndex(data, start)
    chunks.push(data.slice(start, end))
    start = end
  }

  return chunks
}

export class DaemonStreamDataBatcher {
  private pendingByClient = new Map<string, PendingStreamDataBatch>()
  private blockedSockets = new Map<string, Socket>()
  private droppedCharsByClient = new Map<string, number>()
  private getClient: (clientId: string) => StreamDataClient | undefined
  private maxLineBytes: number
  private maxBlockedQueuedChars: number
  private log: (message: string) => void

  constructor(
    getClient: (clientId: string) => StreamDataClient | undefined,
    options: DaemonStreamDataBatcherOptions = {}
  ) {
    this.getClient = getClient
    this.maxLineBytes = Math.max(1, options.maxLineBytes ?? NDJSON_MAX_LINE_BYTES)
    this.maxBlockedQueuedChars = Math.max(1, options.maxBlockedQueuedChars ?? STREAM_BLOCKED_MAX_QUEUED_CHARS)
    this.log = options.log ?? ((message) => console.warn(message))
  }

  isBlocked(clientId: string): boolean {
    return this.blockedSockets.has(clientId)
  }

  enqueue(clientId: string, sessionId: string, data: string, options: EnqueueOptions = {}): void {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    const batch = this.batchFor(clientId)
    const last = batch.queue.at(-1)
    if (last?.sessionId === sessionId && last.exitCode === undefined) {
      last.data += data
    } else {
      batch.queue.push({ sessionId, data })
    }
    batch.queuedChars += data.length

    if (this.isBlocked(clientId)) {
      this.capBlockedQueue(clientId, batch)
      return
    }

    if (
      options.flushImmediately === true &&
      this.queuedCharsForSession(batch, sessionId) <=
        (options.flushMaxChars ?? Number.POSITIVE_INFINITY)
    ) {
      this.flushSession(clientId, sessionId)
      return
    }
    if (!batch.timer) {
      batch.timer = setTimeout(() => this.flush(clientId), STREAM_DATA_BATCH_INTERVAL_MS)
    }
  }

  enqueueExit(clientId: string, sessionId: string, code: number): void {
    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }
    this.batchFor(clientId).queue.push({ sessionId, data: '', exitCode: code })
    this.flush(clientId)
  }

  flush(clientId: string): void {
    const batch = this.pendingByClient.get(clientId)
    if (!batch) {
      return
    }

    if (batch.timer) {
      clearTimeout(batch.timer)
      batch.timer = null
    }
    if (this.isBlocked(clientId)) {
      return
    }
    this.pendingByClient.delete(clientId)

    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    this.writeEntries(clientId, client.streamSocket, batch.queue)
  }

  private batchFor(clientId: string): PendingStreamDataBatch {
    let batch = this.pendingByClient.get(clientId)
    if (!batch) {
      batch = { timer: null, queue: [], queuedChars: 0 }
      this.pendingByClient.set(clientId, batch)
    }
    return batch
  }

  private writeEntries(clientId: string, socket: Socket, entries: QueueEntry[]): void {
    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i]
      const accepted =
        entry.exitCode !== undefined
          ? socket.write(encodeStreamExitEvent(entry.sessionId, entry.exitCode))
          : this.writeStreamDataEvent(socket, entry.sessionId, entry.data)
      if (!accepted && !socket.destroyed) {
        this.block(clientId, socket, entries.slice(i + 1))
        return
      }
    }
  }

  private block(clientId: string, socket: Socket, rest: QueueEntry[]): void {
    const batch = this.batchFor(clientId)
    batch.queue = [...rest, ...batch.queue]
    batch.queuedChars = batch.queue.reduce((sum, entry) => sum + entry.data.length, 0)
    if (batch.timer) {
      clearTimeout(batch.timer)
      batch.timer = null
    }
    if (batch.queue.length === 0) {
      this.pendingByClient.delete(clientId)
    }
    if (this.blockedSockets.get(clientId) === socket) {
      return
    }
    this.blockedSockets.set(clientId, socket)
    const onDrain = (): void => {
      socket.off('close', onClose)
      if (this.blockedSockets.get(clientId) !== socket) return
      this.blockedSockets.delete(clientId)
      const dropped = this.droppedCharsByClient.get(clientId)
      if (dropped) {
        this.droppedCharsByClient.delete(clientId)
        this.log(`[daemon] stream client ${clientId} drained; ${dropped} chars of terminal output were dropped while it was blocked`)
      }
      this.flush(clientId)
    }
    const onClose = (): void => {
      socket.off('drain', onDrain)
      if (this.blockedSockets.get(clientId) === socket) this.blockedSockets.delete(clientId)
    }
    socket.once('drain', onDrain)
    socket.once('close', onClose)
  }

  private capBlockedQueue(clientId: string, batch: PendingStreamDataBatch): void {
    if (batch.queuedChars <= this.maxBlockedQueuedChars) {
      return
    }
    let excess = batch.queuedChars - this.maxBlockedQueuedChars
    let dropped = 0
    for (const entry of batch.queue) {
      if (excess <= 0) break
      if (entry.exitCode !== undefined || entry.data.length === 0) continue
      const cut = Math.min(entry.data.length, excess)
      entry.data = entry.data.slice(cut)
      excess -= cut
      dropped += cut
    }
    batch.queue = batch.queue.filter((entry) => entry.exitCode !== undefined || entry.data.length > 0)
    batch.queuedChars -= dropped
    const before = this.droppedCharsByClient.get(clientId) ?? 0
    if (before === 0 && dropped > 0) {
      this.log(`[daemon] stream client ${clientId} is not reading; dropping the oldest queued terminal output beyond ${this.maxBlockedQueuedChars} chars`)
    }
    this.droppedCharsByClient.set(clientId, before + dropped)
  }

  private queuedCharsForSession(batch: PendingStreamDataBatch, sessionId: string): number {
    let chars = 0
    for (const entry of batch.queue) {
      if (entry.sessionId === sessionId) {
        chars += entry.data.length
      }
    }
    return chars
  }

  private flushSession(clientId: string, sessionId: string): void {
    const batch = this.pendingByClient.get(clientId)
    if (!batch) {
      return
    }

    const flushed: PendingStreamDataBatch['queue'] = []
    const retained: PendingStreamDataBatch['queue'] = []
    let flushedChars = 0
    for (const entry of batch.queue) {
      if (entry.sessionId === sessionId) {
        flushed.push(entry)
        flushedChars += entry.data.length
      } else {
        retained.push(entry)
      }
    }
    if (flushed.length === 0) {
      return
    }

    batch.queue = retained
    batch.queuedChars -= flushedChars
    if (batch.queue.length === 0) {
      if (batch.timer) {
        clearTimeout(batch.timer)
        batch.timer = null
      }
      this.pendingByClient.delete(clientId)
    }

    const client = this.getClient(clientId)
    if (!client?.streamSocket || client.streamSocket.destroyed) {
      return
    }

    this.writeEntries(clientId, client.streamSocket, flushed)
  }

  dropSession(sessionId: string): void {
    for (const [clientId, batch] of this.pendingByClient) {
      const retained = batch.queue.filter(
        (entry) => entry.sessionId !== sessionId || entry.exitCode !== undefined
      )
      if (retained.length === batch.queue.length) {
        continue
      }
      batch.queue = retained
      batch.queuedChars = retained.reduce((sum, entry) => sum + entry.data.length, 0)
      if (retained.length === 0) {
        if (batch.timer) {
          clearTimeout(batch.timer)
          batch.timer = null
        }
        this.pendingByClient.delete(clientId)
      }
    }
  }

  clear(clientId?: string): void {
    const batches =
      clientId === undefined
        ? Array.from(this.pendingByClient.entries())
        : [[clientId, this.pendingByClient.get(clientId)] as const]

    for (const [id, batch] of batches) {
      if (batch?.timer) {
        clearTimeout(batch.timer)
      }
      this.pendingByClient.delete(id)
    }
    if (clientId === undefined) {
      this.blockedSockets.clear()
      this.droppedCharsByClient.clear()
    } else {
      this.blockedSockets.delete(clientId)
      this.droppedCharsByClient.delete(clientId)
    }
  }

  private writeStreamDataEvent(streamSocket: Socket, sessionId: string, data: string): boolean {
    const line = encodeStreamDataEvent(sessionId, data)
    if (
      line.length * MAX_UTF8_BYTES_PER_CODE_UNIT <= this.maxLineBytes ||
      lineBytes(line) <= this.maxLineBytes
    ) {
      return streamSocket.write(line)
    }
    let accepted = true
    for (const chunk of splitStreamDataForNdjson(sessionId, data, this.maxLineBytes)) {
      accepted = streamSocket.write(encodeStreamDataEvent(sessionId, chunk)) && accepted
    }
    return accepted
  }
}
