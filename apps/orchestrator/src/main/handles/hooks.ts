import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { hookHome } from '../agent-hooks/installer-shared'
import { installClaudeHooks, uninstallClaudeHooks } from '../agent-hooks/installer'
import { installCursorHooks, uninstallCursorHooks } from '../agent-hooks/cursor-installer'
import { installGrokHooks, uninstallGrokHooks } from '../agent-hooks/grok-installer'
import { installKimiHooks, uninstallKimiHooks } from '../agent-hooks/kimi-installer'
import { syncCodexMcpConfig } from '../unity/unity-instance-provider'
import { defineHandle } from './registry'
import { applyLayout, jailed, scratchFor, treeOf, type TreeEntry } from './scratch'

type Home = ReturnType<typeof hookHome>

const AGENTS: Record<string, { dir: string; install: (h: Home) => unknown; uninstall: (h: Home) => unknown }> = {
  claude: { dir: '.claude', install: installClaudeHooks, uninstall: uninstallClaudeHooks },
  cursor: { dir: '.cursor', install: installCursorHooks, uninstall: uninstallCursorHooks },
  grok: { dir: '.grok', install: installGrokHooks, uninstall: (h) => (uninstallGrokHooks(h), 'removed') },
  kimi: { dir: '.kimi-code', install: installKimiHooks, uninstall: uninstallKimiHooks },
  codex: { dir: '.codex', install: (h) => syncCodexMcpConfig(join(h.home, '.codex')), uninstall: () => 'codex has no uninstall: the app only writes its MCP server entry' }
}

function snapshot(root: string): Map<string, string> {
  const out = new Map<string, string>()
  for (const e of treeOf(root)) out.set(e.path, e.kind === 'file' ? `f:${e.text ?? e.base64 ?? ''}:${e.mode}` : e.kind === 'link' ? `l:${e.link}` : e.kind)
  return out
}

function changes(before: Map<string, string>, after: Map<string, string>): { added: string[]; changed: string[]; removed: string[] } {
  const added: string[] = []
  const changed: string[] = []
  const removed: string[] = []
  for (const [k, v] of after) {
    if (!before.has(k)) added.push(k)
    else if (before.get(k) !== v) changed.push(k)
  }
  for (const k of before.keys()) if (!after.has(k)) removed.push(k)
  return { added, changed, removed }
}

defineHandle({
  name: 'hooks.install',
  side: 'main',
  agentOnly: true,
  description:
    "Runs the app's agent hook installers against a throwaway HOME in a scratch dir, never your real one: claude (~/.claude/settings.json hooks and statusLine), cursor (~/.cursor/hooks.json), grok (~/.grok/hooks/satura-status.json), kimi (~/.kimi-code/config.toml [[hooks]] block) and codex (~/.codex/config.toml MCP server entry), plus the hook scripts in ~/.satura/agent-hooks. action is install or uninstall, agents picks which (default all). home: '' makes a new HOME, home: <root> reuses one from an earlier call, so install, edit the seed and install again or uninstall in later steps. seed writes files into HOME first (relative paths, text or {json}), like an existing settings.json with your own hooks, broken JSON or a kimi config that already has a hooks key. present: true creates each picked agent's config folder so its installer doesn't skip it. Returns home, per agent the installer's result (written, unchanged, skipped, failed) or its error, what changed in HOME (added, changed, removed paths, backups included), and the files with their contents (under: limits the tree to a subfolder). The installers' own [agent-hooks] log lines are in logs.",
  params: { home: '', action: 'install', agents: ['claude', 'cursor', 'grok', 'kimi', 'codex'], seed: {}, present: true, under: '', keep: false },
  async run(p, ctx) {
    const s = scratchFor({ root: p.home, keep: p.keep }, ctx, 'hooks HOME')
    const home = jailed(s.root, 'home')
    const action = p.action === 'uninstall' ? 'uninstall' : 'install'
    const picked = (Array.isArray(p.agents) && p.agents.length ? p.agents.map(String) : Object.keys(AGENTS)).map((a) => a.toLowerCase())
    const unknown = picked.filter((a) => !AGENTS[a])
    if (unknown.length) throw new Error(`Unknown agent ${unknown.join(', ')}. Pick from ${Object.keys(AGENTS).join(', ')}.`)
    if (p.seed && typeof p.seed === 'object') applyLayout(home, { files: p.seed })
    if (p.present !== false) for (const a of picked) mkdirSync(join(home, AGENTS[a].dir), { recursive: true })
    const h = hookHome(home)
    const before = snapshot(home)
    const results: Record<string, unknown> = {}
    for (const a of picked) {
      try {
        results[a] = AGENTS[a][action](h)
        ctx.log(`${action} ${a}: ${String(results[a])}`)
      } catch (e) {
        results[a] = { error: (e as Error).message }
        ctx.log(`${action} ${a} threw ${(e as Error).message}`)
      }
    }
    const after = snapshot(home)
    const under = String(p.under ?? '').trim()
    const files: TreeEntry[] = treeOf(home, under ? { under } : {})
    return { id: s.id, home, action, results, ...changes(before, after), files }
  }
})
