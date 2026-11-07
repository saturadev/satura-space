import { app, ipcMain } from 'electron'
import type { OpenFileRequest } from '@shared/api'
import { applyZoomToAllWindows } from '../window/window-manager'
import { notifyDevRelaunchRendererWarm } from '../dev-relaunch'
import { setLaunchStep, type LaunchStep } from '../window/splash-window'
import { openBugReport } from '../bug-report'
import { openFileInApp } from '../window/open-file-in-app'
import { compileReport } from '../report/compile'
import { listReports } from '../report/list'
import { runReportAction } from '../satura-exec'
import { readCodeFile, resolveCodeRefs } from '../report/code-refs'
import { writeReportExport } from '../report/export'
import { scanReport } from '../report/export-scan'
import { pathHoverInfo, reportHoverInfo } from '../hover-info'
import { frameMediaBase, reportMediaInfo, reportMediaRead, reportSaveMedia, reportStat } from '../report/report-frame-protocol'
import { appCaches, clearAppCaches } from '../app-caches'
import { APP_CACHE_IDS, type AppCacheId } from '@shared/app-caches'
import type { ReportExportPayload } from '@shared/report-export'

export function registerAppHandlers(): void {
  ipcMain.handle('app:getVersion', () => app.getVersion())

  ipcMain.handle('app:isDev', () => !app.isPackaged)

  ipcMain.handle('app:reportBug', () => openBugReport())

  ipcMain.handle('app:set-zoom-factor', (_event, factor: number) => {
    if (typeof factor === 'number' && Number.isFinite(factor)) applyZoomToAllWindows(factor)
  })

  ipcMain.handle('app:openFile', (event, req: OpenFileRequest): boolean =>
    openFileInApp(req, event.sender.id)
  )

  ipcMain.handle('app:compileReport', (_event, file: string, root?: string) =>
    compileReport(String(file), typeof root === 'string' && root ? root : undefined)
  )

  ipcMain.handle('app:reportAction', (_event, file: string, code: string, root: string) =>
    runReportAction(String(file), String(code ?? ''), typeof root === 'string' ? root : '')
  )

  ipcMain.handle('app:listReports', (_event, root: string) => (typeof root === 'string' && root ? listReports(root) : []))

  ipcMain.handle('app:reportCodeRefs', (_event, file: string, root: string | undefined, refs: string[]) =>
    resolveCodeRefs(String(file), typeof root === 'string' && root ? root : undefined, Array.isArray(refs) ? refs.map(String) : [])
  )

  ipcMain.handle('app:reportReadCode', (_event, file: string, root: string | undefined, rel: string) =>
    readCodeFile(String(file), typeof root === 'string' && root ? root : undefined, String(rel))
  )

  ipcMain.handle('app:reportStat', (_event, file: unknown, root: unknown, path: unknown) =>
    reportStat(String(file ?? ''), typeof root === 'string' ? root : '', String(path ?? ''))
  )

  ipcMain.handle('app:reportMediaInfo', (_event, file: unknown, root: unknown, path: unknown) =>
    reportMediaInfo(String(file ?? ''), typeof root === 'string' ? root : '', String(path ?? ''))
  )

  ipcMain.handle('app:reportMediaRead', (_event, file: unknown, root: unknown, path: unknown, offset: unknown, length: unknown) =>
    reportMediaRead(String(file ?? ''), typeof root === 'string' ? root : '', String(path ?? ''), Number(offset), Number(length))
  )

  ipcMain.handle('app:reportFrameMedia', (_event, file: unknown, root: unknown) => frameMediaBase(String(file ?? ''), typeof root === 'string' ? root : ''))

  ipcMain.handle('app:reportSaveMedia', (_event, file: unknown, root: unknown, path: unknown, dest: unknown) =>
    reportSaveMedia(String(file ?? ''), typeof root === 'string' ? root : '', String(path ?? ''), String(dest ?? ''))
  )

  ipcMain.handle('app:caches', () => appCaches())

  ipcMain.handle('app:clearCaches', (_event, ids: unknown) =>
    clearAppCaches(Array.isArray(ids) ? ids.filter((id): id is AppCacheId => APP_CACHE_IDS.includes(id as AppCacheId)) : [])
  )

  ipcMain.handle('app:pathInfo', (_event, path: string, git?: boolean) => pathHoverInfo(String(path ?? ''), git === true))

  ipcMain.handle('app:reportInfo', (_event, file: string, root: string) => reportHoverInfo(String(file ?? ''), typeof root === 'string' ? root : ''))

  ipcMain.handle('app:reportExportScan', (_event, file: string) => scanReport(String(file)))


  ipcMain.handle('app:reportExportWrite', (_event, out: string, payload: ReportExportPayload) => writeReportExport(String(out), payload))

  ipcMain.on('app:reportDiag', (_event, line: unknown) => {
    console.log(`[report] ${String(line).replace(/\s+/g, ' ').slice(0, 400)}`)
  })

  ipcMain.on('app:renderer-warm', (event) => {
    notifyDevRelaunchRendererWarm(event.sender.id)
  })

  ipcMain.on('app:launch-step', (_event, step: unknown) => {
    if (step === 'workspaces' || step === 'ready') setLaunchStep(step as LaunchStep)
  })
}
