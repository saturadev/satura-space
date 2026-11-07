import { defineHandle, type RendererCtx } from './registry'
import { openFileInWorkbench } from '../lib/editor/open-file'
import { useAppStore } from '../store'
import { runFileVersionsCall, useFileVersions } from '../lib/editor/file-versions-store'
import { versionStamp } from '../lib/editor/file-versions'

async function until<T>(read: () => T | null | undefined | false, ms: number): Promise<T | null> {
  const end = Date.now() + ms
  for (;;) {
    const v = read()
    if (v) return v
    if (Date.now() > end) return null
    await new Promise((r) => setTimeout(r, 50))
  }
}

function viewerTabs(file: string): string[] {
  const s = useAppStore.getState()
  return Object.values(s.tabsByWorkspace).flatMap((tabs) => tabs.filter((t) => t.contentType === 'file-viewer' && s.viewerFileByTab[t.id] === file).map((t) => t.id))
}

async function shownEditor(file: string) {
  const { monaco } = await import('../lib/editor/monaco-setup')
  return until(() => monaco.editor.getEditors().find((e) => e.getModel()?.uri.path === file && e.getDomNode()?.isConnected), 8000)
}

function popupNow(): { title: string; rows: string[]; buttons: string[] } | null {
  const el = document.querySelector('[data-versions-dialog]')
  if (!el) return null
  return {
    title: el.querySelector('h2')?.textContent ?? el.getAttribute('aria-label') ?? '',
    rows: Array.from(el.querySelectorAll('[data-versions-row]'), (r) => (r as HTMLElement).innerText.replace(/\n+/g, ' · ')),
    buttons: Array.from(el.querySelectorAll('[data-versions-choice]'), (b) => `${b.getAttribute('data-versions-choice')}: ${b.textContent ?? ''}`)
  }
}

async function compareNow(): Promise<{ title: string; theirs: string; mine: string; legend: string } | null> {
  const el = document.querySelector('[data-compare-view]')
  if (!el) return null
  const { monaco } = await import('../lib/editor/monaco-setup')
  const models = monaco.editor.getModels().filter((m) => m.uri.scheme === 'merge-conflict.conflict-diff')
  const last = (side: string) => models.filter((m) => m.uri.path === `/${side}`).pop()?.getValue() ?? ''
  return {
    title: el.querySelector('span')?.textContent ?? '',
    theirs: last('current'),
    mine: last('incoming'),
    legend: (el.querySelector('[data-compare-footer]') as HTMLElement | null)?.innerText.replace(/\n+/g, ' · ') ?? ''
  }
}

defineHandle({
  name: 'editor.versions',
  side: 'renderer',
  description:
    "Drives the copies of one text file in this window, for the two-versions popup. op open shows file in a viewer tab of the project workspace (reusing one) and returns its tab id. op type types text into the editor that shows file, at line and column (default the start). op cursor puts that editor's cursor at line and column. op save saves that editor the way Cmd+S does; with racer, that text is written to disk the moment before, as an agent racing the save would, before the editor has seen it. op phone runs a phone's call on this Mac's copy as Satura Remote sends it: phoneOp edit or save, text, and base (default the stamp of the current disk text, with based: draft the stamp of the unsaved edit), and returns the Mac's reply. op answer clicks a choice in the two-versions popup or the compare view: keep, take, compare or later. op state reads the file on disk, this window's unsaved edit (draft) with who made it and the disk version it started from, what its editors show and where their cursors are, the two-versions bar, the popup (title, the two versions it names, its buttons) and the compare view (both sides). Returns what it saw.",
  params: { op: 'state', file: '', text: '', line: 1, column: 1, answer: 'keep', racer: '', phoneOp: 'edit', based: 'disk' },
  async run(p, ctx: RendererCtx) {
    const file = String(p.file ?? '')
    if (!file) throw new Error('Pass file, an absolute path.')
    const op = String(p.op)
    const state = async () => {
      const s = useAppStore.getState()
      const v = useFileVersions.getState()
      const { monaco } = await import('../lib/editor/monaco-setup')
      const disk = await window.api.fs.readFile(file).then((r) => (r.notFound ? null : r.content), () => null)
      return {
        disk,
        draft: s.draftsByPath[file] ?? null,
        draftMeta: s.draftMetaByPath[file] ?? null,
        tabs: viewerTabs(file),
        editors: monaco.editor.getEditors().filter((e) => e.getModel()?.uri.path === file && e.getDomNode()?.isConnected).map((e) => e.getValue()),
        cursors: monaco.editor.getEditors().filter((e) => e.getModel()?.uri.path === file && e.getDomNode()?.isConnected).map((e) => e.getPosition()),
        bar: (document.querySelector('[data-file-versions-bar]') as HTMLElement | null)?.innerText.replace(/\n+/g, ' · ') ?? null,
        conflict: v.push[file] ?? v.disk[file] ?? null,
        popup: popupNow(),
        compare: await compareNow()
      }
    }
    if (op === 'state') return state()
    if (op === 'phone') {
      const phoneOp = String(p.phoneOp) === 'save' ? 'save' : 'edit'
      const s = useAppStore.getState()
      const disk = await window.api.fs.readFile(file).then((r) => (r.notFound ? '' : r.content))
      const base = versionStamp(String(p.based) === 'draft' ? (s.draftsByPath[file] ?? disk) : disk)
      const reply = await runFileVersionsCall(phoneOp, { file, base, text: String(p.text) })
      await new Promise((r) => setTimeout(r, 300))
      return { reply, ...(await state()) }
    }
    if (op === 'open') {
      let tab = viewerTabs(file)[0]
      if (!tab) {
        if (!openFileInWorkbench({ file, workspaceId: ctx.workspaceId || undefined, projectPath: ctx.projectRoot, newTab: true })) throw new Error(`${file} didn't open.`)
        tab = (await until(() => viewerTabs(file)[0], 5000)) ?? ''
      } else useAppStore.getState().activateTab(tab)
      if (!tab) throw new Error(`No tab opened for ${file}.`)
      await shownEditor(file)
      return { tabId: tab, ...(await state()) }
    }
    if (op === 'answer') {
      const want = String(p.answer)
      const button = await until(() => document.querySelector<HTMLButtonElement>(`[data-versions-dialog] [data-versions-choice="${want}"], [data-compare-footer] [data-versions-choice="${want}"]`), 4000)
      if (!button) throw new Error(`No ${want} choice on screen.`)
      button.click()
      await new Promise((r) => setTimeout(r, 600))
      return { clicked: want, ...(await state()) }
    }
    const editor = await shownEditor(file)
    if (!editor) throw new Error(`No editor shows ${file}.`)
    if (op === 'cursor') {
      editor.setPosition({ lineNumber: Number(p.line) || 1, column: Number(p.column) || 1 })
      return state()
    }
    if (op === 'type') {
      editor.focus()
      editor.setPosition({ lineNumber: Number(p.line) || 1, column: Number(p.column) || 1 })
      editor.trigger('keyboard', 'type', { text: String(p.text) })
      await new Promise((r) => setTimeout(r, 300))
      return state()
    }
    if (op === 'save') {
      editor.focus()
      if (String(p.racer ?? '')) await window.api.fs.writeFile(file, String(p.racer))
      await editor.getAction('satura.action.save')?.run()
      await new Promise((r) => setTimeout(r, 500))
      return state()
    }
    throw new Error(`Unknown op ${op}.`)
  }
})
