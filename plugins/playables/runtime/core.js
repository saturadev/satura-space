export const Mathf = {
  PI: Math.PI,
  Infinity: Infinity,
  NegativeInfinity: -Infinity,
  Deg2Rad: Math.PI / 180,
  Rad2Deg: 180 / Math.PI,
  Epsilon: 1.401298e-45,
  Abs: Math.abs,
  Sqrt: Math.sqrt,
  Sin: Math.sin,
  Cos: Math.cos,
  Tan: Math.tan,
  Atan2: Math.atan2,
  Pow: Math.pow,
  Exp: Math.exp,
  Floor: Math.floor,
  Ceil: Math.ceil,
  Max: (...values) => Math.max(...values),
  Min: (...values) => Math.min(...values),
  Sign: (value) => (value >= 0 ? 1 : -1),
  FloorToInt: (value) => Math.floor(value),
  CeilToInt: (value) => Math.ceil(value),
  Round(value) {
    const floor = Math.floor(value);
    const diff = value - floor;
    if (diff < 0.5) return floor;
    if (diff > 0.5) return floor + 1;
    return floor % 2 === 0 ? floor : floor + 1;
  },
  RoundToInt: (value) => Mathf.Round(value),
  Clamp: (value, min, max) => (value < min ? min : value > max ? max : value),
  Clamp01: (value) => (value < 0 ? 0 : value > 1 ? 1 : value),
  Lerp: (a, b, t) => a + (b - a) * Mathf.Clamp01(t),
  LerpUnclamped: (a, b, t) => a + (b - a) * t,
  InverseLerp: (a, b, value) => (a !== b ? Mathf.Clamp01((value - a) / (b - a)) : 0),
  Repeat: (t, length) => Mathf.Clamp(t - Math.floor(t / length) * length, 0, length),
  PingPong(t, length) {
    const repeated = Mathf.Repeat(t, length * 2);
    return length - Math.abs(repeated - length);
  },
  SmoothStep(from, to, t) {
    const clamped = Mathf.Clamp01(t);
    const eased = -2 * clamped * clamped * clamped + 3 * clamped * clamped;
    return to * eased + from * (1 - eased);
  },
  MoveTowards: (current, target, maxDelta) =>
    Math.abs(target - current) <= maxDelta ? target : current + Mathf.Sign(target - current) * maxDelta,
  Approximately: (a, b) => Math.abs(b - a) < Math.max(1e-6 * Math.max(Math.abs(a), Math.abs(b)), 1.121039e-44),
};

export function CsInt(value) {
  return value < 0 ? Math.ceil(value) : Math.floor(value);
}

export class Vector2 {
  constructor(x = 0, y = 0) {
    this.x = x;
    this.y = y;
  }
  static get zero() {
    return new Vector2(0, 0);
  }
  static get one() {
    return new Vector2(1, 1);
  }
  static get up() {
    return new Vector2(0, 1);
  }
  static get right() {
    return new Vector2(1, 0);
  }
  static Lerp(a, b, t) {
    const k = Mathf.Clamp01(t);
    return new Vector2(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k);
  }
  static Distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }
  get magnitude() {
    return Math.hypot(this.x, this.y);
  }
  get normalized() {
    const length = this.magnitude;
    return length > 1e-9 ? new Vector2(this.x / length, this.y / length) : new Vector2();
  }
  clone() {
    return new Vector2(this.x, this.y);
  }
  Set(x, y) {
    this.x = x;
    this.y = y;
  }
  add(other) {
    return new Vector2(this.x + other.x, this.y + other.y);
  }
  sub(other) {
    return new Vector2(this.x - other.x, this.y - other.y);
  }
  mul(scalar) {
    return new Vector2(this.x * scalar, this.y * scalar);
  }
  Equals(other) {
    return other != null && this.x === other.x && this.y === other.y;
  }
}

export class Vector3 {
  constructor(x = 0, y = 0, z = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  static get zero() {
    return new Vector3(0, 0, 0);
  }
  static get one() {
    return new Vector3(1, 1, 1);
  }
  static get up() {
    return new Vector3(0, 1, 0);
  }
  static get right() {
    return new Vector3(1, 0, 0);
  }
  static get forward() {
    return new Vector3(0, 0, 1);
  }
  static get down() {
    return new Vector3(0, -1, 0);
  }
  static get left() {
    return new Vector3(-1, 0, 0);
  }
  static get back() {
    return new Vector3(0, 0, -1);
  }
  static Dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z;
  }
  static Cross(a, b) {
    return new Vector3(a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x);
  }
  static Scale(a, b) {
    return new Vector3(a.x * b.x, a.y * b.y, a.z * b.z);
  }
  static Angle(a, b) {
    const length = Math.sqrt(Vector3.Dot(a, a) * Vector3.Dot(b, b));
    return length < 1e-15 ? 0 : Math.acos(Mathf.Clamp(Vector3.Dot(a, b) / length, -1, 1)) * Mathf.Rad2Deg;
  }
  static Normalize(value) {
    return Vector3.From(value).normalized;
  }
  static Project(vector, normal) {
    const length = Vector3.Dot(normal, normal);
    return length < 1e-15 ? new Vector3() : Vector3.From(normal).mul(Vector3.Dot(vector, normal) / length);
  }
  static ProjectOnPlane(vector, normal) {
    return Vector3.From(vector).sub(Vector3.Project(vector, normal));
  }
  static From(value) {
    return new Vector3(value.x, value.y, value.z === undefined ? 0 : value.z);
  }
  static Lerp(a, b, t) {
    const k = Mathf.Clamp01(t);
    const az = a.z === undefined ? 0 : a.z;
    const bz = b.z === undefined ? 0 : b.z;
    return new Vector3(a.x + (b.x - a.x) * k, a.y + (b.y - a.y) * k, az + (bz - az) * k);
  }
  static LerpUnclamped(a, b, t) {
    return new Vector3(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t);
  }
  static Distance(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
  }
  static MoveTowards(current, target, maxDelta) {
    const delta = target.sub(current);
    const distance = delta.magnitude;
    if (distance <= maxDelta || distance === 0) return target.clone();
    return current.add(delta.mul(maxDelta / distance));
  }
  get magnitude() {
    return Math.hypot(this.x, this.y, this.z);
  }
  get sqrMagnitude() {
    return this.x * this.x + this.y * this.y + this.z * this.z;
  }
  get normalized() {
    const length = this.magnitude;
    return length > 1e-9 ? this.mul(1 / length) : new Vector3();
  }
  clone() {
    return new Vector3(this.x, this.y, this.z);
  }
  Set(x, y, z) {
    this.x = x;
    this.y = y;
    this.z = z;
  }
  add(other) {
    return new Vector3(this.x + other.x, this.y + other.y, this.z + (other.z || 0));
  }
  sub(other) {
    return new Vector3(this.x - other.x, this.y - other.y, this.z - (other.z || 0));
  }
  mul(scalar) {
    return new Vector3(this.x * scalar, this.y * scalar, this.z * scalar);
  }
  Equals(other) {
    return other != null && this.x === other.x && this.y === other.y && this.z === other.z;
  }
}

export class Vector4 {
  constructor(x = 0, y = 0, z = 0, w = 0) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
  clone() {
    return new Vector4(this.x, this.y, this.z, this.w);
  }
}

export class Quaternion {
  constructor(x = 0, y = 0, z = 0, w = 1) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
  }
  static get identity() {
    return new Quaternion(0, 0, 0, 1);
  }
  static Euler(x, y, z) {
    const euler = typeof x === 'object' ? x : { x, y, z };
    const hx = (euler.x * Mathf.Deg2Rad) / 2;
    const hy = (euler.y * Mathf.Deg2Rad) / 2;
    const hz = ((euler.z || 0) * Mathf.Deg2Rad) / 2;
    const sx = Math.sin(hx);
    const cx = Math.cos(hx);
    const sy = Math.sin(hy);
    const cy = Math.cos(hy);
    const sz = Math.sin(hz);
    const cz = Math.cos(hz);
    return new Quaternion(cy * sx * cz + sy * cx * sz, sy * cx * cz - cy * sx * sz, cy * cx * sz - sy * sx * cz, cy * cx * cz + sy * sx * sz);
  }
  static AngleAxis(angle, axis) {
    const direction = Vector3.From(axis).normalized;
    const half = (angle * Mathf.Deg2Rad) / 2;
    const sin = Math.sin(half);
    return new Quaternion(direction.x * sin, direction.y * sin, direction.z * sin, Math.cos(half));
  }
  static FromBasis(r, u, f) {
    const trace = r.x + u.y + f.z;
    if (trace > 0) {
      const s = Math.sqrt(trace + 1) * 2;
      return new Quaternion((u.z - f.y) / s, (f.x - r.z) / s, (r.y - u.x) / s, s / 4);
    }
    if (r.x > u.y && r.x > f.z) {
      const s = Math.sqrt(1 + r.x - u.y - f.z) * 2;
      return new Quaternion(s / 4, (u.x + r.y) / s, (f.x + r.z) / s, (u.z - f.y) / s);
    }
    if (u.y > f.z) {
      const s = Math.sqrt(1 + u.y - r.x - f.z) * 2;
      return new Quaternion((u.x + r.y) / s, s / 4, (f.y + u.z) / s, (f.x - r.z) / s);
    }
    const s = Math.sqrt(1 + f.z - r.x - u.y) * 2;
    return new Quaternion((f.x + r.z) / s, (f.y + u.z) / s, s / 4, (r.y - u.x) / s);
  }
  static LookRotation(forward, up = Vector3.up) {
    const f = Vector3.From(forward).normalized;
    if (f.sqrMagnitude === 0) return Quaternion.identity;
    const r = Vector3.Cross(up, f).normalized;
    if (r.sqrMagnitude === 0) return Quaternion.FromToRotation(Vector3.forward, f);
    return Quaternion.FromBasis(r, Vector3.Cross(f, r), f);
  }
  static FromToRotation(from, to) {
    const a = Vector3.From(from).normalized;
    const b = Vector3.From(to).normalized;
    const dot = Vector3.Dot(a, b);
    if (dot > 0.999999) return Quaternion.identity;
    if (dot < -0.999999) {
      let axis = Vector3.Cross(Vector3.right, a);
      if (axis.sqrMagnitude < 1e-6) axis = Vector3.Cross(Vector3.up, a);
      return Quaternion.AngleAxis(180, axis);
    }
    const cross = Vector3.Cross(a, b);
    return new Quaternion(cross.x, cross.y, cross.z, 1 + dot).normalized;
  }
  static Inverse(q) {
    return new Quaternion(-q.x, -q.y, -q.z, q.w);
  }
  static Dot(a, b) {
    return a.x * b.x + a.y * b.y + a.z * b.z + a.w * b.w;
  }
  static Angle(a, b) {
    const dot = Math.min(Math.abs(Quaternion.Dot(a, b)), 1);
    return dot > 0.999999 ? 0 : Math.acos(dot) * 2 * Mathf.Rad2Deg;
  }
  static SlerpUnclamped(a, b, t) {
    let dot = Quaternion.Dot(a, b);
    const sign = dot < 0 ? -1 : 1;
    dot *= sign;
    let ka = 1 - t;
    let kb = t;
    if (dot < 0.9995) {
      const angle = Math.acos(dot);
      const sin = Math.sin(angle);
      ka = Math.sin((1 - t) * angle) / sin;
      kb = Math.sin(t * angle) / sin;
    }
    kb *= sign;
    return new Quaternion(a.x * ka + b.x * kb, a.y * ka + b.y * kb, a.z * ka + b.z * kb, a.w * ka + b.w * kb).normalized;
  }
  static Slerp(a, b, t) {
    return Quaternion.SlerpUnclamped(a, b, Mathf.Clamp01(t));
  }
  static Lerp(a, b, t) {
    const k = Mathf.Clamp01(t);
    const sign = Quaternion.Dot(a, b) < 0 ? -1 : 1;
    return new Quaternion(a.x + (b.x * sign - a.x) * k, a.y + (b.y * sign - a.y) * k, a.z + (b.z * sign - a.z) * k, a.w + (b.w * sign - a.w) * k).normalized;
  }
  static RotateTowards(from, to, maxDegreesDelta) {
    const angle = Quaternion.Angle(from, to);
    return angle === 0 ? to.clone() : Quaternion.SlerpUnclamped(from, to, Math.min(1, maxDegreesDelta / angle));
  }
  get normalized() {
    const length = Math.hypot(this.x, this.y, this.z, this.w);
    return length < 1e-15 ? Quaternion.identity : new Quaternion(this.x / length, this.y / length, this.z / length, this.w / length);
  }
  get eulerAngles() {
    const q = this.normalized;
    const sin = 2 * (q.w * q.x - q.y * q.z);
    let x;
    let y;
    let z = 0;
    if (Math.abs(sin) < 0.9999999) {
      x = Math.asin(sin);
      y = Math.atan2(2 * (q.x * q.z + q.w * q.y), 1 - 2 * (q.x * q.x + q.y * q.y));
      z = Math.atan2(2 * (q.x * q.y + q.w * q.z), 1 - 2 * (q.x * q.x + q.z * q.z));
    } else {
      x = (Math.PI / 2) * Math.sign(sin);
      y = Math.atan2(-2 * (q.x * q.z - q.w * q.y), 1 - 2 * (q.y * q.y + q.z * q.z));
    }
    const positive = (radians) => {
      const degrees = radians * Mathf.Rad2Deg;
      return degrees < -0.005729578 ? degrees + 360 : degrees > 359.99427 ? degrees - 360 : degrees;
    };
    return new Vector3(positive(x), positive(y), positive(z));
  }
  mul(other) {
    const { x, y, z, w } = this;
    if (other.w === undefined) {
      const tx = 2 * (y * other.z - z * other.y);
      const ty = 2 * (z * other.x - x * other.z);
      const tz = 2 * (x * other.y - y * other.x);
      return new Vector3(other.x + w * tx + y * tz - z * ty, other.y + w * ty + z * tx - x * tz, other.z + w * tz + x * ty - y * tx);
    }
    return new Quaternion(
      w * other.x + x * other.w + y * other.z - z * other.y,
      w * other.y + y * other.w + z * other.x - x * other.z,
      w * other.z + z * other.w + x * other.y - y * other.x,
      w * other.w - x * other.x - y * other.y - z * other.z
    );
  }
  Equals(other) {
    return other != null && this.x === other.x && this.y === other.y && this.z === other.z && this.w === other.w;
  }
  clone() {
    return new Quaternion(this.x, this.y, this.z, this.w);
  }
}

export class Color {
  constructor(r = 0, g = 0, b = 0, a = 1) {
    this.r = r;
    this.g = g;
    this.b = b;
    this.a = a;
  }
  static get white() {
    return new Color(1, 1, 1, 1);
  }
  static get black() {
    return new Color(0, 0, 0, 1);
  }
  static get clear() {
    return new Color(0, 0, 0, 0);
  }
  static get red() {
    return new Color(1, 0, 0, 1);
  }
  static get green() {
    return new Color(0, 1, 0, 1);
  }
  static get blue() {
    return new Color(0, 0, 1, 1);
  }
  static Lerp(a, b, t) {
    const k = Mathf.Clamp01(t);
    return new Color(a.r + (b.r - a.r) * k, a.g + (b.g - a.g) * k, a.b + (b.b - a.b) * k, a.a + (b.a - a.a) * k);
  }
  clone() {
    return new Color(this.r, this.g, this.b, this.a);
  }
  css(alpha = 1) {
    const channel = (value) => Math.round(Mathf.Clamp01(value) * 255);
    return 'rgba(' + channel(this.r) + ',' + channel(this.g) + ',' + channel(this.b) + ',' + Mathf.Clamp01(this.a * alpha) + ')';
  }
}

export class Rect {
  constructor(x = 0, y = 0, width = 0, height = 0) {
    this.x = x;
    this.y = y;
    this.width = width;
    this.height = height;
  }
  get xMin() {
    return this.x;
  }
  get yMin() {
    return this.y;
  }
  get xMax() {
    return this.x + this.width;
  }
  get yMax() {
    return this.y + this.height;
  }
  get center() {
    return new Vector2(this.x + this.width / 2, this.y + this.height / 2);
  }
  get size() {
    return new Vector2(this.width, this.height);
  }
  Contains(point) {
    return point.x >= this.x && point.x < this.x + this.width && point.y >= this.y && point.y < this.y + this.height;
  }
  clone() {
    return new Rect(this.x, this.y, this.width, this.height);
  }
}

const randomState = new Uint32Array(4);

function randomNext() {
  let t = randomState[0];
  t ^= t << 11;
  t >>>= 0;
  randomState[0] = randomState[1];
  randomState[1] = randomState[2];
  randomState[2] = randomState[3];
  const w = randomState[3];
  randomState[3] = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
  return randomState[3];
}

function randomFloat() {
  return Math.fround(Math.fround(randomNext() & 0x7fffff) * Math.fround(1 / 8388607));
}

export const Random = {
  InitState(seed) {
    randomState[0] = seed >>> 0;
    randomState[1] = (Math.imul(1812433253, randomState[0]) + 1) >>> 0;
    randomState[2] = (Math.imul(1812433253, randomState[1]) + 1) >>> 0;
    randomState[3] = (Math.imul(1812433253, randomState[2]) + 1) >>> 0;
  },
  get state() {
    return Array.from(randomState);
  },
  set state(value) {
    randomState.set(value);
  },
  Range(min, max) {
    if (min < max) return min + (randomNext() % (max - min));
    if (min > max) return min - (randomNext() % (min - max));
    return min;
  },
  RangeFloat(min, max) {
    const t = randomFloat();
    return Math.fround(Math.fround(t * min) + Math.fround(Math.fround(1 - t) * max));
  },
  get value() {
    return randomFloat();
  },
};

Random.InitState((Date.now() ^ 0x9e3779b9) >>> 0);

export const Time = {
  time: 0,
  timeAsDouble: 0,
  deltaTime: 0,
  unscaledTime: 0,
  unscaledTimeAsDouble: 0,
  unscaledDeltaTime: 0,
  timeScale: 1,
  frameCount: 0,
  fixedDeltaTime: 0.02,
  maximumDeltaTime: 1 / 3,
  realtimeSinceStartup: 0,
};

export const Screen = {
  width: 1080,
  height: 1920,
  dpi: 96,
};

export const Debug = {
  Log: (...args) => console.log(...args),
  LogWarning: (...args) => console.warn(...args),
  LogError: (...args) => console.error(...args),
  LogFormat: (...args) => console.log(...args),
  Assert(condition, message) {
    if (!condition) console.error(message || 'Assertion failed');
  },
};

const playerPrefs = new Map();

export const PlayerPrefs = {
  GetInt: (key, fallback = 0) => (playerPrefs.has(key) ? playerPrefs.get(key) : fallback),
  SetInt: (key, value) => playerPrefs.set(key, value | 0),
  GetFloat: (key, fallback = 0) => (playerPrefs.has(key) ? playerPrefs.get(key) : fallback),
  SetFloat: (key, value) => playerPrefs.set(key, value),
  GetString: (key, fallback = '') => (playerPrefs.has(key) ? playerPrefs.get(key) : fallback),
  SetString: (key, value) => playerPrefs.set(key, String(value)),
  HasKey: (key) => playerPrefs.has(key),
  DeleteKey: (key) => playerPrefs.delete(key),
  DeleteAll: () => playerPrefs.clear(),
  Save() {},
};

export function Array2D(width, height, fill = null) {
  const columns = new Array(width);
  for (let x = 0; x < width; x++) columns[x] = new Array(height).fill(fill);
  return columns;
}
