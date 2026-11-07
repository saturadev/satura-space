import { Anchor } from '../../main/satura-exec/page/anchor'
import type { Box } from '../../main/satura-exec/page/bubble'
import type { WorkspaceScope } from '../../main/satura-exec/page/scope'
import { exactPart, type Part } from '../../main/satura-exec/page/field-part'

export { whole, valuePart, labelPart, type Part } from '../../main/satura-exec/page/field-part'

export function anchorOn(el: Element, part: Part, frac: { x: number; y: number }, key: string, scope: WorkspaceScope): Anchor {
  return new Anchor(window, el, frac, key, scope, null, () => key, exactPart(part, key))
}

export function fracPoint(b: Box, frac: { x: number; y: number }): { x: number; y: number } {
  return { x: b.x + b.width * frac.x, y: b.y + b.height * frac.y }
}
