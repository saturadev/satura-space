import { randomUUID } from 'node:crypto'
import { PTY_SESSION_ID_SEPARATOR } from '../../shared/pty-session-id-format'

export function mintPtySessionId(worktreeId?: string): string {
  return worktreeId
    ? `${worktreeId}${PTY_SESSION_ID_SEPARATOR}${randomUUID().slice(0, 8)}`
    : randomUUID()
}
