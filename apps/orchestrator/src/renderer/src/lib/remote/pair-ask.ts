import type { RemotePairAsk, RemotePlace } from '@shared/remote-protocol'
import { requestConfirm, useConfirmStore } from '../confirm/confirm-store'

let showing: { askId: string; confirmId: number } | null = null

function countryName(code: string | undefined): string {
  if (!code) return ''
  try {
    return new Intl.DisplayNames(undefined, { type: 'region' }).of(code) ?? code
  } catch {
    return code
  }
}

function placeText(p: RemotePlace | null): string {
  if (!p) return ''
  const where = [p.city || p.region, countryName(p.country)].filter(Boolean).join(', ')
  return [where, p.ip].filter(Boolean).join(' · ')
}

async function ask(a: RemotePairAsk): Promise<void> {
  const pending = requestConfirm({
    title: 'Allow this phone?',
    message: `A phone used the pairing code from this computer. Allow it only if it's yours: once allowed, it can see and drive this computer's projects and terminals.`,
    items: [
      `${a.device}${a.uaShort ? ` · ${a.uaShort}` : ''}`,
      `Account: ${a.email ?? 'not signed in'}`,
      `From: ${placeText(a.place) || 'unknown'}`
    ],
    confirmLabel: 'Allow',
    cancelLabel: 'Deny',
    danger: false,
    desktopOnly: true,
    clickOnly: true
  })
  showing = { askId: a.id, confirmId: useConfirmStore.getState().request?.id ?? -1 }
  const allow = await pending
  const closedByMac = showing?.askId !== a.id
  if (showing?.askId === a.id) showing = null
  if (closedByMac) return
  try {
    const r = await window.api.remote.answerPair(a.id, allow)
    console.info(`[remote] pairing ${a.id} ${allow ? 'allowed' : 'denied'}: ${r.state}`)
  } catch (e) {
    console.warn(`[remote] pairing answer failed: ${(e as Error).message}`)
  }
}

export function watchPairAsks(): () => void {
  const offAsk = window.api.remote.onPairAsk((a) => void ask(a))
  const offDone = window.api.remote.onPairAskDone(({ id }) => {
    if (!showing || showing.askId !== id) return
    const confirmId = showing.confirmId
    showing = null
    if (useConfirmStore.getState().request?.id === confirmId) useConfirmStore.getState().respond(false)
  })
  return () => {
    offAsk()
    offDone()
  }
}
