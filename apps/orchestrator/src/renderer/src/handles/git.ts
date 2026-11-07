import { defineHandle, type RendererCtx } from './registry'

const MAX_TEXT = 4000

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect()
  return r.width > 0 && r.height > 0 && (el as HTMLElement).offsetParent !== null
}

function words(el: Element): string {
  const out: string[] = []
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT)
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = (n.textContent ?? '').trim()
    if (t) out.push(t)
  }
  return out.join(' ')
}

function clip(text: string): string {
  return text.length > MAX_TEXT ? `${text.slice(0, MAX_TEXT)}… (${text.length - MAX_TEXT} more chars)` : text
}

function buttonNames(root: Element, re: RegExp): string[] {
  const out: string[] = []
  for (const b of root.querySelectorAll('button')) {
    const name = (b.getAttribute('aria-label') || b.getAttribute('title') || b.textContent || '').trim()
    if (re.test(name)) out.push(`${name}${(b as HTMLButtonElement).disabled ? ' (disabled)' : ''}`)
  }
  return out
}

defineHandle({
  name: 'git.view',
  side: 'renderer',
  description:
    'Reads the Git view on screen as the user sees it: the branch line, the fetch, pull, push and commit button labels (a running fetch, pull or push shows as "Cancel Fetch", "Cancel Pull" or "Cancel Push"), the progress text next to them, every change row with its group (merge, index, workingTree, never), status text and whether it is selected, the stash rows, and the diff that is open on the right, with both sides as text (or the message shown instead, like "The files are identical."). It reads the Git view of the project workspace of the call, so pass the seeded repo as the project. front is false while that workspace is behind another one: reading still works, and workspace.focus brings it to the front for clicks. Rows inside a folded folder are not listed.',
  params: {},
  async run(_p, ctx: RendererCtx) {
    const area = ctx.workspaceId ? document.querySelector(`[data-workspace="${CSS.escape(ctx.workspaceId)}"]`) : null
    if (!area) throw new Error('The project of this call has no workspace in this window. Pass the repo as the project (--project in the CLI).')
    const view = area.querySelector('.scm-view')
    if (!view) throw new Error('The workspace has no Git view open. Open one with layout.open { kind: "git" }.')
    const branchSel = '[title*="/"]:not([data-scm-group]), [title="No upstream branch"]'
    for (let i = 0; i < 50 && !view.querySelector(branchSel); i++) await new Promise((r) => setTimeout(r, 100))
    const changes = [...view.querySelectorAll('[data-scm-group][title]')].filter((el) => (el.getAttribute('title') ?? '').includes(' • ') || el.getAttribute('data-scm-group') === 'never').map((el) => {
      const title = el.getAttribute('title') ?? ''
      const at = title.lastIndexOf(' • ')
      return {
        path: at > 0 ? title.slice(0, at) : title.replace(/ is marked as an env change.*$/, ''),
        status: at > 0 ? title.slice(at + 3) : 'env change',
        group: el.getAttribute('data-scm-group'),
        selected: el.classList.contains('selected')
      }
    })
    const stashes = [...view.querySelectorAll('[title^="#"]')].map((el) => (el.getAttribute('title') ?? '').replace(/\s+/g, ' '))
    const branchEl = view.querySelector(branchSel)
    const branch = branchEl ? words(branchEl) : ''
    const { monaco } = await import('../lib/editor/monaco-setup')
    const loading = (): boolean => [...view.querySelectorAll('.absolute.inset-0')].some((o) => visible(o) && (o.textContent ?? '').trim().startsWith('Loading'))
    for (let i = 0; i < 50 && loading(); i++) await new Promise((r) => setTimeout(r, 100))
    const diffs = monaco.editor
      .getDiffEditors()
      .filter((d) => view.contains(d.getContainerDomNode()))
      .map((d) => {
        const m = d.getModel()
        if (!m) return null
        const host = d.getContainerDomNode()
        const overlay = [...(host.closest('.relative.min-h-0.flex-1')?.querySelectorAll(':scope > .absolute.inset-0') ?? [])].find((o) => !o.contains(host))
        return {
          path: m.modified.uri.path.replace(/^\//, ''),
          original: clip(m.original.getValue()),
          modified: clip(m.modified.getValue()),
          changes: d.getLineChanges()?.length ?? null,
          message: overlay && visible(overlay) ? (overlay.textContent ?? '').trim() : null
        }
      })
    return {
      front: area.getAttribute('data-active') === 'true',
      branch,
      sync: buttonNames(view, /^(Sync|Pull|Push|Publish|Fetch|Cancel)/),
      progress: (view.querySelector('[data-scm-progress]')?.textContent ?? '').trim() || null,
      commit: buttonNames(view, /^(Commit|Continue)/)[0] ?? null,
      message: (view.querySelector('textarea, input[type="text"]') as HTMLTextAreaElement | null)?.value ?? '',
      changes,
      stashes,
      diff: diffs.find((d) => d !== null) ?? null
    }
  }
})
