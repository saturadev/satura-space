import { useEffect, useState, type ReactNode } from 'react'
import {
  APP_ZOOM_STEPS,
  DEFAULT_APP_ZOOM,
  DEFAULT_EDITOR_FONT_SIZE,
  DEFAULT_SETTINGS,
  DEFAULT_TERMINAL_FONT_SIZE,
  DEFAULT_THEME,
  type AgentConfig,
  type AgentId,
  USAGE_PROVIDERS
} from '@shared/types'
import type { UsageProvider } from '@shared/api'
import { THEMES } from '../../lib/theme/themes'
import { ArrowBigUp, Command, CornerDownLeft, Option } from 'lucide-react'
import { AGENT_CATALOG, getAgentEntry } from '@shared/agent-catalog'
import { useAppStore } from '../../store'
import { useRestartDaemon } from '../../lib/terminal/use-restart-daemon'
import { useUpdaterStatus } from '../../lib/updater/use-updater'
import { AgentIcon } from '../../lib/agent-icon'
import { AgentModelEffort } from '../AgentModelEffort'
import { Select } from '../ui/Select'
import { SOUND_OPTIONS, soundUrl } from '../../lib/agent-alerts/sound-catalog'
import { playSound } from '../../lib/agent-alerts/play-sound'
import {
  IS_MAC,
  SHORTCUT_SECTIONS,
  type KeyToken,
  type ShortcutRow
} from '../../lib/shortcuts/shortcuts'
import { pickPath } from '../../lib/file-picker/file-picker-store'
import { MobileSection } from './MobileSettings'
import { StorageSection } from './StorageSettings'

export function SettingsPanel() {
  const settings = useAppStore((s) => s.settings)
  const detectedAgents = useAppStore((s) => s.detectedAgents)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const setAgentConfig = useAppStore((s) => s.setAgentConfig)
  const setFavoriteAgents = useAppStore((s) => s.setFavoriteAgents)
  const detectAgents = useAppStore((s) => s.detectAgents)
  const adjustFontSize = useAppStore((s) => s.adjustFontSize)
  const authEmail = useAppStore((s) => s.authUser?.email ?? null)
  const signOut = useAppStore((s) => s.signOut)
  const startSignIn = useAppStore((s) => s.startSignIn)
  const signingIn = useAppStore((s) => s.signingIn)
  const authConfigured = useAppStore((s) => s.authConfigured)

  const defaultProjectsFolder = settings?.defaultProjectsFolder ?? ''
  const favorites = settings?.favoriteAgents ?? []
  const detected = detectedAgents ?? []
  const terminalFontSize = settings?.terminalFontSize ?? DEFAULT_TERMINAL_FONT_SIZE
  const editorFontSize = settings?.editorFontSize ?? DEFAULT_EDITOR_FONT_SIZE
  const claudeVirtualizedRenderer = settings?.claudeVirtualizedRenderer ?? true
  const devSimulateNoUnityHub = settings?.devSimulateNoUnityHub ?? false

  const [isDev, setIsDev] = useState(false)
  useEffect(() => {
    window.api.app.isDev().then(setIsDev).catch(() => setIsDev(false))
  }, [])

  const [tab, setTab] = useState<
    'general' | 'themes' | 'alerts' | 'mobile' | 'storage' | 'shortcuts' | 'account' | 'dev'
  >('general')
  const { restarting: restartingDaemon, restartDaemon: restartTerminalDaemon } = useRestartDaemon()

  const browse = async (): Promise<void> => {
    const path = await pickPath({
      mode: 'openFolder',
      purpose: 'projects-root',
      title: 'Default projects folder',
      confirmLabel: 'Choose',
      defaultPath: defaultProjectsFolder || undefined
    })
    if (path) updateSettings({ defaultProjectsFolder: path })
  }

  const moveFav = (id: AgentId, dir: -1 | 1): void => {
    const i = favorites.indexOf(id)
    const j = i + dir
    if (i < 0 || j < 0 || j >= favorites.length) return
    const next = [...favorites]
    ;[next[i], next[j]] = [next[j], next[i]]
    setFavoriteAgents(next)
  }
  const removeFav = (id: AgentId): void => setFavoriteAgents(favorites.filter((f) => f !== id))
  const addFav = (id: AgentId): void => {
    if (favorites.length >= 3 || favorites.includes(id)) return
    setFavoriteAgents([...favorites, id])
  }
  const resetAgent = (id: AgentId): void => {
    const agents = { ...(settings?.agents ?? {}) }
    delete agents[id]
    updateSettings({ agents })
  }

  const nonFavorites = AGENT_CATALOG.map((e) => e.id).filter((id) => !favorites.includes(id))

  return (
    <div className="flex h-full flex-col">
      {}
      <div className="shrink-0 border-b border-white/10 px-6 pt-5">
        <h2 className="text-lg font-semibold text-white">Settings</h2>
        <div className="-mb-px mt-3 flex gap-4">
          <TabButton active={tab === 'general'} onClick={() => setTab('general')}>
            General
          </TabButton>
          <TabButton active={tab === 'themes'} onClick={() => setTab('themes')}>
            Appearance
          </TabButton>
          <TabButton active={tab === 'alerts'} onClick={() => setTab('alerts')}>
            Alerts
          </TabButton>
          <TabButton active={tab === 'mobile'} onClick={() => setTab('mobile')}>
            Mobile
          </TabButton>
          <TabButton active={tab === 'storage'} onClick={() => setTab('storage')}>
            Storage
          </TabButton>
          <TabButton active={tab === 'shortcuts'} onClick={() => setTab('shortcuts')}>
            Keyboard shortcuts
          </TabButton>
          {authConfigured && (
            <TabButton active={tab === 'account'} onClick={() => setTab('account')}>
              Account
            </TabButton>
          )}
          {isDev && (
            <TabButton active={tab === 'dev'} onClick={() => setTab('dev')}>
              Dev only
            </TabButton>
          )}
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-8 overflow-y-auto p-6">
        {tab === 'general' && (
          <>
      {}
      <UpdatesSection />

      {}
      <section className="space-y-2">
        <label className="text-sm font-semibold text-zinc-200">Default projects folder</label>
        <p className="text-xs text-zinc-500">
          Where the welcome screen&rsquo;s folder picker starts when you open a new workspace.
        </p>
        <div className="flex items-center gap-2 rounded-md border border-white/10 bg-sunken p-2">
          <input
            value={defaultProjectsFolder}
            onChange={(e) => updateSettings({ defaultProjectsFolder: e.target.value })}
            spellCheck={false}
            placeholder="~  (defaults to your home folder)"
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:outline-none"
          />
          <button
            onClick={() => void browse()}
            className="shrink-0 rounded border border-white/10 px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            Browse
          </button>
        </div>
      </section>

      {}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-semibold text-zinc-200">Favourite agents (Top 3)</label>
          <span className="text-xs text-zinc-500">{favorites.length}/3</span>
        </div>
        <p className="text-xs text-zinc-500">Shown directly in the panel&rsquo;s &ldquo;+&rdquo; menu, in this order.</p>

        <div className="space-y-1.5">
          {favorites.length === 0 && (
            <p className="text-xs text-zinc-600">No favourites yet — add up to three below.</p>
          )}
          {favorites.map((id, i) => (
            <div
              key={id}
              className="flex items-center gap-2 rounded border border-white/10 bg-sunken px-2.5 py-1.5"
            >
              <span className="flex h-5 w-5 items-center justify-center rounded bg-white/10 text-[11px] font-bold text-zinc-300">
                {i + 1}
              </span>
              <AgentIcon id={id} />
              <span className="flex-1 truncate text-sm text-zinc-100">{getAgentEntry(id)?.label ?? id}</span>
              {!detected.includes(id) && (
                <span className="text-[10px] text-amber-500/80">not installed</span>
              )}
              <button
                onClick={() => moveFav(id, -1)}
                disabled={i === 0}
                title="Move up"
                className="rounded px-1 text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-30"
              >
                ↑
              </button>
              <button
                onClick={() => moveFav(id, 1)}
                disabled={i === favorites.length - 1}
                title="Move down"
                className="rounded px-1 text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-30"
              >
                ↓
              </button>
              <button
                onClick={() => removeFav(id)}
                title="Remove from favourites"
                className="rounded px-1 text-zinc-500 hover:bg-white/10 hover:text-white"
              >
                ×
              </button>
            </div>
          ))}
        </div>

        {favorites.length < 3 && (
          <div className="flex flex-wrap gap-1.5 pt-1">
            {nonFavorites.map((id) => (
              <button
                key={id}
                onClick={() => addFav(id)}
                className="flex items-center gap-1.5 rounded border border-white/10 bg-sunken px-2 py-1 text-xs text-zinc-300 hover:border-white/20 hover:text-white"
              >
                <AgentIcon id={id} className="h-3.5 w-3.5" />
                {getAgentEntry(id)?.label ?? id}
              </button>
            ))}
          </div>
        )}
      </section>

      {}
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <label className="text-sm font-semibold text-zinc-200">Agents</label>
          <button
            onClick={() => void detectAgents()}
            className="rounded border border-white/10 px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/10 hover:text-white"
          >
            Refresh
          </button>
        </div>
        <div className="space-y-1.5">
          {AGENT_CATALOG.map((entry) => (
            <AgentRow
              key={entry.id}
              id={entry.id}
              installed={detected.includes(entry.id)}
              config={settings?.agents[entry.id]}
              onToggleEnabled={(enabled) => setAgentConfig(entry.id, { enabled })}
              onCommit={(patch) => setAgentConfig(entry.id, patch)}
              onReset={() => resetAgent(entry.id)}
            />
          ))}
        </div>
        <p className="pt-1 text-[11px] text-zinc-600">
          BYO auth — sign in via each CLI. No API keys are stored here; env is launch env only.
        </p>
      </section>

      {}
      <section className="space-y-2">
        <label className="text-sm font-semibold text-zinc-200">Claude Code</label>
        <div className="flex items-center gap-3 rounded border border-white/10 bg-sunken px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-zinc-100">Virtualized renderer</p>
            <p className="text-xs text-zinc-500">
              Launch Claude with its fullscreen renderer (
              <code className="text-zinc-400">CLAUDE_CODE_NO_FLICKER=1</code>) — flicker-free,
              mouse support, and flat memory in long sessions.
            </p>
          </div>
          <button
            onClick={() =>
              updateSettings({ claudeVirtualizedRenderer: !claudeVirtualizedRenderer })
            }
            title={claudeVirtualizedRenderer ? 'On — click to disable' : 'Off — click to enable'}
            className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${
              claudeVirtualizedRenderer
                ? 'bg-sky-500/15 text-sky-300 hover:bg-sky-500/25'
                : 'bg-white/5 text-zinc-400 hover:bg-white/10'
            }`}
          >
            {claudeVirtualizedRenderer ? 'On' : 'Off'}
          </button>
        </div>
      </section>

      <UsageVisibilitySection />

      {}
      <section className="space-y-2">
        <label className="text-sm font-semibold text-zinc-200">Terminal daemon</label>
        <div className="flex items-center gap-3 rounded border border-white/10 bg-sunken px-2.5 py-2">
          <div className="min-w-0 flex-1">
            <p className="text-sm text-zinc-100">Restart daemon</p>
            <p className="text-xs text-zinc-500">
              Kills every running terminal pane and restarts the background daemon to clear stale
              state. Panes show &ldquo;Process exited&rdquo; and can be reopened immediately.
            </p>
          </div>
          <button
            onClick={() => void restartTerminalDaemon()}
            disabled={restartingDaemon}
            className="shrink-0 rounded bg-red-500/15 px-2.5 py-1 text-[11px] font-medium text-red-300 hover:bg-red-500/25 disabled:opacity-50"
          >
            {restartingDaemon ? 'Restarting…' : 'Restart daemon'}
          </button>
        </div>
      </section>

      {}
      <section className="space-y-2">
        <label className="text-sm font-semibold text-zinc-200">Font size</label>
        <p className="text-xs text-zinc-500">
          Also adjustable with {IS_MAC ? '⌘' : 'Ctrl'} +/−/0 while a terminal or the file viewer is
          focused.
        </p>
        <div className="space-y-1.5">
          <FontSizeRow
            label="Terminal"
            value={terminalFontSize}
            isDefault={terminalFontSize === DEFAULT_TERMINAL_FONT_SIZE}
            onDelta={(d) => adjustFontSize('terminal', d)}
          />
          <FontSizeRow
            label="File viewer"
            value={editorFontSize}
            isDefault={editorFontSize === DEFAULT_EDITOR_FONT_SIZE}
            onDelta={(d) => adjustFontSize('editor', d)}
          />
        </div>
      </section>


      <AppScaleSetting />

      <ShellSetting />
          </>
        )}

        {tab === 'themes' && <ThemesSection />}

        {tab === 'alerts' && <AlertsSection />}

        {tab === 'mobile' && <MobileSection />}

        {tab === 'storage' && <StorageSection />}

        {tab === 'dev' && isDev && (
          <section className="space-y-2">
            <label className="text-sm font-semibold text-amber-300/90">Dev only</label>
            <p className="text-xs text-zinc-500">
              Visible in the dev build only. Toggles here simulate states for testing.
            </p>
            <div className="flex items-center gap-3 rounded border border-amber-500/20 bg-amber-500/[0.04] px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-zinc-100">Simulate &ldquo;Unity Hub not available&rdquo;</p>
                <p className="text-xs text-zinc-500">
                  Forces the Your-workspace screen to treat Unity Hub as not installed.
                </p>
              </div>
              <button
                onClick={() => updateSettings({ devSimulateNoUnityHub: !devSimulateNoUnityHub })}
                title={devSimulateNoUnityHub ? 'On — click to disable' : 'Off — click to enable'}
                className={`shrink-0 rounded px-2 py-0.5 text-[11px] font-medium ${
                  devSimulateNoUnityHub
                    ? 'bg-amber-500/20 text-amber-300 hover:bg-amber-500/30'
                    : 'bg-white/5 text-zinc-400 hover:bg-white/10'
                }`}
              >
                {devSimulateNoUnityHub ? 'On' : 'Off'}
              </button>
            </div>
            <div className="flex items-center gap-3 rounded border border-amber-500/20 bg-amber-500/[0.04] px-2.5 py-2">
              <div className="min-w-0 flex-1">
                <p className="text-sm text-zinc-100">Simulate update</p>
                <p className="text-xs text-zinc-500">
                  Fakes an available update so the top-bar Update flow can be tested.
                </p>
              </div>
              <button
                onClick={() => window.api.updater.simulate()}
                className="shrink-0 rounded px-2 py-0.5 text-[11px] font-medium bg-white/5 text-zinc-400 hover:bg-white/10"
              >
                Run
              </button>
            </div>
          </section>
        )}

        {tab === 'shortcuts' && (
          <>
      {}
      <p className="text-sm leading-relaxed text-zinc-400">
        Quick Open (double-tap Shift) and Find in files ({IS_MAC ? '⌘' : 'Ctrl'}+Shift+F) work from
        any pane; the Unity Player only takes {IS_MAC ? '⌘' : 'Ctrl'}+P (Play/Stop) and forwards
        every other key to the game. {IS_MAC ? '⌘' : 'Ctrl'} +/−/0 resize the focused terminal / file
        viewer (they never zoom the app).
      </p>
      <div className="space-y-4">
        {SHORTCUT_SECTIONS.map((section) => (
          <div key={section.title} className="rounded-md border border-white/10 bg-sunken">
            <div className="border-b border-white/10 px-3.5 py-2.5">
              <p className="text-sm font-semibold text-zinc-100">{section.title}</p>
              <p className="text-xs text-zinc-500">{section.subtitle}</p>
            </div>
            {section.rows.length === 0 ? (
              <p className="px-3.5 py-3 text-xs italic text-zinc-600">No shortcuts.</p>
            ) : (
              <div className="divide-y divide-white/5">
                {section.rows.map((row, i) => (
                  <ShortcutLine key={i} row={row} />
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
          </>
        )}

        {tab === 'account' && authConfigured && (
          <>
            <section className="space-y-2">
              <label className="text-sm font-semibold text-zinc-200">Satura Space</label>
              <p className="text-xs text-zinc-500">
                You only need an account to pair the Satura Remote phone app. The rest of the app works without one.
              </p>
              <div className="flex items-center justify-between rounded border border-white/10 bg-sunken px-2.5 py-2">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm text-zinc-100">{authEmail ?? 'Not signed in'}</p>
                  {authEmail && <p className="text-xs text-zinc-500">Signed in</p>}
                </div>
                {authEmail ? (
                  <button
                    onClick={() => void signOut()}
                    className="shrink-0 rounded border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:bg-white/10 hover:text-white"
                  >
                    Sign out
                  </button>
                ) : (
                  <button
                    onClick={() => void startSignIn()}
                    disabled={signingIn}
                    className="shrink-0 rounded border border-white/10 px-3 py-1 text-xs text-zinc-300 hover:bg-white/10 hover:text-white disabled:opacity-40"
                  >
                    Sign in
                  </button>
                )}
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  )
}

function TabButton({
  active,
  onClick,
  children
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <button
      onClick={onClick}
      className={`border-b-2 pb-2 text-sm font-medium transition-colors ${
        active
          ? 'border-sky-400 text-white'
          : 'border-transparent text-zinc-400 hover:text-zinc-200'
      }`}
    >
      {children}
    </button>
  )
}

function ThemesSection() {
  const current = useAppStore((s) => s.settings?.theme ?? DEFAULT_THEME)
  const setTheme = useAppStore((s) => s.setTheme)
  const updateSettings = useAppStore((s) => s.updateSettings)
  const startScreenEffect = useAppStore((s) => s.settings?.startScreenEffect ?? true)
  const driftSpotlight = useAppStore((s) => s.settings?.driftSpotlight ?? true)

  return (
    <section className="space-y-3">
      {THEMES.length > 1 && (
      <>
      <div>
        <label className="text-sm font-semibold text-ink">Theme</label>
        <p className="text-xs text-ink-3">
          Recolors the app chrome. The terminal, code editor, and live game view keep their own
          rendering.
        </p>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {THEMES.map((theme) => {
          const selected = current === theme.id
          return (
            <button
              key={theme.id}
              onClick={() => setTheme(theme.id)}
              className={`group flex flex-col overflow-hidden rounded-xl border text-left transition-colors ${
                selected
                  ? 'border-accent ring-1 ring-accent'
                  : 'border-hairline hover:border-strong'
              }`}
            >
              <div
                className="relative flex h-20 items-stretch gap-1.5 p-2"
                style={{ backgroundColor: theme.swatch.canvas }}
              >
                <div
                  className="flex w-1/3 flex-col gap-1 rounded p-1.5"
                  style={{ backgroundColor: theme.swatch.panel }}
                >
                  <span
                    className="h-1.5 w-full rounded-full"
                    style={{ backgroundColor: theme.swatch.accent }}
                  />
                  <span
                    className="h-1 w-3/4 rounded-full opacity-60"
                    style={{ backgroundColor: theme.swatch.ink }}
                  />
                  <span
                    className="h-1 w-2/3 rounded-full opacity-40"
                    style={{ backgroundColor: theme.swatch.ink }}
                  />
                </div>
                <div
                  className="flex flex-1 flex-col gap-1 rounded p-1.5"
                  style={{ backgroundColor: theme.swatch.panel }}
                >
                  <span
                    className="h-1 w-1/2 rounded-full opacity-80"
                    style={{ backgroundColor: theme.swatch.ink }}
                  />
                  <span
                    className="h-1 w-full rounded-full opacity-30"
                    style={{ backgroundColor: theme.swatch.ink }}
                  />
                  <span
                    className="h-1 w-5/6 rounded-full opacity-30"
                    style={{ backgroundColor: theme.swatch.ink }}
                  />
                  <span
                    className="mt-auto h-2 w-10 rounded"
                    style={{ backgroundColor: theme.swatch.accent }}
                  />
                </div>
                {selected && (
                  <span className="absolute right-1.5 top-1.5 flex h-4 w-4 items-center justify-center rounded-full bg-accent text-[10px] font-bold text-accent-fg">
                    ✓
                  </span>
                )}
              </div>
              <div className="space-y-0.5 bg-panel px-3 py-2">
                <p className="text-sm font-medium text-ink">{theme.label}</p>
                <p className="text-[11px] leading-snug text-ink-3">{theme.description}</p>
              </div>
            </button>
          )
        })}
      </div>
      </>
      )}
      <div className="pt-1">
        <ToggleRow
          title="Start screen animation"
          description="Animated squares and cursor ripples on the “Your workspace” screen."
          on={startScreenEffect}
          onToggle={() => updateSettings({ startScreenEffect: !startScreenEffect })}
        />
        <ToggleRow
          title="Let Drift dim the workspace"
          description="A script can ask Drift to darken everything around the thing it’s showing you. Turn this off and it never will."
          on={driftSpotlight}
          onToggle={() => updateSettings({ driftSpotlight: !driftSpotlight })}
        />
      </div>
    </section>
  )
}

function AlertsSection() {
  const settings = useAppStore((s) => s.settings)
  const updateSettings = useAppStore((s) => s.updateSettings)

  const highlight = settings?.agentAlertHighlight ?? true
  const sound = settings?.agentAlertSound ?? true
  const volume = settings?.agentAlertVolume ?? 0.7
  const finishedSound = settings?.agentAlertFinishedSound ?? DEFAULT_SETTINGS.agentAlertFinishedSound
  const attentionSound = settings?.agentAlertAttentionSound ?? DEFAULT_SETTINGS.agentAlertAttentionSound
  const notifyFinished = settings?.notifyAgentFinished ?? DEFAULT_SETTINGS.notifyAgentFinished
  const notifyNeedsYou = settings?.notifyAgentNeedsYou ?? DEFAULT_SETTINGS.notifyAgentNeedsYou

  const options = SOUND_OPTIONS.map((o) => ({ value: o.id, label: o.label, hint: o.group }))
  const preview = (id: string): void => {
    const url = soundUrl(id)
    if (url) playSound(url, volume)
  }

  return (
    <>
      <section className="space-y-2">
        <label className="text-sm font-semibold text-zinc-200">Claude Code alerts</label>
        <p className="text-xs text-zinc-500">
          When a Claude Code panel finishes or asks for your attention while you&rsquo;re looking
          elsewhere, its tab lights up briefly and a sound plays. Only applies to Claude Code panels.
        </p>
      </section>

      <section className="space-y-2">
        <ToggleRow
          title="Highlight the tab"
          description="Briefly flashes the panel&rsquo;s tab so you notice it across many panes."
          on={highlight}
          onToggle={() => updateSettings({ agentAlertHighlight: !highlight })}
        />
        <ToggleRow
          title="Play a sound"
          description="Plays the selected sound effect when a Claude panel finishes or needs you."
          on={sound}
          onToggle={() => updateSettings({ agentAlertSound: !sound })}
        />
      </section>

      <section className="space-y-2">
        <label className="text-sm font-semibold text-zinc-200">Desktop notifications</label>
        <p className="text-xs text-zinc-500">
          A system notification for any agent terminal, unless its tab is already in front of you in the focused
          window. Clicking it brings that tab forward.
        </p>
        <ToggleRow
          title="When an agent finishes"
          description="Claude Code, Codex, Cursor, Grok, Kimi and others finishing their turn."
          on={notifyFinished}
          onToggle={() => updateSettings({ notifyAgentFinished: !notifyFinished })}
        />
        <ToggleRow
          title="When an agent needs you"
          description="A permission prompt, a question, or an input form waiting for an answer."
          on={notifyNeedsYou}
          onToggle={() => updateSettings({ notifyAgentNeedsYou: !notifyNeedsYou })}
        />
      </section>

      <section className="space-y-2">
        <label className="text-sm font-semibold text-zinc-200">Volume</label>
        <div className="flex items-center gap-3 rounded border border-white/10 bg-sunken px-2.5 py-2">
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={volume}
            onChange={(e) => updateSettings({ agentAlertVolume: Number(e.target.value) })}
            className="min-w-0 flex-1 accent-sky-400"
          />
          <span className="w-10 shrink-0 text-right text-xs tabular-nums text-zinc-300">
            {Math.round(volume * 100)}%
          </span>
        </div>
      </section>

      <section className="space-y-2">
        <label className="text-sm font-semibold text-zinc-200">Sound effects</label>
        <p className="text-xs text-zinc-500">
          Pick a sound for each event.
        </p>
        <SoundPickerRow
          label="When Claude finishes"
          value={finishedSound}
          options={options}
          onChange={(v) => updateSettings({ agentAlertFinishedSound: v })}
          onPreview={() => preview(finishedSound)}
        />
        <SoundPickerRow
          label="When Claude needs you"
          value={attentionSound}
          options={options}
          onChange={(v) => updateSettings({ agentAlertAttentionSound: v })}
          onPreview={() => preview(attentionSound)}
        />
      </section>
    </>
  )
}

const USAGE_PROVIDER_LABELS: Record<UsageProvider, string> = {
  claude: 'Claude',
  codex: 'Codex',
  kimi: 'Kimi'
}

function UsageVisibilitySection() {
  const stored = useAppStore((s) => s.settings?.hiddenUsageProviders)
  const hidden = stored ?? []
  const updateSettings = useAppStore((s) => s.updateSettings)

  const toggle = (provider: UsageProvider): void =>
    updateSettings({
      hiddenUsageProviders: hidden.includes(provider)
        ? hidden.filter((p) => p !== provider)
        : [...hidden, provider]
    })

  return (
    <section className="space-y-2">
      <label className="text-sm font-semibold text-zinc-200">Usage limits</label>
      <p className="text-xs text-zinc-500">
        Which agents show usage in the bottom bar. Hidden ones aren&rsquo;t checked at all.
      </p>
      <div className="space-y-1.5">
        {USAGE_PROVIDERS.map((provider) => (
          <ToggleRow
            key={provider}
            title={USAGE_PROVIDER_LABELS[provider]}
            description={`Show ${USAGE_PROVIDER_LABELS[provider]} usage left.`}
            on={!hidden.includes(provider)}
            onToggle={() => toggle(provider)}
          />
        ))}
      </div>
    </section>
  )
}

function ToggleRow({
  title,
  description,
  on,
  onToggle
}: {
  title: string
  description: string
  on: boolean
  onToggle: () => void
}) {
  return (
    <div className="flex items-center gap-3 rounded border border-white/10 bg-sunken px-2.5 py-2">
      <div className="min-w-0 flex-1">
        <p className="text-sm text-zinc-100">{title}</p>
        <p className="text-xs text-zinc-500">{description}</p>
      </div>
      <button
        onClick={onToggle}
        title={on ? 'On — click to disable' : 'Off — click to enable'}
        className={`shrink-0 rounded-md px-2 py-0.5 text-[11px] font-medium ${
          on
            ? 'bg-sky-500/15 text-sky-300 hover:bg-sky-500/25'
            : 'bg-white/5 text-zinc-400 hover:bg-white/10'
        }`}
      >
        {on ? 'On' : 'Off'}
      </button>
    </div>
  )
}

function SoundPickerRow({
  label,
  value,
  options,
  onChange,
  onPreview
}: {
  label: string
  value: string
  options: { value: string; label: string; hint: string }[]
  onChange: (value: string) => void
  onPreview: () => void
}) {
  return (
    <div className="flex items-center gap-2 rounded border border-white/10 bg-sunken px-2.5 py-2">
      <span className="w-40 shrink-0 text-sm text-zinc-100">{label}</span>
      <div className="min-w-0 flex-1">
        <Select value={value} onChange={onChange} options={options} />
      </div>
      <button
        onClick={onPreview}
        title="Preview"
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded border border-white/10 text-zinc-300 hover:bg-white/10 hover:text-white"
      >
        <span className="text-xs leading-none">▶</span>
      </button>
    </div>
  )
}

function UpdatesSection() {
  const status = useUpdaterStatus()
  const [version, setVersion] = useState('')
  useEffect(() => {
    void window.api.app.getVersion().then(setVersion)
  }, [])

  const statusText =
    status.state === 'checking'
      ? 'Checking for updates…'
      : status.state === 'not-available'
        ? 'You are on the latest version.'
        : status.state === 'available'
          ? `Update available: v${status.version}. Open it from the Update button in the top bar.`
          : status.state === 'downloading'
            ? `Downloading v${status.version}… ${status.percent}%`
            : status.state === 'ready'
              ? `v${status.version} ready — restart from the top-bar Update button.`
              : status.state === 'error'
                ? status.message
                : null

  const busy = status.state === 'checking' || status.state === 'downloading'

  return (
    <section className="space-y-2">
      <label className="text-sm font-semibold text-zinc-200">Updates</label>
      <p className="text-xs text-zinc-500">Current version: v{version || '—'}</p>
      <div className="flex items-center gap-2">
        <button
          onClick={() => window.api.updater.check()}
          disabled={busy}
          className="rounded-md border border-white/10 px-2.5 py-1 text-xs text-zinc-300 hover:bg-white/10 hover:text-white disabled:opacity-40"
        >
          Check for Updates
        </button>
      </div>
      {statusText && <p className="text-xs text-zinc-500">{statusText}</p>}
    </section>
  )
}

function AppScaleSetting() {
  const current = useAppStore((s) => s.settings?.appZoomFactor ?? DEFAULT_APP_ZOOM)
  const setAppZoomFactor = useAppStore((s) => s.setAppZoomFactor)

  const steps = APP_ZOOM_STEPS.includes(current)
    ? APP_ZOOM_STEPS
    : [...APP_ZOOM_STEPS, current].sort((a, b) => a - b)

  return (
    <section className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-sm font-semibold text-zinc-200">App scale</label>
        {current !== DEFAULT_APP_ZOOM && (
          <button
            onClick={() => setAppZoomFactor(DEFAULT_APP_ZOOM)}
            className="rounded px-1.5 text-[11px] text-zinc-500 hover:text-zinc-200"
          >
            Reset
          </button>
        )}
      </div>
      <p className="text-xs text-zinc-500">
        Zoom the whole interface in or out. Independent of the terminal / file-viewer font size.
      </p>
      <div className="rounded border border-white/10 bg-sunken p-2">
        <Select
          value={String(current)}
          onChange={(v) => setAppZoomFactor(Number(v))}
          options={steps.map((z) => ({
            value: String(z),
            label: `${Math.round(z * 100)}%`,
            hint: z === DEFAULT_APP_ZOOM ? 'default' : undefined
          }))}
        />
      </div>
    </section>
  )
}

function shellName(path: string): string {
  return (path.split('/').pop() || path).replace(/\.exe$/i, '')
}

function ShellSetting() {
  const current = useAppStore((s) => s.settings?.terminalShell ?? '')
  const updateSettings = useAppStore((s) => s.updateSettings)
  const [shells, setShells] = useState<string[]>([])
  const [pickedCustom, setPickedCustom] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.pty.listShells().then((list) => {
      if (alive) setShells(list)
    })
    return () => {
      alive = false
    }
  }, [])

  const isCustomValue = shells.length > 0 && current !== '' && !shells.includes(current)
  const customMode = pickedCustom || isCustomValue
  const selectValue = customMode ? '__custom__' : current

  return (
    <section className="space-y-2">
      <label className="text-sm font-semibold text-zinc-200">Terminal shell</label>
      <p className="text-xs text-zinc-500">
        Which shell new terminals launch. <span className="text-zinc-300">Auto</span> uses your login
        shell (<code className="text-zinc-400">$SHELL</code>). Open terminals keep their current shell.
      </p>
      <div className="rounded border border-white/10 bg-sunken p-2">
        <Select
          value={selectValue}
          onChange={(v) => {
            if (v === '__custom__') {
              setPickedCustom(true)
            } else {
              setPickedCustom(false)
              updateSettings({ terminalShell: v })
            }
          }}
          options={[
            { value: '', label: 'Auto (login shell)' },
            ...shells.map((s) => ({ value: s, label: shellName(s), hint: s })),
            { value: '__custom__', label: 'Custom…' }
          ]}
        />
      </div>
      {customMode && (
        <input
          value={current}
          onChange={(e) => updateSettings({ terminalShell: e.target.value })}
          spellCheck={false}
          placeholder="/absolute/path/to/shell"
          className="w-full rounded border border-white/10 bg-sunken px-2 py-1 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-white/20 focus:outline-none"
        />
      )}
    </section>
  )
}

function FontSizeRow({
  label,
  value,
  isDefault,
  onDelta
}: {
  label: string
  value: number
  isDefault: boolean
  onDelta: (delta: number | 'reset') => void
}) {
  const step =
    'flex h-6 w-6 items-center justify-center rounded text-zinc-300 hover:bg-white/10 hover:text-white'
  return (
    <div className="flex items-center gap-2 rounded border border-white/10 bg-sunken px-2.5 py-1.5">
      <span className="flex-1 text-sm text-zinc-100">{label}</span>
      {!isDefault && (
        <button onClick={() => onDelta('reset')} className="rounded px-1.5 text-[11px] text-zinc-500 hover:text-zinc-200">
          Reset
        </button>
      )}
      <div className="flex items-center overflow-hidden rounded border border-white/10">
        <button onClick={() => onDelta(-1)} title="Smaller" className={step}>
          −
        </button>
        <span className="min-w-[3rem] border-x border-white/10 px-1 text-center text-xs tabular-nums text-zinc-200">
          {value} px
        </span>
        <button onClick={() => onDelta(+1)} title="Larger" className={step}>
          +
        </button>
      </div>
    </div>
  )
}

function ShortcutLine({ row }: { row: ShortcutRow }) {
  return (
    <div className={`px-3.5 py-2.5 ${row.enabled ? '' : 'opacity-50'}`}>
      <div className="flex items-center gap-3">
        <div className="flex shrink-0 items-center gap-1.5">
          {row.combos.map((combo, i) => (
            <span key={i} className="flex items-center gap-1.5">
              {i > 0 && <span className="px-0.5 text-xs text-zinc-600">or</span>}
              <KeyCombo combo={combo} />
            </span>
          ))}
        </div>
        <span className="min-w-0 flex-1 text-sm text-zinc-200">{row.action}</span>
        {!row.enabled && (
          <span className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[11px] font-medium text-zinc-500">
            Off
          </span>
        )}
      </div>
      {row.note && <p className="pt-1 text-xs text-zinc-600">{row.note}</p>}
    </div>
  )
}

function KeyCombo({ combo }: { combo: KeyToken[] }) {
  return (
    <span className="flex items-center gap-1">
      {combo.map((token, i) => (
        <KeyCap key={i} token={token} />
      ))}
    </span>
  )
}

const ICON = 'h-3.5 w-3.5'

function KeyCap({ token }: { token: KeyToken }) {
  const cap =
    'inline-flex h-7 min-w-[1.75rem] items-center justify-center rounded border border-white/15 bg-white/[0.07] px-2 text-[13px] font-medium text-zinc-100 shadow-[inset_0_-1.5px_0_rgba(0,0,0,0.35)]'

  switch (token) {
    case 'mod':
      return <kbd className={cap}>{IS_MAC ? <Command className={ICON} aria-label="Command" /> : 'Ctrl'}</kbd>
    case 'shift':
      return <kbd className={cap}>{IS_MAC ? <ArrowBigUp className={ICON} aria-label="Shift" /> : 'Shift'}</kbd>
    case 'alt':
      return <kbd className={cap}>{IS_MAC ? <Option className={ICON} aria-label="Option" /> : 'Alt'}</kbd>
    case 'enter':
      return (
        <kbd className={cap}>
          <CornerDownLeft className={ICON} aria-label="Enter" />
        </kbd>
      )
    case 'esc':
      return <kbd className={cap}>Esc</kbd>
    case 'dblclick':
      return <kbd className={cap}>Double-click</kbd>
    default:
      return <kbd className={cap}>{token}</kbd>
  }
}

function envToText(env?: Record<string, string>): string {
  return Object.entries(env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join('\n')
}

function textToEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const t = line.trim()
    const idx = t.indexOf('=')
    if (idx <= 0) continue
    out[t.slice(0, idx).trim()] = t.slice(idx + 1)
  }
  return out
}

function AgentRow({
  id,
  installed,
  config,
  onToggleEnabled,
  onCommit,
  onReset
}: {
  id: AgentId
  installed: boolean
  config?: AgentConfig
  onToggleEnabled: (enabled: boolean) => void
  onCommit: (patch: Partial<AgentConfig>) => void
  onReset: () => void
}) {
  const entry = getAgentEntry(id)
  const enabled = config?.enabled !== false
  const [expanded, setExpanded] = useState(false)
  const [cmd, setCmd] = useState(config?.cmd ?? '')
  const [args, setArgs] = useState(config?.args ?? '')
  const [env, setEnv] = useState(envToText(config?.env))

  const input =
    'w-full rounded border border-white/10 bg-sunken px-2 py-1 font-mono text-xs text-zinc-100 placeholder:text-zinc-600 focus:border-white/20 focus:outline-none'

  return (
    <div className="rounded-lg border border-white/10 bg-sunken">
      <div className="flex items-center gap-2 px-2.5 py-1.5">
        <AgentIcon id={id} />
        <span className="flex-1 truncate text-sm text-zinc-100">{entry?.label ?? id}</span>
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${
            installed
              ? 'bg-emerald-500/15 text-emerald-400'
              : 'bg-white/5 text-zinc-500'
          }`}
        >
          {installed ? 'Detected' : 'Not installed'}
        </span>
        <button
          onClick={() => onToggleEnabled(!enabled)}
          title={enabled ? 'Enabled — click to disable' : 'Disabled — click to enable'}
          className={`rounded px-2 py-0.5 text-[11px] font-medium ${
            enabled
              ? 'bg-sky-500/15 text-sky-300 hover:bg-sky-500/25'
              : 'bg-white/5 text-zinc-400 hover:bg-white/10'
          }`}
        >
          {enabled ? 'On' : 'Off'}
        </button>
        <button
          onClick={() => setExpanded((e) => !e)}
          title="Configure"
          className="rounded px-1 text-zinc-400 hover:bg-white/10 hover:text-white"
        >
          {expanded ? '▾' : '▸'}
        </button>
      </div>

      {expanded && (
        <div className="space-y-2 border-t border-white/10 px-2.5 py-2">
          <AgentModelEffort id={id} />
          <div className="space-y-1">
            <label className="text-[11px] text-zinc-500">Command</label>
            <input
              value={cmd}
              onChange={(e) => setCmd(e.target.value)}
              onBlur={() => onCommit({ cmd: cmd.trim() || undefined })}
              spellCheck={false}
              placeholder={entry?.cmd}
              className={input}
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-zinc-500">Arguments</label>
            <input
              value={args}
              onChange={(e) => setArgs(e.target.value)}
              onBlur={() => onCommit({ args: args })}
              spellCheck={false}
              placeholder={entry?.defaultArgs ?? '(none)'}
              className={input}
            />
          </div>
          <div className="space-y-1">
            <label className="text-[11px] text-zinc-500">Environment (KEY=value per line)</label>
            <textarea
              value={env}
              onChange={(e) => setEnv(e.target.value)}
              onBlur={() => onCommit({ env: textToEnv(env) })}
              spellCheck={false}
              rows={2}
              placeholder="EXAMPLE_FLAG=1"
              className={`${input} resize-y`}
            />
          </div>
          <div className="flex items-center justify-between pt-0.5">
            {entry?.homepageUrl ? (
              <a
                href={entry.homepageUrl}
                target="_blank"
                rel="noreferrer"
                className="text-[11px] text-sky-400 hover:underline"
              >
                Install / docs ↗
              </a>
            ) : (
              <span />
            )}
            <button
              onClick={() => {
                onReset()
                setCmd('')
                setArgs('')
                setEnv('')
              }}
              className="rounded border border-white/10 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-white/10 hover:text-white"
            >
              Reset
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
