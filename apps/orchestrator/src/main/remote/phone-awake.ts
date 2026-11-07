import { app, BrowserWindow } from 'electron'
import { status } from './host'
import { captureActive } from '../capture-state'

const CHECK_MS = 1000

app.commandLine.appendSwitch('disable-renderer-backgrounding')

let phones = false

function sync(): void {
  const want = status().phones > 0
  if (want !== phones) {
    phones = want
    console.log(`[remote] ${want ? 'a phone is connected, windows keep full speed while hidden or minimized' : 'no phone connected, hidden windows may slow down again'}`)
  }
  if (captureActive()) return
  for (const win of BrowserWindow.getAllWindows()) {
    const wc = win.webContents
    if (wc.isDestroyed() || wc.getBackgroundThrottling() === !want) continue
    wc.setBackgroundThrottling(!want)
  }
}

export function startPhoneAwake(): void {
  setInterval(sync, CHECK_MS).unref()
}
