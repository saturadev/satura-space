import type { Tab } from '@shared/types'
import { isSceneTuner } from '@shared/tuner-scope'
import { useAppStore } from '../../store'

function sceneKey(t: Tab): string | null {
  if (t.contentType !== 'tuner' || !t.tuner || !isSceneTuner(t.tuner)) return null
  return `${t.worktreeId}|${t.scratchpadId ?? ''}`
}

function callerOf(stack: string | undefined): string {
  const lines = (stack ?? '').split('\n').slice(1).map((l) => l.trim())
  const own = /scene-gate|zustand|node_modules|chunk-|Set\.forEach/
  return lines.filter((l) => !own.test(l)).slice(0, 3).join(' < ') || 'unknown'
}

export function installSceneTunerGate(): () => void {
  return useAppStore.subscribe((now, prev) => {
    for (const [ws, tabs] of Object.entries(now.tabsByWorkspace)) {
      if (tabs === prev.tabsByWorkspace[ws]) continue
      const had = new Set((prev.tabsByWorkspace[ws] ?? []).map((t) => t.id))
      const seen = new Map<string, Tab>()
      const extra: { tab: Tab; keep: Tab }[] = []
      const ordered = [...tabs].sort((a, b) => Number(had.has(b.id)) - Number(had.has(a.id)) || (a.createdAt ?? 0) - (b.createdAt ?? 0))
      for (const t of ordered) {
        const key = sceneKey(t)
        if (!key) continue
        const keep = seen.get(key)
        if (keep) extra.push({ tab: t, keep })
        else seen.set(key, t)
      }
      if (!extra.length) continue
      const caller = callerOf(new Error().stack)
      const wt = now.worktreesByWorkspace[ws] ?? []
      setTimeout(() => {
        for (const { tab, keep } of extra) {
          const path = wt.find((w) => w.id === tab.worktreeId)?.path ?? tab.worktreeId
          console.warn(`[tuner] duplicate scene Tuner blocked: ${path}${tab.scratchpadId ? ` (scratchpad ${tab.scratchpadId})` : ''} tab=${tab.id} kept=${keep.id} caller=${caller}`)
          const st = useAppStore.getState()
          if (!(st.tabsByWorkspace[ws] ?? []).some((t) => t.id === tab.id)) continue
          st.closeTab(tab.id)
          if (st.tabsByWorkspace[ws]?.some((t) => t.id === keep.id)) useAppStore.getState().activateTab(keep.id)
        }
      }, 0)
    }
  })
}
