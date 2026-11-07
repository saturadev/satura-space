import type { TunerDropdownItem } from '@shared/tuner-inspector-popups'

export interface DropdownHit {
  item: TunerDropdownItem
  path: string[]
}

export function isGroup(item: TunerDropdownItem): boolean {
  return !!item.ch && item.ch.length > 0
}

export function leaves(items: TunerDropdownItem[], path: string[] = [], out: DropdownHit[] = []): DropdownHit[] {
  for (const item of items) {
    if (item.sep || item.help) continue
    if (isGroup(item)) leaves(item.ch ?? [], [...path, item.name], out)
    else out.push({ item, path })
  }
  return out
}

export function searchDropdown(items: TunerDropdownItem[], query: string): DropdownHit[] {
  const q = query.trim()
  if (!q) return []
  const words = q.toLowerCase().split(' ').filter((w) => w.length > 0)
  if (words.length === 0) return []
  const starts: DropdownHit[] = []
  const within: DropdownHit[] = []
  for (const hit of leaves(items)) {
    const name = hit.item.name.toLowerCase().replace(/ /g, '')
    let all = true
    let first = false
    for (let w = 0; w < words.length; w++) {
      if (!name.includes(words[w])) {
        all = false
        break
      }
      if (w === 0 && name.startsWith(words[w])) first = true
    }
    if (!all) continue
    ;(first ? starts : within).push(hit)
  }
  const byName = (a: DropdownHit, b: DropdownHit): number => (a.item.name < b.item.name ? -1 : a.item.name > b.item.name ? 1 : 0)
  starts.sort(byName)
  within.sort(byName)
  return [...starts, ...within]
}

export function findPath(items: TunerDropdownItem[], id: number, path: TunerDropdownItem[] = []): TunerDropdownItem[] | null {
  for (const item of items) {
    if (item.id === id) return [...path, item]
    if (item.ch) {
      const found = findPath(item.ch, id, [...path, item])
      if (found) return found
    }
  }
  return null
}

export function stepSelectable(items: TunerDropdownItem[], from: number, dir: 1 | -1): number {
  const n = items.length
  if (n === 0) return -1
  let i = from
  for (let k = 0; k < n; k++) {
    i = i < 0 ? (dir > 0 ? 0 : n - 1) : i + dir
    if (i < 0 || i >= n) return from
    if (!items[i].sep && !items[i].help) return i
  }
  return from
}
