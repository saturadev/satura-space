import type { ILinkHandler } from '@xterm/xterm'
import { openFileInApp } from '../editor/open-file'
import { showDropFeedback } from '../drop-feedback'
import { tunerTip } from '../tuner/inspector/tooltip'

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent)

export function isLinkActivation(event: Pick<MouseEvent, 'metaKey' | 'ctrlKey'> | undefined): boolean {
  return IS_MAC ? Boolean(event?.metaKey) : Boolean(event?.ctrlKey)
}

function fileUriToPath(uri: string): string | null {
  try {
    const url = new URL(uri)
    if (url.protocol !== 'file:') return null
    return decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, '$1')
  } catch {
    return null
  }
}

function resolveFilePath(uri: string): string | null {
  if (uri.startsWith('file://')) return fileUriToPath(uri)
  if (uri.startsWith('/')) return uri
  return null
}

function linkTarget(uri: string): string {
  if (/^https?:\/\//i.test(uri)) return uri
  return resolveFilePath(uri) ?? `${uri} (not opened: only web and file links open)`
}

function openUri(uri: string, event: MouseEvent, ptyId?: string): void {
  if (/^https?:\/\//i.test(uri)) {
    void window.api.shell.openExternal(uri).catch(() => {})
    return
  }
  const filePath = resolveFilePath(uri)
  if (!filePath) return
  if (event.shiftKey) {
    void window.api.shell.showItemInFolder(filePath).catch(() => {})
    return
  }
  void window.api.fs
    .statPath(filePath)
    .then((info) => {
      if (info.isDirectory) {
        return window.api.shell.openPath(info.resolved).then((result) => {
          if (result === 'revealed') showDropFeedback(`Shown in ${IS_MAC ? 'Finder' : 'the file manager'} instead of opening it: ${info.resolved}`, 4000)
        })
      }
      openFileInApp({ file: info.resolved || filePath, ptyId, preview: true, source: 'terminal' })
      return undefined
    })
    .catch(() => {})
}

export function createTerminalLinkHandler(ptyId?: string): ILinkHandler {
  const owner = {}
  return {
    allowNonHttpProtocols: true,
    activate: (event, text) => {
      tunerTip.hide(owner)
      if (!isLinkActivation(event)) return
      openUri(text, event, ptyId)
    },
    hover: (event, text) => {
      const anchor = { left: event.clientX, top: event.clientY, width: 1, height: 1 }
      tunerTip.schedule({ text: linkTarget(text), anchor, pointer: { x: event.clientX, y: event.clientY }, owner, key: text }, 300)
    },
    leave: () => tunerTip.hide(owner)
  }
}

export function activateWebLink(event: MouseEvent, uri: string): void {
  if (!isLinkActivation(event)) return
  void window.api.shell.openExternal(uri).catch(() => {})
}
