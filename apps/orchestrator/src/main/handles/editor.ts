import { BrowserWindow } from 'electron'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { rendererCall } from '../agent-exec'
import type { RendererHandleReply } from '@shared/app-handles'
import { defineHandle, sleep } from './registry'
import { createAppWindow } from '../window/window-manager'

const ORIGINAL = 'original line\n'
const TAB_VIAS = ['x', 'middle', 'menu', 'phone', 'split', 'workspace']
const WINDOW_VIAS = ['window', 'window-workspace', 'primary-window']

type Step = { tabId?: string; workspaceId?: string; tabs?: unknown[]; draft?: boolean; dialog?: unknown; [k: string]: unknown }

async function stepIn(win: BrowserWindow, params: Record<string, unknown>, projectRoot: string, timeoutMs = 20_000): Promise<Step> {
  const reply = (await rendererCall(win.webContents.id, { kind: 'handle', payload: { name: 'editor.unsavedStep', params, workspaceId: null, projectRoot } }, timeoutMs)) as RendererHandleReply | null
  if (!reply || !('ok' in reply)) throw new Error('The popped-out window did not answer.')
  if (!reply.ok) throw new Error(reply.error)
  return reply.value as Step
}

async function newWindow(before: Set<number>): Promise<BrowserWindow> {
  for (let i = 0; i < 100; i++) {
    const win = BrowserWindow.getAllWindows().find((w) => !before.has(w.id) && !w.isDestroyed())
    if (win) return win
    await sleep(100)
  }
  throw new Error('No new window opened for the popped-out tab.')
}

defineHandle({
  name: 'editor.unsavedClose',
  side: 'main',
  description:
    "Opens a text file of the test project in the file viewer, types an edit without saving and closes it one way, then answers the dialog. via: x (the tab's close button), middle (middle click), menu (Close tab in the tab menu), phone (Close tab run from the phone), split (x while a second tab shows the same file), workspace (closing a terminal-only workspace on a folder of the project), window (the tab popped out to its own window, then that window closed), window-workspace (popped out, then its workspace closed in the main window), primary-window (the workspace moved to a second main window, then that window closed with Close this window). answer: save, dont, cancel or none. Returns whether a dialog asked, what it said, whether the tab, window or workspace closed, whether the edit is still unsaved and what the file on disk holds.",
  params: { via: 'x', answer: 'dont', text: 'unsaved edit ' },
  async run(p, ctx) {
    const via = String(p.via)
    const answer = String(p.answer)
    if (![...TAB_VIAS, ...WINDOW_VIAS].includes(via)) throw new Error(`via is one of ${[...TAB_VIAS, ...WINDOW_VIAS].join(', ')}.`)
    if (!['save', 'dont', 'cancel', 'none'].includes(answer)) throw new Error('answer is save, dont, cancel or none.')
    const project = ctx.writableProject()
    const own = via === 'workspace' || via === 'window-workspace' || via === 'primary-window'
    const folder = own ? join(project, '.sspace', 'unsaved-check') : ''
    if (folder) mkdirSync(folder, { recursive: true })
    const file = join(folder || project, own ? 'Notes.txt' : 'UnsavedCheck.txt')
    writeFileSync(file, ORIGINAL)
    const disk = (): string => (readFileSync(file, 'utf8') === ORIGINAL ? 'unchanged' : 'saved')
    await ctx.renderer('editor.unsavedStep', { op: 'cleanup', file, folder })
    const edit = (await ctx.renderer('editor.unsavedStep', { op: 'edit', file, folder, text: String(p.text), split: via === 'split' }, 30_000)) as Step
    ctx.log(`${via}: typed into ${file} in tab ${edit.tabId}, ${edit.tabs?.length ?? 0} tab(s) show it, unsaved ${edit.draft}`)
    if (TAB_VIAS.includes(via)) {
      const closed = (await ctx.renderer('editor.unsavedStep', { op: 'close', file, folder, tabId: edit.tabId, via: via === 'split' ? 'x' : via, answer }, 30_000)) as Step
      const out = { via, answer, asked: !!closed.dialog, dialog: closed.dialog, tabClosed: closed.tabClosed, workspaceClosed: own ? !closed.workspaceOpen : undefined, tabsLeft: closed.tabs?.length ?? 0, unsaved: closed.draft, disk: disk() }
      await ctx.renderer('editor.unsavedStep', { op: 'cleanup', file, folder })
      return out
    }
    const before = new Set(BrowserWindow.getAllWindows().map((w) => w.id))
    let win: BrowserWindow
    if (via === 'primary-window') {
      const target = createAppWindow(undefined, { role: 'primary' })
      win = await newWindow(before)
      for (let i = 0; i < 100; i++) {
        if (await stepIn(win, { op: 'state', file }, folder, 2000).then(() => true, () => false)) break
        await sleep(200)
      }
      await ctx.renderer('editor.unsavedStep', { op: 'moveWorkspace', file, folder, tabId: target })
    } else {
      await ctx.renderer('editor.unsavedStep', { op: 'popout', file, folder, tabId: edit.tabId })
      win = await newWindow(before)
    }
    let moved: Step = {}
    for (let i = 0; i < 100 && !(moved.tabs?.length && moved.draft); i++) {
      await sleep(100)
      moved = await stepIn(win, { op: 'state', file, folder: '' }, folder || project).catch(() => ({}))
    }
    if (!moved.draft) throw new Error('The popped-out window shows no unsaved edit.')
    const origin = (await ctx.renderer('editor.unsavedStep', { op: 'state', file, folder })) as Step
    ctx.log(`${via}: popped out to window ${win.id}, it shows ${moved.tabs?.length} tab(s) with the edit; the main window keeps it unsaved: ${origin.draft}`)
    let main: Step | null = null
    if (via === 'window') win.close()
    else if (via === 'primary-window') {
      win.close()
      main = await stepIn(win, { op: 'click', answer: 'Close this window', file }, folder)
    } else main = (await ctx.renderer('editor.unsavedStep', { op: 'close', file, folder, via: 'workspace', answer: 'save' }, 30_000)) as Step
    const asked = await stepIn(win, { op: 'answer', answer: 'none', file }, folder || project).catch((e: Error) => ({ dialog: null, error: e.message }) as Step)
    if (asked.dialog && answer !== 'none') await stepIn(win, { op: 'answer', answer, file }, folder || project, 3000).catch(() => null)
    const after = win.isDestroyed() ? null : await stepIn(win, { op: 'state', file }, folder || project).catch(() => null)
    await sleep(500)
    const out = {
      via,
      answer,
      asked: !!asked.dialog,
      dialog: asked.dialog,
      ...(main && via === 'window-workspace' ? { mainDialog: main.dialog, workspaceClosed: !main.workspaceOpen } : {}),
      ...(main && via === 'primary-window' ? { closeThisWindow: main.clicked, mainKeepsEdit: origin.draft } : {}),
      windowClosed: win.isDestroyed(),
      unsaved: after?.draft ?? false,
      disk: disk()
    }
    if (!win.isDestroyed()) {
      await stepIn(win, { op: 'cleanup', file, folder: '' }, folder || project).catch(() => null)
      win.destroy()
    }
    await ctx.renderer('editor.unsavedStep', { op: 'cleanup', file, folder })
    return out
  }
})
