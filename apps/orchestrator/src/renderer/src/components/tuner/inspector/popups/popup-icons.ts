import type { TunerTexture } from '@shared/tuner-inspector-popups'
import { censusTrack } from '@shared/census'

const urls = new Map<string, string>()
censusTrack('popup-icons.urls', urls)

export function ingestPopupIcons(tex: Record<string, TunerTexture> | undefined): void {
  if (!tex) return
  for (const [id, t] of Object.entries(tex)) if (!urls.has(id) && t?.png) urls.set(id, `data:image/png;base64,${t.png}`)
}

export function popupIconUrl(id: string | undefined): string | undefined {
  return id ? urls.get(id) : undefined
}

export function knownPopupIcons(): string[] {
  return [...urls.keys()]
}

let users = 0

export function retainPopupIcons(): () => void {
  users++
  let done = false
  return () => {
    if (done) return
    done = true
    users--
    if (users === 0) urls.clear()
  }
}
