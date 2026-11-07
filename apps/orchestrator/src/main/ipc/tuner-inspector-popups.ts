import { ipcMain } from 'electron'
import { validObjectQuery, type TunerObjectQuery, type TunerObjectQueryResult } from '@shared/tuner-inspector-popups'
import { UnityControlClient } from '../unity/unity-control-client'
import { unityProvider } from '../unity/unity-instance-provider'
import { editorNotRunningError } from '../unity/scratchpad-store'

const CONNECT_WAIT_MS = 3000
const COMMAND_TIMEOUT_MS = 20_000

let current: { key: string; client: UnityControlClient } | null = null

async function clientFor(projectPath: string): Promise<UnityControlClient | string> {
  const ctl = unityProvider.primaryControl(projectPath)
  if (!ctl || !ctl.alive) return editorNotRunningError(projectPath)
  const key = `${ctl.projectKey}\n${ctl.port}`
  if (current?.key !== key) {
    current?.client.close()
    current = { key, client: new UnityControlClient(ctl.port) }
  }
  const client = current.client
  const deadline = Date.now() + CONNECT_WAIT_MS
  while (!client.isConnected && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50))
  return client.isConnected ? client : 'The Unity editor control socket is not reachable yet. It may be reloading.'
}

export async function tunerPopupObjects(projectPath: string, query: TunerObjectQuery): Promise<TunerObjectQueryResult> {
  const q = validObjectQuery(query)
  if (!q) return { ok: false, error: 'Invalid object query' }
  const client = await clientFor(projectPath)
  if (typeof client === 'string') return { ok: false, error: client }
  const r = await client.command('tunerPopup/objects', { ...q }, COMMAND_TIMEOUT_MS)
  if (!r) return { ok: false, error: 'The Unity editor did not answer in time. It may be compiling, importing or showing a dialog.' }
  if (r.status !== 'completed') return { ok: false, error: typeof r.error === 'string' && r.error ? r.error : "Couldn't list objects" }
  const data = r.objects as Omit<TunerObjectQueryResult, 'ok'> | undefined
  if (!data) return { ok: false, error: 'The Unity editor returned no objects' }
  return { ok: true, ...data }
}

export function registerTunerPopupHandlers(): void {
  ipcMain.handle(
    'tunerPopup:objects',
    (_e, { projectPath, query }: { projectPath: string; query: TunerObjectQuery }): Promise<TunerObjectQueryResult> =>
      tunerPopupObjects(projectPath, query)
  )
}
