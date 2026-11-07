import type { WindowSession } from '@shared/api'
import { useAppStore } from '../store'
import { pathBasename } from '../lib/path'
import { PendingEdits, versionStamp, type EditRequest, type PushConflict } from '../lib/editor/file-versions'
import { openVersions, reportPushConflict, setRemoteFileSink, type FileVersionsOp, type FileVersionsReply, type VersionsConflict } from '../lib/editor/file-versions-store'
import { invokeRemote, wsTransport } from './ws-transport'

const PUSH_MS = 300
const RETRY_MS = 2000
const STORE_KEY = `satura.phoneFileEdits:${location.pathname}`

const pending = new PendingEdits()
const timers = new Map<string, ReturnType<typeof setTimeout>>()
const inflight = new Map<string, Promise<boolean>>()
let macDrafts: Record<string, string> = {}

function call(op: FileVersionsOp, req: Partial<EditRequest> & { file: string; seen?: string }): Promise<FileVersionsReply> {
  return invokeRemote<{ value: FileVersionsReply }>('remote:storeAction', { action: 'fileVersions', args: [op, req] }).then((r) => r.value)
}

function persist(): void {
  try {
    const saved = pending.save()
    if (Object.keys(saved).length) window.localStorage.setItem(STORE_KEY, JSON.stringify(saved))
    else window.localStorage.removeItem(STORE_KEY)
  } catch {
  }
}

function restore(): number {
  try {
    return pending.restore(JSON.parse(window.localStorage.getItem(STORE_KEY) ?? 'null'))
  } catch {
    return 0
  }
}

function tabFor(file: string): string {
  const s = useAppStore.getState()
  return Object.entries(s.viewerFileByTab).find(([, f]) => f === file)?.[0] ?? ''
}

function record(file: string, c: PushConflict): VersionsConflict {
  return { file, kind: 'push', from: c.from, by: 'phone', key: `push:${c.id}`, auto: true, tabId: tabFor(file), diskStamp: '' }
}

function schedule(file: string, ms = PUSH_MS): void {
  const t = timers.get(file)
  if (t) clearTimeout(t)
  timers.set(
    file,
    setTimeout(() => {
      timers.delete(file)
      void push(file)
    }, ms)
  )
}

function showMacVersion(file: string): void {
  useAppStore.getState().setDraft(file, macDrafts[file] ?? null)
}

function push(file: string, opts: { force?: boolean; save?: boolean } = {}): Promise<boolean> {
  const busy = inflight.get(file)
  if (busy) return busy.then(() => push(file, opts))
  const out = pending.toSend(file, opts.force)
  if (!out) return Promise.resolve(false)
  const name = pathBasename(file)
  const run = call(opts.save ? 'save' : 'edit', { file, base: out.base, text: out.text, ...(opts.force ? { force: true, seen: out.seen } : {}) }).then(
    (reply) => {
      if (!reply.ok) {
        const c = pending.rejected(file, reply.from, reply.stamp)
        persist()
        console.info(`[versions] the Mac has another version of ${name} (${reply.from}), asking which one to keep`)
        if (c) reportPushConflict(file, record(file, c))
        return false
      }
      const more = pending.acked(file)
      persist()
      reportPushConflict(file, null)
      if (opts.force) console.info(`[versions] the Mac took this phone's version of ${name}`)
      if (opts.save) console.info(`[versions] the Mac saved ${name} from this phone`)
      if (more) schedule(file, 0)
      return true
    },
    (e: Error) => {
      pending.failed(file)
      console.warn(`[versions] couldn't send the edit of ${name} to the Mac: ${e?.message ?? e}, trying again`)
      schedule(file, RETRY_MS)
      return false
    }
  )
  inflight.set(file, run)
  return run.finally(() => inflight.delete(file))
}

export function withPendingEdits(session: WindowSession): WindowSession {
  macDrafts = session.files?.draftsByPath ?? {}
  let settled = false
  for (const file of pending.files()) {
    const mac = macDrafts[file]
    if (mac !== undefined && pending.settleWith(file, mac)) {
      settled = true
      reportPushConflict(file, null)
    }
  }
  if (settled) persist()
  if (!pending.files().length || !session.files) return session
  return { ...session, files: { ...session.files, draftsByPath: pending.overlay(macDrafts) } }
}

export function installFileSync(): void {
  setRemoteFileSink({
    edit(file, prev, text, local) {
      pending.edit(file, prev, text, local)
      persist()
      if (pending.get(file)?.conflict) return
      schedule(file)
    },
    async save(file, text) {
      const t = timers.get(file)
      if (t) clearTimeout(t)
      timers.delete(file)
      await inflight.get(file)
      pending.edit(file, text, text, text)
      if (pending.get(file)?.conflict) {
        openVersions(file)
        return false
      }
      return push(file, { save: true })
    },
    async keep(c) {
      if (c.kind === 'push') {
        await push(c.file, { force: true })
        return
      }
      const reply = await call('keep', { file: c.file, seen: versionStamp(macDrafts[c.file] ?? '') }).catch((e: Error) => {
        console.warn(`[versions] couldn't keep the edits of ${pathBasename(c.file)}: ${e?.message ?? e}`)
        return null
      })
      if (reply && !reply.ok) console.info(`[versions] the Mac's copy of ${pathBasename(c.file)} changed again, look at it once more`)
    },
    async take(c) {
      pending.drop(c.file)
      persist()
      const t = timers.get(c.file)
      if (t) clearTimeout(t)
      timers.delete(c.file)
      reportPushConflict(c.file, null)
      showMacVersion(c.file)
      if (c.kind === 'push') return
      const reply = await call('take', { file: c.file, seen: versionStamp(macDrafts[c.file] ?? '') }).catch((e: Error) => {
        console.warn(`[versions] couldn't take the version on disk of ${pathBasename(c.file)}: ${e?.message ?? e}`)
        return null
      })
      if (reply?.ok) useAppStore.getState().setDraft(c.file, null)
      else if (reply) console.info(`[versions] the Mac's copy of ${pathBasename(c.file)} changed again, look at it once more`)
    },
    macVersion(file) {
      return macDrafts[file]
    }
  })
  const restored = restore()
  if (restored) console.info(`[versions] ${restored} unsent edit(s) from before the page reloaded wait for the Mac`)
  const flush = (): void => {
    for (const file of pending.files()) if (!pending.get(file)?.conflict) schedule(file, 0)
  }
  wsTransport.on('remote:online', flush)
}
