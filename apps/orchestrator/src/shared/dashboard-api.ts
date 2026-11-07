import type {
  DashboardAlertState,
  DashboardAlertsEvent,
  DashboardEdit,
  DashboardFetchRequest,
  DashboardFetchResult,
  DashboardFileResult,
  DashboardGitRequest,
  DashboardGitResult,
  DashboardHandleRequest,
  DashboardHandleResult,
  DashboardLoad,
  DashboardLogsRequest,
  DashboardLogsResult,
  DashboardOpenRequest
} from './dashboard'

export interface DashboardApi {
  load: (project: string) => Promise<DashboardLoad>
  edit: (project: string, edit: DashboardEdit) => Promise<DashboardLoad>
  saveState: (project: string, widget: string, key: string, value: unknown) => void
  fetch: (project: string, req: DashboardFetchRequest) => Promise<DashboardFetchResult>
  abort: (id: string) => void
  handle: (project: string, req: DashboardHandleRequest) => Promise<DashboardHandleResult>
  git: (project: string, req: DashboardGitRequest) => Promise<DashboardGitResult>
  logs: (project: string, req: DashboardLogsRequest) => Promise<DashboardLogsResult>
  file: (project: string, path: string, as?: 'json' | 'text') => Promise<DashboardFileResult>
  watch: (project: string, cb: (files: string[]) => void) => () => void
  setProjects: (projects: string[]) => void
  alerts: (project: string) => Promise<DashboardAlertState[]>
  alertSent: (project: string, id: string, to: string) => void
  onAlerts: (cb: (ev: DashboardAlertsEvent) => void) => () => void
  onOpen: (cb: (req: DashboardOpenRequest) => void) => () => void
  onSpawnAgent: (cb: (req: { projectPath: string; text: string; alert: string }) => void) => () => void
}
