import { useEffect, useState } from 'react'
import { linkVerdict, type LinkVerdict, type MacLinkDiag, type PhoneLinkDiag } from '@shared/remote-link-diag'
import { callsDiag, relayDiag } from './ws-transport'
import { linkOpen, sendVideo, videoDiag, videoStats } from './video/link'

const REPORT_MS = 2000

export interface LinkDiagView {
  phone: PhoneLinkDiag | null
  mac: MacLinkDiag | null
  verdict: LinkVerdict
}

export function phoneLinkDiag(): PhoneLinkDiag | null {
  const v = videoDiag()
  if (!v) return null
  const { rtc, ...video } = v
  return { at: Date.now(), calls: callsDiag(), relay: relayDiag(), rtc, video }
}

export function linkDiagView(): LinkDiagView {
  const phone = phoneLinkDiag()
  const mac = videoStats()?.mac?.link ?? null
  return { phone, mac, verdict: phone ? linkVerdict(phone, mac) : { kind: 'waiting', text: 'No WebRTC link to the desktop yet' } }
}

export function useLinkDiag(on: boolean): LinkDiagView | null {
  const [view, setView] = useState<LinkDiagView | null>(null)
  useEffect(() => {
    if (!on) {
      setView(null)
      return
    }
    setView(linkDiagView())
    const t = setInterval(() => setView(linkDiagView()), 1000)
    return () => clearInterval(t)
  }, [on])
  return view
}

let reporting: ReturnType<typeof setInterval> | null = null

export function startLinkReports(): void {
  if (reporting) return
  reporting = setInterval(() => {
    if (!linkOpen() || document.visibilityState !== 'visible') return
    const diag = phoneLinkDiag()
    if (diag) sendVideo({ t: 'diag', diag })
  }, REPORT_MS)
}
