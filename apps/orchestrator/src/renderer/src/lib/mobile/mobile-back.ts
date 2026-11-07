import { useEffect, useRef } from 'react'

type Handler = () => void

const stack: { id: number; run: () => void; title: () => string }[] = []
const listeners = new Set<() => void>()
let nextId = 1

export function isMobileLayout(): boolean {
  return typeof document !== 'undefined' && document.documentElement.dataset.layout === 'mobile'
}

function changed(): void {
  for (const l of listeners) l()
}

export function canGoBackInPanel(): boolean {
  return stack.length > 0
}

export function goBackInPanel(): boolean {
  const top = stack[stack.length - 1]
  if (!top) return false
  top.run()
  return true
}

export function panelBackTitles(): string[] {
  return stack.map((e) => e.title())
}

export function onPanelBackChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

export function useMobileBack(handler: Handler | null, title = ''): void {
  const ref = useRef(handler)
  ref.current = handler
  const titleRef = useRef(title)
  if (handler && titleRef.current !== title) {
    titleRef.current = title
    queueMicrotask(changed)
  }
  const active = !!handler && isMobileLayout()
  useEffect(() => {
    if (!active) return
    const entry = { id: nextId++, run: () => ref.current?.(), title: () => titleRef.current }
    stack.push(entry)
    changed()
    return () => {
      const i = stack.findIndex((e) => e.id === entry.id)
      if (i >= 0) stack.splice(i, 1)
      changed()
    }
  }, [active])
}
