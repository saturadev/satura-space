import { ipcMain, webContents } from 'electron'
import type {
  DashboardEdit,
  DashboardFetchRequest,
  DashboardGitRequest,
  DashboardHandleRequest,
  DashboardLogsRequest
} from '@shared/dashboard'
import { censusTrack } from '@shared/census'
import { editDashboard, loadDashboard, saveWidgetState } from './files'
import { abortFetch, proxyFetch } from './proxy'
import { callUnityHandle } from './unity-handle'
import { dashboardFile, dashboardGit, dashboardLogs } from './sources'
import { watchDashboard } from './watch'
import { alertStates, forgetWindow, markAlertSent, setOpenProjects } from './alerts'

const subs = new Map<string, () => void>()
censusTrack('dashboard.subs', subs)
const tracked = new Set<number>()

function track(wcId: number): void {
  if (tracked.has(wcId)) return
  const wc = webContents.fromId(wcId)
  if (!wc) return
  tracked.add(wcId)
  wc.once('destroyed', () => {
    tracked.delete(wcId)
    forgetWindow(wcId)
    for (const [key, stop] of subs) {
      if (!key.startsWith(`${wcId}:`)) continue
      stop()
      subs.delete(key)
    }
  })
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

export function registerDashboardHandlers(): void {
  ipcMain.handle('dashboard:load', (_e, project: unknown) => loadDashboard(text(project)))
  ipcMain.handle('dashboard:edit', (_e, project: unknown, edit: DashboardEdit) => editDashboard(text(project), edit))
  ipcMain.on('dashboard:state', (_e, project: unknown, widget: unknown, key: unknown, value: unknown) =>
    saveWidgetState(text(project), text(widget), text(key), value)
  )
  ipcMain.handle('dashboard:fetch', (_e, project: unknown, req: DashboardFetchRequest) => proxyFetch(text(project), req ?? { url: '' }))
  ipcMain.on('dashboard:abort', (_e, id: unknown) => abortFetch(text(id)))
  ipcMain.handle('dashboard:handle', (_e, project: unknown, req: DashboardHandleRequest) => callUnityHandle(text(project), req ?? { name: '' }))
  ipcMain.handle('dashboard:git', (_e, project: unknown, req: DashboardGitRequest) => dashboardGit(text(project), req ?? {}))
  ipcMain.handle('dashboard:logs', (_e, project: unknown, req: DashboardLogsRequest) => dashboardLogs(text(project), req ?? {}))
  ipcMain.handle('dashboard:file', (_e, project: unknown, path: unknown, as: unknown) =>
    dashboardFile(text(project), text(path), as === 'json' || as === 'text' ? as : undefined)
  )
  ipcMain.on('dashboard:watch', (e, id: unknown, project: unknown, folder: unknown) => {
    const wcId = e.sender.id
    const key = `${wcId}:${text(id)}`
    track(wcId)
    subs.get(key)?.()
    const sender = e.sender
    subs.set(
      key,
      watchDashboard(
        text(project),
        (files) => {
          if (!sender.isDestroyed()) sender.send('dashboard:changed', { id: text(id), files })
        },
        folder === 'plugins' ? 'plugins' : 'dashboard'
      )
    )
  })
  ipcMain.on('dashboard:unwatch', (e, id: unknown) => {
    const key = `${e.sender.id}:${text(id)}`
    subs.get(key)?.()
    subs.delete(key)
  })
  ipcMain.on('dashboard:projects', (e, projects: unknown) => {
    track(e.sender.id)
    setOpenProjects(e.sender.id, Array.isArray(projects) ? projects.map(text) : [])
  })
  ipcMain.handle('dashboard:alerts', (_e, project: unknown) => alertStates(text(project)))
  ipcMain.on('dashboard:alertSent', (_e, project: unknown, id: unknown, to: unknown) => markAlertSent(text(project), text(id), text(to)))
}
