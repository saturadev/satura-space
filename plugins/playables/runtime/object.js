import { Vector2, Vector3, Quaternion, Rect, Mathf, Time } from './core.js';

let nextInstanceId = 1;
let nextMoveStamp = 1;

export class UnityObject {
  constructor() {
    this._id = nextInstanceId++;
    this._destroyed = false;
    this._name = '';
  }
  get name() {
    return this._name;
  }
  set name(value) {
    this._name = value;
  }
  GetInstanceID() {
    return this._id;
  }
}

export function Alive(object) {
  return object != null && !object._destroyed;
}

export function matMul(m, n) {
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}

export function matInvert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-12) return [0, 0, 0, 0, 0, 0];
  const a = m[3] / det;
  const b = -m[1] / det;
  const c = -m[2] / det;
  const d = m[0] / det;
  return [a, b, c, d, -(a * m[4] + c * m[5]), -(b * m[4] + d * m[5])];
}

export function matApply(m, x, y) {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

export class WaitForSeconds {
  constructor(seconds) {
    this.seconds = seconds;
  }
}

export class WaitForSecondsRealtime {
  constructor(seconds) {
    this.seconds = seconds;
  }
}

export class WaitForEndOfFrame {}

export class WaitForFixedUpdate {}

export class WaitUntil {
  constructor(predicate) {
    this.predicate = predicate;
  }
}

export class WaitWhile {
  constructor(predicate) {
    this.predicate = predicate;
  }
}

export class Coroutine {
  constructor(owner, routine) {
    this.owner = owner;
    this.routine = routine;
    this.stack = [routine];
    this.done = false;
    this.wait = null;
    this.frame = 0;
  }
}

function isIterator(value) {
  return value != null && typeof value === 'object' && typeof value.next === 'function';
}

function stepCoroutine(coroutine) {
  while (!coroutine.done) {
    const top = coroutine.stack[coroutine.stack.length - 1];
    const result = top.next();
    if (coroutine.done) return;
    if (result.done) {
      coroutine.stack.pop();
      if (coroutine.stack.length === 0) {
        coroutine.done = true;
        return;
      }
      continue;
    }
    const yielded = result.value;
    coroutine.frame = Time.frameCount;
    if (isIterator(yielded)) {
      coroutine.stack.push(yielded);
      continue;
    }
    if (yielded instanceof WaitForSeconds) coroutine.wait = { until: Time.timeAsDouble + Math.fround(yielded.seconds) };
    else if (yielded instanceof WaitForSecondsRealtime) coroutine.wait = { untilReal: Time.unscaledTimeAsDouble + Math.fround(yielded.seconds) };
    else if (yielded instanceof WaitUntil) coroutine.wait = { predicate: yielded.predicate, expect: true };
    else if (yielded instanceof WaitWhile) coroutine.wait = { predicate: yielded.predicate, expect: false };
    else if (yielded instanceof Coroutine) coroutine.wait = { coroutine: yielded };
    else if (yielded instanceof WaitForEndOfFrame) coroutine.wait = { endOfFrame: true };
    else coroutine.wait = null;
    return;
  }
}

function coroutineReady(coroutine, endOfFrame) {
  const wait = coroutine.wait;
  if (wait && wait.endOfFrame) return endOfFrame;
  if (endOfFrame) return false;
  if (coroutine.frame >= Time.frameCount) return false;
  if (!wait) return true;
  if (wait.until !== undefined) return Time.timeAsDouble >= wait.until;
  if (wait.untilReal !== undefined) return Time.unscaledTimeAsDouble >= wait.untilReal;
  if (wait.predicate) return !!wait.predicate() === wait.expect;
  if (wait.coroutine) return wait.coroutine.done;
  return true;
}

export const Engine = {
  roots: [],
  updates: new Set(),
  startQueue: [],
  coroutines: [],
  destroyQueue: [],
  invokes: [],
  animators: new Set(),
  preUpdate: [],
  pendingLoad: null,
  loadScene: null,
  paused: false,

  reset() {
    this.roots.length = 0;
    this.updates.clear();
    this.startQueue.length = 0;
    this.coroutines.length = 0;
    this.destroyQueue.length = 0;
    this.invokes.length = 0;
    this.animators.clear();
    this.pendingLoad = null;
  },

  flushStart() {
    while (this.startQueue.length > 0) {
      const batch = this.startQueue.splice(0, this.startQueue.length);
      for (const behaviour of batch) {
        behaviour._startQueued = false;
        if (behaviour._destroyed || behaviour._started || !behaviour._active) continue;
        behaviour._started = true;
        if (typeof behaviour.Start === 'function') behaviour.Start();
      }
    }
  },

  runCoroutines(endOfFrame) {
    const snapshot = this.coroutines.slice();
    for (const coroutine of snapshot) {
      if (coroutine.done) continue;
      const owner = coroutine.owner;
      if (owner._destroyed || !owner.gameObject.activeInHierarchy) {
        coroutine.done = true;
        continue;
      }
      if (coroutineReady(coroutine, endOfFrame)) stepCoroutine(coroutine);
    }
    if (!endOfFrame) this.coroutines = this.coroutines.filter((coroutine) => !coroutine.done);
  },

  flushDestroy() {
    if (this.destroyQueue.length === 0) return;
    const remaining = [];
    const due = [];
    for (const entry of this.destroyQueue) {
      if (entry.time <= Time.timeAsDouble) due.push(entry.object);
      else remaining.push(entry);
    }
    this.destroyQueue = remaining;
    for (const object of due) destroyNow(object);
  },

  frame(deltaTime) {
    const clamped = Math.min(deltaTime, Time.maximumDeltaTime);
    Time.unscaledDeltaTime = deltaTime;
    Time.unscaledTimeAsDouble += deltaTime;
    Time.unscaledTime = Math.fround(Time.unscaledTimeAsDouble);
    Time.realtimeSinceStartup += deltaTime;
    Time.deltaTime = Math.fround(clamped * Time.timeScale);
    Time.timeAsDouble += clamped * Time.timeScale;
    Time.time = Math.fround(Time.timeAsDouble);
    Time.frameCount++;

    if (this.pendingLoad !== null && this.loadScene) {
      const name = this.pendingLoad;
      this.pendingLoad = null;
      this.loadScene(name);
    }

    for (const hook of this.preUpdate) hook();
    this.flushStart();

    for (const behaviour of Array.from(this.updates)) {
      if (behaviour._destroyed) {
        this.updates.delete(behaviour);
        continue;
      }
      if (behaviour._active && behaviour._started && typeof behaviour.Update === 'function') behaviour.Update();
    }

    if (this.invokes.length > 0) {
      const invokes = this.invokes;
      this.invokes = [];
      for (const invoke of invokes) {
        const owner = invoke.owner;
        if (owner._destroyed || invoke.cancelled) continue;
        if (Time.timeAsDouble < invoke.time) {
          this.invokes.push(invoke);
          continue;
        }
        owner[invoke.method]();
        if (invoke.repeat > 0 && !invoke.cancelled) {
          invoke.time += Math.fround(invoke.repeat);
          this.invokes.push(invoke);
        }
      }
    }

    this.runCoroutines(false);

    for (const animator of Array.from(this.animators)) {
      if (animator._destroyed) {
        this.animators.delete(animator);
        continue;
      }
      if (animator._active) animator._tick(Time.deltaTime);
    }

    for (const behaviour of Array.from(this.updates)) {
      if (!behaviour._destroyed && behaviour._active && behaviour._started && typeof behaviour.LateUpdate === 'function') behaviour.LateUpdate();
    }

    this.runCoroutines(true);
    this.flushDestroy();
  },
};

function collectActive(gameObject, list) {
  for (const component of gameObject.components) list.push(component);
  for (const child of gameObject.transform._children) {
    if (child.gameObject.activeSelf) collectActive(child.gameObject, list);
  }
}

function activateTree(gameObject) {
  const list = [];
  collectActive(gameObject, list);
  for (const component of list) {
    if (component._destroyed) continue;
    if (!component._awoken) {
      component._awoken = true;
      if (typeof component.Awake === 'function') component.Awake();
    }
    if (component._destroyed || !(component instanceof Behaviour)) continue;
    if (component._enabled && !component._active && component.gameObject.activeInHierarchy) component._activate();
  }
}

function deactivateTree(gameObject) {
  const list = [];
  collectActive(gameObject, list);
  for (const component of list) {
    if (component._destroyed || !(component instanceof Behaviour)) continue;
    if (component._active) component._deactivate();
    if (component instanceof MonoBehaviour) component.StopAllCoroutines();
  }
}

function tearDown(gameObject) {
  for (const component of gameObject.components.slice()) {
    if (component._destroyed) continue;
    if (component instanceof Behaviour && component._active) component._deactivate();
    if (component._awoken && typeof component.OnDestroy === 'function') component.OnDestroy();
    component._destroyed = true;
  }
  for (const child of gameObject.transform._children.slice()) tearDown(child.gameObject);
  gameObject._destroyed = true;
}

function destroyNow(object) {
  if (object == null || object._destroyed) return;
  if (object instanceof GameObject) {
    const transform = object.transform;
    tearDown(object);
    if (transform._parent) {
      const siblings = transform._parent._children;
      const index = siblings.indexOf(transform);
      if (index >= 0) siblings.splice(index, 1);
    } else {
      const index = Engine.roots.indexOf(object);
      if (index >= 0) Engine.roots.splice(index, 1);
    }
    return;
  }
  if (object instanceof Transform) {
    destroyNow(object.gameObject);
    return;
  }
  if (object instanceof Component) {
    if (object instanceof Behaviour && object._active) object._deactivate();
    if (object._awoken && typeof object.OnDestroy === 'function') object.OnDestroy();
    object._destroyed = true;
    const components = object.gameObject.components;
    const index = components.indexOf(object);
    if (index >= 0) components.splice(index, 1);
  }
}

export function Destroy(object, delay = 0) {
  if (object == null || object._destroyed) return;
  Engine.destroyQueue.push({ object, time: Time.timeAsDouble + Math.fround(delay) });
}

export function DestroyImmediate(object) {
  destroyNow(object);
}

export function DontDestroyOnLoad(object) {
  const gameObject = object instanceof GameObject ? object : object.gameObject;
  gameObject._persistent = true;
}

export function cloneValue(value, map) {
  if (value == null || typeof value !== 'object') return value;
  if (value instanceof UnityObject) return map.get(value) || value;
  if (Array.isArray(value)) return value.map((item) => cloneValue(item, map));
  if (typeof value.clone === 'function') return value.clone(map);
  const copy = {};
  for (const key of Object.keys(value)) copy[key] = cloneValue(value[key], map);
  return copy;
}

function cloneTree(source, map, pending) {
  const clone = GameObject._raw(source._name, source.transform.constructor);
  clone.activeSelf = source.activeSelf;
  clone.layer = source.layer;
  clone.tag = source.tag;
  map.set(source, clone);
  for (const component of source.components) {
    if (component instanceof Transform) {
      map.set(component, clone.transform);
      pending.push([component, clone.transform]);
      continue;
    }
    const copy = new component.constructor();
    copy.gameObject = clone;
    clone.components.push(copy);
    map.set(component, copy);
    pending.push([component, copy]);
  }
  for (const child of source.transform._children) {
    const childClone = cloneTree(child.gameObject, map, pending);
    childClone.transform._parent = clone.transform;
    clone.transform._children.push(childClone.transform);
  }
  return clone;
}

export function Instantiate(original, a, b, c) {
  if (original == null) throw new Error('The Object you want to instantiate is null.');
  const sourceObject = original instanceof GameObject ? original : original.gameObject;
  const map = new Map();
  const pending = [];
  const clone = cloneTree(sourceObject, map, pending);
  for (const [source, copy] of pending) copy._copy(source, map);
  clone._name = sourceObject._name + '(Clone)';

  let parent = null;
  let position = null;
  let rotation = null;
  let worldPositionStays = false;
  if (a instanceof Transform) {
    parent = a;
    worldPositionStays = b === true;
  } else if (a != null) {
    position = a;
    rotation = b || null;
    parent = c instanceof Transform ? c : null;
  }

  const transform = clone.transform;
  if (parent) {
    transform._parent = parent;
    parent._children.push(transform);
  } else {
    Engine.roots.push(clone);
  }
  if (position) {
    transform.position = position;
    if (rotation) transform.rotation = rotation;
  } else if (parent && worldPositionStays) {
    const local = sourceObject.transform._lp;
    transform.position = local;
  }

  if (clone.activeInHierarchy) activateTree(clone);
  return original instanceof GameObject ? clone : map.get(original);
}

function eachObject(gameObject, visit) {
  visit(gameObject);
  for (const child of gameObject.transform._children) eachObject(child.gameObject, visit);
}

export function FindObjectsOfType(type, includeInactive = false) {
  const found = [];
  for (const root of Engine.roots) {
    eachObject(root, (gameObject) => {
      if (!includeInactive && !gameObject.activeInHierarchy) return;
      for (const component of gameObject.components) {
        if (component instanceof type && !component._destroyed) found.push(component);
      }
    });
  }
  return found;
}

export function FindObjectOfType(type, includeInactive = false) {
  const found = FindObjectsOfType(type, includeInactive);
  return found.length > 0 ? found[0] : null;
}

export class GameObject extends UnityObject {
  constructor(name = 'GameObject', ...componentTypes) {
    super();
    this._name = name;
    this.activeSelf = true;
    this.layer = 0;
    this.tag = 'Untagged';
    this.components = [];
    this._prefab = false;
    this._persistent = false;
    this.transform = new Transform();
    this.transform.gameObject = this;
    this.transform._awoken = true;
    this.components.push(this.transform);
    Engine.roots.push(this);
    for (const type of componentTypes) this.AddComponent(type);
  }

  static _raw(name, transformType) {
    const gameObject = Object.create(GameObject.prototype);
    gameObject._id = nextInstanceId++;
    gameObject._destroyed = false;
    gameObject._name = name;
    gameObject.activeSelf = true;
    gameObject.layer = 0;
    gameObject.tag = 'Untagged';
    gameObject.components = [];
    gameObject._prefab = false;
    gameObject._persistent = false;
    gameObject.transform = new (transformType || Transform)();
    gameObject.transform.gameObject = gameObject;
    gameObject.components.push(gameObject.transform);
    return gameObject;
  }

  static Find(name) {
    let found = null;
    for (const root of Engine.roots) {
      eachObject(root, (gameObject) => {
        if (!found && gameObject._name === name && gameObject.activeInHierarchy) found = gameObject;
      });
      if (found) break;
    }
    return found;
  }

  static FindWithTag(tag) {
    let found = null;
    for (const root of Engine.roots) {
      eachObject(root, (gameObject) => {
        if (!found && gameObject.tag === tag && gameObject.activeInHierarchy) found = gameObject;
      });
      if (found) break;
    }
    return found;
  }

  get gameObject() {
    return this;
  }

  get activeInHierarchy() {
    let transform = this.transform;
    while (transform) {
      const gameObject = transform.gameObject;
      if (!gameObject.activeSelf || gameObject._destroyed) return false;
      if (!transform._parent) return !gameObject._prefab;
      transform = transform._parent;
    }
    return false;
  }

  SetActive(value) {
    value = !!value;
    if (this.activeSelf === value) return;
    if (value) {
      this.activeSelf = true;
      if (this.activeInHierarchy) activateTree(this);
      return;
    }
    const wasActive = this.activeInHierarchy;
    if (wasActive) deactivateTree(this);
    this.activeSelf = false;
  }

  CompareTag(tag) {
    return this.tag === tag;
  }

  AddComponent(type) {
    const component = new type();
    component.gameObject = this;
    this.components.push(component);
    if (this.activeInHierarchy) {
      component._awoken = true;
      if (typeof component.Awake === 'function') component.Awake();
      if (component instanceof Behaviour && component._enabled && !component._destroyed) component._activate();
    }
    return component;
  }

  GetComponent(type) {
    for (const component of this.components) {
      if (component instanceof type && !component._destroyed) return component;
    }
    return null;
  }

  TryGetComponent(type) {
    return this.GetComponent(type);
  }

  GetComponents(type) {
    return this.components.filter((component) => component instanceof type && !component._destroyed);
  }

  GetComponentInChildren(type, includeInactive = false) {
    const found = this.GetComponentsInChildren(type, includeInactive);
    return found.length > 0 ? found[0] : null;
  }

  GetComponentsInChildren(type, includeInactive = false) {
    const found = [];
    const visit = (gameObject) => {
      if (!includeInactive && !gameObject.activeInHierarchy) return;
      for (const component of gameObject.components) {
        if (component instanceof type && !component._destroyed) found.push(component);
      }
      for (const child of gameObject.transform._children) visit(child.gameObject);
    };
    visit(this);
    return found;
  }

  GetComponentInParent(type) {
    let transform = this.transform;
    while (transform) {
      const component = transform.gameObject.GetComponent(type);
      if (component) return component;
      transform = transform._parent;
    }
    return null;
  }

  SendMessage(method, argument) {
    for (const component of this.components.slice()) {
      if (typeof component[method] === 'function') component[method](argument);
    }
  }
}

export class Component extends UnityObject {
  constructor() {
    super();
    this.gameObject = null;
    this._awoken = false;
    this._serialized = null;
  }
  get name() {
    return this.gameObject._name;
  }
  set name(value) {
    this.gameObject._name = value;
  }
  get transform() {
    return this.gameObject.transform;
  }
  get tag() {
    return this.gameObject.tag;
  }
  CompareTag(tag) {
    return this.gameObject.tag === tag;
  }
  GetComponent(type) {
    return this.gameObject.GetComponent(type);
  }
  TryGetComponent(type) {
    return this.gameObject.GetComponent(type);
  }
  GetComponents(type) {
    return this.gameObject.GetComponents(type);
  }
  GetComponentInChildren(type, includeInactive) {
    return this.gameObject.GetComponentInChildren(type, includeInactive);
  }
  GetComponentsInChildren(type, includeInactive) {
    return this.gameObject.GetComponentsInChildren(type, includeInactive);
  }
  GetComponentInParent(type) {
    return this.gameObject.GetComponentInParent(type);
  }
  _load(props, revive) {
    this._serialized = Object.keys(props);
    for (const key of this._serialized) {
      const value = revive(props[key]);
      const current = this[key];
      if (current != null && typeof current._loadEvent === 'function') current._loadEvent(value);
      else this[key] = value;
    }
  }
  _copy(source, map) {
    const fields = source._serialized || source.constructor.fields || [];
    for (const key of fields) this[key] = cloneValue(source[key], map);
    this._serialized = source._serialized;
    if (source._enabled !== undefined) this._enabled = source._enabled;
  }
}

export class Behaviour extends Component {
  constructor() {
    super();
    this._enabled = true;
    this._active = false;
    this._started = false;
    this._startQueued = false;
  }
  get enabled() {
    return this._enabled;
  }
  set enabled(value) {
    value = !!value;
    if (this._enabled === value) return;
    this._enabled = value;
    if (!this._awoken || this._destroyed) return;
    if (value && this.gameObject.activeInHierarchy && !this._active) this._activate();
    else if (!value && this._active) this._deactivate();
  }
  get isActiveAndEnabled() {
    return this._enabled && this.gameObject.activeInHierarchy;
  }
  _activate() {
    this._active = true;
    if (typeof this.OnEnable === 'function') this.OnEnable();
    if (!this._started && !this._startQueued && this._active) {
      this._startQueued = true;
      Engine.startQueue.push(this);
    }
    if (typeof this.Update === 'function' || typeof this.LateUpdate === 'function') Engine.updates.add(this);
  }
  _deactivate() {
    this._active = false;
    if (typeof this.OnDisable === 'function') this.OnDisable();
  }
}

export class MonoBehaviour extends Behaviour {
  StartCoroutine(routine, argument) {
    if (typeof routine === 'string') routine = this[routine](argument);
    const coroutine = new Coroutine(this, routine);
    coroutine.methodName = typeof arguments[0] === 'string' ? arguments[0] : null;
    Engine.coroutines.push(coroutine);
    stepCoroutine(coroutine);
    return coroutine;
  }
  StopCoroutine(routine) {
    if (routine == null) return;
    for (const coroutine of Engine.coroutines) {
      if (coroutine.owner !== this || coroutine.done) continue;
      if (coroutine === routine || coroutine.routine === routine || (typeof routine === 'string' && coroutine.methodName === routine)) {
        coroutine.done = true;
      }
    }
  }
  StopAllCoroutines() {
    for (const coroutine of Engine.coroutines) {
      if (coroutine.owner === this) coroutine.done = true;
    }
  }
  Invoke(method, time) {
    Engine.invokes.push({ owner: this, method, time: Time.timeAsDouble + Math.fround(time), repeat: 0, cancelled: false });
  }
  InvokeRepeating(method, time, repeatRate) {
    Engine.invokes.push({ owner: this, method, time: Time.timeAsDouble + Math.fround(time), repeat: repeatRate, cancelled: false });
  }
  CancelInvoke(method) {
    for (const invoke of Engine.invokes) {
      if (invoke.owner === this && (method === undefined || invoke.method === method)) invoke.cancelled = true;
    }
  }
  IsInvoking(method) {
    return Engine.invokes.some((invoke) => invoke.owner === this && !invoke.cancelled && (method === undefined || invoke.method === method));
  }
}

export class Transform extends Component {
  constructor() {
    super();
    this._parent = null;
    this._children = [];
    this._lp = new Vector3();
    this._le = new Vector3();
    this._ls = new Vector3(1, 1, 1);
    this._driver = null;
    this._stamp = nextMoveStamp++;
  }

  static animated = { m_LocalPosition: '_lp', m_LocalScale: '_ls', localEulerAnglesRaw: '_le', m_LocalEulerAngles: '_le', localEulerAngles: '_le' };

  _load(props, revive) {
    if (props.m_LocalPosition) this._lp = revive(props.m_LocalPosition);
    if (props.m_LocalScale) this._ls = revive(props.m_LocalScale);
    if (props.m_LocalRotation) this._le = revive(props.m_LocalRotation).eulerAngles;
  }

  _copy(source) {
    this._lp = source._lp.clone();
    this._le = source._le.clone();
    this._ls = source._ls.clone();
  }

  _layout() {
    return this._lp;
  }

  _localMatrix() {
    if (this._driver) return this._driver.matrix();
    const position = this._layout();
    const angle = this._le.z * Mathf.Deg2Rad;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return [cos * this._ls.x, sin * this._ls.x, -sin * this._ls.y, cos * this._ls.y, position.x, position.y];
  }

  _worldMatrix() {
    const local = this._localMatrix();
    return this._parent ? matMul(this._parent._worldMatrix(), local) : local;
  }

  _worldZ() {
    return this._lp.z + (this._parent ? this._parent._worldZ() : 0);
  }

  get parent() {
    return this._parent;
  }
  set parent(value) {
    this.SetParent(value, true);
  }

  SetParent(parent, worldPositionStays = true) {
    if (parent === this._parent) return;
    const gameObject = this.gameObject;
    const wasActive = gameObject.activeInHierarchy;
    const world = worldPositionStays ? this._worldMatrix() : null;
    const worldZ = this._worldZ();
    if (this._parent) {
      const siblings = this._parent._children;
      const index = siblings.indexOf(this);
      if (index >= 0) siblings.splice(index, 1);
    } else {
      const index = Engine.roots.indexOf(gameObject);
      if (index >= 0) Engine.roots.splice(index, 1);
    }
    this._parent = parent || null;
    if (parent) parent._children.push(this);
    else Engine.roots.push(gameObject);
    if (world) {
      const local = parent ? matMul(matInvert(parent._worldMatrix()), world) : world;
      const scaleX = Math.hypot(local[0], local[1]);
      const scaleY = Math.hypot(local[2], local[3]);
      this._ls = new Vector3(scaleX * Mathf.Sign(this._ls.x), scaleY * Mathf.Sign(this._ls.y), this._ls.z);
      this._le = new Vector3(this._le.x, this._le.y, Math.atan2(local[1], local[0]) * Mathf.Rad2Deg);
      this._setLayout(local[4], local[5], worldZ - (parent ? parent._worldZ() : 0));
    }
    const isActive = gameObject.activeInHierarchy;
    if (!wasActive && isActive) activateTree(gameObject);
    else if (wasActive && !isActive) deactivateTree(gameObject);
  }

  _setLayout(x, y, z) {
    this._lp = new Vector3(x, y, z);
    this._stamp = nextMoveStamp++;
  }

  _moveStamp() {
    let stamp = this._stamp;
    for (let transform = this._parent; transform; transform = transform._parent) stamp = Math.max(stamp, transform._stamp);
    return stamp;
  }

  get position() {
    const position = this._layout();
    if (!this._parent) return new Vector3(position.x, position.y, this._lp.z);
    const point = matApply(this._parent._worldMatrix(), position.x, position.y);
    return new Vector3(point[0], point[1], this._worldZ());
  }
  set position(value) {
    const z = value.z === undefined ? 0 : value.z;
    if (!this._parent) {
      this._setLayout(value.x, value.y, z);
      return;
    }
    const point = matApply(matInvert(this._parent._worldMatrix()), value.x, value.y);
    this._setLayout(point[0], point[1], z - this._parent._worldZ());
  }

  get localPosition() {
    const position = this._layout();
    return new Vector3(position.x, position.y, this._lp.z);
  }
  set localPosition(value) {
    this._setLayout(value.x, value.y, value.z === undefined ? 0 : value.z);
  }

  get localScale() {
    return this._ls.clone();
  }
  set localScale(value) {
    this._ls = new Vector3(value.x, value.y, value.z === undefined ? 1 : value.z);
  }

  get lossyScale() {
    const world = this._worldMatrix();
    return new Vector3(Math.hypot(world[0], world[1]), Math.hypot(world[2], world[3]), this._ls.z);
  }

  get localEulerAngles() {
    return this._le.clone();
  }
  set localEulerAngles(value) {
    this._le = Vector3.From(value);
  }

  get eulerAngles() {
    const world = this._worldMatrix();
    return new Vector3(this._le.x, this._le.y, Math.atan2(world[1], world[0]) * Mathf.Rad2Deg);
  }
  set eulerAngles(value) {
    const parentAngle = this._parent ? this._parent.eulerAngles.z : 0;
    this._le = new Vector3(value.x, value.y, value.z - parentAngle);
  }

  get localRotation() {
    return Quaternion.Euler(this._le);
  }
  set localRotation(value) {
    this._le = value.eulerAngles;
  }

  get rotation() {
    return Quaternion.Euler(this.eulerAngles);
  }
  set rotation(value) {
    this.eulerAngles = value.eulerAngles;
  }

  get childCount() {
    return this._children.length;
  }

  get root() {
    let transform = this;
    while (transform._parent) transform = transform._parent;
    return transform;
  }

  GetChild(index) {
    return this._children[index];
  }

  [Symbol.iterator]() {
    return this._children.slice()[Symbol.iterator]();
  }

  Find(path) {
    if (path === '') return this;
    let current = this;
    for (const part of path.split('/')) {
      const next = current._children.find((child) => child.gameObject._name === part);
      if (!next) return null;
      current = next;
    }
    return current;
  }

  IsChildOf(parent) {
    let transform = this;
    while (transform) {
      if (transform === parent) return true;
      transform = transform._parent;
    }
    return false;
  }

  GetSiblingIndex() {
    return this._parent ? this._parent._children.indexOf(this) : Engine.roots.indexOf(this.gameObject);
  }

  SetSiblingIndex(index) {
    const list = this._parent ? this._parent._children : Engine.roots;
    const item = this._parent ? this : this.gameObject;
    const current = list.indexOf(item);
    if (current < 0) return;
    list.splice(current, 1);
    list.splice(Mathf.Clamp(index, 0, list.length), 0, item);
  }

  SetAsFirstSibling() {
    this.SetSiblingIndex(0);
  }

  SetAsLastSibling() {
    this.SetSiblingIndex(Number.MAX_SAFE_INTEGER);
  }

  DetachChildren() {
    for (const child of this._children.slice()) child.SetParent(null, true);
  }

  TransformPoint(point) {
    const result = matApply(this._worldMatrix(), point.x, point.y);
    return new Vector3(result[0], result[1], (point.z || 0) + this._worldZ());
  }

  InverseTransformPoint(point) {
    const result = matApply(matInvert(this._worldMatrix()), point.x, point.y);
    return new Vector3(result[0], result[1], (point.z || 0) - this._worldZ());
  }

  Translate(x, y = 0, z = 0) {
    const delta = typeof x === 'object' ? x : new Vector3(x, y, z);
    const position = this._layout();
    this._setLayout(position.x + delta.x, position.y + delta.y, this._lp.z + (delta.z || 0));
  }

  Rotate(x, y = 0, z = 0) {
    const delta = typeof x === 'object' ? x : new Vector3(x, y, z);
    this._le = new Vector3(this._le.x + delta.x, this._le.y + delta.y, this._le.z + delta.z);
  }
}

export class RectTransform extends Transform {
  constructor() {
    super();
    this._amin = new Vector2(0.5, 0.5);
    this._amax = new Vector2(0.5, 0.5);
    this._ap = new Vector2();
    this._sd = new Vector2(100, 100);
    this._pv = new Vector2(0.5, 0.5);
  }

  static animated = {
    m_LocalPosition: '_lp',
    m_LocalScale: '_ls',
    localEulerAnglesRaw: '_le',
    m_LocalEulerAngles: '_le',
    localEulerAngles: '_le',
    m_AnchoredPosition: '_ap',
    m_SizeDelta: '_sd',
    m_AnchorMin: '_amin',
    m_AnchorMax: '_amax',
    m_Pivot: '_pv',
  };

  _load(props, revive) {
    super._load(props, revive);
    if (props.m_AnchorMin) this._amin = revive(props.m_AnchorMin);
    if (props.m_AnchorMax) this._amax = revive(props.m_AnchorMax);
    if (props.m_AnchoredPosition) this._ap = revive(props.m_AnchoredPosition);
    if (props.m_SizeDelta) this._sd = revive(props.m_SizeDelta);
    if (props.m_Pivot) this._pv = revive(props.m_Pivot);
  }

  _copy(source) {
    super._copy(source);
    this._amin = source._amin.clone();
    this._amax = source._amax.clone();
    this._ap = source._ap.clone();
    this._sd = source._sd.clone();
    this._pv = source._pv.clone();
  }

  _size() {
    if (this._driver) return this._driver.size();
    const parent = this._parent;
    if (!(parent instanceof RectTransform)) return this._sd;
    const parentSize = parent._size();
    return new Vector2(
      this._sd.x + (this._amax.x - this._amin.x) * parentSize.x,
      this._sd.y + (this._amax.y - this._amin.y) * parentSize.y
    );
  }

  _anchorReference() {
    const parent = this._parent;
    if (!(parent instanceof RectTransform)) return null;
    const parentSize = parent._size();
    const parentPivot = parent._driver ? new Vector2(0.5, 0.5) : parent._pv;
    return new Vector2(
      -parentPivot.x * parentSize.x + (this._amin.x + (this._amax.x - this._amin.x) * this._pv.x) * parentSize.x,
      -parentPivot.y * parentSize.y + (this._amin.y + (this._amax.y - this._amin.y) * this._pv.y) * parentSize.y
    );
  }

  _layout() {
    const reference = this._anchorReference();
    if (!reference) return this._lp;
    return new Vector2(reference.x + this._ap.x, reference.y + this._ap.y);
  }

  _setLayout(x, y, z) {
    const reference = this._anchorReference();
    this._lp = new Vector3(x, y, z);
    this._stamp = nextMoveStamp++;
    if (reference) this._ap = new Vector2(x - reference.x, y - reference.y);
  }

  get rect() {
    const size = this._size();
    const pivot = this._driver ? new Vector2(0.5, 0.5) : this._pv;
    return new Rect(-pivot.x * size.x, -pivot.y * size.y, size.x, size.y);
  }

  get anchorMin() {
    return this._amin.clone();
  }
  set anchorMin(value) {
    this._amin = new Vector2(value.x, value.y);
  }
  get anchorMax() {
    return this._amax.clone();
  }
  set anchorMax(value) {
    this._amax = new Vector2(value.x, value.y);
  }
  get anchoredPosition() {
    return this._ap.clone();
  }
  set anchoredPosition(value) {
    this._ap = new Vector2(value.x, value.y);
  }
  get sizeDelta() {
    return this._sd.clone();
  }
  set sizeDelta(value) {
    this._sd = new Vector2(value.x, value.y);
  }
  get pivot() {
    return this._pv.clone();
  }
  set pivot(value) {
    this._pv = new Vector2(value.x, value.y);
  }
}
