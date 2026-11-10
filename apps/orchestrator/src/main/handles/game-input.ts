import type { GiAction, GiScheme } from '@shared/game-input'
import { describeControl, resolveControls, type RcEffective } from '@shared/remote-controls'
import { unityProvider } from '../unity/unity-instance-provider'
import { fetchScheme, gameInput } from '../remote-video/game-input'
import { editorCommand, effectiveFor, generatedPath, overridesPath, readControlFiles } from '../remote-video/remote-controls-files'
import { remoteVideo } from '../remote-video'
import { defineHandle, type HandleCtx } from './registry'
import { needPrimary } from './unity'

function line(a: GiAction): string {
  const binds = a.bindings
    .map((b) => {
      if (!b.dev && b.composite) return `${b.composite}:`
      const target = b.key ? `key ${b.key}` : b.dev && b.ctl ? `${b.dev}/${b.ctl}` : b.dev || '?'
      const extra = [b.groups && `groups=${b.groups}`, b.interactions && `int=${b.interactions}`, b.processors && `proc=${b.processors}`].filter(Boolean).join(' ')
      return `${b.part ? `${b.part}=` : ''}${b.path} -> ${target}${extra ? ` (${extra})` : ''}`
    })
    .join(' | ')
  const extra = [a.interactions && `int=${a.interactions}`, a.processors && `proc=${a.processors}`].filter(Boolean).join(' ')
  return `${a.enabled ? 'ON ' : 'off'} ${a.name} ${a.type}/${a.control || '-'}${extra ? ` ${extra}` : ''}: ${binds}`
}

function summary(s: GiScheme): Record<string, unknown> {
  return {
    playing: s.playing,
    paused: s.paused,
    sig: s.sig,
    enabledCount: s.enabledCount,
    assets: s.assets.map((a) => ({
      name: a.name,
      path: a.path,
      sources: a.sources,
      schemes: a.schemes.map((c) => `${c.name} [${c.group}] ${c.devices.join(' ')}`),
      maps: a.maps.map((m) => ({ map: `${m.enabled ? 'ON ' : 'off'} ${m.name}`, actions: m.actions.map(line) }))
    })),
    players: s.players.map((p) => `${p.obj} asset=${p.asset} map=${p.map} scheme=${p.scheme || '-'} default=${p.defaultScheme || '-'} autoSwitch=${p.autoSwitch} ${p.behavior}${p.active ? '' : ' inactive'}`),
    loose: s.loose.map(line)
  }
}

defineHandle({
  name: 'unity.input.scheme',
  side: 'main',
  description:
    "Reads the game's Input System scheme from a running editor, the same report the phone controls are built from: project-wide actions, every .inputactions asset, PlayerInput assets and maps in loaded scenes, runtime copies (generated C# wrappers, PlayerInput clones) and loose enabled actions. Per action: map, type, expected control, enabled now, bindings with paths, the key or device control each resolves to, composites, groups, interactions and processors. world: a world id (a clone's, say) instead of the project's primary. full: true returns the raw report.",
  params: { world: '', full: false },
  async run(p, ctx) {
    const world = String(p.world || '') || needPrimary(ctx).id
    const r = await fetchScheme(world)
    if (!r.scheme) throw new Error(r.error ?? 'no scheme')
    return p.full ? r.scheme : { world, ...summary(r.scheme) }
  }
})

defineHandle({
  name: 'remote.gameInput',
  side: 'main',
  released: true,
  description:
    "Reads the phone game-input link on the Mac: whether the phone's input channels are open, which world the input goes to (the one the phone is showing), the phone sender id, what it holds right now (keys, mouse buttons, gamepad buttons), message counts on the reliable and fast channels, releases done for it (disconnect, panel change, silence), the scheme watch and the overrides file. source: a world id (a clone's, say) makes the phone's video session stream that world and send input there, a dev check for routing until the phone can pick players itself; the phone's next panel change resets it.",
  params: { source: '' },
  async run(p) {
    if (p.source) {
      const now = remoteVideo.devSource(String(p.source))
      if (now == null) throw new Error('No phone video session is open.')
      await new Promise((r) => setTimeout(r, 600))
    }
    const st = gameInput.status()
    const world = typeof st.source === 'string' ? st.source : null
    return { ...st, cursor: world ? unityProvider.cursorStateOf(world) : null }
  }
})

function target(p: Record<string, unknown>, ctx: HandleCtx): { world: string; project: string } {
  const world = String(p.world || '') || needPrimary(ctx).id
  const ctl = unityProvider.worldControl(world)
  if (!ctl) throw new Error(`No editor world ${world}`)
  return { world, project: ctl.realProjectPath }
}

async function moduleState(world: string): Promise<boolean> {
  const r = await fetchScheme(world).catch(() => ({ scheme: null }))
  return !!r.scheme?.gamepadModule
}

function brief(eff: RcEffective, full: boolean): Record<string, unknown> {
  if (full) return eff as unknown as Record<string, unknown>
  return {
    ok: eff.ok,
    defaultMap: eff.maps.find((m) => m.id === eff.defaultMap)?.name ?? eff.defaultMap,
    defaultMapReason: eff.defaultMapReason,
    gamepadModule: eff.gamepadModule,
    trackpad: eff.trackpad,
    maps: eff.maps.map((m) => ({ map: `${m.name}${m.ui ? ' (UI)' : ''}${m.id === eff.defaultMap ? ' (default)' : ''} ${m.id}`, asset: m.asset, controls: m.controls.map((c) => `${c.id} ${describeControl(c)}`) })),
    issues: eff.issues.map((i) => `${i.level} ${i.where}: ${i.message}`)
  }
}

defineHandle({
  name: 'remote.controls',
  side: 'main',
  released: true,
  description:
    "Reads the phone game controls of the project: the generated layout (ProjectSettings/SaturaRemote/controls.generated.json, rewritten by the editor from the Input System assets on every import), the agent's overrides (controls.overrides.json next to it) and the effective layout the phone shows, with every stale or invalid override listed in issues. Per control: action id, path, kind (stick, axis, button, pointer), what it presses, behavior and which fields an override changed. world: a world id instead of the project's primary. full: true returns the whole effective layout and both files.",
  params: { world: '', full: false },
  async run(p, ctx) {
    const { world, project } = target(p, ctx)
    const module = await moduleState(world)
    const eff = effectiveFor(project, module)
    const files = readControlFiles(project)
    return {
      world,
      files: { generated: generatedPath(project), overrides: overridesPath(project), overridesExists: files.overridesText != null },
      ...brief(eff, !!p.full),
      ...(p.full ? { generatedFile: files.generated, overridesFile: files.overrides } : {})
    }
  }
})

defineHandle({
  name: 'remote.controls.validate',
  side: 'main',
  released: true,
  description:
    'Checks a phone controls overrides object against the generated layout without writing anything: returns the issues (stale action or binding ids, bad keys, bad placements, gamepad outputs without the module) and the effective layout it would give. overrides: the object to check; leave it out to check controls.overrides.json on disk. Write the file yourself once it has no issues.',
  params: { world: '', overrides: null, full: false },
  async run(p, ctx) {
    const { world, project } = target(p, ctx)
    const module = await moduleState(world)
    const files = readControlFiles(project)
    const candidate = p.overrides === null || p.overrides === undefined ? undefined : p.overrides
    const eff = candidate === undefined ? effectiveFor(project, module) : resolveControls(files.generated, candidate, { gamepadModule: module })
    return { world, checked: candidate === undefined ? overridesPath(project) : 'the overrides param', valid: !eff.issues.some((i) => i.level !== 'warn'), ...brief(eff, !!p.full) }
  }
})

defineHandle({
  name: 'remote.controls.regenerate',
  side: 'main',
  released: true,
  description:
    "Has the editor rewrite ProjectSettings/SaturaRemote/controls.generated.json from the project's Input System assets now (it also does this on every .inputactions import and on load), then returns what changed and the effective layout with the overrides applied, so stale overrides show up right away.",
  params: { world: '' },
  async run(p, ctx) {
    const { world, project } = target(p, ctx)
    const r = await editorCommand(world, 'input/generate', {})
    const eff = effectiveFor(project, r.gamepadModule === true)
    ctx.log(`[remote-controls] regenerate ${project}: ${String(r.state)} ${String(r.summary)}`)
    return { world, file: r.path, state: r.state, changed: r.changed, summary: r.summary, ...brief(eff, false) }
  }
})

defineHandle({
  name: 'remote.controls.gamepadModule',
  side: 'main',
  released: true,
  description:
    "Turns the Satura Remote gamepad module on or off in the project: the scripting define SATURA_REMOTE_GAMEPAD (Standalone and the active build target) that compiles the engine's SaturaSpace.Sdk.RemoteGamepad assembly, a virtual gamepad the phone drives. Only then can controls.overrides.json switch a control or the whole layout to drive \"gamepad\". on: true or false; leave it out to only read the state. Scripts recompile after a change; save the project to keep the define.",
  params: { world: '', on: null },
  async run(p, ctx) {
    const { world } = target(p, ctx)
    const args = p.on === true || p.on === false ? { on: p.on } : {}
    const r = await editorCommand(world, 'input/gamepadModule', args)
    return { world, present: r.present, changed: r.changed, defines: r.defines, engineHasModule: r.asmdef, note: r.changed ? 'Scripts recompile now; present turns true after the domain reload: await unity.refresh(), then remote.controls.' : undefined }
  }
})
