import { useCallback, useEffect, useMemo, useState } from 'react'
import { cleanProjectPath, projectPluginWidget, type ProjectPluginInfo } from '@shared/project-plugins'
import { DashboardTileView } from '../components/dashboard/DashboardTile'
import { usePlace } from '../components/dashboard/PaneDashboardSlot'
import { openFileInWorkbench } from '../lib/editor/open-file'
import { useRemoteLink } from '../lib/remote-link'
import { debugLog } from '@shared/debug-log'
import '../components/report/report-kit.css'
import '../components/dashboard/dashboard.css'

const RECT = { left: 0, top: 0, width: 0, height: 0 }
const noDrag = (): void => {}

export function ProjectPluginPanel({ tabId, projectPath, name }: { tabId: string; projectPath: string; name: string }) {
  const project = cleanProjectPath(projectPath)
  const place = usePlace(tabId)
  const widget = projectPluginWidget(name)
  const [info, setInfo] = useState<ProjectPluginInfo | null | undefined>(undefined)
  const [state, setState] = useState<Record<string, unknown> | null>(null)
  const [version, setVersion] = useState(0)
  const [ready, setReady] = useState(false)
  const series = useMemo(() => new Map<string, number[]>(), [])
  const link = useRemoteLink()
  const online = link?.online !== false

  useEffect(() => {
    if (!online) return
    let alive = true
    window.api.plugins.project(project).then(
      (list) => alive && setInfo(list.find((p) => p.name === name) ?? null),
      () => alive && setInfo(null)
    )
    return () => {
      alive = false
    }
  }, [project, name, version, online])

  useEffect(() => {
    let alive = true
    window.api.dashboard.load(project).then(
      (res) => alive && setState({ ...(res.state[widget] ?? {}) }),
      () => alive && setState({})
    )
    return () => {
      alive = false
    }
  }, [project, widget])

  useEffect(
    () =>
      window.api.plugins.watch(project, (files) => {
        if (!files.some((f) => f === '' || f === name || f.startsWith(`${name}/`))) return
        debugLog(`[plugin] ${name} changed: ${files.filter((f) => f.startsWith(`${name}/`)).join(', ') || 'folder'}`)
        setVersion((v) => v + 1)
      }),
    [project, name]
  )

  const onReady = useCallback((_widget: string, ok: boolean) => setReady(ok), [])
  const onOpenSource = useCallback(
    (file: string, line?: number) => {
      const abs = file.startsWith('/') || /^[A-Za-z]:[\\/]/.test(file) ? file : `${project}/${file}`
      openFileInWorkbench({ file: abs, line, projectPath: project, text: true, sourceGroupId: place?.groupId })
    },
    [project, place?.groupId]
  )

  const tile = useMemo(() => ({ widget, x: 0, y: 0, w: 12, h: 1 }), [widget])
  const plugin = useMemo(() => ({ name, title: info?.title ?? name }), [name, info?.title])
  const problem = info === null ? `There is no plugin "${name}" in ${project}/.sspace/plugins any more.` : (info?.problem ?? null)
  const settled = info !== undefined && (!!problem || (state !== null && ready))

  return (
    <div
      className="sr-scope dk-root"
      data-plugin-panel={name}
      data-plugin-project={project}
      data-plugin-title={plugin.title}
      data-plugin-settled={settled ? '' : undefined}
    >
      <div className="dk-body">
        {problem ? (
          <div className="dk-empty">
            <h2>{plugin.title}</h2>
            <pre data-plugin-problem>{problem}</pre>
          </div>
        ) : (
          info &&
          state && (
            <DashboardTileView
              project={project}
              place={place}
              pageTitle={plugin.title}
              tile={tile}
              index={0}
              version={version}
              known={info.panel}
              state={state}
              series={series}
              rect={RECT}
              moving={false}
              onPointerDown={noDrag}
              onReady={onReady}
              onOpenSource={onOpenSource}
              plugin={plugin}
            />
          )
        )}
      </div>
    </div>
  )
}
