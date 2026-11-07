import { useCallback, useEffect, useRef, useState } from 'react'
import { DEFAULT_SCM_VIEW_SETTINGS, type ScmViewSettings } from '@shared/git-scm'
import { gitScmApi } from './use-scm-repository'

export function useScmSettings(root: string): [ScmViewSettings, (patch: Partial<ScmViewSettings>) => void] {
  const [settings, setSettings] = useState<ScmViewSettings>(DEFAULT_SCM_VIEW_SETTINGS)
  const latest = useRef(settings)
  latest.current = settings

  useEffect(() => {
    let alive = true
    setSettings(DEFAULT_SCM_VIEW_SETTINGS)
    if (!root) return
    void gitScmApi()
      .getSettings(root)
      .then((result) => {
        if (alive && result.ok) setSettings(result.value)
      })
    return () => {
      alive = false
    }
  }, [root])

  const update = useCallback(
    (patch: Partial<ScmViewSettings>) => {
      const next = { ...latest.current, ...patch }
      latest.current = next
      setSettings(next)
      if (root) void gitScmApi().setSettings(root, next)
    },
    [root]
  )

  return [settings, update]
}
