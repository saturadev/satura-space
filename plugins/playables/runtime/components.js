import { Vector2, Vector3, Color, Rect, Mathf, Screen } from './core.js';
import { UnityObject, Component, Behaviour, Transform, GameObject, Engine, FindObjectsOfType, matApply, matInvert } from './object.js';

export class Sprite extends UnityObject {
  constructor(data, index) {
    super();
    this._name = data.name;
    this.index = index;
    this.atlas = data.atlas;
    this.x = data.x;
    this.y = data.y;
    this.w = data.w;
    this.h = data.h;
    this.px = data.px;
    this.py = data.py;
    this.pixelsPerUnit = data.ppu;
    this.border = data.border || [0, 0, 0, 0];
    this.path = data.path;
  }
  get rect() {
    return new Rect(0, 0, this.w, this.h);
  }
  get pivot() {
    return new Vector2(this.px, this.py);
  }
  get bounds() {
    return { size: new Vector3(this.w / this.pixelsPerUnit, this.h / this.pixelsPerUnit, 0) };
  }
}

export class Font extends UnityObject {
  constructor(data, index) {
    super();
    this._name = data.name;
    this.family = data.file ? 'pf' + index : 'sans-serif';
    this.lineHeight = data.lineHeight || 1.15;
    this.ascent = data.ascent || 0.9;
  }
}

export class Renderer extends Component {
  constructor() {
    super();
    this.enabled = true;
    this.sortingOrder = 0;
    this.sortingLayerID = 0;
  }
}

export class SpriteRenderer extends Renderer {
  constructor() {
    super();
    this.sprite = null;
    this._color = new Color(1, 1, 1, 1);
    this.flipX = false;
    this.flipY = false;
  }

  static fields = ['enabled', 'sortingOrder', 'sortingLayerID', 'sprite', '_color', 'flipX', 'flipY'];
  static animated = { m_Color: '_color', m_Sprite: 'sprite', m_FlipX: 'flipX', m_FlipY: 'flipY', m_Enabled: 'enabled' };

  get color() {
    return this._color.clone();
  }
  set color(value) {
    this._color = new Color(value.r, value.g, value.b, value.a);
  }

  _load(props, revive, data) {
    this.enabled = data.enabled !== false;
    this.sprite = revive(props.m_Sprite);
    if (props.m_Color) this._color = revive(props.m_Color);
    this.flipX = !!props.m_FlipX;
    this.flipY = !!props.m_FlipY;
    this.sortingOrder = props.m_SortingOrder || 0;
    this.sortingLayerID = props.m_SortingLayerID || 0;
  }
}

export class Camera extends Behaviour {
  constructor() {
    super();
    this.orthographic = true;
    this.orthographicSize = 5;
    this.backgroundColor = new Color(0, 0, 0, 1);
    this.clearFlags = 2;
    this.depth = 0;
    this.fieldOfView = 60;
    this.nearClipPlane = 0.3;
    this.farClipPlane = 1000;
    this.cullingMask = -1;
  }

  static fields = ['orthographic', 'orthographicSize', 'backgroundColor', 'clearFlags', 'depth', 'fieldOfView', 'nearClipPlane', 'farClipPlane', 'cullingMask'];

  static get main() {
    const cameras = FindObjectsOfType(Camera).filter((camera) => camera._enabled);
    return cameras.find((camera) => camera.gameObject.tag === 'MainCamera') || null;
  }

  static get all() {
    return FindObjectsOfType(Camera)
      .filter((camera) => camera._enabled)
      .sort((a, b) => a.depth - b.depth);
  }

  _load(props, revive) {
    this.orthographic = props.orthographic !== false;
    this.orthographicSize = props['orthographic size'];
    this.backgroundColor = revive(props.m_BackGroundColor);
    this.clearFlags = props.m_ClearFlags;
    this.depth = props.m_Depth || 0;
    if (props['field of view'] !== undefined) this.fieldOfView = props['field of view'];
    if (props['near clip plane'] !== undefined) this.nearClipPlane = props['near clip plane'];
    if (props['far clip plane'] !== undefined) this.farClipPlane = props['far clip plane'];
    if (typeof props.m_CullingMask === 'number') this.cullingMask = props.m_CullingMask | 0;
  }

  get aspect() {
    return Screen.width / Screen.height;
  }
  get pixelWidth() {
    return Screen.width;
  }
  get pixelHeight() {
    return Screen.height;
  }

  _screenMatrix() {
    const scale = Screen.height / (2 * this.orthographicSize);
    const position = this.transform.position;
    return [scale, 0, 0, scale, Screen.width / 2 - position.x * scale, Screen.height / 2 - position.y * scale];
  }

  WorldToScreenPoint(point) {
    const result = matApply(this._screenMatrix(), point.x, point.y);
    return new Vector3(result[0], result[1], (point.z || 0) - this.transform.position.z);
  }

  ScreenToWorldPoint(point) {
    const result = matApply(matInvert(this._screenMatrix()), point.x, point.y);
    return new Vector3(result[0], result[1], this.transform.position.z + (point.z || 0));
  }
}

export class Collider2D extends Behaviour {
  constructor() {
    super();
    this.isTrigger = false;
    this.offset = new Vector2();
  }
  OverlapPoint(point) {
    const local = matApply(matInvert(this.transform._worldMatrix()), point.x, point.y);
    return this._containsLocal(local[0], local[1]);
  }
  _containsLocal() {
    return false;
  }
}

export class BoxCollider2D extends Collider2D {
  constructor() {
    super();
    this.size = new Vector2(1, 1);
  }
  static fields = ['isTrigger', 'offset', 'size'];
  _load(props, revive) {
    this.isTrigger = !!props.m_IsTrigger;
    this.offset = revive(props.m_Offset);
    this.size = revive(props.m_Size);
  }
  _containsLocal(x, y) {
    return Math.abs(x - this.offset.x) <= this.size.x / 2 && Math.abs(y - this.offset.y) <= this.size.y / 2;
  }
}

export class CircleCollider2D extends Collider2D {
  constructor() {
    super();
    this.radius = 0.5;
  }
  static fields = ['isTrigger', 'offset', 'radius'];
  _load(props, revive) {
    this.isTrigger = !!props.m_IsTrigger;
    this.offset = revive(props.m_Offset);
    this.radius = props.m_Radius;
  }
  _containsLocal(x, y) {
    return Math.hypot(x - this.offset.x, y - this.offset.y) <= this.radius;
  }
}

function evaluateCurve(keys, time) {
  const count = keys.length / 4;
  if (count === 0) return 0;
  if (count === 1 || time <= keys[0]) return keys[1];
  const last = (count - 1) * 4;
  if (time >= keys[last]) return keys[last + 1];
  let index = 0;
  while (index < count - 2 && keys[(index + 1) * 4] <= time) index++;
  const a = index * 4;
  const b = a + 4;
  const t0 = keys[a];
  const v0 = keys[a + 1];
  const out0 = keys[a + 3];
  const t1 = keys[b];
  const v1 = keys[b + 1];
  const in1 = keys[b + 2];
  if (out0 === null || in1 === null) return v0;
  const span = t1 - t0;
  const s = (time - t0) / span;
  const s2 = s * s;
  const s3 = s2 * s;
  return (2 * s3 - 3 * s2 + 1) * v0 + (s3 - 2 * s2 + s) * out0 * span + (-2 * s3 + 3 * s2) * v1 + (s3 - s2) * in1 * span;
}

export class AnimationCurve {
  constructor(keys = []) {
    this.keys = keys;
  }
  Evaluate(time) {
    return evaluateCurve(this.keys, time);
  }
  clone() {
    return new AnimationCurve(this.keys.slice());
  }
}

export class AnimationClip extends UnityObject {
  constructor(data, revive) {
    super();
    this._name = data.name;
    this.length = data.length;
    this.frameRate = data.frameRate;
    this.isLooping = !!data.loop;
    this.curves = data.curves.map((curve) => ({ path: curve.path, type: curve.type, prop: curve.prop, keys: curve.keys }));
    this.objectCurves = data.objectCurves.map((curve) => ({
      path: curve.path,
      type: curve.type,
      prop: curve.prop,
      keys: curve.keys.map((key) => [key[0], revive(key[1])]),
    }));
    this.events = data.events || [];
  }
}

export class RuntimeAnimatorController extends UnityObject {
  constructor(data, revive) {
    super();
    this._name = data.name;
    this.layers = (data.layers || []).map((layer) => ({
      name: layer.name,
      defaultState: layer.defaultState,
      states: layer.states.map((state) => ({
        name: state.name,
        clip: revive(state.clip),
        speed: state.speed,
        writeDefaults: state.writeDefaults !== false,
        transitions: state.transitions || [],
      })),
    }));
  }
  get animationClips() {
    const clips = [];
    for (const layer of this.layers) {
      for (const state of layer.states) {
        if (state.clip && !clips.includes(state.clip)) clips.push(state.clip);
      }
    }
    return clips;
  }
}

const componentTypes = new Map();

export function registerComponentType(name, type) {
  componentTypes.set(name, type);
}

export function lookupComponentType(name) {
  if (componentTypes.has(name)) return componentTypes.get(name);
  const short = name.slice(name.lastIndexOf('.') + 1);
  return componentTypes.get(short) || null;
}

function resolveTarget(root, curve) {
  const transform = root.Find(curve.path);
  if (!transform) return null;
  if (curve.type === 'UnityEngine.GameObject') return transform.gameObject;
  const type = lookupComponentType(curve.type);
  if (!type) return null;
  if (type === Transform || type.prototype instanceof Transform) return transform;
  return transform.gameObject.GetComponent(type);
}

function makeBinding(root, curve, isObject) {
  const target = resolveTarget(root, curve);
  if (!target) return null;
  const parts = curve.prop.split('.');
  let holder = target;
  let field;
  if (target instanceof GameObject) {
    if (curve.prop !== 'm_IsActive') return null;
    return {
      key: curve.path + '|' + curve.type + '|' + curve.prop,
      get: () => (target.activeSelf ? 1 : 0),
      set: (value) => target.SetActive(value > 0.5),
    };
  }
  const table = target.constructor.animated;
  const mapped = table && table[parts[0]];
  if (mapped) {
    if (parts.length === 1) {
      field = mapped;
    } else {
      holder = target[mapped];
      for (let i = 1; i < parts.length - 1; i++) holder = holder ? holder[parts[i]] : null;
      field = parts[parts.length - 1];
    }
  } else if (curve.prop === 'm_Enabled') {
    field = 'enabled';
  } else {
    for (let i = 0; i < parts.length - 1; i++) holder = holder ? holder[parts[i]] : null;
    field = parts[parts.length - 1];
  }
  if (holder == null) return null;
  const isBool = typeof holder[field] === 'boolean';
  return {
    key: curve.path + '|' + curve.type + '|' + curve.prop,
    get: () => (isBool ? (holder[field] ? 1 : 0) : holder[field]),
    set: (value) => {
      holder[field] = isBool && !isObject ? value > 0.5 : value;
    },
  };
}

export class Animator extends Behaviour {
  constructor() {
    super();
    this.runtimeAnimatorController = null;
    this.speed = 1;
    this._state = null;
    this._time = 0;
    this._bound = null;
    this._parameters = new Map();
  }

  static fields = ['runtimeAnimatorController', 'speed'];

  _load(props, revive) {
    this.runtimeAnimatorController = revive(props.m_Controller);
  }

  _activate() {
    super._activate();
    Engine.animators.add(this);
    this._state = null;
    this._time = 0;
  }

  _states() {
    const controller = this.runtimeAnimatorController;
    return controller && controller.layers.length > 0 ? controller.layers[0].states : [];
  }

  _bind() {
    const defaults = new Map();
    const perClip = new Map();
    const root = this.transform;
    for (const clip of this.runtimeAnimatorController ? this.runtimeAnimatorController.animationClips : []) {
      const bindings = [];
      for (const curve of clip.curves) {
        const binding = makeBinding(root, curve, false);
        if (!binding) continue;
        if (!defaults.has(binding.key)) defaults.set(binding.key, { binding, value: binding.get() });
        bindings.push({ binding: defaults.get(binding.key).binding, keys: curve.keys, object: false });
      }
      for (const curve of clip.objectCurves) {
        const binding = makeBinding(root, curve, true);
        if (!binding) continue;
        if (!defaults.has(binding.key)) defaults.set(binding.key, { binding, value: binding.get() });
        bindings.push({ binding: defaults.get(binding.key).binding, keys: curve.keys, object: true });
      }
      perClip.set(clip, bindings);
    }
    this._bound = { defaults, perClip };
  }

  Play(stateName, layer = -1, normalizedTime = 0) {
    const state = this._states().find((candidate) => candidate.name === stateName);
    if (!state) return;
    this._state = state;
    this._time = state.clip ? normalizedTime * state.clip.length : 0;
    this._fresh = true;
  }

  Rebind() {
    this._bound = null;
    this._state = null;
    this._time = 0;
  }

  SetTrigger(name) {
    this._parameters.set(name, true);
  }
  ResetTrigger(name) {
    this._parameters.set(name, false);
  }
  SetBool(name, value) {
    this._parameters.set(name, value);
  }
  GetBool(name) {
    return !!this._parameters.get(name);
  }
  SetFloat(name, value) {
    this._parameters.set(name, value);
  }
  GetFloat(name) {
    return this._parameters.get(name) || 0;
  }
  SetInteger(name, value) {
    this._parameters.set(name, value);
  }
  GetInteger(name) {
    return this._parameters.get(name) || 0;
  }

  GetCurrentAnimatorStateInfo() {
    const state = this._state;
    const length = state && state.clip ? state.clip.length : 0;
    const time = this._time;
    return {
      length,
      normalizedTime: length > 0 ? time / length : 0,
      IsName: (name) => !!state && state.name === name,
    };
  }

  _tick(deltaTime) {
    const controller = this.runtimeAnimatorController;
    if (!controller || controller.layers.length === 0) return;
    if (!this._bound) this._bind();
    if (!this._state) {
      const layer = controller.layers[0];
      this._state = layer.states.find((state) => state.name === layer.defaultState) || layer.states[0] || null;
      this._time = 0;
      this._fresh = true;
    }
    const state = this._state;
    if (!state) return;
    const previous = this._time;
    if (this._fresh) this._fresh = false;
    else this._time += deltaTime * this.speed * state.speed;
    const clip = state.clip;
    let sampleTime = this._time;
    if (clip) {
      if (clip.isLooping && clip.length > 0) sampleTime = this._time % clip.length;
      else sampleTime = Math.min(this._time, clip.length);
      for (const event of clip.events) {
        if (event.time > previous && event.time <= this._time) this.gameObject.SendMessage(event.function, event.string || event.float || event.int);
      }
    }
    const written = new Set();
    if (clip) {
      for (const entry of this._bound.perClip.get(clip) || []) {
        written.add(entry.binding.key);
        if (entry.object) {
          let value = entry.keys.length > 0 ? entry.keys[0][1] : null;
          for (const key of entry.keys) {
            if (key[0] <= sampleTime + 1e-6) value = key[1];
          }
          entry.binding.set(value);
        } else {
          entry.binding.set(evaluateCurve(entry.keys, sampleTime));
        }
      }
    }
    if (state.writeDefaults) {
      for (const [key, entry] of this._bound.defaults) {
        if (!written.has(key)) entry.binding.set(entry.value);
      }
    }
    if (clip && state.transitions.length > 0) {
      for (const transition of state.transitions) {
        if (!transition.hasExitTime || (transition.conditions && transition.conditions.length) || !transition.to) continue;
        if (this._time >= transition.exitTime * clip.length) {
          this.Play(transition.to);
          break;
        }
      }
    }
  }
}

registerComponentType('UnityEngine.Transform', Transform);
registerComponentType('UnityEngine.SpriteRenderer', SpriteRenderer);
registerComponentType('UnityEngine.Camera', Camera);
registerComponentType('UnityEngine.BoxCollider2D', BoxCollider2D);
registerComponentType('UnityEngine.CircleCollider2D', CircleCollider2D);
registerComponentType('UnityEngine.Animator', Animator);
