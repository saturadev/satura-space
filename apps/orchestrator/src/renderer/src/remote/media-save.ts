import { useSyncExternalStore } from 'react'
import type { MediaProgress, MediaSaveAsk, MediaSaved, MediaScope } from '../lib/media-loader'
import { downloadMedia, fileBlob } from './media-cache'

export interface SaveJob {
  id: number
  ask: MediaSaveAsk
  state: 'loading' | 'ready' | 'sharing' | 'error'
  got: number
  total: number
  error: string
  file: File | null
  share: boolean
}

type Prepare = { onProgress?: (p: MediaProgress) => void; scope: MediaScope }

let job: SaveJob | null = null
let finish: ((r: MediaSaved) => void) | null = null
let ctl: AbortController | null = null
let again: Prepare | null = null
let seq = 0
const listeners = new Set<() => void>()

const mb = (n: number): string => (n / 1e6).toFixed(1)
const isAbort = (e: unknown): boolean => /AbortError|cancelled|aborted/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e))
const message = (e: unknown): string => (e instanceof Error ? e.message : String(e)).replace(/^E[A-Z]+:\s*/, '').trim() || 'It stopped.'

function set(next: SaveJob | null): void {
  job = next
  for (const l of [...listeners]) l()
}

function patch(id: number, p: Partial<SaveJob>): void {
  if (job?.id === id) set({ ...job, ...p })
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useSaveJob(): SaveJob | null {
  return useSyncExternalStore(subscribe, () => job)
}

function shareable(file: File): boolean {
  const n = navigator as Navigator & { canShare?: (d: ShareData) => boolean }
  if (typeof n.share !== 'function' || typeof n.canShare !== 'function') return false
  try {
    return n.canShare({ files: [file] })
  } catch {
    return false
  }
}

function end(r: MediaSaved): void {
  const f = finish
  finish = null
  ctl = null
  again = null
  set(null)
  f?.(r)
}

async function prepare(id: number, ask: MediaSaveAsk, p: Prepare): Promise<void> {
  const started = performance.now()
  try {
    await downloadMedia(ask.path, p.scope, (got, total) => {
      patch(id, { got, total })
      p.onProgress?.({ got, total })
    })
    const { blob, type } = await fileBlob(ask.path, p.scope)
    if (job?.id !== id) return
    const file = new File([blob], ask.name, { type })
    const share = shareable(file)
    patch(id, { state: 'ready', file, share, got: blob.size, total: blob.size, error: '' })
    console.info(`[save] ${ask.name} is ready to save, ${mb(blob.size)} MB ${type || 'unknown type'} after ${Math.round(performance.now() - started)} ms; ${share ? 'the share sheet takes files here' : 'no share sheet for files here, it downloads instead'}`)
  } catch (e) {
    if (job?.id !== id || isAbort(e)) return
    patch(id, { state: 'error', error: message(e) })
    console.warn(`[save] ${ask.name} couldn't get ready: ${message(e)}`)
  }
}

export function saveMedia(ask: MediaSaveAsk, onProgress?: (p: MediaProgress) => void, scope: MediaScope = {}): Promise<MediaSaved> {
  if (job) closeSave('another save started')
  const id = ++seq
  ctl = new AbortController()
  const p: Prepare = { onProgress, scope: { ...scope, signal: ctl.signal, ...(ask.tag ? { tag: ask.tag } : {}) } }
  again = p
  set({ id, ask, state: 'loading', got: 0, total: 0, error: '', file: null, share: false })
  console.info(`[save] ${ask.name}: the save sheet opened for the ${ask.kind}${ask.tag?.q === 'best' ? ' in Best quality' : ''}`)
  const done = new Promise<MediaSaved>((resolve) => {
    finish = resolve
  })
  void prepare(id, ask, p)
  return done
}

export function retrySave(): void {
  const j = job
  if (!j || !again) return
  if (j.file) {
    set({ ...j, state: 'ready', error: '' })
    return
  }
  ctl?.abort()
  ctl = new AbortController()
  again = { ...again, scope: { ...again.scope, signal: ctl.signal } }
  set({ ...j, state: 'loading', error: '' })
  console.info(`[save] ${j.ask.name}: trying again`)
  void prepare(j.id, j.ask, again)
}

export function downloadSaved(): void {
  const j = job
  if (!j?.file) return
  const url = URL.createObjectURL(j.file)
  const a = document.createElement('a')
  a.href = url
  a.download = j.ask.name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
  console.info(`[save] ${j.ask.name}: downloaded ${mb(j.file.size)} MB as a file`)
  end({ saved: true, how: 'download', bytes: j.file.size })
}

export function shareSaved(): void {
  const j = job
  if (!j?.file) return
  if (!j.share) return downloadSaved()
  const file = j.file
  patch(j.id, { state: 'sharing' })
  console.info(`[save] ${j.ask.name}: opening the share sheet with ${file.name} (${mb(file.size)} MB ${file.type})`)
  navigator.share({ files: [file], title: j.ask.name }).then(
    () => {
      console.info(`[save] ${j.ask.name}: the share sheet saved or sent it`)
      if (job?.id === j.id) end({ saved: true, how: 'share', bytes: file.size })
    },
    (e: unknown) => {
      if (job?.id !== j.id) return
      if (e instanceof DOMException && e.name === 'AbortError') {
        console.info(`[save] ${j.ask.name}: the share sheet closed without saving`)
        patch(j.id, { state: 'ready' })
        return
      }
      console.warn(`[save] ${j.ask.name}: the share sheet failed: ${message(e)}`)
      patch(j.id, { state: 'error', error: `The share sheet didn't open. ${message(e)}`, share: false })
    }
  )
}

export function closeSave(why: string): void {
  const j = job
  if (!j) return
  ctl?.abort()
  console.info(`[save] ${j.ask.name}: closed (${why})${j.state === 'loading' && j.total ? ` at ${mb(j.got)} of ${mb(j.total)} MB` : ''}`)
  end({ saved: false })
}
