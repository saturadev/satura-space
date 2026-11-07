import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from 'node:fs'
import { dirname } from 'node:path'

const HOST_ID = /^[a-z0-9]{6,32}$/
const MAX_PER_HOST = 8
const MAX_HOSTS = 20_000
const DAY_MS = 86_400_000

export function writeAtomic(file, text) {
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  const fd = openSync(tmp, 'w', 0o600)
  try {
    writeSync(fd, text)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, file)
  try {
    const dir = openSync(dirname(file), 'r')
    try {
      fsyncSync(dir)
    } finally {
      closeSync(dir)
    }
  } catch {
  }
}

export function createOwners({ file = null, flushMs = 30_000, now = Date.now, log = () => {} } = {}) {
  const owners = new Map()
  let dirty = false

  if (file && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, 'utf8'))
      for (const [hostId, list] of Object.entries(raw?.hosts ?? {})) {
        if (!HOST_ID.test(hostId) || !list || typeof list !== 'object') continue
        const m = new Map()
        for (const [account, at] of Object.entries(list)) if (Number(at) > 0) m.set(String(account), Number(at))
        if (m.size) owners.set(hostId, m)
      }
      log('owners loaded', { file, hosts: owners.size })
    } catch (e) {
      log('owners file unreadable, starting fresh', { file, error: String(e?.message ?? e) })
    }
  }

  function note(hostId, account) {
    if (!HOST_ID.test(String(hostId))) return
    const key = String(account ?? '').trim().toLowerCase()
    let m = owners.get(hostId)
    if (!m) {
      if (owners.size >= MAX_HOSTS) {
        let oldest = null
        let oldestAt = Infinity
        for (const [id, list] of owners) {
          const at = Math.max(...list.values())
          if (at < oldestAt) {
            oldestAt = at
            oldest = id
          }
        }
        if (oldest) owners.delete(oldest)
      }
      m = new Map()
      owners.set(hostId, m)
    }
    const before = m.get(key)
    m.set(key, now())
    while (m.size > MAX_PER_HOST) {
      let oldest = null
      for (const [k, at] of m) if (oldest === null || at < m.get(oldest)) oldest = k
      m.delete(oldest)
    }
    if (before === undefined || now() - before > DAY_MS) dirty = true
  }

  function has(hostId, account) {
    return owners.get(String(hostId))?.has(String(account ?? '').trim().toLowerCase()) === true
  }

  function flush() {
    if (!file || !dirty) return false
    try {
      writeAtomic(file, JSON.stringify({ v: 1, hosts: Object.fromEntries([...owners].map(([id, m]) => [id, Object.fromEntries(m)])) }))
      dirty = false
      return true
    } catch (e) {
      log('owners save failed', { file, error: String(e?.message ?? e) })
      return false
    }
  }

  const timer = file && flushMs > 0 ? setInterval(flush, flushMs) : null
  timer?.unref()

  return { note, has, flush, size: () => owners.size, close: () => (timer && clearInterval(timer), flush()) }
}
