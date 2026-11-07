import { ipcMain, webContents } from 'electron'
import { desktopOnly, onPhoneLeft, status as remoteStatus } from '../remote/host'
import { notePhoneDriftAnswer } from '../satura-exec/phone-drift'
import type { TunerRectInfo, TunerRectRequest, TunerRectsRequest } from '@shared/tuner-rect'
import type { TunerHandlesRequest, TunerHandlesState } from '@shared/tuner-handles'
import type { TunerAnimatorRequest, TunerAnimatorResult } from '@shared/tuner-animator'
import type { TunerStagingRequest } from '@shared/tuner-staging'
import type { TunerAnnotations, TunerAnnotationsRequest } from '@shared/tuner-annotations'
import type {
  TunerButtonResult,
  TunerCamera,
  TunerClearViewRequest,
  TunerCanvas,
  TunerEdit,
  TunerEntryTarget,
  TunerHierarchyRequest,
  TunerHierarchyResult,
  TunerObject,
  TunerOpened,
  TunerParticlesOp,
  TunerReset,
  TunerSaveResult,
  TunerResult,
  TunerState,
  TunerTransform,
  TunerTreeRequest,
  TunerView,
  TunerViewObject
} from '@shared/tuner'
import { tunerService, unwatchAllTunerViews, unwatchTunerViews, watchTunerViews } from '../unity/tuner'
import { addTunerViewObject, listTunerViews, writeTunerQuickView } from '../unity/tuner-view'
import { onRendererReset } from '../window/renderer-reset'
import type {
  TunerPickRectRequest,
  TunerPickRectResult,
  TunerPickRequest,
  TunerPickResult,
  TunerSceneSelection,
  TunerSceneSettings,
  TunerTheme
} from '@shared/tuner-sceneview'

export function registerTunerHandlers(): void {
  ipcMain.handle('tuner:listViews', (_e, { projectPath }: { projectPath: string }): TunerView[] =>
    listTunerViews(projectPath)
  )

  ipcMain.handle(
    'tuner:canvases',
    (_e, { projectPath }: { projectPath: string }): Promise<TunerResult<TunerCanvas[]>> =>
      tunerService.canvases(projectPath)
  )

  ipcMain.handle(
    'tuner:writeQuickView',
    (_e, { projectPath, quick }: { projectPath: string; quick: unknown }): TunerResult<string> =>
      writeTunerQuickView(projectPath, quick)
  )

  ipcMain.handle(
    'tuner:addObject',
    (_e, { projectPath, view, object }: { projectPath: string; view: string; object: TunerViewObject }): TunerResult<number> =>
      addTunerViewObject(projectPath, view, object)
  )

  ipcMain.handle('tuner:watchViews', (e, { projectPath }: { projectPath: string }) => {
    const wcId = e.sender.id
    onRendererReset(e.sender, 'tuner:watchViews', () => unwatchAllTunerViews(wcId))
    watchTunerViews(projectPath, wcId)
  })

  ipcMain.handle('tuner:unwatchViews', (e, { projectPath }: { projectPath: string }) => {
    unwatchTunerViews(projectPath, e.sender.id)
  })

  ipcMain.handle(
    'tuner:start',
    (
      e,
      { projectPath, session, view, restore }: { projectPath: string; session: string; view: string; restore?: unknown }
    ): Promise<TunerResult<TunerState>> => {
      const wcId = e.sender.id
      onRendererReset(e.sender, 'tuner:sessions', () => tunerService.stopAllFor(wcId))
      return tunerService.start(wcId, projectPath, session, view, restore)
    }
  )

  ipcMain.handle(
    'tuner:particles',
    (
      _e,
      { projectPath, session, op, speed }: { projectPath: string; session: string; op: TunerParticlesOp; speed?: number }
    ): Promise<TunerResult<null>> => tunerService.particles(projectPath, session, op, speed)
  )

  ipcMain.handle(
    'tuner:animator',
    (
      _e,
      { projectPath, session, req }: { projectPath: string; session: string; req: TunerAnimatorRequest }
    ): Promise<TunerResult<TunerAnimatorResult | null>> => tunerService.animator(projectPath, session, req)
  )

  ipcMain.handle(
    'tuner:staging',
    (_e, { projectPath, session, req }: { projectPath: string; session: string; req: TunerStagingRequest }): Promise<TunerResult<unknown>> =>
      tunerService.staging(projectPath, session, req)
  )

  ipcMain.handle(
    'tuner:hierarchy',
    (
      _e,
      { projectPath, session, req }: { projectPath: string; session: string; req: TunerHierarchyRequest }
    ): Promise<TunerResult<TunerHierarchyResult>> => tunerService.hierarchy(projectPath, session, req)
  )

  ipcMain.handle(
    'tuner:canvasView',
    (
      _e,
      { projectPath, session, canvas, scene }: { projectPath: string; session: string; canvas: string; scene: string }
    ): Promise<TunerResult<TunerState | null>> => tunerService.canvasView(projectPath, session, canvas, scene)
  )

  ipcMain.handle(
    'tuner:select',
    (
      _e,
      { projectPath, session, state }: { projectPath: string; session: string; state: string }
    ): Promise<TunerResult<TunerState>> => tunerService.select(projectPath, session, state)
  )

  ipcMain.handle(
    'tuner:reset',
    (
      _e,
      { projectPath, session, reset }: { projectPath: string; session: string; reset: TunerReset }
    ): Promise<TunerResult<TunerState>> => tunerService.reset(projectPath, session, reset)
  )

  ipcMain.handle(
    'tuner:save',
    (
      _e,
      { projectPath, session, stopPlay }: { projectPath: string; session: string; stopPlay?: boolean }
    ): Promise<TunerResult<TunerSaveResult>> => tunerService.saveOrDiscard(projectPath, session, true, stopPlay === true)
  )

  ipcMain.handle(
    'tuner:discard',
    (
      _e,
      { projectPath, session, stopPlay }: { projectPath: string; session: string; stopPlay?: boolean }
    ): Promise<TunerResult<TunerSaveResult>> => tunerService.saveOrDiscard(projectPath, session, false, stopPlay === true)
  )

  ipcMain.handle(
    'tuner:discardScene',
    (_e, { projectPath }: { projectPath: string }): Promise<TunerResult<TunerSaveResult>> => tunerService.discardScene(projectPath)
  )

  ipcMain.handle(
    'tuner:saveScene',
    (_e, { projectPath }: { projectPath: string }): Promise<TunerResult<TunerSaveResult>> => tunerService.saveScene(projectPath)
  )

  ipcMain.handle(
    'tuner:newScene',
    (_e, { projectPath, path }: { projectPath: string; path: string }): Promise<TunerResult<null>> => tunerService.newScene(projectPath, path)
  )

  ipcMain.handle(
    'tuner:attach',
    (_e, { projectPath, session }: { projectPath: string; session: string }): TunerResult<TunerState> =>
      tunerService.attached(projectPath, session)
  )

  ipcMain.on('tuner:driftAnswer', (e, payload: unknown) => {
    if ((e.sender as unknown as { remote?: boolean }).remote) notePhoneDriftAnswer(payload)
  })

  ipcMain.on('tuner:mirror', (e, payload: unknown) => {
    const wc = webContents.fromId(e.sender.id)
    if (!wc || wc.isDestroyed()) return
    const fromPhone = !!(e.sender as unknown as { remote?: boolean }).remote
    if (!fromPhone && remoteStatus().phones === 0) return
    if (fromPhone) desktopOnly(() => wc.send('tuner:mirror', payload))
    else wc.send('tuner:mirror', payload)
  })

  ipcMain.handle('tuner:stop', (e, { projectPath, session }: { projectPath: string; session: string }) =>
    tunerService.stop(projectPath, session, e.sender.id)
  )

  ipcMain.handle(
    'tuner:refresh',
    (_e, { projectPath, session }: { projectPath: string; session: string }): Promise<TunerResult<TunerState>> =>
      tunerService.refresh(projectPath, session)
  )

  ipcMain.handle(
    'tuner:edit',
    (
      _e,
      { projectPath, session, edit }: { projectPath: string; session: string; edit: TunerEdit }
    ): Promise<TunerResult<TunerObject>> => tunerService.edit(projectPath, session, edit)
  )

  ipcMain.on(
    'tuner:camera',
    (_e, { projectPath, session, camera }: { projectPath: string; session: string; camera: TunerCamera }) =>
      tunerService.camera(projectPath, session, camera)
  )

  ipcMain.on(
    'tuner:surface',
    (_e, { projectPath, session }: { projectPath: string; session: string }) =>
      tunerService.surface(projectPath, session)
  )

  ipcMain.on('tuner:tree', (e, { projectPath, session, req }: { projectPath: string; session: string; req: TunerTreeRequest }) => {
    const remote = e.sender as unknown as { remote?: boolean; cid?: string }
    tunerService.tree(projectPath, session, req, remote.remote ? `phone:${remote.cid ?? '?'}` : `window:${e.sender.id}`)
  })

  ipcMain.on(
    'tuner:watch',
    (_e, { projectPath, session, id, ids }: { projectPath: string; session: string; id: string | null; ids?: string[] }) =>
      tunerService.watch(projectPath, session, id, ids)
  )

  ipcMain.handle(
    'tuner:pickRect',
    (
      _e,
      { projectPath, session, req }: { projectPath: string; session: string; req: TunerPickRectRequest }
    ): Promise<TunerResult<TunerPickRectResult>> => tunerService.pickRect(projectPath, session, req)
  )

  ipcMain.handle(
    'tuner:close',
    (_e, { projectPath, session, id }: { projectPath: string; session: string; id: string }): Promise<TunerResult<TunerState>> =>
      tunerService.close(projectPath, session, id)
  )

  ipcMain.handle(
    'tuner:pick',
    (
      _e,
      { projectPath, session, req }: { projectPath: string; session: string; req: TunerPickRequest }
    ): Promise<TunerResult<TunerPickResult>> => tunerService.pick(projectPath, session, req)
  )

  ipcMain.handle(
    'tuner:clearView',
    (
      _e,
      { projectPath, session, req }: { projectPath: string; session: string; req: TunerClearViewRequest }
    ): Promise<TunerResult<{ index: number }>> => tunerService.clearView(projectPath, session, req)
  )

  ipcMain.handle(
    'tuner:rect',
    (
      _e,
      { projectPath, session, req }: { projectPath: string; session: string; req: TunerRectRequest }
    ): Promise<TunerResult<TunerRectInfo | null>> => tunerService.rect(projectPath, session, req)
  )

  ipcMain.handle(
    'tuner:rects',
    (
      _e,
      { projectPath, session, req }: { projectPath: string; session: string; req: TunerRectsRequest }
    ): Promise<TunerResult<TunerRectInfo[]>> => tunerService.rects(projectPath, session, req)
  )

  ipcMain.handle(
    'tuner:handles',
    (
      _e,
      { projectPath, session, req }: { projectPath: string; session: string; req: TunerHandlesRequest }
    ): Promise<TunerResult<TunerHandlesState>> => tunerService.handles(projectPath, session, req)
  )

  ipcMain.on(
    'tuner:sceneSelection',
    (_e, { projectPath, session, sel }: { projectPath: string; session: string; sel: TunerSceneSelection | null }) =>
      tunerService.sceneSelection(projectPath, session, sel)
  )

  ipcMain.handle(
    'tuner:annotations',
    (_e, { projectPath, session, req }: { projectPath: string; session: string; req: TunerAnnotationsRequest }): Promise<TunerResult<TunerAnnotations>> =>
      tunerService.annotations(projectPath, session, req)
  )

  ipcMain.on('tuner:theme', (_e, { projectPath, session, theme }: { projectPath: string; session: string; theme: TunerTheme }) =>
    tunerService.theme(projectPath, session, theme)
  )

  ipcMain.on(
    'tuner:sceneSettings',
    (_e, { projectPath, session, settings }: { projectPath: string; session: string; settings: TunerSceneSettings }) =>
      tunerService.sceneSettings(projectPath, session, settings)
  )

  ipcMain.on('tuner:visibility', (e, { projectPath, session, visible }: { projectPath: string; session: string; visible: boolean }) => {
    const remote = e.sender as unknown as { remote?: boolean; cid?: string }
    tunerService.visibility(projectPath, session, visible === true, remote.remote ? `phone:${remote.cid ?? '?'}` : undefined)
  })
  onPhoneLeft((cid) => tunerService.dropViewer(`phone:${cid}`))

  ipcMain.on(
    'tuner:transform',
    (_e, { projectPath, session, transform }: { projectPath: string; session: string; transform: TunerTransform }) =>
      tunerService.transform(projectPath, session, transform)
  )

  ipcMain.handle(
    'tuner:open',
    (
      _e,
      { projectPath, session, target, ghost }: { projectPath: string; session: string; target: TunerEntryTarget; ghost?: boolean }
    ): Promise<TunerResult<TunerOpened>> => tunerService.open(projectPath, session, target, ghost === true)
  )

  ipcMain.handle(
    'tuner:button',
    (
      _e,
      { projectPath, session, index }: { projectPath: string; session: string; index: number }
    ): Promise<TunerResult<TunerButtonResult>> => tunerService.button(projectPath, session, index)
  )
}
