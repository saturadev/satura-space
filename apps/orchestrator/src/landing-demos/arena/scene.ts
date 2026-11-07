import {
  AmbientLight,
  BackSide,
  Box3,
  BufferAttribute,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  DirectionalLight,
  Fog,
  Group,
  HemisphereLight,
  type Light,
  LineBasicMaterial,
  LineSegments,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  OrthographicCamera,
  PCFShadowMap,
  PerspectiveCamera,
  PlaneGeometry,
  PointLight,
  Quaternion,
  Raycaster,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  SpotLight,
  SRGBColorSpace,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget
} from 'three'
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js'
import type { Quat, TunerBounds, TunerCamera, TunerMember, TunerPose, Vec3 } from '@shared/tuner'
import { threePosToUnity, threeRotToUnity, unityPosToThree, unityRotToThree } from '@renderer/lib/tuner/space'
import { colliderHandles, colliderLines, project, type ColliderState, type Handle } from './colliders'
import { ParticleEmitter, type PsParams } from './particles'
import type { ExportField } from './inspector'

export interface SceneObjectData {
  path: string
  name: string
  active: boolean
  static?: boolean
  lp: Vec3
  lr: Quat
  ls: Vec3
  euler: Vec3
  mesh?: string
  material?: string
  color?: [number, number, number, number]
  smooth?: number
  metal?: number
  emission?: [number, number, number, number]
  shadows?: number
  light?: { type: string; color: [number, number, number, number]; intensity: number; range: number; spotAngle: number; shadows: string }
  camera?: { fov: number; bg?: [number, number, number, number] }
  rigidbody?: { mass: number; gravity: boolean; kinematic: boolean }
  colliders: ColliderState[]
  components: string[]
  fields: ExportField[]
}

type RawMesh = { v: number[]; n: number[]; t: number[] }
type PackedMesh = { q: number[]; n: number; c: number; p: string; i: string }

export interface SceneData {
  scene: string
  objects: SceneObjectData[]
  meshes: Record<string, RawMesh | PackedMesh>
  ambientSky: [number, number, number, number]
  ambientEquator: [number, number, number, number]
  ambientGround: [number, number, number, number]
}

export interface SimNode {
  id: string
  data: SceneObjectData
  parent: SimNode | null
  children: SimNode[]
  node: Object3D
  mesh: Mesh | null
  material: MeshStandardMaterial | null
  light: PointLight | DirectionalLight | SpotLight | null
  emitter: ParticleEmitter | null
  colliders: ColliderState[]
  active: boolean
  rendererOn: boolean
  lightOn: boolean
  meshName: string | null
}

const OUTLINE_VS = `varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`
const OUTLINE_FS = `
uniform sampler2D mask; uniform vec2 px; uniform vec3 colA; uniform vec3 colB; varying vec2 vUv;
void main() {
  vec4 c = texture2D(mask, vUv);
  float a = 0.0; float b = 0.0;
  for (int x = -2; x <= 2; x++) for (int y = -2; y <= 2; y++) {
    vec4 s = texture2D(mask, vUv + vec2(float(x), float(y)) * px);
    a = max(a, s.r); b = max(b, s.g);
  }
  float inside = max(c.r, c.g);
  float edgeA = a * (1.0 - inside);
  float edgeB = b * (1.0 - inside) * (1.0 - a);
  float alpha = max(edgeA, edgeB);
  if (alpha <= 0.0) discard;
  gl_FragColor = vec4(mix(colB, colA, step(0.5, edgeA)), alpha);
}`

const SKY_VS = `varying vec3 vDir; void main() { vDir = normalize((modelMatrix * vec4(position, 0.0)).xyz); gl_Position = projectionMatrix * viewMatrix * modelMatrix * vec4(position, 1.0); gl_Position.z = gl_Position.w; }`
const SKY_FS = `
varying vec3 vDir; uniform vec3 top; uniform vec3 horizon; uniform vec3 ground;
float h3(vec3 p) { p = fract(p * 0.3183099 + 0.1); p *= 17.0; return fract(p.x * p.y * p.z * (p.x + p.y + p.z)); }
float n3(vec3 x) {
  vec3 i = floor(x); vec3 f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(h3(i), h3(i + vec3(1, 0, 0)), f.x), mix(h3(i + vec3(0, 1, 0)), h3(i + vec3(1, 1, 0)), f.x), f.y),
             mix(mix(h3(i + vec3(0, 0, 1)), h3(i + vec3(1, 0, 1)), f.x), mix(h3(i + vec3(0, 1, 1)), h3(i + vec3(1, 1, 1)), f.x), f.y), f.z);
}
float fbm(vec3 p) { float a = 0.5; float s = 0.0; for (int i = 0; i < 5; i++) { s += a * n3(p); p *= 2.03; a *= 0.5; } return s; }
float stars(vec3 d, float scale, float thr) {
  vec3 p = d * scale; vec3 i = floor(p); vec3 f = fract(p) - 0.5;
  float r = h3(i); if (r < thr) return 0.0;
  vec3 o = vec3(h3(i + 11.0), h3(i + 23.0), h3(i + 37.0)) - 0.5;
  return smoothstep(0.16, 0.0, length(f - o * 0.6)) * (0.35 + 0.65 * (r - thr) / (1.0 - thr));
}
void main() {
  vec3 d = normalize(vDir);
  vec3 c = mix(ground, top, smoothstep(-0.7, 0.9, d.y));
  float band = exp(-pow((d.y * 0.85 + d.x * 0.4 - 0.18) * 2.2, 2.0));
  float n = fbm(d * 2.4 + vec3(3.1, 0.0, 1.7));
  float neb = smoothstep(0.42, 0.92, n) * band;
  c += neb * mix(vec3(0.07, 0.12, 0.34), vec3(0.3, 0.1, 0.36), fbm(d * 4.0 + 7.0));
  c += smoothstep(0.58, 1.0, fbm(d * 7.0 + 2.0)) * band * vec3(0.04, 0.1, 0.18);
  float s = stars(d, 220.0, 0.93) * 0.8 + stars(d, 110.0, 0.965) * 1.2 + stars(d, 48.0, 0.985) * 1.8;
  c += vec3(0.86, 0.9, 1.0) * s * (0.6 + 0.4 * band);
  gl_FragColor = vec4(c, 1.0);
}`

const GIZMO = new Color().setRGB(0.57, 0.96, 0.54, SRGBColorSpace)

await MeshoptDecoder.ready

function srgb(c: number[]): Color {
  return new Color().setRGB(c[0], c[1], c[2], SRGBColorSpace)
}

function bytes(b64: string): Uint8Array {
  const s = atob(b64)
  const u = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i)
  return u
}

function packedGeometry(m: PackedMesh): BufferGeometry {
  const g = new BufferGeometry()
  const v = new Uint16Array(m.n * 4)
  MeshoptDecoder.decodeVertexBuffer(new Uint8Array(v.buffer), m.n, 8, bytes(m.p))
  const t = new Uint16Array(m.c)
  MeshoptDecoder.decodeIndexBuffer(new Uint8Array(t.buffer), m.c, 2, bytes(m.i))
  const pos = new Float32Array(m.n * 3)
  for (let i = 0; i < pos.length; i++) {
    const k = i % 3
    const x = m.q[k] + (v[(i - k) / 3 * 4 + k] / 65535) * (m.q[k + 3] - m.q[k])
    pos[i] = k === 2 ? -x : x
  }
  const idx = new Uint16Array(t.length)
  for (let i = 0; i < t.length; i += 3) {
    idx[i] = t[i]
    idx[i + 1] = t[i + 2]
    idx[i + 2] = t[i + 1]
  }
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setIndex(new BufferAttribute(idx, 1))
  g.computeVertexNormals()
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

function geometryOf(m: RawMesh | PackedMesh): BufferGeometry {
  if ('p' in m) return packedGeometry(m)
  const g = new BufferGeometry()
  const pos = new Float32Array(m.v.length)
  const nor = new Float32Array(m.n.length)
  for (let i = 0; i < m.v.length; i += 3) {
    pos[i] = m.v[i]
    pos[i + 1] = m.v[i + 1]
    pos[i + 2] = -m.v[i + 2]
    nor[i] = m.n[i] ?? 0
    nor[i + 1] = m.n[i + 1] ?? 1
    nor[i + 2] = -(m.n[i + 2] ?? 0)
  }
  const idx = new Uint32Array(m.t.length)
  for (let i = 0; i < m.t.length; i += 3) {
    idx[i] = m.t[i]
    idx[i + 1] = m.t[i + 2]
    idx[i + 2] = m.t[i + 1]
  }
  g.setAttribute('position', new BufferAttribute(pos, 3))
  g.setAttribute('normal', new BufferAttribute(nor, 3))
  g.setIndex(new BufferAttribute(idx, 1))
  g.computeBoundingBox()
  g.computeBoundingSphere()
  return g
}

export interface HandleView {
  handles: Handle[]
  hot: number
  active: number
}

export class ArenaScene {
  readonly nodes = new Map<string, SimNode>()
  readonly byPath = new Map<string, SimNode>()
  readonly geos = new Map<string, BufferGeometry>()
  readonly materials = new Map<string, { color: number[]; smooth: number; metal: number; emission: number[] }>()
  private scene = new Scene()
  private maskScene = new Scene()
  private wireScene = new Scene()
  private wireMat = new MeshBasicMaterial({ color: 0x5e8bd6, wireframe: true, transparent: true, opacity: 0.55, depthWrite: false })
  selectionOutline = true
  selectionWire = false
  private root = new Group()
  private renderer: WebGLRenderer | null = null
  private canvas: HTMLCanvasElement | null = null
  private camera = new PerspectiveCamera(60, 1, 0.03, 4000)
  private ortho = new OrthographicCamera(-1, 1, 1, -1, -2000, 2000)
  private mask: WebGLRenderTarget | null = null
  private outline: ShaderMaterial
  private outlineScene = new Scene()
  private outlineCam = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  private gizmo: LineSegments
  private gizmoHidden: LineSegments
  private maskA = new MeshBasicMaterial({ color: 0xff0000 })
  private maskB = new MeshBasicMaterial({ color: 0x00ff00 })
  private ray = new Raycaster()
  private sun: DirectionalLight | null = null
  lastCamera: PerspectiveCamera | OrthographicCamera | null = null
  showGizmos = true
  showLighting = true
  effects = { skybox: true, fog: true, particles: true }
  private skyMesh: Mesh | null = null
  private fogOn: Fog | null = null
  private grid: LineSegments | null = null
  private ambient: Light[] = []
  private flat = new HemisphereLight(0xffffff, 0x9a9a9a, 3)
  private sky: ShaderMaterial | null = null
  private focus: Set<string> | null = null
  private focusHide = false
  private ghost = 0
  private ghostShown = -1

  constructor(data: SceneData, members: TunerMember[]) {
    for (const [name, m] of Object.entries(data.meshes)) this.geos.set(name, geometryOf(m))
    const plane = new PlaneGeometry(10, 10)
    plane.rotateX(-Math.PI / 2)
    this.geos.set('Plane', plane)
    const quad = new PlaneGeometry(1, 1)
    quad.rotateY(Math.PI)
    this.geos.set('Quad', quad)
    if (!this.geos.has('Sphere')) this.geos.set('Sphere', new SphereGeometry(0.5, 24, 16))
    if (!this.geos.has('Capsule')) this.geos.set('Capsule', new CapsuleGeometry(0.5, 1, 8, 24))
    const pathOf = (m: TunerMember): string => {
      const parts = [m.name]
      for (let p = members.find((x) => x.id === m.parent); p; p = members.find((x) => x.id === p!.parent)) parts.unshift(p.name)
      return parts.join('/')
    }
    const idByPath = new Map(members.map((m) => [pathOf(m), m.id]))
    for (const d of data.objects) {
      if (d.material && d.color) this.materials.set(d.material, { color: d.color, smooth: d.smooth ?? 0.5, metal: d.metal ?? 0, emission: d.emission ?? [0, 0, 0, 1] })
    }
    for (const d of data.objects) {
      const n = this.make(d, idByPath.get(d.path) ?? `x:${d.path}`)
      this.nodes.set(n.id, n)
      this.byPath.set(d.path, n)
    }
    for (const n of this.nodes.values()) {
      const slash = n.data.path.lastIndexOf('/')
      const parent = slash > 0 ? (this.byPath.get(n.data.path.slice(0, slash)) ?? null) : null
      n.parent = parent
      if (parent) {
        parent.children.push(n)
        parent.node.add(n.node)
      } else this.root.add(n.node)
      this.applyLocal(n, n.data.lp, n.data.lr, n.data.ls)
    }
    this.root.updateMatrixWorld(true)
    for (const n of this.nodes.values()) this.aimSun(n)
    const amb = data.ambientSky
    this.ambient = [new HemisphereLight(srgb(amb), srgb(data.ambientGround), 2.2), new AmbientLight(srgb(data.ambientEquator), 0.9)]
    for (const l of this.ambient) this.scene.add(l)
    this.flat.visible = false
    this.scene.add(this.flat)
    const bg = data.objects.find((o) => o.camera?.bg)?.camera?.bg ?? [0.58, 0.63, 0.69, 1]
    const bgc = srgb(bg)
    this.fogOn = new Fog(bgc, 40, 90)
    this.scene.fog = this.fogOn
    this.scene.add(this.root)
    const sky = new ShaderMaterial({
      vertexShader: SKY_VS,
      fragmentShader: SKY_FS,
      side: BackSide,
      depthWrite: false,
      uniforms: {
        top: { value: bgc.clone().multiplyScalar(2.2) },
        horizon: { value: bgc.clone() },
        ground: { value: bgc.clone().multiplyScalar(0.5) }
      }
    })
    this.sky = sky
    const skyMesh = new Mesh(new SphereGeometry(1000, 32, 16), sky)
    skyMesh.renderOrder = -10
    this.skyMesh = skyMesh
    this.scene.add(skyMesh)
    const gp: number[] = []
    const R = 40
    for (let i = -R; i <= R; i++) gp.push(i, 0.003, -R, i, 0.003, R, -R, 0.003, i, R, 0.003, i)
    const gg = new BufferGeometry()
    gg.setAttribute('position', new BufferAttribute(new Float32Array(gp), 3))
    const grid = new LineSegments(gg, new LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.05, depthWrite: false }))
    this.grid = grid
    this.scene.add(grid)
    this.gizmo = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: GIZMO, transparent: true, opacity: 0.95, depthWrite: false }))
    this.gizmo.renderOrder = 20
    this.gizmo.frustumCulled = false
    this.gizmoHidden = new LineSegments(this.gizmo.geometry, new LineBasicMaterial({ color: GIZMO, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false }))
    this.gizmoHidden.renderOrder = 21
    this.gizmoHidden.frustumCulled = false
    this.scene.add(this.gizmo)
    this.scene.add(this.gizmoHidden)
    this.outline = new ShaderMaterial({
      vertexShader: OUTLINE_VS,
      fragmentShader: OUTLINE_FS,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      uniforms: { mask: { value: null }, px: { value: new Vector2(1, 1) }, colA: { value: new Color(1, 0.6, 0.1) }, colB: { value: new Color(0.3, 0.45, 0.7) } }
    })
    this.outlineScene.add(new Mesh(new PlaneGeometry(2, 2), this.outline))
  }

  make(d: SceneObjectData, id: string): SimNode {
    const node = new Object3D()
    node.name = d.path
    let mesh: Mesh | null = null
    let material: MeshStandardMaterial | null = null
    if (d.mesh && this.geos.has(d.mesh)) {
      material = new MeshStandardMaterial()
      this.paint(material, d.material ?? '')
      mesh = new Mesh(this.geos.get(d.mesh)!, material)
      mesh.userData.id = id
      mesh.castShadow = (d.shadows ?? 1) !== 0
      mesh.receiveShadow = true
      node.add(mesh)
    }
    const light = d.light ? this.makeLight(node, d.light.type, { color: srgb(d.light.color), intensity: d.light.intensity, range: d.light.range, angle: d.light.spotAngle, shadows: d.light.shadows !== 'None' }) : null
    return {
      id,
      data: d,
      parent: null,
      children: [],
      node,
      mesh,
      material,
      light,
      emitter: null,
      colliders: structuredClone(d.colliders ?? []),
      active: d.active,
      rendererOn: true,
      lightOn: true,
      meshName: d.mesh ?? null
    }
  }

  private makeLight(node: Object3D, type: string, o: { color: Color; intensity: number; range: number; angle: number; shadows: boolean }): PointLight | DirectionalLight | SpotLight | null {
    if (type === 'Directional') {
      const dl = new DirectionalLight(o.color, o.intensity * 2.2)
      dl.castShadow = o.shadows
      dl.shadow.mapSize.set(2048, 2048)
      dl.shadow.camera.left = -14
      dl.shadow.camera.right = 14
      dl.shadow.camera.top = 14
      dl.shadow.camera.bottom = -14
      dl.shadow.camera.near = 1
      dl.shadow.camera.far = 120
      dl.shadow.bias = -0.0004
      dl.shadow.normalBias = 0.02
      dl.shadow.radius = 3
      this.sun = dl
      this.scene.add(dl)
      this.scene.add(dl.target)
      return dl
    }
    if (type === 'Spot') {
      const sl = new SpotLight(o.color, o.intensity * 2.5, o.range, (Math.max(1, o.angle || 30) * Math.PI) / 360, 0.25, 1.6)
      sl.target.position.set(0, 0, -1)
      node.add(sl)
      node.add(sl.target)
      return sl
    }
    if (type === 'Point') {
      const pl = new PointLight(o.color, o.intensity * 2.5, o.range, 1.6)
      node.add(pl)
      return pl
    }
    return null
  }

  aimSun(n: SimNode): void {
    if (!(n.light instanceof DirectionalLight)) return
    n.node.updateMatrixWorld(true)
    const fwd = new Vector3(0, 0, -1).applyQuaternion(n.node.getWorldQuaternion(new Quaternion()))
    n.light.position.copy(fwd.multiplyScalar(-40))
    n.light.target.position.set(0, 0, 0)
  }

  setLight(n: SimNode, type: string, o: { color: Color; intensity: number; range: number; angle: number; shadows: boolean }): void {
    const old = n.light
    if (old) {
      old.removeFromParent()
      if (old instanceof DirectionalLight || old instanceof SpotLight) old.target.removeFromParent()
      if (old === this.sun) this.sun = null
      old.dispose()
    }
    n.light = this.makeLight(n.node, type, o)
    if (n.light) n.light.visible = n.lightOn
    this.aimSun(n)
  }

  attach(n: SimNode, parent: SimNode | null, index = -1): void {
    this.detach(n)
    n.parent = parent
    const list = parent ? parent.children : null
    if (list) {
      if (index >= 0 && index < list.length) list.splice(index, 0, n)
      else list.push(n)
    }
    ;(parent ? parent.node : this.root).add(n.node)
    this.nodes.set(n.id, n)
    this.reindex()
  }

  detach(n: SimNode): void {
    if (n.parent) n.parent.children = n.parent.children.filter((c) => c !== n)
    n.node.parent?.remove(n.node)
    n.parent = null
  }

  remove(n: SimNode): void {
    for (const c of [...n.children]) this.remove(c)
    this.detach(n)
    if (n.emitter) this.scene.remove(n.emitter.mesh)
    this.nodes.delete(n.id)
    this.reindex()
  }

  restoreEmitter(n: SimNode): void {
    if (n.emitter && !n.emitter.mesh.parent) this.scene.add(n.emitter.mesh)
  }

  pathOf(n: SimNode): string {
    const parts = [n.data.name]
    for (let p = n.parent; p; p = p.parent) parts.unshift(p.data.name)
    return parts.join('/')
  }

  reindex(): void {
    this.byPath.clear()
    for (const n of this.nodes.values()) {
      n.data.path = this.pathOf(n)
      this.byPath.set(n.data.path, n)
    }
  }

  setMesh(n: SimNode, name: string | null): void {
    const g = name ? this.geos.get(name) : null
    n.meshName = g ? name : null
    if (!g) {
      if (n.mesh) n.mesh.visible = false
      return
    }
    if (!n.mesh) {
      n.material ??= new MeshStandardMaterial()
      this.paint(n.material, n.data.material ?? '')
      n.mesh = new Mesh(g, n.material)
      n.mesh.userData.id = n.id
      n.mesh.castShadow = true
      n.mesh.receiveShadow = true
      n.node.add(n.mesh)
    }
    n.mesh.geometry = g
    n.mesh.visible = n.rendererOn
  }

  paint(m: MeshStandardMaterial, name: string): void {
    const p = this.materials.get(name) ?? { color: [0.8, 0.8, 0.8, 1], smooth: 0.5, metal: 0, emission: [0, 0, 0, 1] }
    m.color.copy(srgb(p.color))
    m.roughness = Math.min(1, Math.max(0.08, 1 - p.smooth * 0.85))
    m.metalness = p.metal
    m.emissive.copy(srgb(p.emission.map((x) => Math.min(1, x))))
    m.emissiveIntensity = Math.max(1, ...p.emission.slice(0, 3)) * 2.4
    m.needsUpdate = true
  }

  addEmitter(n: SimNode, params: PsParams): ParticleEmitter {
    const e = new ParticleEmitter(params)
    n.emitter = e
    this.scene.add(e.mesh)
    return e
  }

  prewarm(): void {
    this.root.updateMatrixWorld(true)
    for (const n of this.nodes.values()) {
      const e = n.emitter
      if (!e || !e.params.prewarm) continue
      for (let t = 0; t < e.params.lifetime[1]; t += 0.05) e.step(0.05, n.node.matrixWorld)
      e.upload((v) => v)
    }
  }

  setTheme(outline: number[] | null, child: number[] | null): void {
    if (outline) (this.outline.uniforms.colA.value as Color).setRGB(outline[0], outline[1], outline[2])
    if (child) (this.outline.uniforms.colB.value as Color).setRGB(child[0], child[1], child[2])
  }

  private applyLocal(n: SimNode, lp: Vec3, lr: Quat, ls: Vec3): void {
    n.node.position.copy(unityPosToThree(lp))
    n.node.quaternion.copy(unityRotToThree(lr))
    n.node.scale.set(ls[0], ls[1], ls[2])
    n.node.updateMatrixWorld(true)
  }

  local(n: SimNode): { lp: Vec3; lr: Quat; ls: Vec3 } {
    return { lp: threePosToUnity(n.node.position), lr: threeRotToUnity(n.node.quaternion), ls: [n.node.scale.x, n.node.scale.y, n.node.scale.z] }
  }

  setLocal(id: string, v: { lp?: Vec3; lr?: Quat; ls?: Vec3 }): void {
    const n = this.nodes.get(id)
    if (!n) return
    const cur = this.local(n)
    this.applyLocal(n, v.lp ?? cur.lp, v.lr ?? cur.lr, v.ls ?? cur.ls)
  }

  setWorld(id: string, position?: Vec3, rotation?: Quat, localScale?: Vec3): void {
    const n = this.nodes.get(id)
    if (!n) return
    this.root.updateMatrixWorld(true)
    const parentInv = new Matrix4()
    if (n.node.parent) parentInv.copy(n.node.parent.matrixWorld).invert()
    if (position) n.node.position.copy(unityPosToThree(position).applyMatrix4(parentInv))
    if (rotation) {
      const pq = new Quaternion()
      n.node.parent?.getWorldQuaternion(pq)
      n.node.quaternion.copy(pq.invert().multiply(unityRotToThree(rotation)))
    }
    if (localScale) n.node.scale.set(localScale[0], localScale[1], localScale[2])
    n.node.updateMatrixWorld(true)
  }

  setActive(id: string, active: boolean): void {
    const n = this.nodes.get(id)
    if (!n) return
    n.active = active
    n.node.visible = active
  }

  activeInHierarchy(n: SimNode): boolean {
    for (let x: SimNode | null = n; x; x = x.parent) if (!x.active) return false
    return true
  }

  worldPos(n: SimNode): Vec3 {
    return threePosToUnity(n.node.getWorldPosition(new Vector3()))
  }

  worldRot(n: SimNode): Quat {
    return threeRotToUnity(n.node.getWorldQuaternion(new Quaternion()))
  }

  bounds(n: SimNode): TunerBounds | null {
    const box = new Box3()
    let any = false
    const walk = (x: SimNode): void => {
      if (x.mesh && x.node.visible) {
        box.union(new Box3().setFromObject(x.mesh, true))
        any = true
      }
      for (const c of x.children) walk(c)
    }
    this.root.updateMatrixWorld(true)
    walk(n)
    if (!any) {
      const p = n.node.getWorldPosition(new Vector3())
      box.setFromCenterAndSize(p, new Vector3(0.4, 0.4, 0.4))
    }
    const c = box.getCenter(new Vector3())
    const s = box.getSize(new Vector3())
    return { center: threePosToUnity(c), size: [s.x, s.y, s.z] }
  }

  pose(n: SimNode): TunerPose {
    const l = this.local(n)
    return { id: n.id, active: this.activeInHierarchy(n), position: this.worldPos(n), rotation: this.worldRot(n), localPosition: l.lp, localRotation: l.lr, localScale: l.ls, bounds: this.bounds(n) }
  }

  useCamera(cam: TunerCamera): PerspectiveCamera | OrthographicCamera {
    const aspect = cam.width / Math.max(1, cam.height)
    let c: PerspectiveCamera | OrthographicCamera
    if (cam.ortho && cam.ortho > 0) {
      c = this.ortho
      c.left = -cam.ortho * aspect
      c.right = cam.ortho * aspect
      c.top = cam.ortho
      c.bottom = -cam.ortho
    } else {
      c = this.camera
      c.fov = cam.fov
      c.aspect = aspect
    }
    c.position.copy(unityPosToThree(cam.position))
    c.quaternion.copy(unityRotToThree(cam.rotation))
    c.updateProjectionMatrix()
    c.updateMatrixWorld()
    return c
  }

  setFocus(ids: string[] | null, tree: boolean, hide: boolean): void {
    let next: Set<string> | null = null
    if (ids && ids.length) {
      next = new Set(ids)
      if (tree) {
        const add = (n: SimNode): void => {
          next!.add(n.id)
          for (const c of n.children) add(c)
        }
        for (const id of ids) {
          const n = this.nodes.get(id)
          if (n) add(n)
        }
      }
    }
    const same = (a: Set<string> | null, b: Set<string> | null): boolean => (!a || !b ? a === b : a.size === b.size && [...a].every((x) => b.has(x)))
    if (same(next, this.focus) && hide === this.focusHide) return
    if (next) this.focus = next
    this.focusHide = hide
    if (!next) this.focusOff = true
    else this.focusOff = false
    this.ghostShown = -1
  }

  private focusOff = true

  private applyGhost(): void {
    const t = this.ghost
    const ease = t * t * (3 - 2 * t)
    const cull = !!this.focus && this.focusHide && ease >= 0.5
    let box: Box3 | null = null
    if (cull)
      for (const n of this.nodes.values()) {
        if (!n.mesh || !this.focus!.has(n.id) || !n.rendererOn) continue
        const b = new Box3().setFromObject(n.mesh, true)
        if (!b.isEmpty()) box = box ? box.union(b) : b
      }
    const near = box ? Math.min(20, Math.max(3, box.getSize(new Vector3()).length() * 0.25 + 2)) : 0
    const gap = new Vector3()
    for (const n of this.nodes.values()) {
      if (!n.mesh) continue
      const ud = n.mesh.userData as { hidden?: boolean }
      if (ud.hidden) {
        n.mesh.visible = n.rendererOn
        ud.hidden = false
      }
      if (!cull || this.focus!.has(n.id) || !n.mesh.visible) continue
      if (box) {
        const b = new Box3().setFromObject(n.mesh, true)
        gap.copy(b.min).sub(box.max).max(new Vector3().copy(box.min).sub(b.max)).max(new Vector3())
        if (!b.isEmpty() && gap.length() <= near) continue
      }
      n.mesh.visible = false
      ud.hidden = true
    }
    if (!this.focus || this.focusOff) {
      if (t <= 0) this.focus = null
    }
  }

  step(dt: number): boolean {
    let any = false
    const want = this.focus && !this.focusOff ? 1 : 0
    if (this.ghost !== want) {
      this.ghost = want > this.ghost ? Math.min(want, this.ghost + dt / 0.7) : Math.max(want, this.ghost - dt / 0.45)
      any = true
    }
    if (this.ghostShown !== this.ghost) {
      this.ghostShown = this.ghost
      this.applyGhost()
      any = true
    }
    this.root.updateMatrixWorld(true)
    for (const n of this.nodes.values()) {
      const e = n.emitter
      if (!e) continue
      const on = this.activeInHierarchy(n) && this.effects.particles
      e.mesh.visible = on
      if (!on) continue
      e.step(dt, n.node.matrixWorld)
      e.upload((v) => v)
      any = any || e.count > 0 || e.playing
    }
    return any
  }

  private ensure(w: number, h: number): WebGLRenderer {
    if (!this.renderer) {
      this.canvas = document.createElement('canvas')
      this.renderer = new WebGLRenderer({ canvas: this.canvas, antialias: true, preserveDrawingBuffer: false, powerPreference: 'high-performance' })
      this.renderer.outputColorSpace = SRGBColorSpace
      this.renderer.autoClear = false
      this.renderer.shadowMap.enabled = true
      this.renderer.shadowMap.type = PCFShadowMap
      this.renderer.setPixelRatio(1)
    }
    if (this.canvas!.width !== w || this.canvas!.height !== h) this.renderer.setSize(w, h, false)
    if (!this.mask || this.mask.width !== w || this.mask.height !== h) {
      this.mask?.dispose()
      this.mask = new WebGLRenderTarget(w, h)
    }
    return this.renderer
  }

  private gizmoFor(selected: string[], eye: Vector3): void {
    const pts: number[] = []
    if (this.showGizmos)
      for (const id of selected) {
        const n = this.nodes.get(id)
        if (!n || !this.activeInHierarchy(n)) continue
        for (const c of n.colliders) if (c.enabled) colliderLines(c, n.node.matrixWorld, pts, eye)
      }
    const g = this.gizmo.geometry
    g.setAttribute('position', new BufferAttribute(new Float32Array(pts), 3))
    g.computeBoundingSphere()
  }

  set showGrid(on: boolean) {
    if (this.grid) this.grid.visible = on
  }

  get showGrid(): boolean {
    return this.grid?.visible ?? true
  }

  handlesFor(id: string): Handle[] {
    const n = this.nodes.get(id)
    if (!n) return []
    this.root.updateMatrixWorld(true)
    const c = n.colliders.find((x) => x.enabled && x.type !== 'MeshCollider')
    return c ? colliderHandles(c, n.node.matrixWorld) : []
  }

  render(cam: TunerCamera, selected: string[], target: HTMLCanvasElement | null, handles: HandleView | null, density = 2, maxSide = 1600): { width: number; height: number } | null {
    const css = cam.points && cam.points > 0 ? cam.points : cam.width
    const k = Math.min(1, (density * css) / cam.width, maxSide / Math.max(cam.width, cam.height))
    const w = Math.max(16, Math.round(cam.width * k))
    const h = Math.max(16, Math.round(cam.height * k))
    const r = this.ensure(w, h)
    const c = this.useCamera(cam)
    this.lastCamera = c
    this.root.updateMatrixWorld(true)
    this.gizmoFor(selected, c.position)
    r.setRenderTarget(null)
    r.setClearColor(this.effects.skybox ? 0x000000 : 0x313131, 1)
    r.clear()
    if (this.skyMesh) this.skyMesh.visible = this.effects.skybox
    this.scene.fog = this.effects.fog ? this.fogOn : null
    const off: Light[] = []
    if (!this.showLighting)
      for (const l of [...this.ambient, ...[...this.nodes.values()].map((n) => n.light)])
        if (l && l.visible) {
          l.visible = false
          off.push(l)
        }
    this.flat.visible = !this.showLighting
    r.render(this.scene, c)
    for (const l of off) l.visible = true
    if (selected.length && this.selectionWire) {
      this.wireScene.clear()
      const wire = (n: SimNode): void => {
        if (!this.activeInHierarchy(n)) return
        if (n.mesh && n.rendererOn) {
          const m = new Mesh(n.mesh.geometry, this.wireMat)
          m.matrixAutoUpdate = false
          m.matrix.copy(n.mesh.matrixWorld)
          this.wireScene.add(m)
        }
        for (const ch of n.children) wire(ch)
      }
      for (const id of selected) {
        const n = this.nodes.get(id)
        if (n) wire(n)
      }
      r.render(this.wireScene, c)
    }
    if (selected.length && this.selectionOutline) {
      this.maskScene.clear()
      const sel = new Set(selected)
      const add = (n: SimNode, child: boolean): void => {
        if (!this.activeInHierarchy(n)) return
        if (n.mesh && n.rendererOn) {
          const m = new Mesh(n.mesh.geometry, child ? this.maskB : this.maskA)
          m.matrixAutoUpdate = false
          m.matrix.copy(n.mesh.matrixWorld)
          this.maskScene.add(m)
        }
        for (const ch of n.children) add(ch, child || !sel.has(ch.id))
      }
      for (const id of selected) {
        const n = this.nodes.get(id)
        if (n) add(n, false)
      }
      r.setRenderTarget(this.mask)
      r.setClearColor(0x000000, 1)
      r.clear()
      r.render(this.maskScene, c)
      r.setRenderTarget(null)
      this.outline.uniforms.mask.value = this.mask!.texture
      ;(this.outline.uniforms.px.value as Vector2).set(1 / w, 1 / h)
      r.render(this.outlineScene, this.outlineCam)
    }
    if (!target) return { width: w, height: h }
    if (target.width !== w || target.height !== h) {
      target.width = w
      target.height = h
    }
    const g = target.getContext('2d', { alpha: false, desynchronized: true })
    if (!g) return null
    g.drawImage(this.canvas!, 0, 0)
    if (handles && handles.handles.length) {
      const s = Math.max(1, w / css)
      for (const hd of handles.handles) {
        const p = project(hd.world, c, w, h)
        if (p.z > 1) continue
        const hot = hd.id === handles.active || (handles.active < 0 && hd.id === handles.hot)
        const size = (hot ? 9 : 7) * s
        g.fillStyle = hot ? '#ffe75c' : '#92f48b'
        g.strokeStyle = 'rgba(0,0,0,0.55)'
        g.lineWidth = s
        g.fillRect(Math.round(p.x - size / 2), Math.round(p.y - size / 2), size, size)
        g.strokeRect(Math.round(p.x - size / 2) + 0.5, Math.round(p.y - size / 2) + 0.5, size - 1, size - 1)
      }
    }
    return { width: w, height: h }
  }

  screenOf(p: Vector3, cam: TunerCamera): { x: number; y: number } {
    const c = this.useCamera(cam)
    const v = project(p, c, cam.width, cam.height)
    return { x: v.x, y: v.y }
  }

  rayFrom(cam: TunerCamera, x: number, y: number): { origin: Vector3; dir: Vector3 } {
    const c = this.useCamera(cam)
    this.ray.setFromCamera(new Vector2(x * 2 - 1, -(y * 2 - 1)), c)
    return { origin: this.ray.ray.origin.clone(), dir: this.ray.ray.direction.clone() }
  }

  pick(cam: TunerCamera, x: number, y: number): SimNode[] {
    const c = this.useCamera(cam)
    this.root.updateMatrixWorld(true)
    this.ray.setFromCamera(new Vector2(x * 2 - 1, -(y * 2 - 1)), c)
    const meshes = [...this.nodes.values()].filter((n) => n.mesh && n.rendererOn && this.activeInHierarchy(n)).map((n) => n.mesh!)
    const hits = this.ray.intersectObjects(meshes, false)
    const out: SimNode[] = []
    for (const h of hits) {
      const n = this.nodes.get(h.object.userData.id as string)
      if (n && !out.includes(n)) out.push(n)
    }
    return out
  }

  dispose(): void {
    for (const n of this.nodes.values()) n.emitter?.dispose()
    this.renderer?.dispose()
    this.mask?.dispose()
    this.renderer = null
  }
}
