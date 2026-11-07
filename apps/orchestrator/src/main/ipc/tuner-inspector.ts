import { ipcMain } from 'electron'
import type {
  TunerInspectTarget,
  TunerInspectorFont,
  TunerInspectorInput,
  TunerInspectorResult
} from '@shared/tuner-inspector'
import { tunerInspectorService } from '../unity/tuner-inspector'
import { onRendererReset } from '../window/renderer-reset'

export function registerTunerInspectorHandlers(): void {
  ipcMain.handle(
    'tunerInspector:open',
    (
      e,
      { projectPath, session, target, width }: { projectPath: string; session: string; target: TunerInspectTarget; width: number }
    ): Promise<TunerInspectorResult> => {
      const wcId = e.sender.id
      onRendererReset(e.sender, 'tunerInspector:sessions', () => tunerInspectorService.closeAllFor(wcId))
      return tunerInspectorService.open(wcId, projectPath, session, target, width)
    }
  )

  ipcMain.handle(
    'tunerInspector:input',
    (
      _e,
      { projectPath, session, input }: { projectPath: string; session: string; input: TunerInspectorInput }
    ): Promise<TunerInspectorResult> => tunerInspectorService.input(projectPath, session, input)
  )

  ipcMain.handle(
    'tunerInspector:resize',
    (
      _e,
      { projectPath, session, width }: { projectPath: string; session: string; width: number }
    ): Promise<TunerInspectorResult> => tunerInspectorService.resize(projectPath, session, width)
  )

  ipcMain.handle(
    'tunerInspector:capture',
    (
      _e,
      { projectPath, session, force }: { projectPath: string; session: string; force: boolean }
    ): Promise<TunerInspectorResult> => tunerInspectorService.capture(projectPath, session, force)
  )

  ipcMain.handle('tunerInspector:close', (e, { projectPath, session }: { projectPath: string; session: string }) =>
    tunerInspectorService.close(projectPath, session, e.sender.id)
  )

  ipcMain.handle(
    'tunerInspector:fonts',
    (_e, { fontDir }: { fontDir: string }): Promise<TunerInspectorFont[]> => tunerInspectorService.fonts(fontDir)
  )
}
