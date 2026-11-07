import { useState } from 'react'
import { requestConfirm } from '../confirm/confirm-store'

export function useRestartDaemon(): { restarting: boolean; restartDaemon: () => Promise<void> } {
  const [restarting, setRestarting] = useState(false)

  const restartDaemon = async (): Promise<void> => {
    const ok = await requestConfirm({
      title: 'Restart the terminal daemon?',
      message:
        'Kills every running terminal pane and restarts the daemon process. Panes show "Process exited" and can be reopened immediately. Legacy-protocol sessions from a previous app version are preserved. This can\'t be undone.',
      confirmLabel: 'Restart daemon',
      danger: true
    })
    if (!ok) return
    setRestarting(true)
    try {
      await window.api.pty.restartDaemon()
    } catch (err) {
      void requestConfirm({
        title: 'Terminal daemon restart failed',
        message: err instanceof Error ? err.message : String(err),
        confirmLabel: 'OK',
        hideCancel: true
      })
    } finally {
      setRestarting(false)
    }
  }

  return { restarting, restartDaemon }
}
