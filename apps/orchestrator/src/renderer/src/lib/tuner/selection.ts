export interface TunerSelection {
  ids: string[]
  active: string | null
}

export type PickMode = 'normal' | 'add' | 'sub'

export const NO_SELECTION: TunerSelection = { ids: [], active: null }

export function selectionOf(id: string | null): TunerSelection {
  return id ? { ids: [id], active: id } : NO_SELECTION
}

export function sameSelection(a: TunerSelection, b: TunerSelection): boolean {
  return a.active === b.active && a.ids.length === b.ids.length && a.ids.every((x, i) => x === b.ids[i])
}

function firstAndLast(all: readonly string[], selected: readonly string[]): [number, number] | null {
  if (selected.length === 0) return null
  const set = new Set(selected)
  let first = -1
  let last = -1
  for (let i = 0; i < all.length; i++) {
    if (!set.has(all[i])) continue
    if (first < 0) first = i
    last = i
  }
  return first < 0 ? null : [first, last]
}

export interface MultiSelectArgs {
  clicked: string
  all: readonly string[]
  selected: readonly string[]
  lastClicked: string | null
  keepMulti?: boolean
  allowMulti?: boolean
  range?: boolean
  toggle?: boolean
  arrowKeys?: boolean
}

export function handleMultiSelection(a: MultiSelectArgs): string[] {
  const { clicked, all, selected, lastClicked } = a
  const keepMulti = a.keepMulti === true
  let range = a.range === true
  let toggle = a.toggle === true
  if (a.allowMulti === false) range = toggle = false
  if (toggle && !range) {
    const next = [...selected]
    const at = next.indexOf(clicked)
    if (at >= 0) {
      if (!keepMulti) next.splice(at, 1)
    } else next.push(clicked)
    return next
  }
  if (range) {
    if (clicked === lastClicked) return [...selected]
    const fl = firstAndLast(all, selected)
    if (!fl) return [clicked]
    const [firstIndex, lastIndex] = fl
    const newIndex = all.indexOf(clicked)
    const prevIndex = lastClicked == null ? -1 : all.indexOf(lastClicked)
    if (newIndex < 0) return []
    let dir = 0
    if (prevIndex !== -1) dir = newIndex > prevIndex ? 1 : -1
    let from = 0
    let to = 0
    let addExisting = false
    const usingArrowKeys = a.arrowKeys === true
    const clickedInTheMiddle = lastIndex > newIndex && firstIndex < newIndex
    if (selected.length > 1) {
      const noGapsInSelection = all.length - firstIndex + selected.length === all.length - lastIndex
      const isInSelection = selected.includes(all[newIndex])
      if (isInSelection || noGapsInSelection || clickedInTheMiddle) {
        from = dir > 0 ? firstIndex : newIndex
        to = dir > 0 ? newIndex : lastIndex
        if (clickedInTheMiddle && !noGapsInSelection && !isInSelection) addExisting = true
      } else if (dir > 0) {
        if (newIndex > lastIndex) {
          from = lastIndex + 1
          to = newIndex
          addExisting = true
        } else {
          from = newIndex
          to = lastIndex
        }
      } else if (dir < 0) {
        if (newIndex < firstIndex) {
          from = newIndex
          to = firstIndex - 1
          addExisting = true
        } else {
          from = firstIndex
          to = newIndex
        }
      }
    }
    if (!addExisting || usingArrowKeys) {
      if (newIndex > lastIndex) {
        from = firstIndex
        to = newIndex
      } else if (newIndex >= firstIndex && newIndex < lastIndex) {
        if (dir > 0) {
          from = newIndex
          to = lastIndex
        } else {
          from = firstIndex
          to = newIndex
        }
      } else {
        from = newIndex
        to = lastIndex
      }
    }
    if (addExisting && !usingArrowKeys) {
      const out = [...selected, ...all.slice(from, to + 1)]
      return clickedInTheMiddle ? [...new Set(out)] : out
    }
    return all.slice(from, to + 1)
  }
  if (keepMulti && selected.includes(clicked)) return [...selected]
  return [clicked]
}

export function hierarchySelection(ids: string[]): TunerSelection {
  const unique = [...new Set(ids)]
  return { ids: unique, active: unique.length ? unique[unique.length - 1] : null }
}

export function withActive(ids: string[], active: string | null): TunerSelection {
  const unique = [...new Set(ids)]
  if (unique.length === 0) return NO_SELECTION
  return { ids: unique, active: active && unique.includes(active) ? active : unique[0] }
}

export interface ViewportHit {
  exact: string | null
  base: string | null
  chain: string[]
}

export function viewportClick(sel: TunerSelection, hit: ViewportHit | null, mode: PickMode): TunerSelection {
  if (mode === 'normal') return selectionOf(hit ? (hit.base ?? hit.exact) : null)
  if (!hit) return sel
  if (mode === 'add' && hit.exact && sel.active === hit.exact)
    return withActive(
      sel.ids.filter((x) => x !== hit.exact),
      sel.active
    )
  if (mode === 'sub') {
    const drop = new Set(hit.chain.filter((x) => sel.ids.includes(x)))
    if (drop.size > 0)
      return withActive(
        sel.ids.filter((x) => !drop.has(x)),
        sel.active
      )
  }
  const picked = hit.base ?? hit.exact
  if (!picked) return sel
  return withActive([...sel.ids, picked], picked)
}

export function rectSelection(start: TunerSelection, picked: string[], mode: PickMode): TunerSelection {
  if (mode === 'add') {
    if (picked.length === 0) return start
    const ids = [...start.ids, ...picked]
    return withActive(ids, ids[0])
  }
  if (mode === 'sub') {
    const drop = new Set(picked)
    return withActive(
      start.ids.filter((x) => !drop.has(x)),
      start.active
    )
  }
  return withActive(picked, start.active)
}

export function topLevel<T extends { id: string; path: string; scene: string }>(objects: T[]): T[] {
  return objects.filter((o) => !objects.some((p) => p !== o && p.scene === o.scene && p.path && o.path.startsWith(`${p.path}/`)))
}
