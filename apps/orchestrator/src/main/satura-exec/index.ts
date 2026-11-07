import { reportOpened, tunerHandedOff } from '../remote/push-events'
import { app, BrowserWindow, webContents } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, isAbsolute, resolve } from 'node:path'
import { isHtmlPage } from '@shared/report-url'
import { isReactReport } from '@shared/report-compile'
import { compileReport } from '../report/compile'
import { stampReportSession } from '../report/sessions'
import { reportHeader } from '../report/list'
import { TUNER_SCENE_VIEW, isTunerViewName } from '@shared/tuner'
import { baseOfView, baseScope, isBaseView, scopeRank } from '@shared/tuner-scope'
import { chooseTunerTab, tunerOpenPlan, tunerTabTarget, type TunerFound, type TunerTabInfo } from '@shared/tuner-find'
import { assetTunerViewName } from '@shared/unity-assets'
import { assetProjectRoot, isScratchpadPath, type ScratchpadStatus } from '@shared/scratchpads'
import { findScratchpad, listScratchpads } from '../unity/scratchpad-store'
import { readTunerView, writeTunerQuickView, writeTunerViewFile } from '../unity/tuner-view'
import bootstrapSource from './sandbox/bootstrap.ts?iife'
import { agentExecService, collectReportIn, driveWorkspace, paneModel, rendererCall, tunerTabs } from '../agent-exec'
import { writeReportExport } from '../report/export'
import { exportFileName } from '../report/export-scan'
import type { ReportExportPayload } from '@shared/report-export'
import { isPaneAct, userMoved } from '@shared/pane-plan'
import { setSaturaExecHandler } from '../agent-hooks'
import { ptyOwnerWebContentsId } from '../ipc/pty'
import { unityProvider } from '../unity/unity-instance-provider'
import { worldStore } from '../unity/world-store'
import { scratchpads } from '../unity/scratchpads'
import { tunerInspectorService } from '../unity/tuner-inspector'
import { loadState } from '../persistence'
import { WindowDriver } from './driver'
import { consoleLog, installLogCapture, mainLog, type LogQuery } from './logs'
import { createRunner, type CallerInfo } from './runner'
import { driftSpotlightOf } from './spotlight-setting'
import { workerHost } from './sandbox/worker-host'
import { censusTrack } from '@shared/census'
import { callHandle, handleResult, listHandles, releaseRun, stopHandle } from '../handles'
import type { SaturaExecReply, SaturaExecRequest } from '@shared/satura-exec'
import type { ExecSnapshot, ExecTabsReply } from '@shared/agent-exec'
import type { ExecTab } from '@shared/tab-ref'
import { describePhonePanel, type PhonePanel } from '@shared/phone-panel'
import { phonePanel, showOnPhone } from '../remote/host'
import { requireGraphics, unityModeCall } from '../unity/unity-mode-call'
import { unityLifecycleCall } from '../unity/unity-lifecycle-call'
import { dashboardExec } from '../dashboard/exec'
import { dashboardOwner, dashboardProjectOf } from '../dashboard/owners'
import { debugLog } from '@shared/debug-log'

function within(child: string, parent: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function unityProject(want: string): string {
  const live = unityProvider.listInstances().filter((i) => i.kind === 'primary')
  const byDepth = (dir: number) => (a: { projectPath: string }, b: { projectPath: string }) => dir * (a.projectPath.length - b.projectPath.length)
  const match =
    live.filter((i) => want && within(want, i.projectPath)).sort(byDepth(-1))[0] ??
    live.filter((i) => want && within(i.projectPath, want)).sort(byDepth(1))[0] ??
    (live.length === 1 ? live[0] : undefined)
  if (!match) {
    const known = live.map((i) => i.projectPath).join(', ') || 'none'
    throw new Error(`No Unity editor is open for ${want || 'this project'}. Open editors: ${known}.`)
  }
  return match.projectPath
}

function viewName(raw: unknown, fallback: string): string {
  const name = (typeof raw === 'string' && raw.trim() ? raw.trim() : fallback).replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 56)
  return isTunerViewName(name) ? name : 'Objects'
}

type TunerCtx = { window: number; projectRoot: string; paneKey: string; workspace: string | null }

function phoneTabIn(p: PhonePanel, workspaceId: string): string | null {
  return p.visible && p.screen === 'panel' && p.workspace?.id === workspaceId ? (p.tab?.id ?? null) : null
}

async function tunerTabsSeen(wcId: number, workspaceId: string, show?: string): Promise<TunerTabInfo[] | null> {
  const tabs = await tunerTabs(wcId, workspaceId, show)
  const id = phoneTabIn(phonePanel(), workspaceId)
  return tabs && id ? tabs.map((t) => (t.tabId === id ? { ...t, phone: true } : t)) : tabs
}

function phoneSummary(p: PhonePanel, workspaceId: string | null): Record<string, unknown> {
  if (!p.connected) return { connected: false, summary: describePhonePanel(p) }
  return {
    connected: true,
    device: p.device,
    visible: p.visible,
    screen: p.screen,
    workspace: p.workspace?.name ?? null,
    ...(workspaceId && p.workspace ? { thisWorkspace: p.workspace.id === workspaceId } : {}),
    tab: p.tab ? { id: p.tab.id, label: p.tab.label, kind: p.tab.kind, pane: p.tab.pane, onMac: p.tab.onMac, ...(p.tab.closed ? { closed: true } : {}) } : null,
    ...(p.pending ? { pending: p.pending.tabId ?? 'the focused tab' } : {}),
    summary: describePhonePanel(p)
  }
}

function tabRefText(raw: unknown): string {
  if (typeof raw === 'string') return raw.trim()
  if (raw && typeof raw === 'object' && typeof (raw as { id?: unknown }).id === 'string') return (raw as { id: string }).id
  return ''
}

const PHONE_SHOW_MS = 6000
const PHONE_FOLLOW_MS = 2000
const PHONE_ASLEEP_MS = 1500

async function tabsCall(args: Record<string, unknown>, ctx: { window: number | null; paneKey: string; workspace: string | null }): Promise<unknown> {
  if (args.action === 'phone') return phoneSummary(phonePanel(), ctx.workspace)
  if (ctx.window === null) throw new Error("This call isn't tied to a Satura Space window. Run the agent in a Satura Space terminal tab.")
  const show = args.action === 'switch' ? tabRefText(args.tab) : undefined
  if (args.action === 'switch' && !show) throw new TypeError("app.switchTab() takes the tab's id, label or kind, like app.switchTab('Console')")
  const r = (await rendererCall(ctx.window, { kind: 'tabs', payload: { workspaceId: ctx.workspace ?? '', ...(show ? { show } : {}) } })) as ExecTabsReply | null
  if (!r) throw new Error("The Satura Space window didn't answer.")
  if ('error' in r) throw new Error(r.error)
  const mark = (t: ExecTab, p: PhonePanel): ExecTab => ({ ...t, phone: t.id === phoneTabIn(p, r.workspaceId) })
  if (args.action === 'list') return r.tabs.map((t) => mark(t, phonePanel()))
  if (args.action !== 'switch' || !r.shown) throw new Error(`Unknown tabs call ${String(args.action)}`)
  const tab = r.shown
  const before = phonePanel()
  const target = { workspaceId: r.workspaceId, tabId: tab.id }
  if (args.phone !== true) {
    const follows = before.visible && before.screen === 'panel' && before.workspace?.id === r.workspaceId
    const after = follows ? (await showOnPhone(target, PHONE_FOLLOW_MS, false)).panel : phonePanel()
    debugLog(`[satura-exec] app.switchTab ${tab.label} (${tab.id.slice(0, 8)}) on the Mac; ${describePhonePanel(after)}`)
    return { tab: mark(tab, after), phone: phoneSummary(after, r.workspaceId) }
  }
  if (!before.connected) throw new Error(`The desktop shows "${tab.label}" now, but no phone is connected. app.phone() says whether one is.`)
  const res = await showOnPhone(target, before.visible ? PHONE_SHOW_MS : PHONE_ASLEEP_MS)
  const note = res.shown ? undefined : res.panel.visible ? `The phone didn't show "${tab.label}" within ${PHONE_SHOW_MS / 1000} s.` : `The phone is in the background: it shows "${tab.label}" when it comes back.`
  debugLog(`[satura-exec] app.switchTab ${tab.label} (${tab.id.slice(0, 8)}) on the Mac and the phone: ${res.shown ? 'shown' : 'not shown yet'}; ${describePhonePanel(res.panel)}`)
  return { tab: mark(tab, res.panel), phone: phoneSummary(res.panel, r.workspaceId), ...(note ? { note } : {}) }
}

const driftRatios = new Map<string, Record<string, number>>()
const reportOwners = new Map<string, string>()
const REPORT_ACTION_TIMEOUT_S = 300
let runReport: ((req: SaturaExecRequest, signal: AbortSignal) => Promise<SaturaExecReply>) | null = null

const ownerKey = (file: string): string => file.replace(/\\/g, '/')

export function reportOwner(file: string): string | null {
  return reportOwners.get(ownerKey(file)) ?? null
}

async function sessionPane(file: string, projectRoot: string): Promise<string | null> {
  const session = reportHeader(await readFile(file, 'utf8')).session
  if (!session) return null
  const place = await agentExecService().workspaceOf('', projectRoot).catch(() => null)
  if (!place?.wcId) return null
  const snap = (await rendererCall(place.wcId, { kind: 'snapshot', payload: { projectRoot } }, 3000).catch(() => null)) as ExecSnapshot | null
  return snap?.terminals?.find((t) => t.sessionId === session)?.ptyId ?? null
}

export async function runReportAction(file: string, code: string, projectRoot: string): Promise<SaturaExecReply> {
  if (!runReport) return { ok: false, error: 'Satura Space is still starting up.', logs: [], shots: [], ms: 0 }
  const board = dashboardProjectOf(file)
  const owner = reportOwners.get(ownerKey(file)) ?? (board ? dashboardOwner(board) : await sessionPane(file, projectRoot).catch(() => null)) ?? undefined
  const paneKey = await agentExecService().paneForProject(projectRoot, owner).catch(() => null)
  debugLog(`[${board ? 'dashboard' : 'report'}] action in ${file.split(/[\\/]/).slice(-2).join('/')} runs as ${paneKey ?? 'no terminal'}${owner && owner !== paneKey ? ` (author ${owner} is gone)` : ''}`)
  return runReport({ code, projectRoot, paneKey: paneKey ?? undefined, timeout: REPORT_ACTION_TIMEOUT_S, origin: 'report' }, new AbortController().signal)
}
censusTrack('index.driftRatios', driftRatios)

async function layoutCall(args: Record<string, unknown>, ctx: { window: number; paneKey: string; workspace: string | null }): Promise<unknown> {
  if (!ctx.workspace) return null
  const key = `${ctx.window}:${ctx.workspace}`
  if (args.action === 'mark') {
    const split = String(args.key ?? '')
    const ratio = Number(args.ratio)
    if (split && Number.isFinite(ratio)) driftRatios.set(key, { ...(driftRatios.get(key) ?? {}), [split]: ratio })
    return null
  }
  const act = args.action === 'act' && isPaneAct(args.act) ? args.act : undefined
  const group = typeof args.group === 'string' ? args.group : undefined
  const model = await paneModel(ctx.window, ctx.workspace, ctx.paneKey || undefined, { take: args.take === true, act, groupId: group })
  if (!model) return null
  return { ...model, respect: userMoved(model.tree, driftRatios.get(key) ?? {}) }
}

function loadedScenes(project: string): string[] {
  try {
    const status = JSON.parse(readFileSync(join(project, '.sspace', '.mcp_status.json'), 'utf8')) as { scenes?: { name?: unknown; loaded?: unknown }[] }
    return (status.scenes ?? []).filter((x) => x && x.loaded !== false && typeof x.name === 'string' && x.name).map((x) => String(x.name))
  } catch {
    return []
  }
}

async function findTuner(args: Record<string, unknown>, ctx: TunerCtx): Promise<TunerFound | null> {
  const unknown = { view: '', label: '', count: 0, others: [] }
  if (!ctx.workspace) return unknown
  const tabs = await tunerTabsSeen(ctx.window, ctx.workspace)
  if (!tabs) return unknown
  const pick = chooseTunerTab(tabs, typeof args.view === 'string' && args.view ? args.view : undefined, typeof args.target === 'string' && args.target ? args.target : undefined)
  if (!pick) return null
  if (!pick.shown) await tunerTabs(ctx.window, ctx.workspace, pick.tabId)
  const others = tabs.filter((t) => t !== pick).map((t) => t.view || t.label)
  return { view: pick.view, label: pick.label, count: tabs.length, others, ...(pick.shown ? {} : { activated: true }) }
}

function scratchpadProject(projectRoot: string, id: unknown): string | null {
  if (typeof id !== 'string' || !id) return null
  const dir = assetProjectRoot(unityProject(projectRoot), id)
  if (!existsSync(join(dir, 'Assets'))) throw new Error(`No scratchpad ${id} in ${projectRoot}.`)
  return dir
}

export async function scratchpadOf(args: Record<string, unknown>, ctx: TunerCtx): Promise<string> {
  const raw = typeof args.ref === 'string' ? args.ref.trim().replace(/[\\/]+$/, '') : ''
  const root = unityProject(ctx.projectRoot)
  if (/[\\/]Library[\\/]VP[\\/]mppm[0-9a-f]{8}$/.test(raw)) throw new TypeError(`${raw} is a multiplayer clone. A Tuner opens on the project or one of its scratchpads.`)
  const metas = await listScratchpads(root)
  const meta = findScratchpad(metas, isScratchpadPath(raw) ? basename(raw) : raw)
  if (meta) return meta.id
  const names = metas.map((m) => `'${m.name}'`).join(', ')
  throw new TypeError(`No scratchpad "${raw}" in ${root}. ${names ? `Scratchpads: ${names}.` : 'It has no scratchpads.'} scratchpad.list() shows them.`)
}

export interface TunerTargetState {
  name: string
  scratchpad: string | null
  status: ScratchpadStatus
  detail: string
  error: string | null
}

const STARTING_LIFECYCLES = new Set(['init', 'launching', 'restarting'])

function editorDetail(path: string): string {
  const inst = Object.values(worldStore.getWorld(worldStore.resolveProject(path)).observed.instances).find((i) => i.role === 'primary')
  if (!inst) return ''
  if (inst.progressLabel) return `${inst.progressLabel}${inst.progressPct >= 0 && !inst.progressLabel.includes('%') ? ` ${Math.round(inst.progressPct)}%` : ''}`
  return inst.compile === 'compiling' ? 'compiling scripts' : ''
}

function projectEditorStatus(path: string): { status: ScratchpadStatus; error: string | null } {
  const failure = unityProvider.bootFailure(path)
  if (failure) return { status: 'error', error: failure }
  const st = unityProvider.primaryStatus(path)
  if (st.launching) return { status: 'starting', error: null }
  if (!st.running) return { status: 'stopped', error: null }
  if (st.lifecycle === 'error') return { status: 'error', error: null }
  return { status: st.lifecycle == null || STARTING_LIFECYCLES.has(st.lifecycle) ? 'starting' : 'running', error: null }
}

export async function tunerTarget(args: Record<string, unknown>, ctx: TunerCtx): Promise<TunerTargetState> {
  const root = unityProject(ctx.projectRoot)
  const id = typeof args.scratchpad === 'string' && args.scratchpad ? args.scratchpad : null
  if (!id) return { name: "The project's Unity editor", scratchpad: null, ...projectEditorStatus(root), detail: editorDetail(root) }
  const info = (await scratchpads.list(root)).find((s) => s.id === id)
  if (!info) throw new Error(`No scratchpad ${id} in ${root}. scratchpad.list() shows them.`)
  return { name: `Scratchpad “${info.name}”`, scratchpad: info.id, status: info.status, detail: info.status === 'starting' ? editorDetail(info.path) : '', error: info.error }
}

export function tunerTargetProblem(t: TunerTargetState, wait: number | false | undefined): string | null {
  if (t.status === 'running') return null
  const pad = t.scratchpad ? `'${t.scratchpad}'` : ''
  const detail = t.detail ? ` (${t.detail})` : ''
  if (t.status === 'error')
    return `${t.name} failed to start${t.error ? `: ${t.error}` : ''}. ${pad ? `Restart it with scratchpad.restart(${pad}), then open the Tuner again.` : 'Fix that and relaunch it with unity.relaunch(), then open the Tuner again.'}`
  if (t.status === 'stopped' || t.status === 'stopping') {
    if (wait === false) return null
    return `${t.name} ${t.status === 'stopped' ? "isn't running" : 'is stopping'}, so the Tuner didn't open. ${pad ? `Start it with scratchpad.start(${pad}) first` : 'Start it with unity.ready() first'}, or pass { wait: false } to open the Tuner on it anyway.`
  }
  if (wait !== undefined) return null
  return `${t.name} is still starting${detail}, so the Tuner didn't open. Pass { wait: 300 } to open it and wait until it's ready${pad ? ", { wait: false } to open it without waiting, or { scratchpad: null } for the project's own editor" : ', or { wait: false } to open it without waiting'}.`
}

export async function openTuner(args: Record<string, unknown>, ctx: TunerCtx): Promise<string> {
  const project = scratchpadProject(ctx.projectRoot, args.scratchpad) ?? unityProject(ctx.projectRoot)
  requireGraphics('tuner.open()', project)
  const target = await tunerTarget(args, ctx)
  const wait = args.wait === false ? false : typeof args.wait === 'number' ? args.wait : undefined
  const problem = tunerTargetProblem(target, wait)
  console.log(`[tuner] agent open on ${target.scratchpad ? `scratchpad ${target.scratchpad}` : 'project'}: ${target.status}${target.detail ? ` (${target.detail})` : ''} wait=${wait === undefined ? 'none' : wait === false ? 'no' : `${wait}s`}${problem ? ' -> refused' : ''}`)
  if (problem) throw new Error(problem)
  const scenes = loadedScenes(project)
  const plan = tunerOpenPlan(args, scenes, (rel) => existsSync(join(project, rel)))
  if (plan.kind === 'error') throw new Error(plan.message)
  let view: string
  if (plan.kind === 'scene') view = TUNER_SCENE_VIEW
  else if (plan.kind === 'asset') view = assetTunerViewName(plan.path)
  else {
    const name = filterName(viewName(args.name, plan.path.split('/').pop() ?? 'Object'))
    const json: Record<string, unknown> = { title: name, note: '', paneKey: ctx.paneKey, kind: 'objects' }
    json.objects = [{ path: plan.path, ...(plan.scene ? { scene: plan.scene } : {}), children: true }]
    writeTunerViewFile(project, name, json)
    view = name
  }
  if (isBaseView(view) && ctx.workspace) {
    const tabs = ((await tunerTabsSeen(ctx.window, ctx.workspace)) ?? []).filter((t) => tunerTabTarget(t) === (target.scratchpad || 'project'))
    const want = baseScope(baseOfView(view), null)
    const ranked = tabs
      .map((t) => {
        const b = baseOfView(t.base || t.view)
        const scope = baseScope(b, b.kind === 'view' ? readTunerView(project, b.id) : null)
        const unloaded = plan.kind === 'asset' && scope.kind === 'scene' && !scope.scene
        return { t, rank: unloaded ? 0 : scopeRank(scope, want) }
      })
      .filter((x) => x.rank > 0)
    const top = Math.max(0, ...ranked.map((x) => x.rank))
    const pick = chooseTunerTab(ranked.filter((x) => x.rank === top).map((x) => x.t))
    if (pick && (!pick.base || pick.base === pick.view)) {
      if (!pick.shown) await tunerTabs(ctx.window, ctx.workspace, pick.tabId)
      tunerHandedOff({ projectPath: project, view: pick.view, paneKey: ctx.paneKey })
      return pick.view
    }
    if (view === TUNER_SCENE_VIEW && !readTunerView(project, TUNER_SCENE_VIEW)) writeTunerQuickView(project, { kind: 'scene' })
  }
  const wc = webContents.fromId(ctx.window)
  if (!wc || wc.isDestroyed()) throw new Error('The window is gone.')
  wc.send('tuner:open', { projectPath: project, view, paneKey: ctx.paneKey, quiet: true, ...(isBaseView(view) ? { unfilter: true } : {}) })
  tunerHandedOff({ projectPath: project, view, paneKey: ctx.paneKey })
  return view
}

function filterName(name: string): string {
  return isBaseView(name) || name.toLowerCase() === TUNER_SCENE_VIEW ? `${name}-filter` : name
}

function openVideo(args: Record<string, unknown>, ctx: { window: number; projectRoot: string; paneKey: string }): string {
  const raw = typeof args.path === 'string' ? args.path.trim() : ''
  if (!raw) throw new TypeError("video.open() needs a path, like video.open('/abs/path/video.mp4') — the path video.finish() returned")
  const file = isAbsolute(raw) ? raw : resolve(ctx.projectRoot || process.cwd(), raw)
  if (!existsSync(file)) throw new Error(`No video at ${file}`)
  return openInViewer(file, ctx)
}

export async function openReport(
  args: Record<string, unknown>,
  ctx: { window: number; projectRoot: string; paneKey: string }
): Promise<{ file: string; stamp: string; ms: number }> {
  const raw = typeof args.path === 'string' ? args.path.trim() : ''
  const fn = args.check === true ? 'report.check' : 'report.open'
  if (!raw) throw new TypeError(`${fn}() needs a path, like ${fn}('.sspace/reports/run/report.tsx')`)
  const file = isAbsolute(raw) ? raw : resolve(ctx.projectRoot || process.cwd(), raw)
  if (!existsSync(file)) throw new Error(`No report at ${file}`)
  if (isHtmlPage(file)) {
    if (args.check !== true) reportOpened(openInViewer(file, ctx), ctx.paneKey, ctx.projectRoot)
    return { file, stamp: '', ms: 0 }
  }
  if (!isReactReport(file)) throw new Error(`A report is a report.tsx file, got ${file}`)
  if (ctx.paneKey) await noteReportSession(file, ctx)
  const res = await compileReport(file, ctx.projectRoot || undefined)
  if (!res.ok) {
    const n = res.diagnostics.length
    throw new Error(`The report has ${n} error${n === 1 ? '' : 's'}, so it was not opened:\n${res.text}`)
  }
  if (args.check === true) return { file, stamp: res.stamp, ms: res.ms }
  if (ctx.paneKey) reportOwners.set(ownerKey(file), ctx.paneKey)
  reportOpened(openInViewer(file, ctx), ctx.paneKey, ctx.projectRoot)
  return { file, stamp: res.stamp, ms: res.ms }
}

async function noteReportSession(file: string, ctx: { window: number; paneKey: string }): Promise<void> {
  const wcId = ptyOwnerWebContentsId(ctx.paneKey) ?? ctx.window
  const snap = (await rendererCall(wcId, { kind: 'snapshot', payload: { ptyId: ctx.paneKey } }, 3000).catch(() => null)) as ExecSnapshot | null
  const session = snap?.terminals?.find((t) => t.ptyId === ctx.paneKey)?.sessionId ?? null
  const name = file.split(/[\\/]/).slice(-2).join('/')
  if (!session) {
    debugLog(`[report] ${name}: terminal ${ctx.paneKey} has no agent session, so the report is not linked to one`)
    return
  }
  const res = await stampReportSession(file, session).catch((err: unknown) => {
    console.warn(`[report] could not save the session of ${file}: ${err instanceof Error ? err.message : String(err)}`)
    return null
  })
  if (!res) return
  debugLog(`[report] ${name} belongs to session ${res.session}${res.wrote ? ' (written into the Report tag)' : ''}${res.session !== session ? `, not the caller's ${session}` : ''}`)
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('app:reportsChanged', { file })
}

async function exportReport(
  args: Record<string, unknown>,
  ctx: { window: number; projectRoot: string; paneKey: string }
): Promise<{ file: string; bytes: number; pages: number; media: number; warnings: string[] }> {
  const raw = typeof args.path === 'string' ? args.path.trim() : ''
  if (!raw) throw new TypeError("report.export() needs a path, like report.export('.sspace/reports/run/report.tsx')")
  const base = ctx.projectRoot || process.cwd()
  const file = isAbsolute(raw) ? raw : resolve(base, raw)
  if (!existsSync(file)) throw new Error(`No report at ${file}`)
  if (!isReactReport(file)) throw new Error(`A report is a report.tsx file, got ${file}`)
  const wantOut = typeof args.out === 'string' ? args.out.trim() : ''
  const out = wantOut ? (isAbsolute(wantOut) ? wantOut : resolve(base, wantOut)) : join(dirname(file), exportFileName(file))
  const payload = (await collectReportIn(ctx.window, file, ctx.projectRoot || '')) as (ReportExportPayload & { error?: string }) | null
  if (!payload) throw new Error('The app window did not answer. Open the project in Satura Space and try again.')
  if (payload.error) throw new Error(payload.error)
  const res = await writeReportExport(out, payload)
  if (!res.ok) throw new Error(res.error)
  return { file: res.file, bytes: res.bytes, pages: res.pages, media: res.media, warnings: res.warnings }
}

function openInViewer(file: string, ctx: { window: number; projectRoot: string; paneKey: string }): string {
  const wc = webContents.fromId(ctx.window)
  if (!wc || wc.isDestroyed()) throw new Error('The window is gone.')
  wc.send('app:openFile', { file, ptyId: ctx.paneKey || undefined, projectPath: ctx.projectRoot || undefined, source: 'link' })
  return file
}

async function callerInfo(paneKey: string, projectRoot: string): Promise<CallerInfo> {
  const service = agentExecService()
  if (paneKey) {
    const wcId = ptyOwnerWebContentsId(paneKey)
    if (wcId === undefined) return { window: null, name: 'Agent' }
    const [status, place] = await Promise.all([
      service.handle({ command: 'status', paneKey, args: {} }).catch(() => null),
      service.workspaceOf(paneKey, projectRoot).catch(() => null)
    ])
    const rows = (status?.agents as { relation?: string; agent?: string | null; label?: string }[] | undefined) ?? []
    const me = rows.find((r) => r.relation === 'you')
    const name = me ? [me.agent, me.label].filter(Boolean).join(' · ') : 'Agent'
    return { window: wcId, name: name || 'Agent', workspace: place?.wcId === wcId ? place.workspaceId : null }
  }
  if (!projectRoot) return { window: null, name: 'Agent' }
  const place = await service.workspaceOf('', projectRoot).catch(() => null)
  return { window: place?.wcId ?? null, name: 'Agent', workspace: place?.workspaceId ?? null }
}

export function registerSaturaExec(): void {
  installLogCapture()
  const runner = createRunner({
    spawnHost: (code, init) => workerHost(join(__dirname, 'satura-exec-worker.js'), code, bootstrapSource, init),
    caller: callerInfo,
    windows: () =>
      BrowserWindow.getAllWindows()
        .filter((w) => !w.isDestroyed())
        .map((w) => ({ id: w.webContents.id, title: w.getTitle(), focused: w.isFocused(), visible: w.isVisible() })),
    driver: (id, options) => {
      const wc = webContents.fromId(id)
      if (!wc || wc.isDestroyed()) throw new Error(`Window ${id} is gone.`)
      return new WindowDriver(wc, {
        ...options,
        spotlight: () => driftSpotlightOf(loadState().settings),
        drive: (on) => (options.workspace ? driveWorkspace(id, options.workspace, on) : Promise.resolve()),
        ...(options.autoFront && options.workspace && !app.isPackaged
          ? { bringFront: () => rendererCall(id, { kind: 'handle', payload: { name: 'workspace.focus', params: {}, workspaceId: options.workspace, projectRoot: '' } }) }
          : {})
      })
    },
    agents: (command, args, paneKey, projectRoot) =>
      agentExecService().handle({ command, args, paneKey: paneKey || undefined, projectRoot }),
    layout: (args, ctx) => layoutCall(args, ctx),
    tabs: (args, ctx) => tabsCall(args, ctx),
    video: async (args, ctx) => {
      if (args.action === 'open') return openVideo(args, ctx)
      throw new Error(`Unknown video call ${String(args.action)}`)
    },
    report: async (args, ctx) => {
      if (args.action === 'open') return openReport(args, ctx)
      if (args.action === 'export') return exportReport(args, ctx)
      throw new Error(`Unknown report call ${String(args.action)}`)
    },
    dashboard: (args, ctx) => dashboardExec(args, ctx),
    tuner: async (args, ctx) => {
      if (args.action === 'open') return openTuner(args, ctx)
      if (args.action === 'find') return findTuner(args, ctx)
      if (args.action === 'scratchpad') return scratchpadOf(args, ctx)
      if (args.action === 'target') {
        const t = await tunerTarget(args, ctx)
        const wait = args.wait === false ? false : typeof args.wait === 'number' ? args.wait : undefined
        const problem = tunerTargetProblem(t, wait)
        console.log(`[tuner] agent target ${t.scratchpad ? `scratchpad ${t.scratchpad}` : 'project'} is ${t.status}${t.detail ? ` (${t.detail})` : ''} wait=${wait === undefined ? 'none' : wait === false ? 'no' : `${wait}s`}${problem ? ' -> refused' : ''}`)
        return { ...t, problem }
      }
      if (args.action === 'list') return ctx.workspace ? ((await tunerTabsSeen(ctx.window, ctx.workspace)) ?? []) : []
      if (args.action === 'values') return typeof args.session === 'string' && ctx.projectRoot ? tunerInspectorService.values(ctx.projectRoot, args.session).catch(() => null) : null
      if (args.action === 'field') return typeof args.session === 'string' && ctx.projectRoot ? tunerInspectorService.field(ctx.projectRoot, args.session, String(args.section ?? ''), String(args.name ?? '')).catch(() => null) : null
      if (args.action === 'undoGroup') return typeof args.session === 'string' && ctx.projectRoot ? tunerInspectorService.undoGroup(ctx.projectRoot, args.session, String(args.step ?? ''), String(args.group ?? '')).catch(() => null) : null
      if (args.action === 'setField') {
        if (typeof args.session !== 'string' || !ctx.projectRoot) throw new Error('The Tuner inspector is not connected to Unity yet.')
        return tunerInspectorService.setField(ctx.projectRoot, args.session, String(args.section ?? ''), String(args.name ?? ''), String(args.value ?? ''))
      }
      throw new Error(`Unknown tuner call ${String(args.action)}`)
    },
    logs: async (source, options, ctx) => {
      if (source === 'app') return mainLog(options as LogQuery)
      if (source === 'console') {
        const window = options.window === undefined ? ctx.window : Number(options.window)
        if (window === null || !Number.isFinite(window)) throw new Error('Pass a window id: this call has no window of its own.')
        return consoleLog(window, options as LogQuery)
      }
      throw new Error(`Unknown log ${source}. Use logs.app() or logs.console(), and unity.logs() for Unity.`)
    },
    handles: async (args, ctx) => {
      if (args.action === 'list') return listHandles(String(args.filter ?? ''), ctx)
      if (args.action === 'call') return callHandle(String(args.name ?? ''), args.params, ctx, args.wait)
      if (args.action === 'result') return handleResult(args.run, args.wait)
      if (args.action === 'stop') return stopHandle(args.run)
      throw new Error(`Unknown handle call ${String(args.action)}`)
    },
    runEnded: (run) => releaseRun(run),
    unityMode: (args, projectRoot) => unityModeCall(args, projectRoot),
    unity: (args, projectRoot, signal) => unityLifecycleCall(args, projectRoot, signal),
    requireGraphics,
    log: (line) => debugLog(`[satura-exec] ${line}`),
    now: Date.now,
    exclusive: !app.isPackaged
  })
  runReport = runner.run
  setSaturaExecHandler((req, signal, peer) => runner.run({ ...req, origin: undefined }, signal, peer))
}
