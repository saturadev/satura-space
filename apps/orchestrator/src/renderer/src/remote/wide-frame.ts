const COLUMN_PX = 760

function desktopBrowser(): boolean {
  const ua = navigator.userAgent
  if (/iPhone|iPad|iPod|Android/i.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1)) return false
  if (window.matchMedia('(display-mode: standalone)').matches) return false
  return window.matchMedia('(hover: hover) and (pointer: fine)').matches
}

function ownParent(): Window | null {
  if (window.parent === window) return null
  try {
    return window.parent.location.origin === location.origin && window.parent.document.documentElement.dataset.frame === 'top' ? window.parent : null
  } catch {
    return null
  }
}

export function topWindow(): Window {
  return ownParent() ?? window
}

function mirrorIntoTop(top: Window): void {
  const mirror = (): void => {
    try {
      top.history.replaceState(null, '', location.pathname + location.search + location.hash)
      top.document.title = document.title
    } catch {
    }
  }
  for (const name of ['replaceState', 'pushState'] as const) {
    const own = history[name].bind(history)
    history[name] = (...args: Parameters<History['replaceState']>): void => {
      own(...args)
      mirror()
    }
  }
  window.addEventListener('hashchange', mirror)
  window.addEventListener('popstate', mirror)
  new MutationObserver(mirror).observe(document.querySelector('title') ?? document.head, { childList: true, characterData: true, subtree: true })
  mirror()
}

function mountColumn(): void {
  const doc = document.documentElement
  doc.dataset.frame = 'top'
  const style = document.createElement('style')
  style.textContent = `html,body{margin:0;height:100%;background:#000;overflow:hidden}#root{height:100%;display:flex;justify-content:center;background:radial-gradient(circle 900px at 50% 20%,rgb(18 20 38),#000)}iframe[data-remote-column]{display:block;width:min(${COLUMN_PX}px,100%);height:100%;border:0;background:#000;box-shadow:0 0 0 1px rgb(255 255 255/.07),0 30px 80px rgb(0 0 0/.6)}`
  document.head.appendChild(style)
  const frame = document.createElement('iframe')
  frame.src = location.href
  frame.title = 'Satura Remote'
  frame.allow = 'camera; clipboard-read; clipboard-write; fullscreen; autoplay'
  frame.dataset.remoteColumn = ''
  const root = document.getElementById('root') ?? document.body
  root.replaceChildren(frame)
  frame.addEventListener('load', () => frame.contentWindow?.focus())
  console.info(`[remote] desktop browser ${window.innerWidth}x${window.innerHeight}: Satura Remote shows in a column up to ${COLUMN_PX} px wide`)
}

export function framedForDesktop(): boolean {
  const top = ownParent()
  if (top) {
    mirrorIntoTop(top)
    return false
  }
  if (window.parent !== window || !desktopBrowser()) return false
  mountColumn()
  return true
}
