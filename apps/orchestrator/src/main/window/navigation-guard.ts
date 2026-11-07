import { app, shell, type WebContents } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isAppPage } from '@shared/app-page'
import { REPORT_FRAME_SCHEME, REPORT_FRAME_URL } from '@shared/report-frame'

const EXTERNAL = new Set(['http:', 'https:', 'mailto:'])
const NO_SUBFRAME = new Set(['file:', 'javascript:', 'chrome:', 'devtools:'])

function parse(raw: string): URL | null {
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

export function appPageUrl(): string {
  const dev = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
  const devUrl = dev ? parse(dev) : null
  if (devUrl) return devUrl.origin + '/'
  return pathToFileURL(join(__dirname, '../renderer/index.html')).href
}

export function openOutside(raw: string, why: string): boolean {
  const u = parse(raw)
  if (!u || !EXTERNAL.has(u.protocol)) {
    console.log(`[nav] blocked ${why} to ${raw.slice(0, 200)}`)
    return false
  }
  console.log(`[nav] ${why} to ${u.origin} opens in the system browser`)
  void shell.openExternal(u.href)
  return true
}

function guard(wc: WebContents): void {
  wc.on('will-navigate', (e) => {
    if (isAppPage(e.url, appPageUrl()) || parse(e.url)?.protocol === 'devtools:') return
    e.preventDefault()
    openOutside(e.url, 'navigation')
  })
  wc.on('will-frame-navigate', (e) => {
    if (e.isMainFrame) return
    let from = ''
    try {
      from = e.frame?.url ?? ''
    } catch {
      from = ''
    }
    if (from.startsWith(`${REPORT_FRAME_SCHEME}:`) && e.url !== REPORT_FRAME_URL) {
      e.preventDefault()
      console.log(`[nav] blocked a report frame navigating to ${e.url.slice(0, 200)}`)
      return
    }
    const u = parse(e.url)
    if (u && !NO_SUBFRAME.has(u.protocol)) return
    e.preventDefault()
    console.log(`[nav] blocked frame navigation to ${e.url.slice(0, 200)}`)
  })
  wc.on('will-redirect', (e) => {
    if (!e.isMainFrame || isAppPage(e.url, appPageUrl())) return
    e.preventDefault()
    console.log(`[nav] blocked redirect to ${e.url.slice(0, 200)}`)
  })
  wc.on('will-attach-webview', (e) => {
    e.preventDefault()
    console.log('[nav] blocked a <webview>')
  })
  wc.setWindowOpenHandler(({ url }) => {
    openOutside(url, 'new window')
    return { action: 'deny' }
  })
}

export function installNavigationGuard(): void {
  app.on('web-contents-created', (_e, wc) => guard(wc))
}
