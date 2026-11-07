import {
  BoxGeometry,
  BufferGeometry,
  Camera,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DoubleSide,
  Group,
  LineBasicMaterial,
  LineLoop,
  Material,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  OrthographicCamera,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3
} from 'three'
import type { Quat, TunerCamera, Vec3 } from '@shared/tuner'
import { acquireGizmoRenderer, releaseGizmoRenderer, renderGizmo } from './gizmo-renderer'
import { noteLive } from './perf'
import type { Axis, HandleId, HandleMode, HandleSpace } from './handles'
import { unityPosToThree, unityRotToThree } from './space'

export const AXIS_COLORS = [0xe8453c, 0x7ccf3b, 0x3b7bf0]
const ACTIVE_COLOR = 0xf5d547
const UNIFORM_COLOR = 0xcfcfd4
const DIRS = [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, -1)]
const HANDLE_PX = 84
const ORTHO_NEAR = 0.01
const ORTHO_FAR = 1_000_000
const BACK = new Vector3(0, 0, 1)

export interface OverlayInput {
  camera: Pick<TunerCamera, 'position' | 'rotation' | 'fov' | 'ortho' | 'clip'>
  planar?: boolean
  handle: { position: Vec3; rotation: Quat } | null
  mode: HandleMode
  space: HandleSpace
  hoverHandle: HandleId | null
  activeHandle: HandleId | null
}

interface Part {
  id: HandleId
  mats: (MeshBasicMaterial | LineBasicMaterial)[]
  baseColor: number
  baseOpacity: number
  hit: Mesh
  nodes: Object3D[]
  enabled: boolean
}

function planarPart(id: HandleId): boolean {
  return id.kind === 'axis' || id.kind === 'scale' ? id.axis !== 2 : id.axis === 2
}

function sameHandle(a: HandleId | null, b: HandleId | null): boolean {
  return !!a && !!b && a.kind === b.kind && a.axis === b.axis
}

function basic(color: number, opacity = 1): MeshBasicMaterial {
  return new MeshBasicMaterial({ color, transparent: true, opacity, depthTest: false, depthWrite: false, side: DoubleSide })
}

function hitMat(): MeshBasicMaterial {
  return new MeshBasicMaterial({ visible: false, side: DoubleSide })
}

export class SceneOverlay {
  readonly scene = new Scene()
  readonly camera = new PerspectiveCamera(50, 1, 0.03, 20000)
  readonly ortho = new OrthographicCamera(-1, 1, 1, -1, ORTHO_NEAR, ORTHO_FAR)
  private view: Camera = this.camera
  private root = new Group()
  private oriented = new Group()
  private moveGroup = new Group()
  private rotateGroup = new Group()
  private scaleGroup = new Group()
  private occluder: Mesh
  private outline: LineLoop
  private planes: Group[] = []
  private parts: Part[] = []
  private ray = new Raycaster()

  private disposed = false

  constructor() {
    acquireGizmoRenderer()
    noteLive('overlay', 1)
    this.scene.add(this.root)
    this.root.add(this.oriented)
    this.oriented.add(this.moveGroup, this.rotateGroup, this.scaleGroup)

    for (let i = 0; i < 3; i++) {
      const axis = i as Axis
      const dir = DIRS[i]
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir)
      const mat = basic(AXIS_COLORS[i])
      const shaft = new Mesh(new CylinderGeometry(0.011, 0.011, 0.78, 8), mat)
      shaft.quaternion.copy(q)
      shaft.position.copy(dir).multiplyScalar(0.47)
      const tip = new Mesh(new ConeGeometry(0.055, 0.2, 20), mat)
      tip.quaternion.copy(q)
      tip.position.copy(dir).multiplyScalar(0.94)
      const hit = new Mesh(new CylinderGeometry(0.08, 0.08, 1.0, 8), hitMat())
      hit.quaternion.copy(q)
      hit.position.copy(dir).multiplyScalar(0.55)
      for (const m of [shaft, tip]) m.renderOrder = 5
      this.moveGroup.add(shaft, tip, hit)
      this.parts.push({ id: { kind: 'axis', axis }, mats: [mat], baseColor: AXIS_COLORS[i], baseOpacity: 1, hit, nodes: [shaft, tip, hit], enabled: true })

      const plane = new Group()
      const fillMat = basic(AXIS_COLORS[i], 0.28)
      const edgeMat = new LineBasicMaterial({ color: AXIS_COLORS[i], transparent: true, opacity: 0.9, depthTest: false, depthWrite: false })
      const fill = new Mesh(new PlaneGeometry(0.2, 0.2), fillMat)
      const edge = new LineLoop(
        new BufferGeometry().setFromPoints([
          new Vector3(-0.1, -0.1, 0),
          new Vector3(0.1, -0.1, 0),
          new Vector3(0.1, 0.1, 0),
          new Vector3(-0.1, 0.1, 0)
        ]),
        edgeMat
      )
      const pHit = new Mesh(new PlaneGeometry(0.26, 0.26), hitMat())
      plane.add(fill, edge, pHit)
      plane.quaternion.setFromUnitVectors(new Vector3(0, 0, 1), dir)
      fill.renderOrder = 4
      edge.renderOrder = 4
      this.moveGroup.add(plane)
      this.planes.push(plane)
      this.parts.push({
        id: { kind: 'plane', axis },
        mats: [fillMat, edgeMat],
        baseColor: AXIS_COLORS[i],
        baseOpacity: 0.28,
        hit: pHit,
        nodes: [plane],
        enabled: true
      })
    }

    for (let i = 0; i < 3; i++) {
      const axis = i as Axis
      const dir = DIRS[i]
      const q = new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir)
      const mat = basic(AXIS_COLORS[i])
      const shaft = new Mesh(new CylinderGeometry(0.011, 0.011, 0.82, 8), mat)
      shaft.quaternion.copy(q)
      shaft.position.copy(dir).multiplyScalar(0.49)
      const cube = new Mesh(new BoxGeometry(0.11, 0.11, 0.11), mat)
      cube.quaternion.copy(q)
      cube.position.copy(dir).multiplyScalar(0.94)
      const hit = new Mesh(new CylinderGeometry(0.09, 0.09, 1.0, 8), hitMat())
      hit.quaternion.copy(q)
      hit.position.copy(dir).multiplyScalar(0.57)
      for (const m of [shaft, cube]) m.renderOrder = 5
      this.scaleGroup.add(shaft, cube, hit)
      this.parts.push({ id: { kind: 'scale', axis }, mats: [mat], baseColor: AXIS_COLORS[i], baseOpacity: 1, hit, nodes: [shaft, cube, hit], enabled: true })
    }
    const uniMat = basic(UNIFORM_COLOR)
    const uni = new Mesh(new BoxGeometry(0.15, 0.15, 0.15), uniMat)
    const uniHit = new Mesh(new BoxGeometry(0.24, 0.24, 0.24), hitMat())
    uni.renderOrder = 6
    this.scaleGroup.add(uni, uniHit)
    this.parts.push({ id: { kind: 'scale', axis: 3 }, mats: [uniMat], baseColor: UNIFORM_COLOR, baseOpacity: 1, hit: uniHit, nodes: [uni, uniHit], enabled: true })

    this.occluder = new Mesh(new SphereGeometry(0.985, 32, 16), new MeshBasicMaterial({ colorWrite: false, depthWrite: true }))
    this.occluder.renderOrder = 3
    this.rotateGroup.add(this.occluder)
    for (let i = 0; i < 3; i++) {
      const axis = i as Axis
      const mat = new MeshBasicMaterial({ color: AXIS_COLORS[i], transparent: true, opacity: 1, depthTest: true, depthWrite: false })
      const ring = new Mesh(new TorusGeometry(1, 0.014, 8, 128), mat)
      const hit = new Mesh(new TorusGeometry(1, 0.085, 6, 64), hitMat())
      for (const m of [ring, hit]) {
        if (i === 0) m.rotation.y = Math.PI / 2
        if (i === 1) m.rotation.x = Math.PI / 2
      }
      ring.renderOrder = 5
      this.rotateGroup.add(ring, hit)
      this.parts.push({ id: { kind: 'ring', axis }, mats: [mat], baseColor: AXIS_COLORS[i], baseOpacity: 1, hit, nodes: [ring, hit], enabled: true })
    }
    this.outline = new LineLoop(
      new BufferGeometry().setFromPoints(
        Array.from({ length: 96 }, (_, k) => new Vector3(Math.cos((k / 96) * Math.PI * 2) * 1.12, Math.sin((k / 96) * Math.PI * 2) * 1.12, 0))
      ),
      new LineBasicMaterial({ color: 0xd4d4d8, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false })
    )
    const disc = new Mesh(new CircleGeometry(1, 64), basic(0xffffff, 0.04))
    this.outline.add(disc)
    this.outline.renderOrder = 4
    this.root.add(this.outline)
  }

  update(input: OverlayInput, aspect: number, heightPx: number): void {
    const size = input.camera.ortho ?? 0
    const ortho = size > 0
    const planar = input.planar ?? ortho
    let cam: PerspectiveCamera | OrthographicCamera
    if (ortho) {
      cam = this.ortho
      cam.left = -size * aspect
      cam.right = size * aspect
      cam.top = size
      cam.bottom = -size
      cam.near = ORTHO_NEAR
      cam.far = ORTHO_FAR
    } else {
      cam = this.camera
      cam.fov = input.camera.fov
      cam.aspect = aspect
      cam.near = input.camera.clip?.[0] ?? 0.03
      cam.far = input.camera.clip?.[1] ?? 20000
    }
    this.view = cam
    cam.position.copy(unityPosToThree(input.camera.position))
    cam.quaternion.copy(unityRotToThree(input.camera.rotation))
    const back = BACK.clone().applyQuaternion(cam.quaternion)
    if (ortho && !planar && input.handle) {
      const reach = Math.max(1e-6, ((2 * size) / Math.max(1, heightPx)) * HANDLE_PX * 4)
      const ahead = cam.position.clone().sub(unityPosToThree(input.handle.position)).dot(back)
      cam.position.addScaledVector(back, reach - ahead)
      cam.near = reach * 1e-3
      cam.far = reach * 2
    }
    cam.updateProjectionMatrix()
    cam.updateMatrixWorld()
    for (const p of this.parts) {
      p.enabled = !planar || planarPart(p.id)
      for (const n of p.nodes) n.visible = p.enabled
    }

    const h = input.handle
    this.root.visible = !!h && input.mode !== 'rect'
    if (!h) return
    const center = unityPosToThree(h.position)
    this.root.position.copy(center)
    const dist = Math.max(1e-3, cam.position.distanceTo(center))
    const unitsPerPx = ortho
      ? (2 * size) / Math.max(1, heightPx)
      : (2 * dist * Math.tan((input.camera.fov * Math.PI) / 360)) / Math.max(1, heightPx)
    this.root.scale.setScalar(unitsPerPx * HANDLE_PX)
    this.oriented.quaternion.copy(input.space === 'local' || input.mode === 'scale' ? unityRotToThree(h.rotation) : new Quaternion())
    this.moveGroup.visible = input.mode === 'move'
    this.rotateGroup.visible = input.mode === 'rotate'
    this.scaleGroup.visible = input.mode === 'scale'
    this.outline.visible = input.mode === 'rotate'
    this.outline.quaternion.copy(cam.quaternion)
    this.root.updateMatrixWorld(true)

    const localCam = (ortho ? back.clone() : cam.position.clone().sub(center)).applyQuaternion(this.oriented.quaternion.clone().invert())
    for (let i = 0; i < 3; i++) {
      const [a, b] = i === 0 ? [1, 2] : i === 1 ? [0, 2] : [0, 1]
      const sa = planar || localCam.dot(DIRS[a]) >= 0 ? 1 : -1
      const sb = planar || localCam.dot(DIRS[b]) >= 0 ? 1 : -1
      this.planes[i].position.copy(DIRS[a]).multiplyScalar(0.3 * sa).addScaledVector(DIRS[b], 0.3 * sb)
    }

    const viewDir = ortho ? back : cam.position.clone().sub(center).normalize()
    for (const p of this.parts) {
      const active = sameHandle(p.id, input.activeHandle)
      const hover = !input.activeHandle && sameHandle(p.id, input.hoverHandle)
      const dimmed = !!input.activeHandle && !active
      let facing = 1
      if ((p.id.kind === 'axis' || p.id.kind === 'scale') && p.id.axis !== 3) {
        const worldDir = DIRS[p.id.axis].clone().applyQuaternion(this.oriented.quaternion)
        facing = 1 - Math.max(0, Math.abs(worldDir.dot(viewDir)) - 0.9) * 8
      }
      for (const [k, m] of p.mats.entries()) {
        m.color.setHex(active || hover ? ACTIVE_COLOR : p.baseColor)
        const base = k === 0 ? p.baseOpacity : 0.9
        const shown = p.id.kind === 'plane' && k === 0 && (active || hover) ? 0.55 : base
        m.opacity = (dimmed ? shown * 0.25 : shown) * Math.max(0.15, facing)
      }
    }
  }

  pickHandle(ndc: Vector2, mode: HandleMode): HandleId | null {
    if (!this.root.visible) return null
    this.ray.setFromCamera(ndc, this.view)
    const kinds: HandleId['kind'][] = mode === 'move' ? ['axis', 'plane'] : mode === 'scale' ? ['scale'] : ['ring']
    const parts = this.parts.filter((p) => p.enabled && kinds.includes(p.id.kind))
    const hits = this.ray.intersectObjects(
      parts.map((p) => p.hit),
      false
    )
    const center = this.root.position
    const toCam =
      this.view instanceof OrthographicCamera ? BACK.clone().applyQuaternion(this.view.quaternion) : this.view.position.clone().sub(center)
    for (const h of hits) {
      const part = parts.find((p) => p.hit === h.object)
      if (!part) continue
      if (part.id.kind === 'ring' && h.point.clone().sub(center).dot(toCam) < -0.02 * this.root.scale.x) continue
      return part.id
    }
    return null
  }

  partPoints(width: number, height: number): { kind: HandleId['kind']; axis: number; x: number; y: number }[] {
    if (!this.root.visible) return []
    this.root.updateMatrixWorld(true)
    const out: { kind: HandleId['kind']; axis: number; x: number; y: number }[] = []
    for (const p of this.parts) {
      if (!p.enabled || !p.hit.visible) continue
      let shown = true
      for (let o: Object3D | null = p.hit; o; o = o.parent) if (!o.visible) shown = false
      if (!shown) continue
      const v = new Vector3().setFromMatrixPosition(p.hit.matrixWorld).project(this.view)
      out.push({ kind: p.id.kind, axis: p.id.axis, x: (v.x * 0.5 + 0.5) * width, y: (1 - (v.y * 0.5 + 0.5)) * height })
    }
    return out
  }

  centerPoint(width: number, height: number): { x: number; y: number } | null {
    if (!this.root.visible) return null
    this.root.updateMatrixWorld(true)
    const v = new Vector3().setFromMatrixPosition(this.root.matrixWorld).project(this.view)
    if (!(v.z < 1)) return null
    return { x: (v.x * 0.5 + 0.5) * width, y: (1 - (v.y * 0.5 + 0.5)) * height }
  }

  ringPoints(axis: number, width: number, height: number, n = 32): { x: number; y: number; front: boolean }[] {
    const part = this.parts.find((p) => p.id.kind === 'ring' && p.id.axis === axis)
    if (!this.root.visible || !part || !part.hit.visible) return []
    this.root.updateMatrixWorld(true)
    const center = new Vector3().setFromMatrixPosition(part.hit.matrixWorld)
    const camPos = this.view.position.clone()
    const out: { x: number; y: number; front: boolean }[] = []
    for (let k = 0; k < n; k++) {
      const a = (k / n) * Math.PI * 2
      const w = new Vector3(Math.cos(a), Math.sin(a), 0).applyMatrix4(part.hit.matrixWorld)
      const front = w.clone().sub(center).dot(camPos.clone().sub(center)) >= 0
      const v = w.project(this.view)
      out.push({ x: (v.x * 0.5 + 0.5) * width, y: (1 - (v.y * 0.5 + 0.5)) * height, front })
    }
    return out
  }

  get handleSize(): number {
    return this.root.scale.x
  }

  get hasContent(): boolean {
    return this.root.visible
  }

  render(canvas: HTMLCanvasElement, under?: (ctx: CanvasRenderingContext2D) => void): void {
    renderGizmo(canvas, this.scene, this.view, under)
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    releaseGizmoRenderer()
    noteLive('overlay', -1)
    this.scene.traverse((o) => {
      const m = o as Mesh
      m.geometry?.dispose()
      for (const mat of [m.material].flat() as (Material | undefined)[]) mat?.dispose()
    })
  }
}
