import { useEffect, useState } from 'react'
import { dialogButtonLabel, type UnityDialog } from '@shared/unity/lifecycle'

export function UnityDialogCard({ project, dialog, remote = false }: { project: string; dialog: UnityDialog; remote?: boolean }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    setBusy(null)
    setError('')
  }, [dialog.id])
  const where = remote ? 'phone' : 'desktop'
  const press = (button: string): void => {
    if (busy) return
    const label = dialogButtonLabel(button)
    setBusy(button)
    setError('')
    console.info(`[unity] ${where} pressed '${label}' in the Unity dialog '${dialog.title || 'untitled'}' for ${project}`)
    void window.api.unity.answerDialog(project, dialog.id, button).then(
      (r) => {
        console.info(`[unity] Unity dialog answer '${label}': ${r.ok ? 'ok' : 'failed'}${r.error ? `: ${r.error}` : r.note ? `: ${r.note}` : ''}`)
        if (!r.ok) {
          setBusy(null)
          setError(r.error || "Unity didn't take the answer.")
        }
      },
      (e: Error) => {
        console.warn(`[unity] Unity dialog answer '${label}' failed: ${e.message}`)
        setBusy(null)
        setError(e.message || "The answer didn't reach the desktop.")
      }
    )
  }
  return (
    <div
      className={`flex w-full flex-col items-center gap-2 text-center ${remote ? 'max-w-[320px]' : 'max-w-md px-6'}`}
      data-unity-dialog={dialog.id}
      data-unity-dialog-title={dialog.title}
    >
      <p className={`uppercase tracking-wide text-amber-300/80 ${remote ? 'text-[11px]' : 'text-[10px]'}`}>Unity is waiting for an answer</p>
      <p className={remote ? 'text-[15px] font-medium text-zinc-100' : 'text-sm text-zinc-100'}>{dialog.title || 'Unity dialog'}</p>
      {dialog.message && (
        <p className={`max-h-[40vh] w-full overflow-y-auto whitespace-pre-line leading-snug text-zinc-400 ${remote ? 'text-[13px]' : 'text-xs'}`}>{dialog.message}</p>
      )}
      {dialog.buttons.length > 0 ? (
        <div className={`mt-2 flex flex-wrap items-center justify-center ${remote ? 'gap-2.5' : 'gap-2'}`}>
          {dialog.buttons.map((b, i) => (
            <button
              key={`${i}:${b}`}
              type="button"
              data-unity-dialog-button={dialogButtonLabel(b)}
              disabled={!!busy}
              onClick={() => press(b)}
              className={
                remote
                  ? `ws-press h-9 rounded-full px-5 text-[14px] font-medium text-zinc-100 disabled:opacity-50 ${busy === b ? 'bg-white/20' : 'bg-white/[0.09]'}`
                  : `rounded px-3 py-1.5 text-xs outline-none transition-colors disabled:opacity-50 ${busy === b ? 'bg-white/20 text-white' : 'border border-white/10 text-zinc-200 hover:bg-white/10 hover:text-white'}`
              }
            >
              {busy === b ? `${dialogButtonLabel(b)}…` : dialogButtonLabel(b)}
            </button>
          ))}
        </div>
      ) : (
        <p className="text-xs text-zinc-500">This dialog has no buttons Satura Space can press. Answer it in Unity on the computer.</p>
      )}
      {error && <p className="text-xs leading-snug text-rose-300" data-unity-dialog-error>{error}</p>}
    </div>
  )
}
