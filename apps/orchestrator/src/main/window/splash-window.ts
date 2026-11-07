import { app, BrowserWindow } from 'electron'
import { inBackground } from './background'

const MIN_SHOW_MS = 1100
const FALLBACK_MS = 60000
const READY_WAIT_MS = 8000
const FADE_MS = 220

let win: BrowserWindow | null = null
let active = false
let startedAt = 0
let ready = false
let finishing = false
let stepIndex = -1
let fallback: ReturnType<typeof setTimeout> | null = null
const held: (() => void)[] = []

export type LaunchStep = 'starting' | 'interface' | 'workspaces' | 'ready'

const STEPS: Record<LaunchStep, [number, string]> = {
  starting: [0, 'Starting Satura Space'],
  interface: [1, 'Loading the interface'],
  workspaces: [2, 'Restoring your workspaces'],
  ready: [3, 'Ready']
}
const STEP_COUNT = 3

const ROT = -28
function orbitPt(t: number): [number, number] {
  const a = (ROT * Math.PI) / 180
  const x = 300 * Math.cos(t)
  const y = 64 * Math.sin(t)
  return [512 + x * Math.cos(a) - y * Math.sin(a), 512 + x * Math.sin(a) + y * Math.cos(a)]
}

function pageHtml(): string {
  const [d1x, d1y] = orbitPt(0)
  const [d2x, d2y] = orbitPt(Math.PI)
  const word = [...'Satura Space'].map((c, i) => `<span style="animation-delay:${675 + i * 14}ms">${c}</span>`).join('')
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;height:100%;background:transparent;color:#e5e7eb;font-family:'Inter Variable',Inter,-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;user-select:none;-webkit-app-region:drag;overflow:hidden;cursor:default}
body{display:flex;align-items:center;justify-content:center}
.card{box-sizing:border-box;width:248px;height:214px;border-radius:16px;background:#0f1013;border:1px solid rgb(255 255 255 / .08);box-shadow:0 1px 0 rgb(255 255 255 / .04) inset,0 10px 30px rgb(0 0 0 / .45);display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px;transition:opacity ${FADE_MS}ms ease,transform ${FADE_MS}ms ease}
body.out .card{opacity:0;transform:scale(.97)}
svg{width:96px;height:96px;overflow:visible}
svg .p{transform-box:fill-box;transform-origin:center}
.dash{stroke-dasharray:1 1;animation:dash var(--d,342ms) cubic-bezier(.65,0,.35,1) var(--at,0ms) both}
@keyframes dash{from{stroke-dashoffset:1}to{stroke-dashoffset:0}}
.halo{animation:show 90ms ease 315ms both}
@keyframes show{from{opacity:0}to{opacity:1}}
.face{animation:fly 342ms cubic-bezier(.16,1,.3,1) var(--at) both}
.f-top{--from:translate(0,-420px) rotate(-90deg) scale(.4)}
.f-left{--from:translate(-460px,260px) rotate(70deg) scale(.4)}
.f-right{--from:translate(460px,260px) rotate(-70deg) scale(.4)}
@keyframes fly{from{opacity:0;transform:var(--from);filter:blur(8px)}to{opacity:1;transform:none;filter:blur(0)}}
.cube{animation:bump 162ms cubic-bezier(.16,1,.3,1) 495ms both}
@keyframes bump{50%{transform:scale(1.12)}}
.dot{animation:pop 216ms cubic-bezier(.34,1.56,.64,1) 594ms both}
@keyframes pop{from{opacity:0;transform:scale(0)}to{opacity:1;transform:scale(1)}}
svg{transform-origin:center;animation:pulse 1500ms cubic-bezier(.45,0,.55,1) 720ms infinite}
@keyframes pulse{0%,100%{transform:scale(1);filter:drop-shadow(0 0 0 rgb(129 150 255 / 0))}50%{transform:scale(1.045);filter:drop-shadow(0 0 18px rgb(129 150 255 / .45))}}
.meta{display:flex;flex-direction:column;align-items:center;gap:8px}
.word{font-size:13px;font-weight:600;letter-spacing:.01em;display:flex}
.word span{display:inline-block;white-space:pre;animation:rise 234ms cubic-bezier(.16,1,.3,1) both}
@keyframes rise{from{opacity:0;transform:translateY(8px);filter:blur(6px)}to{opacity:1;transform:none;filter:blur(0)}}
.cap{font-size:10.5px;color:#6b717b;height:14px;letter-spacing:.02em;animation:show 180ms ease 405ms both}
.cap.swap{animation:swap 135ms cubic-bezier(.16,1,.3,1) both}
@keyframes swap{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
.bar{width:96px;height:2px;border-radius:2px;background:rgb(255 255 255 / .07);overflow:hidden;animation:show 180ms ease 405ms both}
.bar b{display:block;height:100%;width:0;background:#8196ff;border-radius:2px;transition:width 225ms cubic-bezier(.65,0,.35,1)}
@media (prefers-reduced-motion: reduce){*{animation:none!important}}
</style></head><body><div class="card">
<svg viewBox="0 0 1024 1024" fill="none">
<g transform="rotate(${ROT} 512 512)"><ellipse class="p dash" style="--at:342ms;--d:405ms" cx="512" cy="512" rx="430" ry="120" stroke="#e5e7eb" stroke-width="22" pathLength="1"/></g>
<path class="halo" d="M690 268 L510 164 L252 313 L252 466 L322 506 M334 756 L514 860 L772 711 L772 558 L702 518" stroke="#0f1013" stroke-width="140" stroke-linejoin="round" stroke-linecap="round"/>
<path class="dash" style="--at:0ms" d="M690 268 L510 164 L252 313 L252 466 L322 506" stroke="#e5e7eb" stroke-width="96" stroke-linejoin="round" stroke-linecap="round" pathLength="1"/>
<path class="dash" style="--at:63ms" d="M334 756 L514 860 L772 711 L772 558 L702 518" stroke="#e5e7eb" stroke-width="96" stroke-linejoin="round" stroke-linecap="round" pathLength="1"/>
<g transform="rotate(${ROT} 512 512)">
<line class="dash" style="--at:531ms;--d:162ms" x1="812" y1="512" x2="664" y2="512" stroke="#e5e7eb" stroke-width="20" stroke-linecap="round" pathLength="1"/>
<line class="dash" style="--at:531ms;--d:162ms" x1="212" y1="512" x2="360" y2="512" stroke="#e5e7eb" stroke-width="20" stroke-linecap="round" pathLength="1"/>
</g>
<g class="p cube">
<polygon class="p face f-top" style="--at:158ms" points="508,362 628,430 508,498 388,430" fill="#e5e7eb" stroke="#e5e7eb" stroke-width="12" stroke-linejoin="round"/>
<polygon class="p face f-left" style="--at:189ms" points="380,450 498,518 498,660 380,592" fill="#e5e7eb" stroke="#e5e7eb" stroke-width="12" stroke-linejoin="round"/>
<polygon class="p face f-right" style="--at:220ms" points="518,518 636,450 636,592 518,660" fill="#e5e7eb" stroke="#e5e7eb" stroke-width="12" stroke-linejoin="round"/>
</g>
<circle class="p dot" cx="${d1x}" cy="${d1y}" r="44" fill="#e5e7eb"/>
<circle class="p dot" cx="${d2x}" cy="${d2y}" r="44" fill="#e5e7eb"/>
</svg>
<div class="meta"><div class="word">${word}</div><div class="cap" id="cap"></div><div class="bar"><b id="bar"></b></div></div></div>
<script>
window.step = (text, frac) => {
  const cap = document.getElementById('cap')
  if (cap.textContent !== text) {
    cap.textContent = text
    if (performance.now() > 600) { cap.classList.remove('swap'); void cap.offsetWidth; cap.classList.add('swap') }
  }
  document.getElementById('bar').style.width = (frac * 100) + '%'
}
window.fadeOut = () => document.body.classList.add('out')
</script>
</body></html>`
}

function run(js: string): void {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
  void win.webContents.executeJavaScript(js).catch(() => {})
}

function applyStep(): void {
  const entry = Object.values(STEPS).find(([i]) => i === stepIndex)
  if (!entry) return
  run(`window.step(${JSON.stringify(entry[1])}, ${Math.min(1, (stepIndex + 1) / (STEP_COUNT + 1))})`)
}

export function showLaunchSplash(): void {
  if (win || active) return
  if (!app.isPackaged && process.env.SATURA_DEV_CAPTURE === '1') return
  active = true
  startedAt = Date.now()
  win = new BrowserWindow({
    width: 276,
    height: 242,
    center: true,
    frame: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    transparent: true,
    hasShadow: false,
    backgroundColor: '#00000000',
    title: 'Satura Space',
    webPreferences: { sandbox: true }
  })
  win.setMenuBarVisibility(false)
  win.once('ready-to-show', () => {
    if (!win || win.isDestroyed() || inBackground) return
    win.show()
  })
  win.webContents.once('did-finish-load', applyStep)
  win.on('closed', () => {
    win = null
    if (active) finish(true)
  })
  void win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(pageHtml()))
  fallback = setTimeout(() => finish(true), FALLBACK_MS)
  setLaunchStep('starting')
}

export function setLaunchStep(step: LaunchStep): void {
  if (!active || finishing) return
  const [index] = STEPS[step]
  if (index <= stepIndex) return
  stepIndex = index
  console.log(`[splash] ${step} at ${Date.now() - startedAt}ms`)
  applyStep()
  if (step === 'ready') markReady()
}

export function holdUntilLaunched(show: () => void): boolean {
  if (!active) return false
  held.push(show)
  console.log(`[splash] window ready to show at ${Date.now() - startedAt}ms`)
  if (held.length === 1 && !ready) {
    if (fallback) clearTimeout(fallback)
    fallback = setTimeout(() => finish(true), READY_WAIT_MS)
  }
  return true
}

function markReady(): void {
  if (ready) return
  ready = true
  const wait = Math.max(0, MIN_SHOW_MS - (Date.now() - startedAt))
  setTimeout(() => finish(false), wait)
}

function finish(now: boolean): void {
  if (!active || finishing) return
  finishing = true
  if (fallback) clearTimeout(fallback)
  fallback = null
  const release = (): void => {
    active = false
    console.log(`[splash] closed at ${Date.now() - startedAt}ms${now ? ' (forced)' : ''}, showing ${held.length} window(s)`)
    for (const show of held.splice(0)) show()
    run('window.fadeOut()')
    setTimeout(() => {
      if (win && !win.isDestroyed()) win.destroy()
      win = null
    }, FADE_MS)
  }
  if (now) release()
  else setTimeout(release, 150)
}
