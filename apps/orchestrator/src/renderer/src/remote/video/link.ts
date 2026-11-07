import { useEffect, useState } from 'react'
import type { RvLayout, RvPhoneMsg, RvSettings, RvTunerMeta } from '@shared/remote-video'
import { VideoReceiver, type ReceiverStats, type VideoDiag } from './receiver'
import { censusGauge } from '@shared/census'
import { setMediaChannel } from '../media-cache'
import { setGameChannel } from '../game-input/link'
import { onConnectionState, setLinkChannel, setLinkHeard, videoSecret } from '../ws-transport'
import { saveStreamPrefs, streamPrefs } from './prefs'
import { stepTrouble } from './steps'

interface Viewer {
  source: string
  project?: string | null
  canvas: HTMLCanvasElement | null
  onStats?: (s: ReceiverStats) => void
}

type Tile = (id: string, jpeg: Uint8Array) => void

let rx: VideoReceiver | null = null
let viewer: Viewer | null = null
const viewingListeners = new Set<() => void>()
let lastStats: ReceiverStats | null = null
const statsListeners = new Set<(s: ReceiverStats) => void>()
const tunerListeners = new Set<(m: RvTunerMeta) => void>()
const tileListeners = new Set<Tile>()
const layoutListeners = new Set<(l: RvLayout) => void>()
const openListeners = new Set<() => void>()
const termListeners = new Set<(text: string) => void>()
const termStateListeners = new Set<(open: boolean) => void>()

censusGauge('phone.videoListeners', () => statsListeners.size + tunerListeners.size + tileListeners.size + layoutListeners.size + openListeners.size + termListeners.size + termStateListeners.size)

function receiver(): VideoReceiver {
  if (rx) return rx
  const r = new VideoReceiver({
    port: window.api.remoteVideo,
    secret: videoSecret,
    source: null,
    canvas: null,
    onStats: (s) => {
      lastStats = s
      viewer?.onStats?.(s)
      for (const l of statsListeners) l(s)
    },
    onTunerFrame: (m) => {
      for (const l of tunerListeners) l(m)
    },
    onTile: (id, jpeg) => {
      for (const l of tileListeners) l(id, jpeg)
    },
    onLayout: (l) => {
      for (const cb of layoutListeners) cb(l)
    },
    onTerm: (text) => {
      for (const l of termListeners) l(text)
    },
    onTermState: (open) => {
      for (const l of termStateListeners) l(open)
    },
    onMedia: setMediaChannel,
    onGameChannel: setGameChannel,
    onLink: setLinkChannel,
    onOpen: () => {
      if (viewer) {
        r.set(streamPrefs(viewer.project ?? null))
        r.send({ t: 'source', source: viewer.source })
      }
      for (const l of openListeners) l()
    }
  })
  rx = r
  setLinkHeard(() => r.lastHeard)
  void r.start()
  document.addEventListener('visibilitychange', onVisibility)
  onConnectionState((state) => {
    if (state !== 'online') return
    setTimeout(() => {
      if (!r.open) r.restart('the desktop is reachable again')
    }, 0)
  })
  return r
}

function onVisibility(): void {
  const r = rx
  if (!r?.open) return
  if (document.visibilityState === 'hidden') {
    console.info('video: page hidden, pausing the stream and layout tiles on the Mac')
    r.send({ t: 'source', source: null })
    r.send({ t: 'layout', on: false })
    return
  }
  console.info('video: page visible again')
  r.send({ t: 'source', source: r.source })
  if (r.source) r.requestKey('the page is visible again')
  for (const l of openListeners) l()
}

export function watchVideo(v: Viewer): () => void {
  viewer = v
  for (const l of viewingListeners) l()
  const r = receiver()
  r.setCanvas(v.canvas)
  r.set(streamPrefs(v.project ?? null))
  r.setSource(v.source)
  console.log(`video: viewing ${v.source}`)
  return () => {
    if (viewer !== v) return
    viewer = null
    for (const l of viewingListeners) l()
    r.setCanvas(null)
    r.setSource(null)
  }
}

export function setVideoCanvas(v: Viewer, canvas: HTMLCanvasElement | null): void {
  v.canvas = canvas
  if (viewer === v) rx?.setCanvas(canvas)
}

export function sendVideo(m: RvPhoneMsg): void {
  receiver().send(m)
}

export function requestVideoKey(why: string): void {
  receiver().requestKey(why)
}

export function newVideoTrack(why: string): void {
  receiver().askVideo(why)
}

export function setVideoSettings(settings: Partial<RvSettings>): void {
  saveStreamPrefs(viewer?.project ?? null, settings)
  receiver().set(settings)
}

export function videoStats(): ReceiverStats | null {
  return lastStats
}

export function videoDiag(): VideoDiag | null {
  return rx?.diag() ?? null
}

export function restartVideo(why: string): void {
  rx?.restart(why)
}

export function videoTrouble(): string {
  return stepTrouble(lastStats?.furthest ?? 'desktop')
}

function listen<T>(set: Set<T>, cb: T): () => void {
  receiver()
  set.add(cb)
  return () => set.delete(cb)
}

export const onVideoStats = (cb: (s: ReceiverStats) => void): (() => void) => listen(statsListeners, cb)

export function useVideoViewing(): boolean {
  const [on, setOn] = useState(() => !!viewer)
  useEffect(() => {
    const l = (): void => setOn(!!viewer)
    viewingListeners.add(l)
    l()
    return () => {
      viewingListeners.delete(l)
    }
  }, [])
  return on
}

export function useVideoStats(): ReceiverStats | null {
  const [s, setS] = useState(lastStats)
  useEffect(() => onVideoStats(setS), [])
  return s
}
export const onTunerMeta = (cb: (m: RvTunerMeta) => void): (() => void) => listen(tunerListeners, cb)
export const onTile = (cb: Tile): (() => void) => listen(tileListeners, cb)
export const onLayout = (cb: (l: RvLayout) => void): (() => void) => listen(layoutListeners, cb)
export const onLinkOpen = (cb: () => void): (() => void) => listen(openListeners, cb)
export const linkOpen = (): boolean => !!rx?.open
export const ensureVideoLink = (): void => void receiver()
export const onTermText = (cb: (text: string) => void): (() => void) => listen(termListeners, cb)
export const onTermLink = (cb: (open: boolean) => void): (() => void) => listen(termStateListeners, cb)
export const termLinkOpen = (): boolean => !!rx?.termOpen
export const sendTermText = (text: string): boolean => !!rx?.sendTerm(text)
