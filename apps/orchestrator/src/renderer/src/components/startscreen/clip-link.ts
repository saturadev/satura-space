export const CLIP_PROMPT =
  'Make a small original playable game inspired by the video in ClipToGame/source. Read ClipToGame/source/brief.md, then follow the guide it names.'

export interface ClipProgress {
  stage: string
  text: string
  percent: number | null
}

const cancelled = new Set<string>()

export function clipLinkProblem(link: string): string | null {
  const text = link.trim()
  if (!text) return null
  try {
    const u = new URL(text)
    if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !u.hostname.includes('.')) throw new Error('not a web link')
    return null
  } catch {
    return 'That is not a video link. Paste the full address, starting with https://.'
  }
}

export function newClipJob(): string {
  return `clip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

export function onClipProgress(job: string, cb: (p: ClipProgress) => void): () => void {
  return window.api.plugins.onEvent((plugin, event, data) => {
    if (plugin !== 'clipgame' || event !== 'progress') return
    const d = data as { job?: string; stage?: string; text?: string; percent?: number | null }
    if (d.job !== job) return
    cb({ stage: d.stage ?? '', text: d.text ?? '', percent: typeof d.percent === 'number' ? d.percent : null })
  })
}

export async function fetchClip(url: string, job: string): Promise<{ ok: true } | { ok: false; error: string; cancelled: boolean }> {
  let res: Awaited<ReturnType<typeof window.api.plugins.call>>
  try {
    res = await window.api.plugins.call('clipgame', 'fetch', '', { url, job })
  } catch (e) {
    res = { ok: false, error: (e as Error).message || 'Could not read the video.' }
  }
  const wasCancelled = cancelled.delete(job)
  if (res.ok) return { ok: true }
  return { ok: false, error: res.error, cancelled: wasCancelled }
}

export function cancelClip(job: string): void {
  cancelled.add(job)
  void window.api.plugins.call('clipgame', 'cancel', '', { job })
}

export async function attachClip(projectRoot: string, job: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const res = await window.api.plugins.call('clipgame', 'attach', projectRoot, { job })
    return res.ok ? { ok: true } : { ok: false, error: res.error }
  } catch (e) {
    return { ok: false, error: (e as Error).message || 'Could not add the video to the project.' }
  }
}
