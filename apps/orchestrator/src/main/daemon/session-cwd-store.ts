import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

const MAX_SESSIONS = 500

export class SessionCwdStore {
  private cwds: Record<string, string> = {}

  constructor(private readonly file: string) {
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [id, cwd] of Object.entries(parsed)) if (typeof cwd === 'string' && cwd) this.cwds[id] = cwd
      }
    } catch {
    }
  }

  get(sessionId: string): string | undefined {
    return this.cwds[sessionId]
  }

  set(sessionId: string, cwd: string): void {
    if (!cwd || this.cwds[sessionId] === cwd) return
    delete this.cwds[sessionId]
    this.cwds[sessionId] = cwd
    const ids = Object.keys(this.cwds)
    for (const id of ids.slice(0, Math.max(0, ids.length - MAX_SESSIONS))) delete this.cwds[id]
    this.save()
  }

  delete(sessionId: string): void {
    if (!(sessionId in this.cwds)) return
    delete this.cwds[sessionId]
    this.save()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      writeFileSync(this.file, JSON.stringify(this.cwds))
    } catch (err) {
      console.warn('[daemon] saving terminal cwds failed:', err)
    }
  }
}
