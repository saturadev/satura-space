import { useEffect, useState } from 'react'

export function useEditorRevealed(projectPath: string | null | undefined): boolean | null {
  const [state, setState] = useState<{ projectPath: string; revealed: boolean } | null>(null)
  useEffect(() => {
    if (!projectPath) return
    let alive = true
    let seq = 0
    const check = (): void => {
      const mine = ++seq
      void window.api.unity.isEditorRevealed(projectPath).then((revealed) => {
        if (alive && mine === seq) setState({ projectPath, revealed })
      })
    }
    check()
    const off = window.api.unity.onEditorRevealChanged(() => check())
    return () => {
      alive = false
      off()
    }
  }, [projectPath])
  if (!projectPath) return false
  return state && state.projectPath === projectPath ? state.revealed : null
}
