import { create } from 'zustand'
import { ArrowUp, Paperclip, X } from 'lucide-react'
import { invokeRemote } from '../ws-transport'
import { haptic, run, call, showToast, useShell } from './bridge'
import { openMenu } from './menus'

interface Shot {
  id: string
  url: string
  blob: Blob
  ext: 'png' | 'jpg'
  w: number
  h: number
}

const MAX_SIDE = 2048
const MAX_SHOTS = 6
const CHUNK = 512 * 1024

const useShots = create<{ shots: Shot[]; sent: number; total: number }>(() => ({ shots: [], sent: 0, total: 0 }))

const clip = typeof navigator !== 'undefined' ? navigator.clipboard : undefined
const readClip = clip?.read ? clip.read.bind(clip) : null

const kb = (n: number): string => `${Math.round(n / 1024)} KB`

function newId(): string {
  return [...crypto.getRandomValues(new Uint8Array(8))].map((b) => b.toString(16).padStart(2, '0')).join('')
}

function base64(b: Uint8Array): string {
  let s = ''
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000))
  return btoa(s)
}

async function shrink(file: Blob): Promise<Shot> {
  const bmp = await createImageBitmap(file)
  const k = Math.min(1, MAX_SIDE / Math.max(bmp.width, bmp.height))
  const w = Math.max(1, Math.round(bmp.width * k))
  const h = Math.max(1, Math.round(bmp.height * k))
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  c.getContext('2d')?.drawImage(bmp, 0, 0, w, h)
  bmp.close()
  const ext = file.type === 'image/png' ? 'png' : 'jpg'
  const blob = await new Promise<Blob | null>((r) => c.toBlob(r, ext === 'png' ? 'image/png' : 'image/jpeg', 0.85))
  c.width = c.height = 0
  if (!blob) throw new Error("The phone couldn't read that image")
  return { id: newId(), url: URL.createObjectURL(blob), blob, ext, w, h }
}

export async function addImages(files: Blob[], from: string): Promise<void> {
  for (const f of files) {
    if (useShots.getState().shots.length >= MAX_SHOTS) {
      showToast(`Up to ${MAX_SHOTS} images per message`)
      return
    }
    try {
      const s = await shrink(f)
      useShots.setState((st) => ({ shots: [...st.shots, s] }))
      console.info(`[attach] ${from}: ${f.type || 'image'} ${kb(f.size)} -> ${s.ext} ${s.w}x${s.h} ${kb(s.blob.size)}`)
    } catch (e) {
      console.info(`[attach] ${from}: ${f.type || 'file'} refused: ${(e as Error).message}`)
      showToast("The phone couldn't read that image")
    }
  }
}

function removeShot(id: string): void {
  if (useShots.getState().total) return
  const s = useShots.getState().shots.find((x) => x.id === id)
  if (s) URL.revokeObjectURL(s.url)
  useShots.setState((st) => ({ shots: st.shots.filter((x) => x.id !== id) }))
}

let input: HTMLInputElement | null = null

function pick(camera: boolean): void {
  if (!input) {
    input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.style.display = 'none'
    input.dataset.wsAttachInput = ''
    input.addEventListener('change', () => {
      const files = [...(input?.files ?? [])]
      const from = input?.hasAttribute('capture') ? 'camera' : 'library'
      if (input) input.value = ''
      void addImages(files, from)
    })
    document.body.appendChild(input)
  }
  input.multiple = !camera
  if (camera) input.setAttribute('capture', 'environment')
  else input.removeAttribute('capture')
  input.click()
}

async function pasteImages(): Promise<void> {
  try {
    if (!readClip) throw new Error('no clipboard')
    const blobs: Blob[] = []
    for (const item of await readClip()) {
      const type = item.types.find((t) => t.startsWith('image/'))
      if (type) blobs.push(await item.getType(type))
    }
    if (!blobs.length) return showToast('There is no image on the clipboard')
    await addImages(blobs, 'clipboard')
  } catch {
    showToast("The browser didn't share the clipboard. Long-press the text field and choose Paste.")
  }
}

export function pastedImages(data: DataTransfer | null): boolean {
  const files = [...(data?.files ?? [])].filter((f) => f.type.startsWith('image/'))
  if (!files.length) return false
  void addImages(files, 'paste')
  return true
}

export function openAttach(anchor: HTMLElement): void {
  openMenu(
    [
      { id: 'library', label: 'Photo Library or Files', icon: 'photo', enabled: true },
      { id: 'camera', label: 'Take Photo', icon: 'camera', enabled: true },
      { id: 'paste', label: 'Paste Image', icon: 'doc.on.clipboard', enabled: true }
    ],
    '',
    anchor,
    false,
    (n) => (n.id === 'paste' ? void pasteImages() : pick(n.id === 'camera'))
  )
}

export function hasShots(): boolean {
  return useShots.getState().shots.length > 0
}

async function upload(root: string, s: Shot): Promise<string> {
  const bytes = new Uint8Array(await s.blob.arrayBuffer())
  let path = ''
  for (let at = 0; at < bytes.length; at += CHUNK) {
    const part = bytes.subarray(at, at + CHUNK)
    path = await invokeRemote<string>('remote:attach', { root, id: s.id, ext: s.ext, at, total: bytes.length, data: base64(part) })
    useShots.setState((st) => ({ sent: st.sent + part.length }))
  }
  return path
}

export async function sendShots(text: string, restore: (text: string) => void): Promise<void> {
  const { shots, total } = useShots.getState()
  const root = useShell.getState().workspace?.root
  if (total || !shots.length) return
  if (!root) return showToast('No project is open')
  useShots.setState({ sent: 0, total: shots.reduce((n, s) => n + s.blob.size, 0) })
  console.info(`[attach] sending ${shots.length} images, ${kb(useShots.getState().total)}, then ${text.length} chars`)
  try {
    const paths: string[] = []
    for (const s of shots) paths.push(await upload(root, s))
    console.info(`[attach] on the desktop: ${paths.join(', ')}`)
    for (const s of shots) URL.revokeObjectURL(s.url)
    useShots.setState({ shots: [], sent: 0, total: 0 })
    haptic('success')
    run('composer', 'The terminal', 5, (req) => call('send', text, req, paths))
  } catch (e) {
    useShots.setState({ sent: 0, total: 0 })
    console.info(`[attach] upload failed: ${(e as Error).message}`)
    restore(text)
    showToast(`The images didn't reach the desktop: ${(e as Error).message}`)
  }
}

export function AttachKey({ className }: { className: string }) {
  const n = useShots((s) => s.shots.length)
  return (
    <button type="button" aria-label="Attach images" onMouseDown={(e) => e.preventDefault()} onClick={(e) => openAttach(e.currentTarget)} className={`ws-glass ws-press relative flex items-center justify-center ${className}`} data-ws-key="attach">
      <Paperclip size={17} strokeWidth={2.2} />
      {n > 0 && <span className="absolute right-1 top-1 min-w-4 rounded-full bg-[rgb(10_132_255)] px-1 text-[10px] font-bold leading-4">{n}</span>}
    </button>
  )
}

export function AttachStrip({ onSend }: { onSend: () => void }) {
  const { shots, sent, total } = useShots()
  if (!shots.length) return null
  return (
    <div className="flex items-center gap-2 px-3 pt-1.5" data-ws-attach-strip>
      <div className="ws-hscroll flex min-w-0 flex-1 gap-2">
        {shots.map((s) => (
          <button key={s.id} type="button" aria-label="Remove image" onMouseDown={(e) => e.preventDefault()} onClick={() => removeShot(s.id)} className="relative h-14 w-14 shrink-0 overflow-hidden rounded-[10px] bg-white/[0.06]" data-ws-attach-thumb={s.id}>
            <img src={s.url} alt="" className="h-full w-full object-cover" />
            {!total && (
              <span className="absolute right-1 top-1 flex h-[18px] w-[18px] items-center justify-center rounded-full bg-black/65">
                <X size={12} strokeWidth={2.6} />
              </span>
            )}
          </button>
        ))}
      </div>
      {total ? (
        <span className="w-11 shrink-0 text-center text-[12px] font-semibold tabular-nums text-[var(--ws-label2)]" data-ws-attach-progress>{Math.round((sent / total) * 100)}%</span>
      ) : (
        <button type="button" aria-label="Send" onMouseDown={(e) => e.preventDefault()} onClick={onSend} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-[rgb(10_132_255)] text-white" data-ws-attach-send>
          <ArrowUp size={20} strokeWidth={2.6} />
        </button>
      )}
    </div>
  )
}
