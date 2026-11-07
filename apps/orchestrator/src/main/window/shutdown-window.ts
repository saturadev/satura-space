import { BrowserWindow } from 'electron'
import { inBackground } from './background'

let win: BrowserWindow | null = null
let holds = 0
let currentTitle = ''
let currentSubtitle = ''

function pageHtml(title: string, subtitle: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:#0c0d0f;color:#e5e7eb;font-family:'Segoe UI',system-ui,sans-serif;user-select:none;-webkit-app-region:drag;overflow:hidden}
.wrap{display:flex;align-items:center;gap:14px;height:100%;padding:0 20px;box-sizing:border-box}
.spin{width:22px;height:22px;border:2.5px solid rgba(255,255,255,.15);border-top-color:#8196ff;border-radius:50%;animation:r .9s linear infinite;flex:none}
@keyframes r{to{transform:rotate(360deg)}}
.t{font-size:13.5px;font-weight:600;margin:0 0 3px}
.s{font-size:12px;color:#9aa0a9;margin:0}
</style></head><body><div class="wrap"><div class="spin"></div><div><p class="t" id="t">${title}</p><p class="s" id="s">${subtitle}</p></div></div></body></html>`
}

function applyText(): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  void win.webContents
    .executeJavaScript(
      `document.getElementById('t').textContent = ${JSON.stringify(currentTitle)};` +
        `document.getElementById('s').textContent = ${JSON.stringify(currentSubtitle)}`
    )
    .catch(() => {})
}

function ensureWindow(): void {
  if (win && !win.isDestroyed()) {
    applyText()
    return
  }
  win = new BrowserWindow({
    width: 400,
    height: 110,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    closable: false,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    backgroundColor: '#0c0d0f',
    webPreferences: { sandbox: true }
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed() || inBackground) return
    win.show()
  })
  void win.loadURL(
    'data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml(currentTitle, currentSubtitle))
  )
}

export function acquireShutdownStatus(title: string, subtitle: string): () => void {
  currentTitle = title
  currentSubtitle = subtitle
  holds++
  ensureWindow()
  let released = false
  return () => {
    if (released) return
    released = true
    holds--
    if (holds > 0) return
    holds = 0
    if (win && !win.isDestroyed()) win.destroy()
    win = null
  }
}

export function setShutdownSubtitle(subtitle: string): void {
  currentSubtitle = subtitle
  applyText()
}
