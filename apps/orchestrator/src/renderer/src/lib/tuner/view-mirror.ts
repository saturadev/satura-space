import type { TunerMirror } from '@shared/tuner'

export const MIRROR_FROM = Math.random().toString(36).slice(2, 10)

export const isPhoneView = (): boolean => typeof document !== 'undefined' && document.documentElement.dataset.layout === 'mobile'

const ORBIT_MS = 50

type Payload = Omit<TunerMirror, 'from'>

const orbitTimers = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> | null; next: Payload | null }>()

export function sendTunerMirror(p: Payload): void {
  window.api.tuner.mirror({ ...p, from: MIRROR_FROM })
}

export function sendTunerOrbit(projectPath: string, session: string, orbit: unknown, flush = false): void {
  const key = `${projectPath}\n${session}`
  let st = orbitTimers.get(key)
  if (!st) {
    st = { at: 0, timer: null, next: null }
    orbitTimers.set(key, st)
  }
  const s = st
  s.next = { projectPath, session, orbit }
  const now = performance.now()
  const fire = (): void => {
    s.timer = null
    s.at = performance.now()
    if (s.next) sendTunerMirror(s.next)
    s.next = null
  }
  if (flush || now - s.at >= ORBIT_MS) {
    if (s.timer) clearTimeout(s.timer)
    fire()
  } else if (!s.timer) s.timer = setTimeout(fire, ORBIT_MS - (now - s.at))
}

export function onTunerMirror(projectPath: string, session: string, cb: (m: TunerMirror) => void): () => void {
  return window.api.tuner.onMirror((m) => {
    if (!m || m.from === MIRROR_FROM || m.projectPath !== projectPath || m.session !== session) return
    cb(m)
  })
}
