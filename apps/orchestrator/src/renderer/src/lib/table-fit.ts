import { isValidElement, type ReactNode } from 'react'

const SHORT_CELL = 30
const MAX_SCAN = 400
const WIDE = /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/

export function nodeText(node: ReactNode, depth = 0): string {
  if (node == null || typeof node === 'boolean') return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number' || typeof node === 'bigint') return String(node)
  if (depth > 8) return ''
  if (Array.isArray(node)) {
    let out = ''
    for (const n of node) {
      out += nodeText(n as ReactNode, depth + 1)
      if (out.length > MAX_SCAN) break
    }
    return out
  }
  if (isValidElement(node)) return nodeText((node.props as { children?: ReactNode }).children, depth + 1)
  return ''
}

interface HastLike {
  type?: string
  value?: string
  children?: HastLike[]
}

export function hastText(node: HastLike | undefined, depth = 0): string {
  if (!node || depth > 8) return ''
  if (node.type === 'text') return node.value ?? ''
  let out = ''
  for (const c of node.children ?? []) {
    out += hastText(c, depth + 1)
    if (out.length > MAX_SCAN) break
  }
  return out
}

function visualWidth(text: string): number {
  let w = 0
  for (const ch of text.trim()) {
    w += WIDE.test(ch) ? 2 : 1
    if (w > SHORT_CELL) break
  }
  return w
}

export function cellFit(...texts: string[]): string {
  let widest = 0
  for (const t of texts) widest = Math.max(widest, visualWidth(t))
  if (!widest) return ''
  return widest <= SHORT_CELL ? 'tf-nw' : 'tf-long'
}
