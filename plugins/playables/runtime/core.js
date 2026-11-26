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
  constructor(x = 0, y = 0, z = 0, w = 1, euler = null) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.w = w;
    this._euler = euler || new Vector3(0, 0, Math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z)) * Mathf.Rad2Deg);
  }
  static get identity() {
    return new Quaternion(0, 0, 0, 1, new Vector3());
  }
  static Euler(x, y, z) {
    const euler = typeof x === 'object' ? Vector3.From(x) : new Vector3(x, y, z);
    const half = (euler.z * Mathf.Deg2Rad) / 2;
    return new Quaternion(0, 0, Math.sin(half), Math.cos(half), euler);
  }
  static AngleAxis(angle, axis) {
    return Quaternion.Euler(axis.x * angle, axis.y * angle, axis.z * angle);
  }
  get eulerAngles() {
    return this._euler.clone();
  }
  clone() {
    return new Quaternion(this.x, this.y, this.z, this.w, this._euler.clone());
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
