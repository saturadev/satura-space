import { Vector3, Time, Screen } from './core.js';
import { Component, Behaviour, MonoBehaviour, Engine, FindObjectsOfType, m4Invert, m4Point, m4Vector } from './object.js';
import { Camera, registerComponentType } from './components.js';
import { WorldRaycasters } from './ui.js';
import { SceneManager } from './scene.js';
import { Ray, Bounds, WorldBounds, Mesh } from './gl.js';

export class RaycastHit {
  constructor() {
    this.point = new Vector3();
    this.normal = new Vector3();
    this.distance = 0;
    this.collider = null;
  }
  get transform() {
    return this.collider ? this.collider.transform : null;
  }
  get rigidbody() {
    return this.collider ? this.collider.attachedRigidbody : null;
  }
}

export const ForceMode = Object.freeze({ Force: 0, Impulse: 1, VelocityChange: 2, Acceleration: 5 });

function closestOnTriangle(p, a, b, c) {
  const ab = b.sub(a);
  const ac = c.sub(a);
  const ap = p.sub(a);
  const d1 = Vector3.Dot(ab, ap);
  const d2 = Vector3.Dot(ac, ap);
  if (d1 <= 0 && d2 <= 0) return a;
  const bp = p.sub(b);
  const d3 = Vector3.Dot(ab, bp);
  const d4 = Vector3.Dot(ac, bp);
  if (d3 >= 0 && d4 <= d3) return b;
  const vc = d1 * d4 - d3 * d2;
  if (vc <= 0 && d1 >= 0 && d3 <= 0) return a.add(ab.mul(d1 / (d1 - d3)));
  const cp = p.sub(c);
  const d5 = Vector3.Dot(ab, cp);
  const d6 = Vector3.Dot(ac, cp);
  if (d6 >= 0 && d5 <= d6) return c;
  const vb = d5 * d2 - d1 * d6;
  if (vb <= 0 && d2 >= 0 && d6 <= 0) return a.add(ac.mul(d2 / (d2 - d6)));
  const va = d3 * d6 - d5 * d4;
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) return b.add(c.sub(b).mul((d4 - d3) / (d4 - d3 + (d5 - d6))));
  const k = 1 / (va + vb + vc);
  return a.add(ab.mul(vb * k)).add(ac.mul(vc * k));
}

function raySphere(origin, direction, center, radius) {
  const m = origin.sub(center);
  const b = Vector3.Dot(m, direction);
  const c = Vector3.Dot(m, m) - radius * radius;
  if (c > 0 && b > 0) return -1;
  const discriminant = b * b - c;
  if (discriminant < 0) return -1;
  return Math.max(0, -b - Math.sqrt(discriminant));
}

export class Collider extends Component {
  constructor() {
    super();
    this.enabled = true;
    this.isTrigger = false;
    this.center = new Vector3();
  }
  get attachedRigidbody() {
    return this.gameObject.GetComponentInParent(Rigidbody);
  }
  _loadCollider(props, revive, data) {
    this.enabled = data.enabled !== false;
    this.isTrigger = !!props.m_IsTrigger;
    if (props.m_Center) this.center = revive(props.m_Center);
  }
  Raycast(ray, hit, maxDistance = Infinity) {
    const found = this._ray(ray.origin, ray.direction, maxDistance);
    if (!found) return false;
    hit.point = found.point;
    hit.normal = found.normal;
    hit.distance = found.distance;
    hit.collider = this;
    return true;
  }
  ClosestPoint(point) {
    const surface = this._surface(Vector3.From(point));
    return surface.inside ? Vector3.From(point) : surface.point;
  }
  _contact(center, radius, margin) {
    const surface = this._surface(center);
    if (!surface) return null;
    const separation = (surface.inside ? -surface.distance : surface.distance) - radius;
    return separation < margin ? { separation, normal: surface.normal, point: surface.point, collider: this } : null;
  }
}

export class SphereCollider extends Collider {
  constructor() {
    super();
    this.radius = 0.5;
  }
  static fields = ['enabled', 'isTrigger', 'center', 'radius'];
  _load(props, revive, data) {
    this._loadCollider(props, revive, data);
    this.radius = props.m_Radius;
  }
  _world() {
    const scale = this.transform.lossyScale;
    return { center: this.transform.TransformPoint(this.center), radius: this.radius * Math.max(scale.x, scale.y, scale.z) };
  }
  get bounds() {
    const world = this._world();
    return new Bounds(world.center, new Vector3(world.radius * 2, world.radius * 2, world.radius * 2));
  }
  _ray(origin, direction, maxDistance) {
    const world = this._world();
    const distance = raySphere(origin, direction, world.center, world.radius);
    if (distance < 0 || distance > maxDistance) return null;
    const point = origin.add(direction.mul(distance));
    return { distance, point, normal: point.sub(world.center).normalized };
  }
  _surface(point) {
    const world = this._world();
    const offset = point.sub(world.center);
    const length = offset.magnitude;
    const normal = length > 1e-9 ? offset.mul(1 / length) : new Vector3(0, 1, 0);
    return { point: world.center.add(normal.mul(world.radius)), normal, distance: Math.abs(length - world.radius), inside: length < world.radius };
  }
}

export class BoxCollider extends Collider {
  constructor() {
    super();
    this.size = new Vector3(1, 1, 1);
  }
  static fields = ['enabled', 'isTrigger', 'center', 'size'];
  _load(props, revive, data) {
    this._loadCollider(props, revive, data);
    if (props.m_Size) this.size = revive(props.m_Size);
  }
  get bounds() {
    return WorldBounds(this.transform._world4(), this.center, this.size.mul(0.5));
  }
  _ray(origin, direction, maxDistance) {
    const world = this.transform._world4();
    const inverse = m4Invert(world);
    const o = m4Point(inverse, origin.x, origin.y, origin.z).sub(this.center);
    const d = m4Vector(inverse, direction.x, direction.y, direction.z);
    let near = 0;
    let far = maxDistance;
    let axis = null;
    let sign = 0;
    for (const key of ['x', 'y', 'z']) {
      const half = this.size[key] / 2;
      if (Math.abs(d[key]) < 1e-12) {
        if (Math.abs(o[key]) > half) return null;
        continue;
      }
      let t0 = (-half - o[key]) / d[key];
      let t1 = (half - o[key]) / d[key];
      const flip = t0 > t1;
      if (flip) [t0, t1] = [t1, t0];
      if (t0 > near) {
        near = t0;
        axis = key;
        sign = flip ? 1 : -1;
      }
      far = Math.min(far, t1);
      if (near > far) return null;
    }
    const local = new Vector3();
    if (axis) local[axis] = sign;
    const normal = axis ? m4Vector([inverse[0], inverse[4], inverse[8], 0, inverse[1], inverse[5], inverse[9], 0, inverse[2], inverse[6], inverse[10], 0, 0, 0, 0, 1], local.x, local.y, local.z).normalized : direction.mul(-1);
    return { distance: near, point: origin.add(direction.mul(near)), normal };
  }
  _surface(point) {
    const world = this.transform._world4();
    const local = m4Point(m4Invert(world), point.x, point.y, point.z).sub(this.center);
    const scale = this.transform.lossyScale;
    const clamped = new Vector3();
    let inside = true;
    let best = null;
    let depth = Infinity;
    for (const key of ['x', 'y', 'z']) {
      const half = this.size[key] / 2;
      clamped[key] = Math.max(-half, Math.min(half, local[key]));
      if (clamped[key] !== local[key]) inside = false;
      const gap = (half - Math.abs(local[key])) * scale[key];
      if (gap < depth) {
        depth = gap;
        best = key;
      }
    }
    if (inside) clamped[best] = (local[best] < 0 ? -1 : 1) * (this.size[best] / 2);
    const surface = m4Point(world, clamped.x + this.center.x, clamped.y + this.center.y, clamped.z + this.center.z);
    const offset = inside ? surface.sub(point) : point.sub(surface);
    const distance = offset.magnitude;
    return { point: surface, normal: distance > 1e-9 ? offset.mul(1 / distance) : new Vector3(0, 1, 0), distance, inside };
  }
}

export class CapsuleCollider extends Collider {
  constructor() {
    super();
    this.radius = 0.5;
    this.height = 2;
    this.direction = 1;
  }
  static fields = ['enabled', 'isTrigger', 'center', 'radius', 'height', 'direction'];
  _load(props, revive, data) {
    this._loadCollider(props, revive, data);
    this.radius = props.m_Radius;
    this.height = props.m_Height;
    this.direction = props.m_Direction === undefined ? 1 : props.m_Direction;
  }
  _world() {
    const keys = ['x', 'y', 'z'];
    const along = keys[this.direction];
    const scale = this.transform.lossyScale;
    const radius = this.radius * Math.max(...keys.filter((key) => key !== along).map((key) => scale[key]));
    const half = Math.max(0, (this.height * scale[along]) / 2 - radius);
    const axis = new Vector3();
    axis[along] = 1;
    const center = this.transform.TransformPoint(this.center);
    const offset = this.transform.rotation.mul(axis).mul(half);
    return { a: center.sub(offset), b: center.add(offset), radius };
  }
  get bounds() {
    const world = this._world();
    const size = new Vector3(Math.abs(world.a.x - world.b.x) + world.radius * 2, Math.abs(world.a.y - world.b.y) + world.radius * 2, Math.abs(world.a.z - world.b.z) + world.radius * 2);
    return new Bounds(world.a.add(world.b).mul(0.5), size);
  }
  _ray(origin, direction, maxDistance) {
    const world = this._world();
    const axis = world.b.sub(world.a);
    const length = axis.magnitude;
    let best = -1;
    for (const end of [world.a, world.b]) {
      const t = raySphere(origin, direction, end, world.radius);
      if (t >= 0 && (best < 0 || t < best)) best = t;
    }
    if (length > 1e-9) {
      const n = axis.mul(1 / length);
      const m = origin.sub(world.a);
      const dPerp = direction.sub(n.mul(Vector3.Dot(direction, n)));
      const mPerp = m.sub(n.mul(Vector3.Dot(m, n)));
      const a = Vector3.Dot(dPerp, dPerp);
      const b = Vector3.Dot(dPerp, mPerp);
      const c = Vector3.Dot(mPerp, mPerp) - world.radius * world.radius;
      const discriminant = b * b - a * c;
      if (a > 1e-12 && discriminant >= 0) {
        const t = Math.max(0, (-b - Math.sqrt(discriminant)) / a);
        const along = Vector3.Dot(m.add(direction.mul(t)), n);
        if (along >= 0 && along <= length && (c <= 0 || b <= 0) && (best < 0 || t < best)) best = t;
      }
    }
    if (best < 0 || best > maxDistance) return null;
    const point = origin.add(direction.mul(best));
    return { distance: best, point, normal: this._surface(point).normal };
  }
  _surface(point) {
    const world = this._world();
    const axis = world.b.sub(world.a);
    const length = Vector3.Dot(axis, axis);
    const t = length > 1e-12 ? Math.max(0, Math.min(1, Vector3.Dot(point.sub(world.a), axis) / length)) : 0;
    const on = world.a.add(axis.mul(t));
    const offset = point.sub(on);
    const distance = offset.magnitude;
    const normal = distance > 1e-9 ? offset.mul(1 / distance) : new Vector3(0, 1, 0);
    return { point: on.add(normal.mul(world.radius)), normal, distance: Math.abs(distance - world.radius), inside: distance < world.radius };
  }
}

export class MeshCollider extends Collider {
  constructor() {
    super();
    this.sharedMesh = null;
    this.convex = false;
    this._cache = null;
  }
  static fields = ['enabled', 'isTrigger', 'sharedMesh', 'convex'];
  _load(props, revive, data) {
    this._loadCollider(props, revive, data);
    this.sharedMesh = revive(props.m_Mesh);
    this.convex = !!props.m_Convex;
  }
  _triangles() {
    const mesh = this.sharedMesh;
    if (!(mesh instanceof Mesh)) return { points: [], indices: [], bounds: new Bounds(this.transform.position, new Vector3()) };
    const world = this.transform._world4();
    const key = world.join(',');
    if (this._cache && this._cache.key === key && this._cache.mesh === mesh) return this._cache;
    const data = mesh._decoded();
    const points = [];
    for (let i = 0; i < data.positions.length; i += 3) points.push(m4Point(world, data.positions[i], data.positions[i + 1], data.positions[i + 2]));
    const flip = world[0] * (world[5] * world[10] - world[6] * world[9]) - world[4] * (world[1] * world[10] - world[2] * world[9]) + world[8] * (world[1] * world[6] - world[2] * world[5]) < 0;
    this._cache = { key, mesh, points, indices: data.indices, flip, bounds: WorldBounds(world, data.center, data.extents) };
    return this._cache;
  }
  get bounds() {
    return this._triangles().bounds;
  }
  _ray(origin, direction, maxDistance) {
    const cache = this._triangles();
    let best = null;
    for (let i = 0; i < cache.indices.length; i += 3) {
      const a = cache.points[cache.indices[i]];
      const b = cache.points[cache.indices[i + (cache.flip ? 2 : 1)]];
      const c = cache.points[cache.indices[i + (cache.flip ? 1 : 2)]];
      const ab = b.sub(a);
      const ac = c.sub(a);
      const normal = Vector3.Cross(ab, ac);
      const facing = Vector3.Dot(normal, direction);
      if (facing >= -1e-12) continue;
      const t = Vector3.Dot(normal, a.sub(origin)) / facing;
      if (t < 0 || t > maxDistance || (best && t >= best.distance)) continue;
      const point = origin.add(direction.mul(t));
      const ap = point.sub(a);
      const d00 = Vector3.Dot(ab, ab);
      const d01 = Vector3.Dot(ab, ac);
      const d11 = Vector3.Dot(ac, ac);
      const d20 = Vector3.Dot(ap, ab);
      const d21 = Vector3.Dot(ap, ac);
      const k = d00 * d11 - d01 * d01;
      const v = (d11 * d20 - d01 * d21) / k;
      const w = (d00 * d21 - d01 * d20) / k;
      if (v < -1e-7 || w < -1e-7 || v + w > 1 + 1e-7) continue;
      best = { distance: t, point, normal: normal.normalized };
    }
    return best;
  }
  _surface(point, reach = Infinity) {
    const cache = this._triangles();
    const box = cache.bounds;
    if (reach < Infinity) {
      const d = point.sub(box.center);
      if (Math.abs(d.x) > box.extents.x + reach || Math.abs(d.y) > box.extents.y + reach || Math.abs(d.z) > box.extents.z + reach) return null;
    }
    let best = null;
    for (let i = 0; i < cache.indices.length; i += 3) {
      const a = cache.points[cache.indices[i]];
      const b = cache.points[cache.indices[i + (cache.flip ? 2 : 1)]];
      const c = cache.points[cache.indices[i + (cache.flip ? 1 : 2)]];
      const face = Vector3.Cross(b.sub(a), c.sub(a));
      if (Vector3.Dot(face, point.sub(a)) < 0) continue;
      const on = closestOnTriangle(point, a, b, c);
      const offset = point.sub(on);
      const distance = offset.magnitude;
      if (best && distance >= best.distance) continue;
      best = { point: on, normal: distance > 1e-9 ? offset.mul(1 / distance) : face.normalized, distance, inside: false };
    }
    return best;
  }
  _contact(center, radius, margin) {
    const surface = this._surface(center, radius + margin);
    if (!surface) return null;
    const separation = surface.distance - radius;
    return separation < margin ? { separation, normal: surface.normal, point: surface.point, collider: this } : null;
  }
}

export class Rigidbody extends Component {
  constructor() {
    super();
    this.mass = 1;
    this.linearDamping = 0;
    this.useGravity = true;
    this.isKinematic = false;
    this.constraints = 0;
    this._velocity = new Vector3();
    this._acceleration = new Vector3();
    this._impulse = new Vector3();
    this._touching = new Map();
    this._inside = new Set();
  }
  static fields = ['mass', 'linearDamping', 'useGravity', 'isKinematic', 'constraints'];
  _load(props) {
    this.mass = props.m_Mass === undefined ? 1 : props.m_Mass;
    this.linearDamping = props.m_LinearDamping !== undefined ? props.m_LinearDamping : props.m_Drag || 0;
    this.useGravity = props.m_UseGravity === undefined ? true : !!props.m_UseGravity;
    this.isKinematic = !!props.m_IsKinematic;
    this.constraints = props.m_Constraints || 0;
  }
  get linearVelocity() {
    return this._velocity.clone();
  }
  set linearVelocity(value) {
    this._velocity = Vector3.From(value);
  }
  get velocity() {
    return this._velocity.clone();
  }
  set velocity(value) {
    this._velocity = Vector3.From(value);
  }
  get drag() {
    return this.linearDamping;
  }
  set drag(value) {
    this.linearDamping = value;
  }
  get position() {
    return this.transform.position;
  }
  set position(value) {
    this.transform.position = value;
  }
  get rotation() {
    return this.transform.rotation;
  }
  set rotation(value) {
    this.transform.rotation = value;
  }
  AddForce(x, y, z, mode) {
    const vector = typeof x === 'object';
    const force = vector ? x : new Vector3(x, y, z);
    const kind = (vector ? y : mode) || 0;
    if (kind === ForceMode.Force) this._acceleration = this._acceleration.add(force.mul(1 / this.mass));
    else if (kind === ForceMode.Acceleration) this._acceleration = this._acceleration.add(force);
    else this._impulse = this._impulse.add(kind === ForceMode.Impulse ? force.mul(1 / this.mass) : force);
  }
  MovePosition(position) {
    this.transform.position = position;
  }
  MoveRotation(rotation) {
    this.transform.rotation = rotation;
  }
  _freeze() {
    const v = this._velocity;
    if (this.constraints & 2) v.x = 0;
    if (this.constraints & 4) v.y = 0;
    if (this.constraints & 8) v.z = 0;
  }
  _simulate(dt, own, others) {
    const contacts = [];
    if (!this.isKinematic) {
      let v = this._velocity.add(this._acceleration.mul(dt)).add(this._impulse);
      if (this.useGravity) v = v.add(Physics.gravity.mul(dt));
      this._velocity = v.mul(Math.max(0, 1 - this.linearDamping * dt));
      this._freeze();
    }
    this._acceleration = new Vector3();
    this._impulse = new Vector3();
    const overlaps = new Set();
    for (const shape of own) {
      const sphere = shape instanceof SphereCollider ? shape._world() : null;
      const box = sphere ? null : shape.bounds;
      for (const other of others) {
        const trigger = shape.isTrigger || other.isTrigger;
        if (sphere) {
          const contact = other._contact(sphere.center, sphere.radius, trigger ? 0 : Physics.defaultContactOffset * 2);
          if (!contact) continue;
          if (trigger) overlaps.add(other);
          else if (!this.isKinematic) contacts.push(contact);
        } else if (trigger && box.Intersects(other.bounds)) {
          overlaps.add(other);
        }
      }
    }
    if (!this.isKinematic) {
      let move = this._velocity.clone();
      for (let pass = 0; pass < 4; pass++) {
        for (const contact of contacts) {
          const gap = contact.separation;
          const speed = Vector3.Dot(this._velocity, contact.normal);
          const limit = gap >= 0 ? (-gap * Physics.depenetration) / dt : 0;
          if (speed < limit) this._velocity = this._velocity.add(contact.normal.mul(limit - speed));
          const push = gap >= 0 ? limit : Math.min((-gap * Physics.depenetration) / dt, Physics.defaultMaxDepenetrationVelocity);
          const moving = Vector3.Dot(move, contact.normal);
          if (moving < push) move = move.add(contact.normal.mul(push - moving));
        }
        this._freeze();
        if (this.constraints & 2) move.x = 0;
        if (this.constraints & 4) move.y = 0;
        if (this.constraints & 8) move.z = 0;
      }
      const transform = this.transform;
      transform.position = transform.position.add(move.mul(dt));
    }
    return { contacts, overlaps };
  }
}

export class Collision {
  constructor(collider, body, contacts, relativeVelocity) {
    this.collider = collider;
    this.rigidbody = body;
    this.contacts = contacts;
    this.relativeVelocity = relativeVelocity;
  }
  get gameObject() {
    return (this.rigidbody || this.collider).gameObject;
  }
  get transform() {
    return this.gameObject.transform;
  }
  get contactCount() {
    return this.contacts.length;
  }
  GetContact(index) {
    return this.contacts[index];
  }
}

function castArguments(args) {
  let index = 2;
  let origin = args[0];
  let direction = args[1];
  if (args[0] instanceof Ray) {
    origin = args[0].origin;
    direction = args[0].direction;
    index = 1;
  } else {
    direction = Vector3.From(direction).normalized;
  }
  const hit = args[index] instanceof RaycastHit ? args[index++] : null;
  const maxDistance = args[index] === undefined ? Infinity : args[index];
  const mask = args[index + 1] === undefined ? -5 : args[index + 1];
  return { origin: Vector3.From(origin), direction, hit, maxDistance, mask };
}

function castAll(origin, direction, maxDistance, mask) {
  const hits = [];
  for (const collider of FindObjectsOfType(Collider)) {
    if (!collider.enabled || ((mask >>> collider.gameObject.layer) & 1) === 0) continue;
    const found = collider._ray(origin, direction, maxDistance);
    if (!found) continue;
    const hit = new RaycastHit();
    hit.point = found.point;
    hit.normal = found.normal;
    hit.distance = found.distance;
    hit.collider = collider;
    hits.push(hit);
  }
  return hits.sort((a, b) => a.distance - b.distance);
}

const fixedClock = { origin: 0, fixed: 0 };

export const Physics = {
  gravity: new Vector3(0, -9.81, 0),
  defaultContactOffset: 0.01,
  defaultMaxDepenetrationVelocity: 10,
  depenetration: 0.8,
  startTime: 0,
  simulate: true,
  DefaultRaycastLayers: -5,
  AllLayers: -1,

  Raycast(...args) {
    const cast = castArguments(args);
    const hits = castAll(cast.origin, cast.direction, cast.maxDistance, cast.mask);
    if (hits.length === 0) return false;
    if (cast.hit) Object.assign(cast.hit, hits[0]);
    return true;
  },

  RaycastAll(...args) {
    const cast = castArguments(args);
    return castAll(cast.origin, cast.direction, cast.maxDistance, cast.mask);
  },

  OverlapSphere(position, radius, mask = -1) {
    const center = Vector3.From(position);
    return FindObjectsOfType(Collider).filter((collider) => collider.enabled && ((mask >>> collider.gameObject.layer) & 1) !== 0 && !!collider._contact(center, radius, 0));
  },

  CheckSphere(position, radius, mask = -1) {
    return this.OverlapSphere(position, radius, mask).length > 0;
  },

  step(dt) {
    const saved = [Time.deltaTime, Time.time];
    Time.deltaTime = dt;
    Time.time = Math.fround(fixedClock.origin + fixedClock.fixed);
    Time.inFixedTimeStep = true;
    for (const behaviour of FindObjectsOfType(MonoBehaviour)) {
      if (behaviour._active && behaviour._started && typeof behaviour.FixedUpdate === 'function') behaviour.FixedUpdate();
    }
    const bodies = FindObjectsOfType(Rigidbody);
    if (bodies.length > 0) {
      const colliders = FindObjectsOfType(Collider).filter((collider) => collider.enabled);
      const owners = new Map();
      for (const collider of colliders) owners.set(collider, collider.attachedRigidbody);
      const events = [];
      for (const body of bodies) {
        const own = colliders.filter((collider) => owners.get(collider) === body);
        const others = colliders.filter((collider) => owners.get(collider) !== body);
        const before = body._velocity.clone();
        const result = body._simulate(dt, own, others);
        const touching = new Map();
        for (const contact of result.contacts) {
          if (!touching.has(contact.collider)) touching.set(contact.collider, []);
          touching.get(contact.collider).push(contact);
        }
        for (const [collider, contacts] of touching) {
          events.push([body._touching.has(collider) ? 'OnCollisionStay' : 'OnCollisionEnter', body, collider, contacts, before]);
        }
        for (const collider of body._touching.keys()) {
          if (!touching.has(collider)) events.push(['OnCollisionExit', body, collider, [], before]);
        }
        body._touching = touching;
        for (const collider of result.overlaps) events.push([body._inside.has(collider) ? 'OnTriggerStay' : 'OnTriggerEnter', body, collider]);
        for (const collider of body._inside) {
          if (!result.overlaps.has(collider)) events.push(['OnTriggerExit', body, collider]);
        }
        body._inside = result.overlaps;
      }
      for (const [message, body, collider, contacts, velocity] of events) {
        if (body._destroyed) continue;
        const mine = body.gameObject.GetComponentInChildren(Collider);
        if (contacts) {
          const other = owners.get(collider) || null;
          body.gameObject.SendMessage(message, new Collision(collider, other, contacts, velocity.mul(-1)));
          if (!collider._destroyed) (other || collider).gameObject.SendMessage(message, new Collision(mine, body, contacts, velocity));
        } else {
          body.gameObject.SendMessage(message, collider);
          if (!collider._destroyed && mine) collider.gameObject.SendMessage(message, mine);
        }
      }
    }
    Time.inFixedTimeStep = false;
    Time.deltaTime = saved[0];
    Time.time = saved[1];
  },

  frame(ahead) {
    if (!Physics.simulate) return;
    const now = Time.timeAsDouble;
    const next = now + (ahead || 0) * Time.timeScale;
    const dt = Math.fround(Time.fixedDeltaTime);
    let steps = 0;
    Time.timeAsDouble = next;
    if (ahead) Time.frameCount++;
    while (fixedClock.fixed + dt <= next - fixedClock.origin && steps < 16) {
      if (steps === 0) Engine.flushStart();
      fixedClock.fixed += dt;
      Time.fixedTime = Math.fround(fixedClock.fixed);
      Physics.step(dt);
      steps++;
    }
    if (ahead) Time.frameCount--;
    Time.timeAsDouble = now;
  },
};

Engine.early.push(Physics.frame);
Engine.preUpdate.unshift(() => Physics.frame(0));

SceneManager.sceneLoaded.AddListener(() => {
  fixedClock.origin = Time.timeAsDouble - Physics.startTime;
  fixedClock.fixed = 0;
});

export class PhysicsRaycaster extends Behaviour {
  constructor() {
    super();
    this.eventMask = -1;
  }
  static fields = ['eventMask'];
  static last = null;
  _load(props) {
    if (typeof props.m_EventMask === 'number') this.eventMask = props.m_EventMask | 0;
  }
}

WorldRaycasters.push((x, y) => {
  if (x < 0 || y < 0 || x >= Screen.width || y >= Screen.height) return null;
  for (const camera of Camera.all.reverse()) {
    const raycaster = camera.gameObject.GetComponent(PhysicsRaycaster);
    if (!raycaster || !raycaster._enabled) continue;
    const ray = camera.ScreenPointToRay(new Vector3(x, y, 0));
    const hits = castAll(ray.origin, ray.direction, camera.farClipPlane - camera.nearClipPlane, camera.cullingMask & raycaster.eventMask);
    if (hits.length === 0) continue;
    PhysicsRaycaster.last = hits[0];
    return hits[0].collider.gameObject;
  }
  return null;
});

registerComponentType('UnityEngine.BoxCollider', BoxCollider);
registerComponentType('UnityEngine.SphereCollider', SphereCollider);
registerComponentType('UnityEngine.CapsuleCollider', CapsuleCollider);
registerComponentType('UnityEngine.MeshCollider', MeshCollider);
registerComponentType('UnityEngine.Rigidbody', Rigidbody);
registerComponentType('UnityEngine.EventSystems.PhysicsRaycaster', PhysicsRaycaster);
