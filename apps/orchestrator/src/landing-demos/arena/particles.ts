import {
  AdditiveBlending,
  CanvasTexture,
  DoubleSide,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Matrix4,
  Mesh,
  NormalBlending,
  PlaneGeometry,
  Quaternion,
  ShaderMaterial,
  Vector3
} from 'three'
import type { TunerColor, TunerCurve, TunerGradient } from '@shared/tuner-inspector-popups'
import { evaluate } from '@renderer/components/tuner/inspector/popups/curve-math'
import { evaluateGradient } from '@renderer/components/tuner/inspector/popups/gradient-math'

export interface PsParams {
  duration: number
  looping: boolean
  prewarm: boolean
  lifetime: [number, number]
  speed: [number, number]
  size: [number, number]
  rotation: [number, number]
  color: TunerColor
  gravity: number
  simSpeed: number
  maxParticles: number
  world: boolean
  emission: boolean
  rate: number
  shape: boolean
  shapeType: string
  angle: number
  radius: number
  arc: number
  boxSize: [number, number, number]
  randomDirection: number
  colorOn: boolean
  gradient: TunerGradient | null
  sizeOn: boolean
  sizeCurve: TunerCurve | null
  velocityOn: boolean
  velocity: [number, number, number]
  noiseOn: boolean
  noiseStrength: number
  noiseFrequency: number
  rotationOn: boolean
  angular: number
  limitOn: boolean
  limitSpeed: number
  dampen: number
  render: string
  lengthScale: number
  velocityScale: number
  additive: boolean
  rendererOn: boolean
}

interface P {
  pos: Vector3
  vel: Vector3
  age: number
  life: number
  size: number
  rot: number
  spin: number
  seed: number
  col: TunerColor
}

const VS = `
attribute vec3 iPos;
attribute vec3 iVel;
attribute vec4 iCol;
attribute vec2 iSize;
uniform float stretch;
uniform float lengthScale;
uniform float velocityScale;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vUv = uv;
  vCol = iCol;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float s = iSize.x;
  vec2 c = position.xy;
  if (stretch > 0.5) {
    vec3 vv = (modelViewMatrix * vec4(iVel, 0.0)).xyz;
    vec2 d = vv.xy;
    float len = length(d);
    vec2 dir = len > 1e-5 ? d / len : vec2(0.0, 1.0);
    vec2 side = vec2(-dir.y, dir.x);
    float l = s * lengthScale + length(iVel) * velocityScale;
    mv.xy += side * c.x * s + dir * (c.y - 0.5) * l;
  } else {
    float cr = cos(iSize.y);
    float sr = sin(iSize.y);
    mv.xy += vec2(c.x * cr - c.y * sr, c.x * sr + c.y * cr) * s;
  }
  gl_Position = projectionMatrix * mv;
}`

const FS = `
uniform sampler2D map;
varying vec2 vUv;
varying vec4 vCol;
void main() {
  vec4 t = texture2D(map, vUv);
  vec4 c = vCol * t;
  if (c.a < 0.004) discard;
  gl_FragColor = c;
}`

function softDot(): CanvasTexture {
  const c = document.createElement('canvas')
  c.width = c.height = 64
  const g = c.getContext('2d')!
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32)
  grad.addColorStop(0, 'rgba(255,255,255,1)')
  grad.addColorStop(0.35, 'rgba(255,255,255,0.75)')
  grad.addColorStop(1, 'rgba(255,255,255,0)')
  g.fillStyle = grad
  g.fillRect(0, 0, 64, 64)
  const t = new CanvasTexture(c)
  t.needsUpdate = true
  return t
}

let dot: CanvasTexture | null = null

function rnd(a: [number, number], r: number): number {
  return a[0] + (a[1] - a[0]) * r
}

function hash(n: number): number {
  const x = Math.sin(n * 127.1) * 43758.5453
  return x - Math.floor(x)
}

function noise3(x: number, y: number, z: number, s: number): number {
  return Math.sin(x * 1.7 + s) * Math.cos(y * 2.3 + s * 1.3) + Math.sin(z * 1.9 + y * 0.7 + s * 0.7) * 0.6
}

export class ParticleEmitter {
  readonly mesh: Mesh
  params: PsParams
  playing = true
  time = 0
  speed = 1
  private list: P[] = []
  private acc = 0
  private seq = 0
  private geo: InstancedBufferGeometry
  private iPos: InstancedBufferAttribute
  private iVel: InstancedBufferAttribute
  private iCol: InstancedBufferAttribute
  private iSize: InstancedBufferAttribute
  private mat: ShaderMaterial
  private cap = 0
  private origin = new Vector3()
  private rot = new Quaternion()

  constructor(params: PsParams) {
    this.params = params
    dot ??= softDot()
    const quad = new PlaneGeometry(1, 1)
    this.geo = new InstancedBufferGeometry()
    this.geo.index = quad.index
    this.geo.setAttribute('position', quad.getAttribute('position'))
    this.geo.setAttribute('uv', quad.getAttribute('uv'))
    this.iPos = new InstancedBufferAttribute(new Float32Array(0), 3)
    this.iVel = new InstancedBufferAttribute(new Float32Array(0), 3)
    this.iCol = new InstancedBufferAttribute(new Float32Array(0), 4)
    this.iSize = new InstancedBufferAttribute(new Float32Array(0), 2)
    this.mat = new ShaderMaterial({
      vertexShader: VS,
      fragmentShader: FS,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      uniforms: { map: { value: dot }, stretch: { value: 0 }, lengthScale: { value: 2 }, velocityScale: { value: 0 } }
    })
    this.ensure(64)
    this.mesh = new Mesh(this.geo, this.mat)
    this.mesh.frustumCulled = false
    this.mesh.renderOrder = 5
  }

  get count(): number {
    return this.list.length
  }

  private ensure(n: number): void {
    if (n <= this.cap) return
    this.cap = Math.max(n, this.cap * 2)
    this.iPos = new InstancedBufferAttribute(new Float32Array(this.cap * 3), 3)
    this.iVel = new InstancedBufferAttribute(new Float32Array(this.cap * 3), 3)
    this.iCol = new InstancedBufferAttribute(new Float32Array(this.cap * 4), 4)
    this.iSize = new InstancedBufferAttribute(new Float32Array(this.cap * 2), 2)
    this.geo.setAttribute('iPos', this.iPos)
    this.geo.setAttribute('iVel', this.iVel)
    this.geo.setAttribute('iCol', this.iCol)
    this.geo.setAttribute('iSize', this.iSize)
  }

  restart(): void {
    this.list = []
    this.time = 0
    this.acc = 0
    this.playing = true
  }

  stop(): void {
    this.list = []
    this.time = 0
    this.acc = 0
    this.playing = false
  }

  private direction(r1: number, r2: number, r3: number): { p: Vector3; d: Vector3 } {
    const pr = this.params
    if (!pr.shape) return { p: new Vector3(), d: new Vector3(0, 0, 1) }
    const t = pr.shapeType.toLowerCase()
    const a = r1 * Math.PI * 2 * (pr.arc / 360)
    if (t.includes('sphere') || t.includes('hemisphere')) {
      const u = r2 * 2 - 1
      const s = Math.sqrt(1 - u * u)
      const d = new Vector3(s * Math.cos(a), s * Math.sin(a), t.includes('hemi') ? Math.abs(u) : u)
      return { p: d.clone().multiplyScalar(pr.radius * Math.cbrt(r3)), d }
    }
    if (t.includes('box')) {
      const p = new Vector3((r1 - 0.5) * pr.boxSize[0], (r2 - 0.5) * pr.boxSize[1], (r3 - 0.5) * pr.boxSize[2])
      return { p, d: new Vector3(0, 0, 1) }
    }
    if (t.includes('circle') || t.includes('edge')) {
      const p = new Vector3(Math.cos(a), Math.sin(a), 0).multiplyScalar(pr.radius * Math.sqrt(r2))
      return { p, d: p.lengthSq() > 0 ? p.clone().normalize() : new Vector3(1, 0, 0) }
    }
    const rr = pr.radius * Math.sqrt(r2)
    const p = new Vector3(Math.cos(a) * rr, Math.sin(a) * rr, 0)
    const ang = (Math.min(90, Math.max(0, pr.angle)) * Math.PI) / 180
    const spread = pr.radius > 0 ? Math.sqrt(r2) : r3
    const tilt = ang * spread
    const d = new Vector3(Math.cos(a) * Math.sin(tilt), Math.sin(a) * Math.sin(tilt), Math.cos(tilt))
    return { p, d }
  }

  private spawn(world: Matrix4): void {
    const pr = this.params
    if (this.list.length >= pr.maxParticles) return
    const s = ++this.seq
    const r = (k: number): number => hash(s * 7.13 + k * 1.37)
    const { p, d } = this.direction(r(1), r(2), r(3))
    if (pr.randomDirection > 0) {
      const rv = new Vector3(r(4) * 2 - 1, r(5) * 2 - 1, r(6) * 2 - 1).normalize()
      d.lerp(rv, pr.randomDirection).normalize()
    }
    p.z = -p.z
    d.z = -d.z
    const pos = p.applyMatrix4(world)
    const dir = d.applyQuaternion(this.rot).normalize()
    const sp = rnd(pr.speed, r(7))
    this.list.push({
      pos,
      vel: dir.multiplyScalar(sp),
      age: 0,
      life: Math.max(0.01, rnd(pr.lifetime, r(8))),
      size: rnd(pr.size, r(9)),
      rot: (rnd(pr.rotation, r(10)) * Math.PI) / 180,
      spin: 0,
      seed: s,
      col: pr.color
    })
  }

  step(dtReal: number, world: Matrix4): void {
    const pr = this.params
    world.decompose(this.origin, this.rot, new Vector3())
    if (!this.playing) return
    const dt = Math.min(0.05, dtReal) * pr.simSpeed * this.speed
    if (dt <= 0) return
    this.time += dt
    if (this.time > pr.duration) {
      if (pr.looping) this.time %= Math.max(0.01, pr.duration)
      else this.time = pr.duration
    }
    const emitting = pr.looping || this.time < pr.duration
    if (pr.emission && emitting && pr.rate > 0) {
      this.acc += pr.rate * dt
      while (this.acc >= 1) {
        this.acc -= 1
        this.spawn(world)
      }
    }
    const g = -9.81 * pr.gravity * dt
    const keep: P[] = []
    for (const p of this.list) {
      p.age += dt
      if (p.age >= p.life) continue
      p.vel.y += g
      if (pr.limitOn && pr.limitSpeed >= 0) {
        const v = p.vel.length()
        if (v > pr.limitSpeed) p.vel.multiplyScalar(1 - pr.dampen * (1 - pr.limitSpeed / v))
      }
      let vx = p.vel.x
      let vy = p.vel.y
      let vz = p.vel.z
      if (pr.velocityOn) {
        const lv = new Vector3(pr.velocity[0], pr.velocity[1], pr.velocity[2])
        if (!pr.world) lv.applyQuaternion(this.rot)
        vx += lv.x
        vy += lv.y
        vz += lv.z
      }
      if (pr.noiseOn && pr.noiseStrength !== 0) {
        const f = pr.noiseFrequency
        const k = pr.noiseStrength * 2
        vx += noise3(p.pos.y * f, p.pos.z * f, this.time * 0.6, p.seed % 17) * k
        vy += noise3(p.pos.z * f, p.pos.x * f, this.time * 0.6, (p.seed % 13) + 3) * k
        vz += noise3(p.pos.x * f, p.pos.y * f, this.time * 0.6, (p.seed % 11) + 7) * k
      }
      p.pos.x += vx * dt
      p.pos.y += vy * dt
      p.pos.z += vz * dt
      if (pr.rotationOn) p.rot += ((pr.angular * Math.PI) / 180) * dt
      keep.push(p)
    }
    if (keep.length > pr.maxParticles) keep.splice(0, keep.length - Math.max(0, pr.maxParticles))
    this.list = keep
  }

  upload(toThree: (v: Vector3) => Vector3): void {
    const pr = this.params
    const n = pr.rendererOn ? this.list.length : 0
    this.ensure(n)
    const ap = this.iPos.array as Float32Array
    const av = this.iVel.array as Float32Array
    const ac = this.iCol.array as Float32Array
    const as = this.iSize.array as Float32Array
    const tmp = new Vector3()
    for (let i = 0; i < n; i++) {
      const p = this.list[i]
      const t = p.age / p.life
      const pos = toThree(tmp.copy(p.pos))
      ap[i * 3] = pos.x
      ap[i * 3 + 1] = pos.y
      ap[i * 3 + 2] = pos.z
      const vel = toThree(tmp.copy(p.vel))
      av[i * 3] = vel.x
      av[i * 3 + 1] = vel.y
      av[i * 3 + 2] = vel.z
      let c = p.col
      if (pr.colorOn && pr.gradient) {
        const g = evaluateGradient(pr.gradient, t)
        c = { r: c.r * g.r, g: c.g * g.g, b: c.b * g.b, a: c.a * g.a }
      }
      ac[i * 4] = c.r
      ac[i * 4 + 1] = c.g
      ac[i * 4 + 2] = c.b
      ac[i * 4 + 3] = c.a
      const k = pr.sizeOn && pr.sizeCurve ? Math.max(0, evaluate(pr.sizeCurve, t)) : 1
      as[i * 2] = p.size * k
      as[i * 2 + 1] = p.rot
    }
    this.geo.instanceCount = n
    this.iPos.needsUpdate = true
    this.iVel.needsUpdate = true
    this.iCol.needsUpdate = true
    this.iSize.needsUpdate = true
    this.mat.uniforms.stretch.value = /stretch/i.test(pr.render) ? 1 : 0
    this.mat.uniforms.lengthScale.value = pr.lengthScale
    this.mat.uniforms.velocityScale.value = pr.velocityScale
    const blend = pr.additive ? AdditiveBlending : NormalBlending
    if (this.mat.blending !== blend) {
      this.mat.blending = blend
      this.mat.needsUpdate = true
    }
  }

  dispose(): void {
    this.geo.dispose()
    this.mat.dispose()
  }
}
