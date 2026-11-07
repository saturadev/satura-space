import { existsSync } from 'node:fs'
import { webContents } from 'electron'
import { widgetFile } from '@shared/dashboard'
import { compileReport } from '../report/compile'
import { alertStates } from './alerts'
import { cleanProject, loadDashboard } from './files'
import { setDashboardOwner } from './owners'

type Ctx = { window: number; projectRoot: string; paneKey: string }

async function openDashboard(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  const project = cleanProject(ctx.projectRoot || '')
  if (!project) throw new Error('dashboard.open() needs a project: run it from an agent terminal of the project.')
  const load = await loadDashboard(project)
  if (!load.exists) throw new Error(`There is no dashboard in ${project} yet. Write .sspace/dashboard/dashboard.json and the widgets in .sspace/dashboard/widgets/<id>.tsx, then open it.`)
  if (load.error && !load.doc.pages.length) throw new Error(`dashboard.json has a problem:\n${load.error}`)
  const want = typeof args.page === 'string' ? args.page.trim() : ''
  const page = want ? load.doc.pages.find((p) => p.id === want || p.title.toLowerCase() === want.toLowerCase()) : load.doc.pages[0]
  if (!page) {
    const ids = load.doc.pages.map((p) => p.id).join(', ') || 'none'
    throw new Error(want ? `No page "${want}". Pages: ${ids}.` : 'dashboard.json has no pages.')
  }
  const widgets: Record<string, string> = {}
  for (const id of [...new Set(page.tiles.map((t) => t.widget))]) {
    const file = widgetFile(project, id)
    if (!existsSync(file)) {
      widgets[id] = `No widget file .sspace/dashboard/widgets/${id}.tsx`
      continue
    }
    const res = await compileReport(file, project)
    widgets[id] = res.ok ? 'ok' : res.text
  }
  if (ctx.paneKey) setDashboardOwner(project, ctx.paneKey)
  const wc = webContents.fromId(ctx.window)
  if (!wc || wc.isDestroyed()) throw new Error('The window is gone.')
  wc.send('dashboard:open', { projectPath: project, page: page.id, ptyId: ctx.paneKey || undefined })
  return {
    project,
    title: load.doc.title,
    page: page.id,
    pages: load.doc.pages.map((p) => ({ id: p.id, title: p.title, widgets: p.tiles.map((t) => t.widget) })),
    compile: widgets,
    ...(load.error ? { layoutProblems: load.error } : {}),
    alerts: alertStates(project)
  }
}

export async function dashboardExec(args: Record<string, unknown>, ctx: Ctx): Promise<unknown> {
  if (args.action === 'open') return openDashboard(args, ctx)
  if (args.action === 'alerts') return alertStates(cleanProject(ctx.projectRoot || ''))
  throw new Error(`Unknown dashboard call ${String(args.action)}`)
}
