import { mediaLoader, type MediaTag } from '../../lib/media-loader'
import type { FrameBytes, FrameSource } from './frame-decoder'

const READ_MAX = 4 * 1024 * 1024
const nameOf = (path: string): string => path.split('/').pop() || 'the video'
const none = (): (() => void) => () => {}

export function bridgeSource(path: string, read: (offset: number, length: number) => Promise<{ data: Uint8Array; size: number }>): FrameSource {
  return {
    name: nameOf(path),
    eager: true,
    open: async () => {
      const head = await read(0, 1)
      const size = head.size
      if (!size) throw new Error('the file is empty')
      const bytes: FrameBytes = {
        size,
        read: async (start, end) => {
          if (end - start <= READ_MAX) return (await read(start, end - start)).data
          const out = new Uint8Array(end - start)
          for (let at = start; at < end; at += READ_MAX) out.set((await read(at, Math.min(READ_MAX, end - at))).data, at - start)
          return out
        },
        have: () => size,
        done: () => true,
        onMore: none
      }
      return bytes
    }
  }
}

export interface LoaderSourceHooks {
  tag?: MediaTag
  arm?: () => void
  progress?: (got: number, total: number) => void
  failed?: (why: string) => void
}

export interface LoaderSource extends FrameSource {
  stop: (why: string) => void
}

const isAbort = (e: unknown): boolean => /AbortError|cancelled|aborted/i.test(e instanceof Error ? `${e.name} ${e.message}` : String(e))

export function loaderSource(path: string, eager: boolean, hooks: LoaderSourceHooks = {}): LoaderSource {
  let opened: Promise<FrameBytes> | null = null
  let stopped = false
  let have = 0
  let size = 0
  let done = false
  const listeners = new Set<() => void>()
  const tell = (): void => {
    for (const l of listeners) l()
  }
  const open = (): Promise<FrameBytes> => {
    if (opened) return opened
    const loader = mediaLoader()
    if (!loader?.download || !loader.read) return Promise.reject(new Error('this page has no way to read videos from the desktop'))
    const read = loader.read.bind(loader)
    hooks.arm?.()
    opened = new Promise<FrameBytes>((resolve, reject) => {
      let told = false
      const bytes = (): FrameBytes => ({
        size,
        read: async (start, end) => (await read(path, start, end - start)).data,
        have: () => have,
        done: () => done,
        onMore: (cb) => {
          listeners.add(cb)
          return () => listeners.delete(cb)
        }
      })
      const settle = (): void => {
        if (told || !size) return
        told = true
        resolve(bytes())
      }
      void loader
        .download!(path, (p) => {
          if (stopped) return
          have = p.got
          size = p.total
          done = p.total > 0 && p.got >= p.total
          hooks.progress?.(p.got, p.total)
          settle()
          tell()
        }, hooks.tag ? { tag: hooks.tag } : undefined)
        .then(
          (r) => {
            if (stopped) return
            have = r.size
            size = r.size
            done = true
            hooks.progress?.(r.size, r.size)
            settle()
            tell()
          },
          (e: unknown) => {
            if (stopped || isAbort(e)) return
            const why = e instanceof Error ? e.message : String(e)
            hooks.failed?.(why)
            if (!told) {
              told = true
              reject(e instanceof Error ? e : new Error(why))
            }
          }
        )
    })
    return opened
  }
  return {
    name: nameOf(path),
    eager,
    open,
    stop: (why) => {
      if (stopped || !opened) return
      stopped = true
      mediaLoader()?.stop?.(path, why)
    }
  }
}
