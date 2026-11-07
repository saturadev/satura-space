import { defineHandle, type RendererCtx } from './registry'

function nameOf(el: Element): string {
  return (el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '').trim().replace(/\s+/g, ' ')
}

function matcher(name: string): (s: string) => boolean {
  if (!name) return () => true
  const re = /^\/(.*)\/([a-z]*)$/.exec(name)
  if (re) {
    const r = new RegExp(re[1], re[2])
    return (s) => r.test(s)
  }
  return (s) => s === name
}

function dialog(): { title: string; message: string; buttons: string[] } | null {
  const el = document.querySelector('[data-confirm-dialog]')
  if (!el) return null
  return {
    title: el.querySelector('h2')?.textContent ?? '',
    message: el.querySelector('p')?.textContent ?? '',
    buttons: Array.from(el.querySelectorAll('button'), (b) => (b.textContent ?? '').trim())
  }
}

function fill(el: Element, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

defineHandle({
  name: 'ui.act',
  side: 'renderer',
  description:
    "Finds elements in this window the way a user picks them and acts on them. selector is a CSS selector (default button), within a CSS selector of the containers to search in (default the project workspace; 'document' for the whole window, like the confirm dialog), name filters by aria-label, title or text (exact, or /regex/flags), index picks one of the matches. op read only lists them; click clicks the picked one; fill sets an input or textarea to value the way typing does; key presses key (like Enter) on it. Waits up to wait ms for a match. Returns the matches, what it did and the confirm dialog shown afterwards.",
  params: { op: 'read', selector: 'button', within: '', name: '', index: 0, value: '', key: '', wait: 2000 },
  async run(p, ctx: RendererCtx) {
    const within = String(p.within ?? '')
    const roots = (): Element[] => {
      if (within === 'document') return [document.body]
      const area = ctx.workspaceId ? document.querySelector(`[data-workspace="${CSS.escape(ctx.workspaceId)}"]`) : null
      const base = area ?? document.body
      return within ? [...base.querySelectorAll(within)] : [base]
    }
    const ok = matcher(String(p.name ?? ''))
    const find = (): Element[] => roots().flatMap((r) => [...r.querySelectorAll(String(p.selector || 'button'))]).filter((el) => ok(nameOf(el)))
    const end = Date.now() + Math.max(0, Number(p.wait ?? 2000))
    let found = find()
    while (!found.length && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 50))
      found = find()
    }
    const matches = found.slice(0, 40).map((el) => ({ tag: el.tagName.toLowerCase(), name: nameOf(el).slice(0, 160), disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true' }))
    const op = String(p.op ?? 'read')
    const el = found[Number(p.index ?? 0)]
    if (op !== 'read' && !el) throw new Error(`Nothing matches ${String(p.selector)} named ${String(p.name) || 'anything'}${within ? ` within ${within}` : ''}.`)
    if (op === 'click') (el as HTMLElement).click()
    else if (op === 'fill') fill(el, String(p.value ?? ''))
    else if (op === 'key') {
      const key = String(p.key || 'Enter')
      el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
      el.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
    }
    if (op !== 'read') await new Promise((r) => setTimeout(r, 150))
    return { count: found.length, matches, did: op === 'read' ? null : `${op} ${el ? nameOf(el).slice(0, 80) : ''}`, dialog: dialog() }
  }
})
