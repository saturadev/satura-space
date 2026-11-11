import type { ComponentType, ReactElement } from 'react'
import {
  Box,
  ClipboardCheck,
  FileClock,
  FileCode2,
  FileText,
  LayoutDashboard,
  Puzzle,
  Film,
  FlaskConical,
  Gamepad2,
  GitBranch,
  Globe,
  Image as ImageIcon,
  Music,
  ScrollText,
  SlidersHorizontal,
  SquareTerminal
} from 'lucide-react'
import type { Tab } from '@shared/types'
import { isReactReport } from '@shared/report-compile'
import { isHtmlPage } from '@shared/report-url'
import { isPlayableAudio, isPlayableVideo } from '@shared/media-url'
import { AgentIcon } from '../../lib/agent-icon'
import { useTunerTabTitle } from '../../lib/tuner/tab-titles'
import { UnityPrefabIcon, UnityPrefabVariantIcon, UnitySceneIcon, UnityStagingPrefabIcon } from '../tuner/unity-icons'
import { useAppStore } from '../../store'
import { hasUndelivered, useDashboardAlerts } from '../../lib/dashboard/alerts-store'
import { pluginPanel } from '../../plugins'

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|avif|bmp|tga|psd|svg|ico|exr|hdr)$/i
const TEXT_EXT = /\.(md|markdown|txt|rst)$/i
const LOG_EXT = /\.log$/i

interface Kind {
  icon: ComponentType<{ size?: number; strokeWidth?: number; absoluteStrokeWidth?: boolean; className?: string; 'aria-hidden'?: boolean }>
  name: string
}

export const PANEL_KIND = {
  terminal: { icon: SquareTerminal, name: 'Terminal' },
  unity: { icon: Gamepad2, name: 'Unity player' },
  console: { icon: ScrollText, name: 'Unity console' },
  tuner: { icon: SlidersHorizontal, name: 'Tuner' },
  tunerScene: { icon: UnitySceneIcon, name: 'Scene' },
  tunerPrefab: { icon: UnityPrefabIcon, name: 'Prefab' },
  tunerVariant: { icon: UnityPrefabVariantIcon, name: 'Prefab Variant' },
  tunerStaging: { icon: UnityStagingPrefabIcon, name: 'Staging prefab' },
  asset: { icon: Box, name: 'Asset' },
  scratchpad: { icon: FlaskConical, name: 'Scratchpads' },
  git: { icon: GitBranch, name: 'Git' },
  dashboard: { icon: LayoutDashboard, name: 'Dashboard' },
  report: { icon: ClipboardCheck, name: 'Report' },
  page: { icon: Globe, name: 'Page' },
  video: { icon: Film, name: 'Video' },
  audio: { icon: Music, name: 'Audio' },
  image: { icon: ImageIcon, name: 'Image' },
  log: { icon: FileClock, name: 'Log' },
  text: { icon: FileText, name: 'Document' },
  code: { icon: FileCode2, name: 'File' },
  plugin: { icon: Puzzle, name: 'Plugin' }
} satisfies Record<string, Kind>

export function panelKind(tab: Tab, file?: string): Kind {
  switch (tab.contentType) {
    case 'terminal':
      return PANEL_KIND.terminal
    case 'unity-instance-player':
      return PANEL_KIND.unity
    case 'unity-console':
      return PANEL_KIND.console
    case 'tuner':
      return tab.tuner?.kind === 'file' ? PANEL_KIND.asset : PANEL_KIND.tuner
    case 'unity-scratchpad':
      return PANEL_KIND.scratchpad
    case 'git-scm':
      return PANEL_KIND.git
    case 'dashboard':
      return PANEL_KIND.dashboard
    case 'plugin': {
      const panel = pluginPanel(tab.plugin)
      return panel ? { icon: panel.icon, name: panel.title } : PANEL_KIND.plugin
    }
    case 'file-viewer': {
      const f = file ?? ''
      if (!f) return PANEL_KIND.code
      if (isReactReport(f)) return PANEL_KIND.report
      if (isHtmlPage(f)) return PANEL_KIND.page
      if (isPlayableVideo(f)) return PANEL_KIND.video
      if (isPlayableAudio(f)) return PANEL_KIND.audio
      if (IMAGE_EXT.test(f)) return PANEL_KIND.image
      if (LOG_EXT.test(f)) return PANEL_KIND.log
      if (TEXT_EXT.test(f)) return PANEL_KIND.text
      return PANEL_KIND.code
    }
  }
  return PANEL_KIND.code
}

export function PanelGlyph({ kind, title }: { kind: Kind; title?: boolean }): ReactElement {
  const Icon = kind.icon
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center" title={title ? kind.name : undefined} data-panel-icon={kind.name}>
      <Icon size={14} strokeWidth={2} absoluteStrokeWidth aria-hidden />
    </span>
  )
}

function DashboardIcon({ tab }: { tab: Tab }): ReactElement {
  const root = useAppStore((s) => Object.values(s.worktreesByWorkspace).flat().find((w) => w.id === tab.worktreeId)?.path ?? '')
  const loud = hasUndelivered(useDashboardAlerts(root))
  return (
    <span className="relative flex shrink-0" data-dashboard-tab-alert={loud ? '' : undefined}>
      <PanelGlyph kind={PANEL_KIND.dashboard} title />
      {loud && <span className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[#ef6e6b] ring-2 ring-[var(--panel)]" />}
    </span>
  )
}

export function PanelIcon({ tab, file }: { tab: Tab; file?: string }): ReactElement {
  const tunerTitle = useTunerTabTitle(tab.contentType === 'tuner' ? tab.id : '')
  if (tab.agentId) return <AgentIcon id={tab.agentId} className="h-3.5 w-3.5 shrink-0" />
  if (tab.contentType === 'dashboard') return <DashboardIcon tab={tab} />
  if (tunerTitle && !tab.customLabel)
    return (
      <PanelGlyph
        kind={
          tunerTitle.kind === 'staging'
            ? PANEL_KIND.tunerStaging
            : tunerTitle.kind === 'variant'
              ? PANEL_KIND.tunerVariant
              : tunerTitle.kind === 'prefab'
                ? PANEL_KIND.tunerPrefab
                : PANEL_KIND.tunerScene
        }
        title
      />
    )
  return <PanelGlyph kind={panelKind(tab, file)} title />
}
