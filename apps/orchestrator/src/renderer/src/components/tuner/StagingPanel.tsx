import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, Maximize2, Play, Repeat, Route, Square, X } from 'lucide-react'
import { stagingLabel, stagingRunning, type TunerStaging, type TunerStagingItem, type TunerStagingReport, type TunerStagingScenario } from '@shared/tuner-staging'
import { stagingTrails, type StagingTrail } from '../../lib/tuner/staging-report'
import { Fullscreen } from '../report/Fullscreen'
import '../report/report-kit.css'
import { StagingReport } from './StagingReport'
import { useToolbarMenu } from './useToolbarMenu'
import { UnityStagingPrefabIcon } from './unity-icons'

const iconBtn = 'flex h-5 w-5 shrink-0 items-center justify-center rounded text-ink-2 transition-colors hover:bg-white/10 hover:text-ink disabled:opacity-40 disabled:hover:bg-transparent'
const solidBtn = 'flex h-5 w-5 shrink-0 items-center justify-center rounded bg-white/10 text-ink transition-colors hover:bg-white/15'
const stopBtn = 'flex h-5 w-5 shrink-0 items-center justify-center rounded bg-amber-400/15 text-amber-300 transition-colors hover:bg-amber-400/25'
const SOURCE = /(Assets\/[^\s:()]+\.cs):(\d+)/
const REPORT_EVERY_MS = 400
const memory: { showPath: boolean; picked: string | null } = { showPath: true, picked: null }

function sceneName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1).replace(/\.unity$/i, '')
}

function sceneFolder(path: string): string {
  const i = path.lastIndexOf('/')
  return i > 0 ? path.slice(0, i) : ''
}

function resultTip(sc: TunerStagingScenario): string {
  const r = sc.run
  if (!r) return 'Not run yet'
  if (r.result === 'fail') return r.loop ? `The last iteration failed: ${r.lastError || r.error}` : r.error || 'Failed'
  if (r.result === 'pass') return r.loop ? `The last iteration passed (${r.passed} of ${r.iterations})` : `Passed in ${r.seconds.toFixed(1)} s`
  return r.status === 'stopped' ? 'Stopped before it finished' : 'No result yet'
}

function mark(sc: TunerStagingScenario): string {
  const r = sc.run
  return r?.result === 'pass' ? '✓' : r?.result === 'fail' ? '✗' : '—'
}

function markColor(sc: TunerStagingScenario): string {
  const r = sc.run
  return r?.result === 'pass' ? 'text-emerald-400' : r?.result === 'fail' ? 'text-rose-400' : 'text-ink-3'
}

function dotColor(sc: TunerStagingScenario): string {
  if (sc.queued || stagingRunning(sc)) return 'bg-amber-400 ring-[3px] ring-amber-400/20'
  const r = sc.run
  return r?.result === 'pass' ? 'bg-emerald-400' : r?.result === 'fail' ? 'bg-rose-400' : 'bg-zinc-600'
}

function rowText(sc: TunerStagingScenario): string {
  if (sc.queued) return 'starting'
  const r = sc.run
  return r && r.loop && stagingRunning(sc) ? `#${r.iterations + 1}` : ''
}

function resultWord(sc: TunerStagingScenario): { word: string; color: string } {
  if (sc.queued) return { word: 'starting Play', color: 'text-amber-300' }
  const r = sc.run
  if (!r) return { word: 'not run', color: 'text-ink-3' }
  if (stagingRunning(sc)) return { word: r.loop ? `running, iteration ${r.iterations + 1}` : 'running', color: 'text-amber-300' }
  if (r.result === 'pass') return { word: 'passed', color: 'text-emerald-400' }
  if (r.result === 'fail') return { word: 'failed', color: 'text-rose-400' }
  return { word: r.status === 'stopped' ? 'stopped' : 'no result', color: 'text-ink' }
}

function failure(sc: TunerStagingScenario): { text: string; file: string; line: number } | null {
  const r = sc.run
  if (!r || r.result !== 'fail') return null
  const raw = (r.loop ? r.lastError || r.error : r.error) || ''
  const m = SOURCE.exec(raw)
  return { text: raw.split('\n')[0].trim() || 'Failed', file: m ? m[1] : '', line: m ? Number(m[2]) : 0 }
}

function useStagingReport(sc: TunerStagingScenario | null, fetchReport: (path: string) => Promise<TunerStagingReport | null>): TunerStagingReport | null {
  const [report, setReport] = useState<TunerStagingReport | null>(null)
  const path = sc?.path ?? ''
  const key = sc ? `${sc.path}|${sc.run?.run ?? 0}|${sc.run?.rev ?? 0}|${sc.run?.status ?? ''}` : ''
  const pathRef = useRef(path)
  pathRef.current = path
  const fetchRef = useRef(fetchReport)
  fetchRef.current = fetchReport
  const timerRef = useRef(0)
  const busyRef = useRef(false)
  const lastRef = useRef(0)
  useEffect(() => {
    setReport(null)
    lastRef.current = 0
  }, [path])
  useEffect(() => {
    if (!key || timerRef.current) return
    const pull = (): void => {
      timerRef.current = 0
      if (busyRef.current) {
        timerRef.current = window.setTimeout(pull, 120)
        return
      }
      const want = pathRef.current
      if (!want) return
      busyRef.current = true
      lastRef.current = Date.now()
      void fetchRef.current(want).then(
        (r) => {
          busyRef.current = false
          if (pathRef.current === want) setReport(r && r.path === want ? r : null)
        },
        () => {
          busyRef.current = false
        }
      )
    }
    timerRef.current = window.setTimeout(pull, Math.max(0, REPORT_EVERY_MS - (Date.now() - lastRef.current)))
  }, [key])
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = 0
    },
    []
  )
  return report
}

function Summary({ sc, children }: { sc: TunerStagingScenario; children?: ReactNode }) {
  const r = sc.run
  const running = stagingRunning(sc)
  const result = resultWord(sc)
  const fail = failure(sc)
  return (
    <>
      {sc.description && <div className="text-ink-3">{sc.description}</div>}
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        <span>
          Result <span className={result.color}>{result.word}</span>
        </span>
        {r && !running && r.seconds > 0 && (
          <span>
            Time <span className="tabular-nums text-ink">{r.seconds.toFixed(1)} s</span>
          </span>
        )}
        {r?.loop && r.iterations > 0 && (
          <span>
            Iterations <span className="tabular-nums text-ink">{r.iterations}</span> · <span className="tabular-nums text-emerald-400">{r.passed} ✓</span>{' '}
            <span className="tabular-nums text-rose-400">{r.failed} ✗</span>
          </span>
        )}
        {sc.loop && !running && <span className="text-ink-3">Loops until you stop it. Inspector changes carry into the next pass.</span>}
      </div>
      {fail && (
        <div className="text-rose-300" data-staging-failure>
          {fail.text}
          {fail.file && children}
        </div>
      )}
    </>
  )
}

function Detail({
  item,
  sc,
  report,
  expanded,
  showPath,
  onShowPath,
  onExpand,
  onRun,
  onStop,
  onOpen,
  onSource
}: {
  item: TunerStagingItem
  sc: TunerStagingScenario
  report: TunerStagingReport | null
  expanded: boolean
  showPath: boolean
  onShowPath: (show: boolean) => void
  onExpand: (open: boolean) => void
  onRun: (path: string, item: string) => void
  onStop: (path: string) => void
  onOpen: (file: string) => void
  onSource: (file: string, line: number) => void
}) {
  const r = sc.run
  const running = stagingRunning(sc)
  const blocked = !running && !!item.running && item.running !== sc.name
  const fail = failure(sc)
  const tracked = !!report?.iterations.some((it) => it.tracks.some((t) => t.t.length > 1))
  const source = fail?.file ? (
    <button
      type="button"
      data-staging-source={`${fail.file}:${fail.line}`}
      className="ml-2 font-mono text-[10px] text-ink-3 hover:text-ink hover:underline"
      onClick={() => onSource(fail.file, fail.line)}
      data-ti-tip="Open the script at this line"
    >
      {fail.file.slice(fail.file.lastIndexOf('/') + 1)}:{fail.line}
    </button>
  ) : null
  const video = r?.video ? (
    <button type="button" data-staging-video={r.video} className="self-start text-sky-300 hover:underline" onClick={() => onOpen(r.video)} data-ti-tip="Open the video of this run">
      Video of this run
    </button>
  ) : null
  const pathToggle = tracked ? (
    <button
      type="button"
      data-staging-path-toggle={showPath ? 'on' : 'off'}
      aria-pressed={showPath}
      className={`flex h-5 shrink-0 items-center gap-1 rounded px-1.5 transition-colors ${showPath ? 'bg-violet-400/15 text-violet-200' : 'text-ink-2 hover:bg-white/10 hover:text-ink'}`}
      onClick={() => onShowPath(!showPath)}
      data-ti-tip={showPath ? 'Hide the tracked path in the scene view' : 'Draw the tracked path in the scene view'}
    >
      <Route className="h-3 w-3" />
      <span>Path</span>
    </button>
  ) : null
  const body = (big: boolean) => (
    <>
      <Summary sc={sc}>{source}</Summary>
      {report && <StagingReport report={report} big={big} onOpen={onOpen} />}
      {video}
      {!r && !sc.queued && <div className="text-ink-3">Not run yet.</div>}
    </>
  )
  return (
    <div data-staging-detail={sc.path} className="flex min-h-0 min-w-0 flex-col">
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3">
        <span className={`shrink-0 ${markColor(sc)}`}>{mark(sc)}</span>
        <span className="min-w-0 truncate text-[12px] font-medium text-ink">{sc.label}</span>
        <span className="min-w-0 truncate text-ink-3">{item.group}</span>
        <span className="min-w-0 flex-1" />
        {pathToggle}
        {report && (
          <button type="button" data-staging-expand className={iconBtn} onClick={() => onExpand(true)} data-ti-tip="Show the report full screen">
            <Maximize2 className="h-3 w-3" />
          </button>
        )}
        {running ? (
          <button type="button" data-staging-detail-stop={sc.path} className={stopBtn} onClick={() => onStop(sc.path)} data-ti-tip={sc.loop ? 'Stop the loop' : 'Stop this run'}>
            <Square className="h-2.5 w-2.5 fill-current" />
          </button>
        ) : blocked ? (
          <span className="shrink-0 text-ink-3" data-staging-blocked>
            {item.group} is running {stagingLabel(item.running)}
          </span>
        ) : (
          <button type="button" data-staging-detail-run={sc.path} className={solidBtn} onClick={() => onRun(sc.path, item.path)} data-ti-tip="Run it">
            <Play className="h-3 w-3 fill-current" />
          </button>
        )}
      </div>
      <div data-staging-scroll className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-3 py-2">
        {expanded ? (
          <>
            <Summary sc={sc}>{source}</Summary>
            <div className="text-ink-3">The report is open full screen. Press Esc to bring it back here.</div>
          </>
        ) : (
          body(false)
        )}
      </div>
      {expanded && (
        <Fullscreen
          kind="staging"
          title={
            <span className="flex items-center gap-2">
              <span className={markColor(sc)}>{mark(sc)}</span>
              <span className="text-ink">{sc.label}</span>
              <span className="text-ink-3">{item.group}</span>
            </span>
          }
          tools={pathToggle}
          onClose={() => onExpand(false)}
        >
          <div className="rk-ov-scroll" data-staging-full={sc.path}>
            <div className="mx-auto flex max-w-[1100px] flex-col gap-3 px-5 py-4 text-[12px] text-ink-2">{body(true)}</div>
          </div>
        </Fullscreen>
      )}
    </div>
  )
}

function SceneSwitch({ staging, onScene }: { staging: TunerStaging; onScene: (path: string) => void }) {
  const { open, setOpen, rootRef, menuRef } = useToolbarMenu()
  const scenes = staging.scenes
  const others = scenes.filter((p) => p !== staging.scenePath)
  if (others.length === 0) return staging.scene ? <span className="min-w-0 truncate text-ink-3">· {staging.scene}</span> : null
  return (
    <div ref={rootRef} className="min-w-0">
      <button
        type="button"
        data-staging-scene-switch={staging.scenePath}
        className="flex h-5 min-w-0 items-center gap-1 rounded px-1 text-ink-2 hover:bg-white/10 hover:text-ink"
        onClick={() => setOpen(!open)}
        data-ti-tip="Open another staging scene"
      >
        <span className="min-w-0 truncate">· {staging.scene || 'no scene'}</span>
        <ChevronDown className="h-3 w-3 shrink-0" />
      </button>
      {open && (
        <div ref={menuRef} data-staging-scene-menu className="surface-overlay fixed left-0 top-0 z-30 max-h-[50vh] min-w-[220px] overflow-y-auto rounded-lg py-1 text-[11px]">
          <div className="px-2.5 pb-1 pt-0.5 text-[10px] text-ink-3">Staging scenes</div>
          {scenes.map((p) => {
            const on = p === staging.scenePath
            return (
              <button
                key={p}
                type="button"
                data-staging-scene={p}
                className={`flex w-full items-center gap-2 px-2.5 py-1 text-left ${on ? 'bg-sky-500/10 text-sky-200' : 'text-ink-2 hover:bg-white/5 hover:text-ink'}`}
                onClick={() => {
                  setOpen(false)
                  if (!on) onScene(p)
                }}
              >
                <span className="flex w-3 shrink-0 justify-center">{on && <Check className="h-3 w-3" />}</span>
                <span className="shrink-0">{sceneName(p)}</span>
                <span className="min-w-0 truncate text-ink-3">{sceneFolder(p)}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}

export function StagingPanel({
  staging,
  onRun,
  onStop,
  onOpen,
  onSource,
  onScene,
  onTrails,
  fetchReport,
  onClose
}: {
  staging: TunerStaging | null
  onRun: (path: string, item: string) => void
  onStop: (path: string) => void
  onOpen: (file: string) => void
  onSource: (file: string, line: number) => void
  onScene: (path: string) => void
  onTrails: (trails: StagingTrail[] | null) => void
  fetchReport: (path: string) => Promise<TunerStagingReport | null>
  onClose: () => void
}) {
  const [picked, setPickedState] = useState<string | null>(memory.picked)
  const setPicked = useCallback((path: string) => {
    memory.picked = path
    setPickedState(path)
  }, [])
  const [expanded, setExpanded] = useState(false)
  const [showPath, setShowPathState] = useState(memory.showPath)
  const items = staging?.items ?? []
  const all = items.flatMap((item) => item.scenarios.map((sc) => ({ item, sc })))
  const current = all.find((x) => x.sc.path === picked) ?? all[0] ?? null
  const report = useStagingReport(current?.sc ?? null, fetchReport)
  const setShowPath = useCallback((show: boolean) => {
    memory.showPath = show
    setShowPathState(show)
  }, [])
  const onTrailsRef = useRef(onTrails)
  onTrailsRef.current = onTrails
  useEffect(() => {
    onTrailsRef.current(showPath && report ? stagingTrails(report) : null)
  }, [report, showPath])
  useEffect(() => () => onTrailsRef.current(null), [])
  useEffect(() => {
    if (!current) setExpanded(false)
  }, [current])
  return (
    <div
      data-tuner-staging
      data-staging-playing={staging?.playing ? 'yes' : 'no'}
      data-staging-count={items.length}
      data-staging-open-scene={staging?.scenePath ?? ''}
      data-staging-scenes={staging?.scenes.join('\n') ?? ''}
      data-staging-expanded={expanded ? 'yes' : 'no'}
      className={`surface-overlay pointer-events-auto relative mx-2 mb-2 mt-1.5 flex shrink-0 flex-col rounded-lg text-[11px] text-ink-2 ${items.length > 0 ? 'h-[45%] min-h-[180px]' : 'max-h-[45%]'}`}
    >
      <div className="flex h-[30px] shrink-0 items-center gap-1 border-b border-hairline px-1.5">
        <span className="shrink-0 font-medium text-ink">Staging</span>
        {staging && <SceneSwitch staging={staging} onScene={onScene} />}
        <span className="min-w-0 flex-1" />
        {staging && !staging.playing && items.length > 0 && <span className="shrink-0 text-ink-3">▶ starts Play first</span>}
        <button type="button" data-staging-close className={iconBtn} onClick={onClose} data-ti-tip="Close the staging panel">
          <X className="h-3 w-3" />
        </button>
      </div>
      {!staging && <div className="px-2 py-1.5 text-ink-3">Reading the scene…</div>}
      {staging?.error && <div className="px-2 py-1.5 text-rose-300">{staging.error}</div>}
      {staging && !staging.error && items.length === 0 && (
        <div className="px-2 py-1.5 text-ink-3">
          {staging.scenes.length > 0
            ? 'No staging prefabs in this scene. Pick a staging scene above.'
            : 'No staging prefabs in this scene. A staging prefab has a script that derives from SaturaStaging.'}
        </div>
      )}
      {items.length > 0 && (
        <div className="grid min-h-0 flex-1 grid-cols-[minmax(200px,300px)_1fr] grid-rows-[minmax(0,1fr)] overflow-hidden">
          <div className="min-h-0 overflow-y-auto border-r border-hairline py-1" data-staging-list>
            {items.map((item) => (
              <div key={item.path} data-staging-item={item.group}>
                <div className="flex h-6 items-center gap-1.5 px-2 text-ink-2" data-ti-tip={item.path}>
                  <UnityStagingPrefabIcon size={14} className="shrink-0 text-violet-300" />
                  <span className="min-w-0 truncate">{item.group}</span>
                  {item.scenarios.length === 0 && <span className="shrink-0 text-ink-3">no scenarios</span>}
                </div>
                {item.scenarios.map((sc) => {
                  const running = stagingRunning(sc)
                  const r = sc.run
                  const blocked = !running && !!item.running && item.running !== sc.name
                  const selected = current?.sc.path === sc.path
                  const text = rowText(sc)
                  return (
                    <div
                      key={sc.path}
                      data-staging-scenario={sc.path}
                      data-staging-status={sc.queued ? 'queued' : r ? r.status : 'idle'}
                      data-staging-result={r?.result ?? ''}
                      data-staging-loop={sc.loop ? 'yes' : 'no'}
                      data-staging-video-file={r?.video || undefined}
                      data-staging-selected={selected ? 'yes' : undefined}
                      className={`flex h-6 items-center gap-2 pl-[26px] pr-1.5 ${selected ? 'bg-sky-500/20' : 'hover:bg-white/5'}`}
                      onClick={() => setPicked(sc.path)}
                    >
                      <span data-staging-mark className="flex w-2 shrink-0 justify-center" data-ti-tip={resultTip(sc)}>
                        <span className={`h-[7px] w-[7px] rounded-full ${dotColor(sc)}`} />
                        <span className="sr-only">{mark(sc)}</span>
                      </span>
                      <span className="min-w-0 flex-1 truncate text-ink" data-ti-tip={sc.description || sc.name}>
                        {sc.label}
                      </span>
                      {sc.loop && <Repeat className="h-3 w-3 shrink-0 text-ink-3" aria-label="loops" />}
                      {text && <span className="shrink-0 tabular-nums text-amber-300">{text}</span>}
                      {running ? (
                        <button type="button" data-staging-stop={sc.path} className={iconBtn} onClick={() => onStop(sc.path)} data-ti-tip={sc.loop ? 'Stop the loop' : 'Stop this run'}>
                          <Square className="h-2.5 w-2.5 fill-current" />
                        </button>
                      ) : blocked ? (
                        <span className="h-5 w-5 shrink-0" data-ti-tip={`${item.group} runs one scenario at a time: ${stagingLabel(item.running)} is running`} />
                      ) : (
                        <button
                          type="button"
                          data-staging-run={sc.path}
                          className={iconBtn}
                          onClick={() => onRun(sc.path, item.path)}
                          data-ti-tip={sc.loop ? 'Run it. It loops until you stop it, and your inspector changes carry into the next pass.' : 'Run it on a fresh copy of this staging prefab'}
                        >
                          <Play className="h-3 w-3 fill-current" />
                        </button>
                      )}
                    </div>
                  )
                })}
              </div>
            ))}
          </div>
          {current ? (
            <Detail
              item={current.item}
              sc={current.sc}
              report={report}
              expanded={expanded}
              showPath={showPath}
              onShowPath={setShowPath}
              onExpand={setExpanded}
              onRun={onRun}
              onStop={onStop}
              onOpen={onOpen}
              onSource={onSource}
            />
          ) : (
            <div className="px-3 py-2 text-ink-3">No scenarios yet. Mark a coroutine on the staging script with [SaturaScenario].</div>
          )}
        </div>
      )}
    </div>
  )
}
