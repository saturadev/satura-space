import type { UitkCapture } from '@shared/tuner-inspector-uitk'
import { censusTrack } from '@shared/census'

const urls = new Map<string, string>()
censusTrack('uitk-textures.urls', urls)

export function ingestUitkTextures(capture: UitkCapture): void {
  if (!capture.tex) return
  for (const [id, t] of Object.entries(capture.tex)) if (!urls.has(id)) urls.set(id, `data:image/png;base64,${t.png}`)
}

export function uitkTextureUrl(id: string): string | undefined {
  return urls.get(id)
}

let users = 0

export function retainUitkTextures(): () => void {
  users++
  let done = false
  return () => {
    if (done) return
    done = true
    users--
    if (users === 0) urls.clear()
  }
}
