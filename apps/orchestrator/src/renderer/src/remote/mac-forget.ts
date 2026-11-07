import { desktopNameKey, pushKeyName, pushOpenKey } from '@shared/remote-push'
import { forgetPairing } from './e2e'
import { storeDelete } from './push-store'
import { dropMac, macPath } from './macs'

export async function forgetMacOnPhone(hostId: string, why: string): Promise<{ unsubscribed: boolean; unregistered: boolean }> {
  let unsubscribed = false
  let unregistered = false
  try {
    const reg = await navigator.serviceWorker?.getRegistration(macPath(hostId))
    if (reg && reg.scope.endsWith(macPath(hostId))) {
      const sub = await reg.pushManager.getSubscription().catch(() => null)
      if (sub) unsubscribed = await sub.unsubscribe().catch(() => false)
      for (const n of await reg.getNotifications().catch(() => [] as Notification[])) n.close()
      unregistered = await reg.unregister().catch(() => false)
    }
  } catch {
  }
  await forgetPairing(hostId, true).catch(() => {})
  await Promise.all([storeDelete(pushKeyName(hostId)), storeDelete(pushOpenKey(hostId)), storeDelete(desktopNameKey(hostId))].map((p) => p.catch(() => {})))
  try {
    for (const k of Object.keys(localStorage)) if (k.endsWith(`:${hostId}`) && k.startsWith('satura-remote-')) localStorage.removeItem(k)
  } catch {
  }
  dropMac(hostId)
  console.info(`[macs] removed ${hostId} from this phone (${why}): pairing and key deleted${unsubscribed ? ', notifications unsubscribed' : ''}${unregistered ? ', its worker unregistered' : ''}; other Macs are untouched`)
  return { unsubscribed, unregistered }
}
