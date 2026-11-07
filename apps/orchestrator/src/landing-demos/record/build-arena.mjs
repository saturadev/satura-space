import { readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FIXTURES, scrubPersonal } from './tap.mjs'
import { MeshoptEncoder } from './vendor/meshopt_encoder.mjs'

const FOCUS = 'landing-focus'
const RAW = process.argv[2] || process.env.LANDING_RAW || join(tmpdir(), 'landing-arena-raw.json')
const raw = JSON.parse(readFileSync(RAW, 'utf8'))
const calls = raw.tap.calls
const call = (ch, pred = () => true) => calls.find((c) => c.ch === ch && pred(c))
const start = call('tuner:start', (c) => c.result?.ok && c.args[0]?.view !== FOCUS)

const DROP_SECTIONS = new Set(['Material', 'preview', 'UniversalAdditionalCameraData', 'UniversalAdditionalLightData'])
const stylePool = []
const styleKey = new Map()
const texPool = []
const texKey = new Map()
const pool = (list, keys, body) => {
  const k = JSON.stringify(body)
  let i = keys.get(k)
  if (i == null) {
    i = list.length
    list.push(body)
    keys.set(k, i)
  }
  return i
}

function dropped(cap) {
  return (cap?.sections ?? []).filter((s) => s.kind === 'component' && DROP_SECTIONS.has(s.key)).length
}

function packCapture(base, full, hidden = Math.max(dropped(base), dropped(full))) {
  const styles = new Map()
  for (const s of [...(base.styles ?? []), ...(full.styles ?? [])]) styles.set(s.id, s)
  const textures = new Map()
  for (const t of [...(base.textures ?? []), ...(full.textures ?? [])]) textures.set(t.id, t)
  const prev = new Map(base.sections.map((s) => [s.key, s]))
  const sections = full.sections.filter((s) => !DROP_SECTIONS.has(s.key)).map((s) => (s.same && prev.get(s.key) ? prev.get(s.key) : s))
  const { styles: _s, textures: _t, session: _x, focus: _f, popups: _p, ...rest } = full
  const c = rest.target?.components
  const shown = sections.filter((x) => x.kind === 'component').length
  if (c) rest.target = { ...rest.target, components: { shown, total: Math.max(shown, c.total - hidden) } }
  return {
    ...rest,
    sections,
    styleRefs: [...styles.values()].map(({ id, ...body }) => [id, pool(stylePool, styleKey, body)]),
    texRefs: [...textures.values()].map(({ id, ...body }) => [id, pool(texPool, texKey, body)])
  }
}

const captures = {}
for (const [path, base] of Object.entries(raw.captures)) captures[path] = packCapture(base, raw.expanded?.[path] ?? base)
const focusStart = calls.find((c) => c.ch === 'tuner:start' && c.args[0]?.view === FOCUS && c.result?.ok)
const focus = raw.focusView && focusStart ? { view: { name: FOCUS, assets: [], buttons: [], updatedAt: 0, ...raw.focusView }, start: focusStart.result, captures: Object.fromEntries(Object.entries(raw.focusCaptures ?? {}).map(([p, c]) => [p, packCapture(c, c, Math.max(dropped(raw.captures[p]), dropped(raw.expanded?.[p])))])) } : null

const objects = {}
for (const s of raw.tap.sends) {
  const a = s.args[0]
  if (s.ch !== 'tuner:live' || !a) continue
  for (const o of [a.object, ...(a.objects ?? [])]) if (o && !objects[o.id]) objects[o.id] = o
}
const animator = raw.tap.sends.filter((s) => s.ch === 'tuner:live' && s.args[0]?.animator !== undefined).map((s) => s.args[0].animator)
const particles = raw.tap.sends.find((s) => s.ch === 'tuner:live' && s.args[0]?.particles)?.args[0].particles ?? null

const KEEP_FIELD = /^(InitialModule|EmissionModule|ShapeModule|ColorModule|SizeModule|VelocityModule|ClampVelocityModule|ForceModule|RotationModule|NoiseModule)\.|^(lengthInSec|looping|prewarm|simulationSpeed|moveWithTransform|m_RenderMode|m_LengthScale|m_VelocityScale|m_Enabled)$/
const scene = structuredClone(raw.scene)
for (const o of scene.objects) {
  o.fields = o.fields.filter((f) => {
    if (f.component !== 'ParticleSystem' && f.component !== 'ParticleSystemRenderer') return true
    if (!KEEP_FIELD.test(f.path)) return false
    return !/\.(minCurve|maxCurve|minGradient|maxGradient)\.|\.m_Curve|m_NumColorKeys|m_NumAlphaKeys|key\d|ctime|atime/.test(f.path) || /(SizeModule\.curve\.maxCurve|ColorModule\.gradient\.maxGradient)$/.test(f.path)
  })
}

const b64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString('base64')
await MeshoptEncoder.ready
for (const [name, m] of Object.entries(scene.meshes)) {
  const nv = m.v.length / 3
  if (nv < 2000 || nv > 65535) continue
  const lo = [0, 1, 2].map((k) => Math.min(...m.v.filter((_, i) => i % 3 === k)))
  const hi = [0, 1, 2].map((k) => Math.max(...m.v.filter((_, i) => i % 3 === k)))
  const idx = Uint32Array.from(m.t)
  const [remap, n] = MeshoptEncoder.reorderMesh(idx, true, true)
  const v = new Uint16Array(n * 4)
  for (let i = 0; i < nv; i++) {
    if (remap[i] === 0xffffffff) continue
    for (let k = 0; k < 3; k++) v[remap[i] * 4 + k] = Math.round(((m.v[i * 3 + k] - lo[k]) / (hi[k] - lo[k] || 1)) * 65535)
  }
  const p = MeshoptEncoder.encodeVertexBuffer(new Uint8Array(v.buffer), n, 8)
  const t = MeshoptEncoder.encodeIndexBuffer(new Uint8Array(idx.buffer), idx.length, 4)
  scene.meshes[name] = { q: [...lo, ...hi], n, c: idx.length, p: b64(p), i: b64(t) }
}

const out = {
  recordedAt: raw.recordedAt,
  root: raw.project,
  session: start.args[0].session ?? raw.session,
  inspectorWidth: raw.inspectorWidth,
  listViews: call('tuner:listViews').result,
  start: start.result,
  world: call('unity:getWorld')?.result ?? null,
  objects,
  animator,
  particles,
  captures,
  styles: stylePool,
  textures: texPool,
  scene,
  focus,
  templates: Object.fromEntries(Object.entries(raw.templates ?? {}).map(([k, c]) => [k, packCapture(c.base, c.full, 0)]))
}
const json = scrubPersonal(JSON.stringify(out))
writeFileSync(join(FIXTURES, 'arena.json'), json)
console.log(`arena.json ${json.length} bytes, ${Object.keys(captures).length} captures, ${stylePool.length} styles, ${texPool.length} textures, ${animator.length} animator updates, focus ${focus ? Object.keys(focus.captures).join('+') : 'none'}, templates ${Object.keys(out.templates).join(' ')}`)
