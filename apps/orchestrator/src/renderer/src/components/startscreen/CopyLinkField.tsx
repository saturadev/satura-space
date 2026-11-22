import type { NewProjectKind, UnityEditorForCreate } from '@shared/api'
import type { AgentId } from '@shared/types'
import { getAgentLabel } from '@shared/agent-catalog'
import { AgentIcon } from '../../lib/agent-icon'
import { AgentModelEffort, agentHasModelEffort } from '../AgentModelEffort'

const CHANNEL_RANK: Record<string, number> = { f: 3, p: 2, b: 1, a: 0 }

function versionKey(v: string): number[] {
  const m = /^(\d+)\.(\d+)\.(\d+)([a-z])(\d+)/.exec(v)
  if (!m) return [0, 0, 0, -1, 0]
  return [Number(m[1]), Number(m[2]), Number(m[3]), CHANNEL_RANK[m[4]] ?? -1, Number(m[5])]
}

export function latestEditorFor(editors: UnityEditorForCreate[] | null, kind: NewProjectKind): string {
  const usable = (editors ?? []).filter((e) => e.kinds.includes(kind))
  usable.sort((a, b) => {
    const ka = versionKey(a.version)
    const kb = versionKey(b.version)
    for (let i = 0; i < ka.length; i += 1) if (ka[i] !== kb[i]) return kb[i] - ka[i]
    return 0
  })
  return usable[0]?.version ?? ''
}

export function CopyLinkField({
  value,
  onChange,
  problem,
  ready,
  agents,
  agent,
  onAgent
}: {
  value: string
  onChange: (v: string) => void
  problem: string | null
  ready: 'loading' | 'none' | 'ready'
  agents: AgentId[]
  agent: AgentId | null
  onAgent: (id: AgentId) => void
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-2 pb-1 pt-3">
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
        autoFocus
        placeholder="Paste a TikTok, Reels, Shorts or X link"
        title="Link to a short video: TikTok, Instagram Reels, YouTube Shorts, X, or any video page"
        className={`h-[44px] w-full rounded-lg border bg-canvas px-3 font-mono text-[15px] font-medium text-ink outline-none transition-colors placeholder:text-ink-4 ${
          problem ? 'border-rose-400/60' : 'border-transparent hover:border-accent/50 focus:border-accent/70'
        }`}
      />
      {agents.length > 0 && (
        <div className="flex flex-wrap items-center justify-center gap-2 pt-1">
          <span className="text-xs text-ink-3">Agent</span>
          {agents.map((id) => (
            <button
              key={id}
              onClick={() => onAgent(id)}
              aria-pressed={id === agent}
              className={`flex h-9 items-center gap-2 rounded-full border px-3.5 text-[13px] font-semibold transition-colors ${
                id === agent ? 'border-accent/70 bg-accent/15 text-ink' : 'border-transparent bg-canvas text-ink-2 hover:text-ink'
              }`}
            >
              <AgentIcon id={id} className="h-4 w-4" />
              {getAgentLabel(id)}
            </button>
          ))}
        </div>
      )}
      {agent && agentHasModelEffort(agent) && (
        <div className="w-full rounded-md bg-canvas p-3">
          <AgentModelEffort id={agent} />
        </div>
      )}
      <div className="flex min-h-[18px] max-w-full items-center justify-center gap-1.5 text-[11px]">
        {problem ? (
          <>
            <span className="whitespace-pre-wrap text-center leading-snug text-rose-300">{problem}</span>
            {problem.includes('nodejs.org') && (
              <button
                onClick={() => void window.api.shell.openExternal('https://nodejs.org')}
                className="shrink-0 rounded-md bg-panel px-2 py-1 text-[11px] font-medium text-ink-2 transition-colors hover:bg-elevated hover:text-ink"
              >
                Get Node.js
              </button>
            )}
          </>
        ) : ready === 'ready' ? (
          <span className="text-ink-3">Creates a new Unity project with the clip and starts your agent on a game that plays like it.</span>
        ) : ready === 'none' ? (
          <span className="text-rose-300">No Unity editor is installed. Install one in Unity Hub first.</span>
        ) : (
          <span className="text-ink-3">Looking for an installed Unity…</span>
        )}
      </div>
    </div>
  )
}
