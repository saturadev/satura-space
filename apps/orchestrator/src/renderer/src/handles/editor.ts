import { defineHandle, type RendererCtx } from './registry'
import { openFileInWorkbench } from '../lib/editor/open-file'
import { useAppStore } from '../store'
import { renameExplorerPath } from '../lib/editor/move-file'

interface LineTokensLike {
  findTokenIndexAtOffset(offset: number): number
  getClassName(i: number): string
  getStandardTokenType(i: number): number
  getStartOffset(i: number): number
  getEndOffset(i: number): number
}

interface TokenizedModel {
  tokenization: { forceTokenization(line: number): void; getLineTokens(line: number): LineTokensLike }
}

const STANDARD = ['other', 'comment', 'string', 'regexp']

function rgbHex(rgb: string): string {
  const m = rgb.match(/\d+/g)
  return m ? `#${m.slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('')}` : rgb
}

defineHandle({
  name: 'editor.open',
  side: 'renderer',
  description: 'Opens a file in the file viewer of the project workspace, at line when given. Returns whether it opened.',
  params: { file: '', line: 0 },
  async run(p, ctx: RendererCtx) {
    const file = String(p.file ?? '')
    if (!file) throw new Error('Pass file, an absolute path.')
    const line = Number(p.line) || undefined
    const opened = openFileInWorkbench({ file, line, workspaceId: ctx.workspaceId || undefined, projectPath: ctx.projectRoot, newTab: true })
    await new Promise((r) => setTimeout(r, 800))
    return { opened }
  }
})

defineHandle({
  name: 'viewer.state',
  side: 'renderer',
  description:
    "Reads the Live toggle (re-read from disk every second) and the Blame toggle of the file viewer tabs in this window whose file path ends with file, the same state the toolbar buttons and the phone's actions show. live: true or false sets Live on the first such tab, and blame: true or false sets Blame for its file, as a click on the desktop button would. Returns each matching tab with its file, Live and Blame.",
  params: { file: '', live: '', blame: '' },
  async run(p) {
    const suffix = String(p.file ?? '')
    if (!suffix) throw new Error('Pass file, the end of the viewer file path.')
    const s = useAppStore.getState()
    const tabs = Object.entries(s.viewerFileByTab).filter(([, f]) => f.endsWith(suffix))
    if (!tabs.length) throw new Error(`No viewer tab shows a file ending with ${suffix}.`)
    const flag = (v: unknown): boolean | null => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null)
    const live = flag(p.live)
    const blame = flag(p.blame)
    if (live !== null) s.setViewerLive(tabs[0][0], live)
    if (blame !== null && !!s.blameEnabledByPath[tabs[0][1]] !== blame) s.toggleBlame(tabs[0][1])
    if (live !== null || blame !== null) await new Promise((r) => setTimeout(r, 300))
    const now = useAppStore.getState()
    return tabs.map(([tab, file]) => ({ tab, file, live: !!now.liveByTab[tab], blame: !!now.blameEnabledByPath[file] }))
  }
})

defineHandle({
  name: 'editor.tokens',
  side: 'renderer',
  description:
    'Reads syntax tokens from every open Monaco editor whose file path ends with path. For each text in find, it takes the first occurrence and returns the language, whether the TextMate tokenizer is active for it, and the tokens that cover the text: their text, Monaco class, standard type (other, comment, string, regexp), the colour they render in, whether that colour is the invalid red, and the TextMate scopes. It also returns how long the TextMate engine took to load.',
  params: { path: '', find: [] },
  async run(p) {
    const { monaco } = await import('../lib/editor/monaco-setup')
    const { textMateScopes, textMateLoadMs } = await import('../lib/editor/textmate/textmate')
    const { TokenizationRegistry } = await import('monaco-editor/esm/vs/editor/common/languages.js')
    const suffix = String(p.path ?? '')
    const finds = (Array.isArray(p.find) ? p.find : [p.find]).map(String).filter(Boolean)
    const editors = monaco.editor.getEditors().filter((e) => e.getModel()?.uri.path.endsWith(suffix))
    if (!editors.length) throw new Error(`No open editor has a file ending with ${suffix}.`)
    const out = []
    for (const editor of editors) {
      const model = editor.getModel()!
      const lang = model.getLanguageId()
      const support = TokenizationRegistry.get(lang) as { createBackgroundTokenizer?: unknown } | null
      const host = editor.getDomNode()?.querySelector('.monaco-editor') ?? editor.getDomNode()
      const probe = document.createElement('span')
      host?.appendChild(probe)
      const colorOf = (cls: string): string => {
        probe.className = cls
        return rgbHex(getComputedStyle(probe).color)
      }
      const scopes = await textMateScopes(lang, model.uri.path, model.getValue())
      const results = finds.map((text) => {
        const match = model.findNextMatch(text, { lineNumber: 1, column: 1 }, false, true, null, false)
        if (!match) return { text, found: false }
        const ln = match.range.startLineNumber
        const tm = model as unknown as TokenizedModel
        tm.tokenization.forceTokenization(ln)
        const lt = tm.tokenization.getLineTokens(ln)
        const from = match.range.startColumn - 1
        const to = match.range.endColumn - 1
        const tokens = []
        for (let i = lt.findTokenIndexAtOffset(from); i >= 0; i++) {
          const start = lt.getStartOffset(i)
          if (start >= to) break
          const cls = lt.getClassName(i)
          const color = colorOf(cls)
          const at = Math.max(start, from)
          const sc = scopes.lines[ln - 1]?.find((t) => t.start <= at && at < t.end)
          tokens.push({
            text: model.getLineContent(ln).slice(start, lt.getEndOffset(i)),
            className: cls,
            type: STANDARD[lt.getStandardTokenType(i)] ?? 'other',
            color,
            invalidRed: color.toLowerCase() === '#f44747',
            scopes: sc?.scopes ?? []
          })
          if (lt.getEndOffset(i) >= to) break
        }
        return { text, found: true, line: ln, column: match.range.startColumn, tokens }
      })
      probe.remove()
      out.push({ uri: model.uri.toString(), language: lang, textMate: !!support?.createBackgroundTokenizer, grammar: scopes.grammar, results })
    }
    return { loadMs: await textMateLoadMs(), editors: out }
  }
})

interface DialogSeen {
  title: string
  message: string
  files: string[]
  buttons: string[]
  id?: number
}

const ANSWER_LABEL: Record<string, RegExp> = { save: /^Save( All)?$|^Close (Workspace|Window)$/, dont: /^Don.t Save$/, cancel: /^Cancel$/ }

async function until<T>(read: () => T | null | undefined | false, ms: number): Promise<T | null> {
  const end = Date.now() + ms
  for (;;) {
    const v = read()
    if (v) return v
    if (Date.now() > end) return null
    await new Promise((r) => setTimeout(r, 50))
  }
}

function dialogNow(): DialogSeen | null {
  const el = document.querySelector('[data-confirm-dialog]')
  if (!el) return null
  return {
    title: el.querySelector('h2')?.textContent ?? '',
    message: el.querySelector('p')?.textContent ?? '',
    files: Array.from(el.querySelectorAll('[data-confirm-project] .truncate[title]'), (f) => f.textContent ?? ''),
    buttons: Array.from(el.querySelectorAll('button'), (b) => b.textContent ?? '')
  }
}

function clickAnswer(answer: string): boolean {
  const want = ANSWER_LABEL[answer]
  const button = want ? Array.from(document.querySelectorAll<HTMLButtonElement>('[data-confirm-dialog] button')).find((b) => want.test((b.textContent ?? '').trim())) : null
  button?.click()
  return !!button
}

function viewerTabs(file: string): { tabId: string; workspaceId: string }[] {
  const s = useAppStore.getState()
  return Object.entries(s.tabsByWorkspace).flatMap(([workspaceId, tabs]) =>
    tabs.filter((t) => t.contentType === 'file-viewer' && s.viewerFileByTab[t.id] === file).map((t) => ({ tabId: t.id, workspaceId }))
  )
}

defineHandle({
  name: 'editor.unsavedStep',
  side: 'renderer',
  description:
    "One step of editor.unsavedClose in this window. op edit opens file in a new tab (in a terminal-only workspace on folder when given), types text into it and, with split, opens it in a second tab. op close closes tabId the way via does (x, middle, menu, phone, workspace) and answers the dialog (save, dont, cancel, none). op answer answers the dialog shown in this window, op click clicks the button labelled answer, op moveWorkspace moves the workspace on folder to the window whose id is tabId, op popout moves tabId to a new window, op state reads the tabs and draft of file, op cleanup drops the draft, the tabs and the workspace on folder. Returns what it saw.",
  params: { op: 'state', file: '', folder: '', text: '', split: false, tabId: '', via: 'x', answer: 'none' },
  async run(p, ctx: RendererCtx) {
    const file = String(p.file ?? '')
    const folder = String(p.folder ?? '')
    const op = String(p.op)
    const state = () => {
      const s = useAppStore.getState()
      return { tabs: viewerTabs(file), draft: file in s.draftsByPath, workspaceOpen: !!folder && s.workspaces.some((w) => w.folderPath === folder), dialogOpen: !!dialogNow() }
    }
    if (op === 'state') return state()
    if (op === 'answer') {
      const seen = await until(dialogNow, 8000)
      if (seen && p.answer !== 'none') clickAnswer(String(p.answer))
      await new Promise((r) => setTimeout(r, 800))
      return { dialog: seen, ...state() }
    }
    if (op === 'click') {
      const label = String(p.answer)
      const button = await until(() => Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((b) => (b.textContent ?? '').trim() === label), 8000)
      button?.click()
      await new Promise((r) => setTimeout(r, 300))
      return { clicked: !!button, ...state() }
    }
    if (op === 'moveWorkspace') {
      const { moveWorkspaceToWindow } = await import('../lib/workspace-move')
      const ws = useAppStore.getState().workspaces.find((w) => w.folderPath === folder)
      if (!ws) throw new Error(`No workspace on ${folder}.`)
      return { moved: await moveWorkspaceToWindow(ws.id, String(p.tabId)), ...state() }
    }
    if (op === 'popout') {
      const { moveTabToWindow } = await import('../lib/panel-move')
      return { moved: await moveTabToWindow(String(p.tabId), 'new'), ...state() }
    }
    if (op === 'cleanup') {
      if (dialogNow() && clickAnswer('cancel')) await new Promise((r) => setTimeout(r, 300))
      const s = useAppStore.getState()
      if (file) s.setDraft(file, null)
      for (const t of viewerTabs(file)) useAppStore.getState().closeTab(t.tabId)
      const ws = folder ? s.workspaces.find((w) => w.folderPath === folder) : null
      if (ws) useAppStore.getState().deleteWorkspace(ws.id)
      return state()
    }
    if (op === 'edit') {
      if (!file) throw new Error('Pass file, an absolute path.')
      let workspaceId = ctx.workspaceId
      if (folder) {
        const s = useAppStore.getState()
        workspaceId = s.workspaces.find((w) => w.folderPath === folder)?.id ?? s.createWorkspaceWithGrid(folder, folder, 1, 1)
        s.setActiveWorkspace(workspaceId)
      }
      const before = new Set(viewerTabs(file).map((t) => t.tabId))
      if (!openFileInWorkbench({ file, workspaceId, projectPath: folder || ctx.projectRoot, newTab: true })) throw new Error(`${file} didn't open.`)
      const tab = await until(() => viewerTabs(file).find((t) => !before.has(t.tabId)), 5000)
      if (!tab) throw new Error(`No tab opened for ${file}.`)
      const { monaco } = await import('../lib/editor/monaco-setup')
      const editor = await until(() => monaco.editor.getEditors().find((e) => e.getModel()?.uri.path === file && e.getDomNode()?.isConnected && !!e.getModel()?.getValue()), 8000)
      if (!editor) throw new Error(`No editor shows ${file}.`)
      await new Promise((r) => setTimeout(r, 300))
      editor.focus()
      editor.setPosition({ lineNumber: 1, column: 1 })
      editor.trigger('keyboard', 'type', { text: String(p.text || 'unsaved edit ') })
      if (!(await until(() => file in useAppStore.getState().draftsByPath, 3000))) throw new Error(`Typing into ${file} left no unsaved draft.`)
      if (p.split === true || p.split === 'true') {
        openFileInWorkbench({ file, workspaceId, projectPath: folder || ctx.projectRoot, newTab: true })
        await until(() => viewerTabs(file).length > before.size + 1, 5000)
      }
      return { tabId: tab.tabId, workspaceId: tab.workspaceId, ...state() }
    }
    if (op !== 'close') throw new Error(`Unknown op ${op}.`)
    const tabId = String(p.tabId)
    const via = String(p.via)
    const answer = String(p.answer)
    let seen: DialogSeen | null = null
    if (via === 'phone') {
      const { runDesktopCall } = await import('../lib/actions/desktop-actions')
      const r = (await runDesktopCall('runPanelAction', [tabId, 'tab.close', null])) as { confirm: (DialogSeen & { id: number; confirmLabel?: string; secondaryLabel?: string; cancelLabel?: string }) | null }
      const c = r.confirm
      seen = c ? { id: c.id, title: c.title, message: c.message, files: [], buttons: [c.cancelLabel ?? 'Cancel', c.secondaryLabel ?? '', c.confirmLabel ?? ''].filter(Boolean) } : null
      if (c && answer !== 'none') await runDesktopCall('answerConfirm', [c.id, answer === 'save' ? 'confirm' : answer === 'dont' ? 'secondary' : 'cancel'])
    } else {
      const el = document.querySelector<HTMLElement>(`[data-tabbar-tab][data-tab-id="${tabId}"]`)
      if (via === 'x') {
        const x = el?.querySelector<HTMLButtonElement>('button[aria-label="Close tab"]')
        if (!x) throw new Error(`Tab ${tabId} has no close button on screen.`)
        x.click()
      } else if (via === 'middle') {
        if (!el) throw new Error(`Tab ${tabId} is not on screen.`)
        el.dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }))
      } else if (via === 'menu') {
        const { tabMenuNodes } = await import('../lib/actions/tab-actions')
        const { runAction } = await import('../lib/actions/action-tree')
        await runAction(tabMenuNodes(tabId), 'tab.close')
      } else if (via === 'workspace') {
        const { requestDeleteWorkspace } = await import('../components/workspace/WorkspaceList')
        const ws = useAppStore.getState().workspaces.find((w) => w.folderPath === folder)
        if (!ws) throw new Error(`No workspace on ${folder}.`)
        requestDeleteWorkspace(ws.id)
      } else throw new Error(`Unknown via ${via}: x, middle, menu, phone or workspace.`)
      seen = await until(dialogNow, 2000)
      if (seen && answer !== 'none') clickAnswer(answer)
    }
    await new Promise((r) => setTimeout(r, 800))
    return { dialog: seen, tabClosed: !Object.values(useAppStore.getState().tabsByWorkspace).some((tabs) => tabs.some((t) => t.id === tabId)), ...state() }
  }
})

defineHandle({
  name: 'explorer.rename',
  side: 'renderer',
  description:
    'Renames a file or folder inside the project the way Rename in the file explorer does, meta file included. Refuses when a file or folder with the new name is already there, and shows the same message the explorer shows. With raw: true it calls the rename the way the Files shell on the phone does, with no explorer code in this window, so open tabs and unsaved edits follow only through the rename notice from the app. Returns whether it renamed and the message.',
  params: { path: '', name: '', raw: false },
  async run(p, ctx: RendererCtx) {
    const path = String(p.path ?? '')
    const name = String(p.name ?? '')
    const root = ctx.projectRoot.replace(/[/\\]+$/, '')
    if (!path || !root || !path.startsWith(root + '/')) throw new Error('Pass path, an absolute path inside the project.')
    if (!name || /[\\/]/.test(name)) throw new Error('Pass name, a file name without slashes.')
    const dest = `${path.slice(0, path.lastIndexOf('/'))}/${name}`
    if (p.raw === true || p.raw === 'true') {
      const res = await window.api.fs.rename(path, dest)
      await new Promise((r) => setTimeout(r, 300))
      return { dest, ok: res.ok, message: res.ok ? null : res.code }
    }
    return { dest, ...(await renameExplorerPath(path, dest)) }
  }
})
