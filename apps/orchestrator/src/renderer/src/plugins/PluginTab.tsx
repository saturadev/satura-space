import { projectPluginOfKey } from '@shared/project-plugins'
import { pluginPanel } from '.'
import { ProjectPluginPanel } from './project'

export function PluginTab({ tabId, projectPath, plugin, focused }: { tabId: string; projectPath: string; plugin: string | null; focused: boolean }) {
  const own = projectPluginOfKey(plugin)
  if (own) return <ProjectPluginPanel key={own} tabId={tabId} projectPath={projectPath} name={own} />
  const found = pluginPanel(plugin)
  const Panel = found?.component
  if (!found || !Panel) return <div className="flex h-full items-center justify-center text-sm text-zinc-500">This panel's plugin is not in this build.</div>
  return (
    <div className="relative h-full w-full" data-plugin-panel={found.plugin} data-plugin-title={found.title} data-plugin-settled="">
      <Panel projectPath={projectPath} tabId={tabId} focused={focused} />
    </div>
  )
}
