import { DEFAULT_SETTINGS } from '@shared/types'
import { handle } from './api'
import { demoCopy } from './clipboard'

export function installBaseApi(): void {
  handle('app', 'getVersion', () => Promise.resolve('2.0.0'))
  handle('app', 'isDev', () => Promise.resolve(false))
  handle('app', 'getZoomFactor', () => 1)
  handle('app', 'notifyRendererWarm', () => undefined)
  handle('app', 'launchStep', () => undefined)
  handle('settings', 'get', () => Promise.resolve(DEFAULT_SETTINGS))
  handle('settings', 'set', (s) => Promise.resolve(s))
  handle('auth', 'getSession', () => Promise.resolve(null))
  handle('auth', 'getEntitlement', () => Promise.resolve(null))
  handle('agents', 'detect', () => Promise.resolve([]))
  handle('recents', 'list', () => Promise.resolve([]))
  handle('pty', 'listShells', () => Promise.resolve([]))
  handle('fs', 'readDir', () => Promise.resolve([]))
  handle('fs', 'statPath', (p) => Promise.resolve({ resolved: p, exists: false, isFile: false, isDirectory: false }))
  handle('ui', 'writeClipboardText', (text) => demoCopy(String(text)))
  handle('shell', 'openExternal', (url) => {
    window.open(url, '_blank', 'noopener')
    return Promise.resolve()
  })
}
