import { app, BrowserWindow, clipboard, ipcMain, nativeImage, shell } from 'electron'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { toNativePath } from './native-path'
import { planOpenPath, type OpenPathResult } from './open-path-plan'
import { noteTerminalClipboard, terminalClipboardVerdict, type TerminalClipboardResult } from './terminal-clipboard'

const MAX_CLIPBOARD_IMAGE_BYTES = 64 * 1024 * 1024

function fileUrlsToPaths(text: string): string[] {
  const paths: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const url = line.trim()
    if (!url.startsWith('file:')) continue
    try {
      paths.push(fileURLToPath(url))
    } catch {
    }
  }
  return paths
}

async function readClipboardFilePaths(): Promise<string[]> {
  try {
    for (const item of await clipboard.read()) {
      if (item.types.includes('text/uri-list')) {
        const paths = fileUrlsToPaths(await (await item.getType('text/uri-list')).text())
        if (paths.length) return paths
      }
      const raw = process.platform === 'win32'
        ? 'electron application/osclipboard;format="FileNameW"'
        : 'electron application/osclipboard;format="public.file-url"'
      if (!item.types.includes(raw)) continue
      const blob = await item.getType(raw)
      if (process.platform === 'win32') {
        const path = Buffer.from(await blob.arrayBuffer()).toString('ucs2').replace(/\0+$/, '')
        if (path) return [path]
      } else {
        const paths = fileUrlsToPaths(await blob.text())
        if (paths.length) return paths
      }
    }
  } catch {
  }
  return []
}

async function readClipboardPng(): Promise<Buffer | null> {
  for (const item of await clipboard.read()) {
    const type = item.types.find((t) => t === 'image/png') ?? item.types.find((t) => t.startsWith('image/'))
    if (!type) continue
    const bytes = Buffer.from(await ((await item.getType(type)) as Blob).arrayBuffer())
    if (type === 'image/png') return bytes
    const image = nativeImage.createFromBuffer(bytes)
    return image.isEmpty() ? null : image.toPNG()
  }
  return null
}

export function registerShellHandlers(): void {
  ipcMain.handle('ui:writeClipboardText', (_e, text: string): Promise<void> =>
    clipboard.writeText(typeof text === 'string' ? text : '')
  )

  ipcMain.handle('ui:readClipboardText', (): Promise<string> => clipboard.readText())

  ipcMain.handle('ui:readClipboardFilePaths', (): Promise<string[]> => readClipboardFilePaths())

  ipcMain.handle('ui:saveClipboardImageAsTempFile', async (): Promise<string | null> => {
    const buffer = await readClipboardPng().catch(() => null)
    if (!buffer?.byteLength || buffer.byteLength > MAX_CLIPBOARD_IMAGE_BYTES) return null
    const tempPath = join(app.getPath('temp'), `satura-paste-${Date.now()}-${randomUUID()}.png`)
    await writeFile(tempPath, buffer)
    return tempPath
  })

  ipcMain.handle(
    'ui:writeTerminalClipboard',
    async (e, args: { text?: unknown; ptyId?: unknown; terminalFocused?: unknown }): Promise<TerminalClipboardResult> => {
      const text = args?.text
      const ptyId = typeof args?.ptyId === 'string' ? args.ptyId : ''
      const terminalFocused = args?.terminalFocused === true
      const windowFocused = BrowserWindow.fromWebContents(e.sender)?.isFocused() === true
      const result = terminalClipboardVerdict(text, windowFocused, terminalFocused)
      const chars = typeof text === 'string' ? text.length : 0
      noteTerminalClipboard({ at: Date.now(), ptyId, chars, result, windowFocused, terminalFocused })
      if (result === 'written') {
        clipboard.writeText(text as string)
        console.log(`[terminal] OSC 52: a program in terminal ${ptyId || '?'} set the clipboard (${chars} chars)`)
      } else {
        console.log(`[terminal] OSC 52 clipboard write from terminal ${ptyId || '?'} refused: ${result} (window focused ${windowFocused}, terminal focused ${terminalFocused}, ${chars} chars)`)
      }
      return result
    }
  )

  ipcMain.handle('shell:openPath', async (_e, path: string): Promise<OpenPathResult> => {
    if (typeof path !== 'string' || !path) return 'missing'
    const plan = await planOpenPath(toNativePath(path))
    if (plan.action === 'open') {
      const err = await shell.openPath(plan.resolved)
      if (!err) {
        console.log(`[shell] opened ${plan.resolved}: ${plan.reason}`)
        return 'opened'
      }
      console.log(`[shell] openPath ${plan.resolved} failed: ${err}`)
      return 'missing'
    }
    if (plan.action === 'reveal') {
      shell.showItemInFolder(plan.resolved)
      console.log(`[shell] revealed ${plan.resolved} instead of opening it: ${plan.reason}`)
      return 'revealed'
    }
    return 'missing'
  })

  ipcMain.handle('shell:showItemInFolder', (_e, path: string): void => {
    if (typeof path === 'string' && path) shell.showItemInFolder(toNativePath(path))
  })

  ipcMain.handle('shell:openExternal', async (_e, url: string): Promise<void> => {
    if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) return
    console.log(`[shell] opening ${url.slice(0, 200)} in the system browser`)
    await shell.openExternal(url)
  })
}
