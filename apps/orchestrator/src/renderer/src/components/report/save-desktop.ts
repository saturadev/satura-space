import { pickPath } from '../../lib/file-picker/file-picker-store'
import type { MediaSaveAsk, MediaSaved } from '../../lib/media-loader'

export async function saveOnDesktop(file: string, root: string, ask: MediaSaveAsk): Promise<MediaSaved> {
  const ext = /\.([A-Za-z0-9]{1,8})$/.exec(ask.name)?.[1]
  const downloads = (await window.api.picker.places().catch(() => null))?.places.find((p) => p.kind === 'downloads')?.path
  const dest = await pickPath({
    mode: 'save',
    purpose: 'report-media',
    title: ask.kind === 'video' ? 'Save video' : 'Save picture',
    confirmLabel: 'Save',
    defaultPath: downloads,
    defaultName: ask.name,
    filters: ext ? [{ name: ask.kind === 'video' ? 'Video' : 'Picture', extensions: [ext] }] : undefined
  })
  if (!dest) return { saved: false }
  const out = ext && !dest.toLowerCase().endsWith(`.${ext.toLowerCase()}`) ? `${dest}.${ext}` : dest
  const r = await window.api.app.reportSaveMedia(file, root, ask.path, out)
  return { saved: true, how: 'file', file: r.file, bytes: r.bytes }
}
