import { ipcMain, webContents, type WebContents } from 'electron'
import type { UnityLogEvent, UnityLogLine } from '@shared/api'
import { unityLogTailers } from '../unity/unity-log-tailer'
import { onRendererReset } from '../window/renderer-reset'
import { censusTrack } from '@shared/census'

interface Sub {
  count: number
  remove: (() => void) | null
  ready: Promise<void>
}

const subsByWc = new Map<number, Map<string, Sub>>()
censusTrack('unity-console.subsByWc', subsByWc)

function send(wcId: number, payload: UnityLogEvent): void {
  const wc = webContents.fromId(wcId)
  if (wc && !wc.isDestroyed()) wc.send('unity:console:log', payload)
}

function dropAll(wcId: number): void {
  const m = subsByWc.get(wcId)
  if (m) {
    subsByWc.delete(wcId)
    for (const sub of m.values()) {
      sub.count = 0
      sub.remove?.()
      sub.remove = null
    }
  }
}

function isCurrent(wcId: number, projectPath: string, sub: Sub): boolean {
  return subsByWc.get(wcId)?.get(projectPath) === sub
}

async function subscribe(sender: WebContents, projectPath: string): Promise<UnityLogLine[]> {
  const wcId = sender.id
  onRendererReset(sender, 'unity:console', () => dropAll(wcId))
  let m = subsByWc.get(wcId)
  if (!m) {
    m = new Map()
    subsByWc.set(wcId, m)
  }
  const existing = m.get(projectPath)
  if (existing) {
    existing.count++
    await existing.ready
    if (isCurrent(wcId, projectPath, existing) && existing.remove) {
      return await unityLogTailers.getSnapshot(projectPath)
    }
    existing.count--
    return subscribe(sender, projectPath)
  }
  let markReady: () => void = () => {}
  const sub: Sub = {
    count: 1,
    remove: null,
    ready: new Promise<void>((r) => (markReady = r))
  }
  m.set(projectPath, sub)
  try {
    const { snapshot, remove } = await unityLogTailers.addListener(projectPath, (lines) =>
      send(wcId, { projectPath, lines })
    )
    if (sub.count <= 0 || !isCurrent(wcId, projectPath, sub)) remove()
    else sub.remove = remove
    return snapshot
  } catch (e) {
    if (isCurrent(wcId, projectPath, sub)) {
      m.delete(projectPath)
      if (m.size === 0 && subsByWc.get(wcId) === m) subsByWc.delete(wcId)
    }
    throw e
  } finally {
    markReady()
  }
}

export function registerUnityConsoleHandlers(): void {
  ipcMain.handle(
    'unity:console:subscribe',
    (event, { projectPath }: { projectPath: string }): Promise<UnityLogLine[]> =>
      subscribe(event.sender, projectPath)
  )

  ipcMain.on('unity:console:unsubscribe', (event, { projectPath }: { projectPath: string }) => {
    const wcId = event.sender.id
    const m = subsByWc.get(wcId)
    const sub = m?.get(projectPath)
    if (!m || !sub) return
    sub.count--
    if (sub.count <= 0) {
      sub.remove?.()
      sub.remove = null
      m.delete(projectPath)
      if (m.size === 0) subsByWc.delete(wcId)
    }
  })
}
