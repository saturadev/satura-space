import { useCallback, useMemo, useState } from 'react'

export const isMac = /Mac/i.test(navigator.platform || navigator.userAgent)

export function isToggleModifier(e: { metaKey: boolean; ctrlKey: boolean }): boolean {
  return isMac ? e.metaKey : e.ctrlKey
}

export type SelectionClick = 'single' | 'toggle' | 'range'

export interface ListSelection {
  readonly selected: ReadonlySet<string>
  readonly size: number
  has(key: string): boolean
  click(e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, key: string, ordered: readonly string[]): SelectionClick
  contextTarget(key: string): string[]
  select(keys: readonly string[]): void
  clear(): void
}

export function useListSelection(): ListSelection {
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [anchor, setAnchor] = useState<string | null>(null)

  const click = useCallback(
    (e: { metaKey: boolean; ctrlKey: boolean; shiftKey: boolean }, key: string, ordered: readonly string[]): SelectionClick => {
      const toggle = isToggleModifier(e)
      if (e.shiftKey && anchor !== null) {
        const from = ordered.indexOf(anchor)
        const to = ordered.indexOf(key)
        if (from !== -1 && to !== -1) {
          const range = ordered.slice(Math.min(from, to), Math.max(from, to) + 1)
          setSelected((prev) => new Set(toggle ? [...prev, ...range] : range))
          return 'range'
        }
      }
      if (toggle) {
        setSelected((prev) => {
          const next = new Set(prev)
          if (next.has(key)) next.delete(key)
          else next.add(key)
          return next
        })
        setAnchor(key)
        return 'toggle'
      }
      setSelected(new Set([key]))
      setAnchor(key)
      return 'single'
    },
    [anchor]
  )

  const contextTarget = useCallback(
    (key: string): string[] => {
      if (selected.has(key)) return [...selected]
      setSelected(new Set([key]))
      setAnchor(key)
      return [key]
    },
    [selected]
  )

  const select = useCallback((keys: readonly string[]) => {
    setSelected(new Set(keys))
    setAnchor(keys.at(-1) ?? null)
  }, [])

  const clear = useCallback(() => {
    setSelected(new Set())
    setAnchor(null)
  }, [])

  return useMemo(
    () => ({
      selected,
      size: selected.size,
      has: (key: string) => selected.has(key),
      click,
      contextTarget,
      select,
      clear
    }),
    [selected, click, contextTarget, select, clear]
  )
}
