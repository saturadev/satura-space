import { useState } from 'react'
import { ChevronRight, Plus, Puzzle } from 'lucide-react'
import { AnchoredLayer } from '../ui/AnchoredLayer'
import { MenuLabel, MenuSeparator, menuItemClass } from '../ui/FloatingMenu'
import { PanelGlyph } from './PanelIcon'
import type { NewSessionModel } from '../../lib/actions/new-session-actions'

export function PluginsSubmenu({ m, isUnityProject }: { m: NewSessionModel; isUnityProject: boolean | null }) {
  const [open, setOpen] = useState(false)
  const [asking, setAsking] = useState(false)
  const [request, setRequest] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const submit = (): void => {
    if (busy) return
    if (!request.trim()) {
      setError('Say what the plugin should do.')
      return
    }
    setBusy(true)
    setError('')
    void m.startNewPlugin(request).then((r) => {
      setBusy(false)
      if (!r.sent) setError(r.error)
    })
  }

  return (
    <div className="relative" onMouseEnter={() => setOpen(true)} onMouseLeave={() => !asking && setOpen(false)} data-plugins-menu>
      <button className={menuItemClass} onClick={() => setOpen((o) => !o)}>
        <Puzzle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
        Plugins
        <ChevronRight className="ml-auto h-3.5 w-3.5 shrink-0 text-zinc-500" strokeWidth={2} />
      </button>

      {open && (
        <AnchoredLayer side="left" align="start" gap={2} className="animate-submenu-pop-in surface-overlay w-72 origin-top-right rounded-lg p-1">
          <div data-plugins-submenu>
            <MenuLabel>Built-in</MenuLabel>
            {m.plugins.map((row) => (
              <button
                key={row.panel.key}
                onClick={row.open}
                disabled={!row.enabled}
                title={row.existing ? `Show the open ${row.panel.title} panel for this folder` : (row.panel.hint ?? row.panel.title)}
                className={menuItemClass}
                data-plugin-panel-open={row.panel.key}
              >
                <PanelGlyph kind={{ icon: row.panel.icon, name: row.panel.title }} />
                {row.existing ? `Show ${row.panel.title}` : row.panel.title}
                {row.existing ? (
                  <span className="ml-auto text-[10px] text-zinc-500">already open</span>
                ) : (
                  !row.enabled && isUnityProject === false && <span className="ml-auto text-[10px] text-zinc-600">not a Unity project</span>
                )}
              </button>
            ))}
            <MenuLabel>This project</MenuLabel>
            {m.ownPlugins.length === 0 && <div className="px-2 py-1.5 text-[12px] text-ink-3">No plugins in .sspace/plugins yet</div>}
            {m.ownPlugins.map((row) => (
              <button
                key={row.key}
                onClick={row.open}
                disabled={!row.enabled}
                title={row.info.problem ?? (row.info.description || row.info.title)}
                className={menuItemClass}
                data-plugin-panel-open={row.key}
              >
                <Puzzle className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                <span className="truncate">{row.existing ? `Show ${row.info.title}` : row.info.title}</span>
                {row.existing ? (
                  <span className="ml-auto shrink-0 text-[10px] text-zinc-500">already open</span>
                ) : (
                  row.note && <span className={`ml-auto shrink-0 text-[10px] ${row.info.problem ? 'text-err' : 'text-zinc-600'}`}>{row.note}</span>
                )}
              </button>
            ))}
            <MenuSeparator />
            {asking ? (
              <div className="px-2 py-1.5" data-new-plugin-field>
                <input
                  autoFocus
                  value={request}
                  disabled={busy}
                  onChange={(e) => {
                    setRequest(e.target.value)
                    setError('')
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      submit()
                    } else if (e.key === 'Escape') {
                      e.preventDefault()
                      e.stopPropagation()
                      setAsking(false)
                    }
                  }}
                  placeholder="What should the plugin do?"
                  aria-label="What should the plugin do?"
                  className="h-7 w-full rounded border border-accent bg-sunken px-2 text-[12.5px] text-ink outline-none placeholder:text-ink-4"
                />
                <div className="mt-1 text-[11px] leading-snug text-ink-3">
                  {busy ? 'Starting an agent…' : error ? <span className="text-err">{error}</span> : m.pluginAgent ? 'Enter starts an agent that writes it into .sspace/plugins' : 'No agent to start. Turn one on in Settings.'}
                </div>
              </div>
            ) : (
              <button className={menuItemClass} disabled={!m.targetPath || !m.pluginAgent} onClick={() => setAsking(true)} title="Describe a plugin and an agent writes it for this project" data-new-plugin>
                <Plus className="h-3.5 w-3.5 shrink-0" strokeWidth={2} />
                New plugin…
              </button>
            )}
          </div>
        </AnchoredLayer>
      )}
    </div>
  )
}
