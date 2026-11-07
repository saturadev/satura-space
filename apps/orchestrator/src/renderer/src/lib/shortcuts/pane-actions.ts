type Handler = () => void
type PlayToggleHandler = (fullscreen: boolean) => void

const playToggle = new Map<string, PlayToggleHandler>()
const consoleFind = new Map<string, Handler>()
const viewerFind = new Map<string, Handler>()
const playing = new Set<string>()

export function registerUnityPlayToggle(ptyId: string, fn: PlayToggleHandler): () => void {
  playToggle.set(ptyId, fn)
  return () => {
    if (playToggle.get(ptyId) === fn) playToggle.delete(ptyId)
  }
}

export function requestUnityPlayToggle(ptyId: string, fullscreen = false): boolean {
  const fn = playToggle.get(ptyId)
  if (!fn) return false
  fn(fullscreen)
  return true
}

export function setUnityPlaying(ptyId: string, isPlaying: boolean): () => void {
  if (isPlaying) playing.add(ptyId)
  else playing.delete(ptyId)
  return () => {
    playing.delete(ptyId)
  }
}

export function isUnityPlaying(ptyId: string): boolean {
  return playing.has(ptyId)
}

export function registerConsoleFind(ptyId: string, fn: Handler): () => void {
  consoleFind.set(ptyId, fn)
  return () => {
    if (consoleFind.get(ptyId) === fn) consoleFind.delete(ptyId)
  }
}

export function requestConsoleFind(ptyId: string): boolean {
  const fn = consoleFind.get(ptyId)
  if (!fn) return false
  fn()
  return true
}

export function registerViewerFind(tabId: string, fn: Handler): () => void {
  viewerFind.set(tabId, fn)
  return () => {
    if (viewerFind.get(tabId) === fn) viewerFind.delete(tabId)
  }
}

export function requestViewerFind(tabId: string): boolean {
  const fn = viewerFind.get(tabId)
  if (!fn) return false
  fn()
  return true
}
