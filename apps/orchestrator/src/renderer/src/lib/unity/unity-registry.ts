import { censusTrack } from '@shared/census'
import { isMobileLayout } from '../mobile/mobile-back'


const hosts = new Map<string, HTMLDivElement>()
censusTrack('unity-registry.hosts', hosts)
const canvases = new Map<string, HTMLCanvasElement>()
censusTrack('unity-registry.canvases', canvases)
const textInputs = new Map<string, HTMLTextAreaElement>()
censusTrack('unity-registry.textInputs', textInputs)
const hintResends = new Map<string, () => void>()
censusTrack('unity-registry.hintResends', hintResends)

let parking: HTMLDivElement | null = null
function getParking(): HTMLDivElement {
  if (!parking) {
    parking = document.createElement('div')
    parking.style.cssText =
      'position:absolute;left:-99999px;top:0;width:960px;height:540px;overflow:hidden;'
    document.body.appendChild(parking)
  }
  return parking
}

export function getUnityHost(id: string): HTMLDivElement {
  let el = hosts.get(id)
  if (!el) {
    el = document.createElement('div')
    el.tabIndex = 0
    el.style.cssText =
      'position:relative;width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#000;overflow:hidden;outline:none;'
    const canvas = document.createElement('canvas')
    canvas.style.cssText = 'display:block;width:100%;height:100%;object-fit:contain;'
    canvas.dataset.unitySession = id
    el.appendChild(canvas)
    const text = document.createElement('textarea')
    text.tabIndex = -1
    text.autocomplete = 'off'
    text.spellcheck = false
    text.setAttribute('autocorrect', 'off')
    text.setAttribute('autocapitalize', 'off')
    text.setAttribute('aria-hidden', 'true')
    text.dataset.unityTextInput = id
    text.style.cssText =
      'position:absolute;left:0;top:0;width:1px;height:1px;padding:0;border:0;margin:0;opacity:0;resize:none;overflow:hidden;pointer-events:none;caret-color:transparent;'
    el.appendChild(text)
    const host = el
    host.addEventListener('focus', () => {
      if (host.isConnected && !isMobileLayout()) text.focus({ preventScroll: true })
    })
    hosts.set(id, el)
    canvases.set(id, canvas)
    textInputs.set(id, text)
    getParking().appendChild(el)
  }
  return el
}

export function getUnityCanvas(id: string): HTMLCanvasElement {
  getUnityHost(id)
  return canvases.get(id)!
}

export function getUnityTextInput(id: string): HTMLTextAreaElement {
  getUnityHost(id)
  return textInputs.get(id)!
}

export function recreateUnityCanvases(): void {
  for (const [id, old] of canvases) {
    const fresh = document.createElement('canvas')
    fresh.style.cssText = old.style.cssText
    fresh.dataset.unitySession = id
    fresh.width = old.width
    fresh.height = old.height
    old.replaceWith(fresh)
    canvases.set(id, fresh)
  }
  if (canvases.size) console.warn(`[unity-registry] recreated ${canvases.size} video canvas(es) after GPU reset`)
}

try {
  window.api?.window?.onGpuReset?.(() => recreateUnityCanvases())
} catch {
}

export function parkUnityHost(id: string): void {
  const el = hosts.get(id)
  if (!el) return
  const park = getParking()
  if (el.parentElement !== park) park.appendChild(el)
}

export function releaseUnityHost(id: string): void {
  const el = hosts.get(id)
  if (el?.parentElement) el.parentElement.removeChild(el)
  hosts.delete(id)
  canvases.delete(id)
  textInputs.delete(id)
}

export function registerHintResend(id: string, fn: () => void): void {
  hintResends.set(id, fn)
}

export function unregisterHintResend(id: string, fn: () => void): void {
  if (hintResends.get(id) === fn) hintResends.delete(id)
}

export function requestHintResend(id: string): void {
  hintResends.get(id)?.()
}
