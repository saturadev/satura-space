import { Vector2, Vector3, Vector4, Quaternion, Color, Rect } from './core.js';
import { UnityObject, GameObject, Behaviour, MonoBehaviour, Transform, RectTransform, Engine, Destroy } from './object.js';
import { Sprite, Font, AnimationClip, AnimationCurve, RuntimeAnimatorController, registerComponentType, lookupComponentType } from './components.js';
import { PointerInput } from './ui.js';

class MissingBehaviour extends Behaviour {
  static fields = [];
}

const missingTypes = new Set();
const tableFactories = new Map();

export class ScriptableObject extends UnityObject {
  _load(props, revive) {
    for (const key of Object.keys(props)) this[key] = revive(props[key]);
  }
}

export function registerAssetTable(name, factory) {
  tableFactories.set(name, factory);
}

registerAssetTable('objects', (row, index, revive) => {
  const type = lookupComponentType(row.type);
  const object = type ? new type() : new ScriptableObject();
  object._name = row.name;
  if (!type) console.warn('Playable runtime: unsupported asset type ' + row.type);
  if (typeof object._load === 'function') object._load(row.props || {}, revive, row);
  return object;
});

function decodeBase64(text) {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function registerTypes(types) {
  for (const name of Object.keys(types)) registerComponentType(name, types[name]);
}

export const Assets = {
  data: null,
  sprites: [],
  fonts: [],
  clips: [],
  controllers: [],
  prefabs: new Map(),
  clipOverrides: [],
  files: {},
  rows: new Map(),

  load(data, files) {
    this.data = data;
    this.files = files || {};
    this.rows.clear();
    this.prefabs.clear();
    this.sprites = data.sprites.map((sprite, index) => new Sprite(sprite, index));
    this.fonts = data.fonts.map((font, index) => new Font(font, index));
    const reviveAsset = (value) => reviveValue(value, null);
    this.clips = data.clips.map((clip) => new AnimationClip(clip, reviveAsset));
    this.controllers = data.controllers.map((controller) => new RuntimeAnimatorController(controller, reviveAsset));
  },

  prefab(path) {
    if (this.prefabs.has(path)) return this.prefabs.get(path);
    const unitData = this.data.prefabs[path];
    if (!unitData) return null;
    const unit = { ids: new Map(), roots: [], pending: [] };
    this.prefabs.set(path, unit);
    buildUnit(unitData, unit);
    for (const root of unit.roots) root._prefab = true;
    finishUnit(unit);
    return unit;
  },

  row(table, index) {
    const key = table + ':' + index;
    if (this.rows.has(key)) return this.rows.get(key);
    const rows = (this.data.tables || {})[table];
    const data = rows ? rows[index] : undefined;
    if (data === undefined) return null;
    const revive = (value) => reviveValue(value, null);
    const factory = tableFactories.get(table);
    this.rows.set(key, null);
    const value = factory ? factory(data, index, revive) : revive(data);
    this.rows.set(key, value);
    return value;
  },

  table(table) {
    const rows = (this.data.tables || {})[table] || [];
    return rows.map((_, index) => this.row(table, index));
  },

  file(name) {
    return this.files[name] || null;
  },

  bytes(name) {
    const url = this.files[name];
    if (!url) return null;
    return decodeBase64(url.slice(url.indexOf(',') + 1));
  },

  sprite(name) {
    return this.sprites.find((sprite) => sprite._name === name || sprite.path === name) || null;
  },

  clip(name) {
    return this.clips.find((clip) => clip._name === name) || null;
  },
};

function reviveValue(value, unit) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((item) => reviveValue(item, unit));
  if (value.$v) {
    const v = value.$v;
    if (v.length === 2) return new Vector2(v[0], v[1]);
    if (v.length === 3) return new Vector3(v[0], v[1], v[2]);
    return new Vector4(v[0], v[1], v[2], v[3]);
  }
  if (value.$c) return new Color(value.$c[0], value.$c[1], value.$c[2], value.$c[3]);
  if (value.$q) {
    const q = value.$q;
    return new Quaternion(q[0], q[1], q[2], q[3], new Vector3(q[4], q[5], q[6]));
  }
  if (value.$rect) return new Rect(value.$rect[0], value.$rect[1], value.$rect[2], value.$rect[3]);
  if (value.$curve) return new AnimationCurve(value.$curve);
  if (value.$sprite !== undefined) return Assets.sprites[value.$sprite] || null;
  if (value.$clip !== undefined) return Assets.clips[value.$clip] || null;
  if (value.$ctrl !== undefined) return Assets.controllers[value.$ctrl] || null;
  if (value.$font !== undefined) return Assets.fonts[value.$font] || null;
  if (value.$prefab !== undefined) {
    const prefab = Assets.prefab(value.$prefab);
    return prefab ? prefab.ids.get(value.$id) || null : null;
  }
  if (value.$id !== undefined) return unit ? unit.ids.get(value.$id) || null : null;
  if (value.$a !== undefined) return Assets.row(value.$a, value.$i);
  if (value.$asset !== undefined) return null;
  const result = {};
  for (const key of Object.keys(value)) result[key] = reviveValue(value[key], unit);
  return result;
}

function buildObject(node, unit, parent) {
  const transformNode = node.components[0];
  const transformType = transformNode && transformNode.type === 'UnityEngine.RectTransform' ? RectTransform : Transform;
  const gameObject = GameObject._raw(node.name, transformType);
  gameObject.activeSelf = node.active !== false;
  gameObject.layer = node.layer || 0;
  gameObject.tag = node.tag || 'Untagged';
  unit.ids.set(node.id, gameObject);
  if (parent) {
    gameObject.transform._parent = parent.transform;
    parent.transform._children.push(gameObject.transform);
  }
  for (const componentNode of node.components) {
    let component;
    if (componentNode === transformNode) {
      component = gameObject.transform;
    } else {
      let type = lookupComponentType(componentNode.type);
      if (!type) {
        if (!missingTypes.has(componentNode.type)) {
          missingTypes.add(componentNode.type);
          console.warn('Playable runtime: unsupported component ' + componentNode.type);
        }
        type = MissingBehaviour;
      }
      component = new type();
      component.gameObject = gameObject;
      gameObject.components.push(component);
    }
    unit.ids.set(componentNode.id, component);
    unit.pending.push([component, componentNode]);
  }
  for (const child of node.children) buildObject(child, unit, gameObject);
  return gameObject;
}

function buildUnit(unitData, unit) {
  for (const root of unitData.roots) unit.roots.push(buildObject(root, unit, null));
}

function finishUnit(unit) {
  const revive = (value) => reviveValue(value, unit);
  for (const [component, node] of unit.pending) {
    if (component instanceof Behaviour && node.enabled === false) component._enabled = false;
    if (component instanceof MissingBehaviour) continue;
    component._load(node.props || {}, revive, node);
  }
  unit.pending = [];
}

function findByPath(roots, path) {
  const parts = path.split('/');
  for (const root of roots) {
    if (root._name === path) return root;
    if (root._name !== parts[0]) continue;
    let current = root.transform;
    let index = 1;
    while (current && index < parts.length) {
      let matched = null;
      for (let length = parts.length - index; length >= 1 && !matched; length--) {
        const name = parts.slice(index, index + length).join('/');
        matched = current._children.find((child) => child.gameObject._name === name) || null;
        if (matched) index += length;
      }
      current = matched;
    }
    if (current) return current.gameObject;
  }
  return null;
}

function assignOverride(target, key, value) {
  const current = target[key];
  if (Array.isArray(value) && current && typeof current === 'object' && 'x' in current) {
    const names = ['x', 'y', 'z', 'w'];
    const copy = current.clone();
    value.forEach((item, index) => {
      copy[names[index]] = item;
    });
    target[key] = copy;
  } else if (Array.isArray(value) && current && typeof current === 'object' && 'r' in current) {
    target[key] = new Color(value[0], value[1], value[2], value[3] === undefined ? 1 : value[3]);
  } else {
    target[key] = value;
  }
}

function applyOverrides(roots, overrides, sceneName) {
  for (const override of overrides || []) {
    if (override.scene && override.scene !== sceneName) continue;
    const gameObject = findByPath(roots, override.path);
    if (!gameObject) {
      console.warn('Playable override: object not found ' + override.path);
      continue;
    }
    let target = gameObject;
    if (override.component) {
      const type = lookupComponentType(override.component);
      target = type ? gameObject.GetComponent(type) : null;
      if (!target) {
        console.warn('Playable override: component not found ' + override.component + ' on ' + override.path);
        continue;
      }
    }
    for (const key of Object.keys(override.set || {})) assignOverride(target, key, override.set[key]);
  }
}

function applyClipOverrides(overrides) {
  for (const override of overrides || []) {
    const clip = Assets.clip(override.clip);
    if (!clip) continue;
    for (const curve of clip.curves) {
      if (curve.path !== override.path || curve.prop !== override.prop) continue;
      const scale = override.scale === undefined ? 1 : override.scale;
      curve.keys = curve.keys.map((value, index) => (index % 4 === 0 || value === null ? value : value * scale));
    }
  }
}

const sceneLoadedListeners = [];

export const SceneManager = {
  active: null,
  overrides: [],
  onMissingScene: null,
  sceneLoaded: {
    AddListener: (listener) => sceneLoadedListeners.push(listener),
    RemoveListener(listener) {
      const index = sceneLoadedListeners.indexOf(listener);
      if (index >= 0) sceneLoadedListeners.splice(index, 1);
    },
  },

  init(data, options = {}) {
    Assets.load(data, options.files);
    this.overrides = options.overrides || [];
    applyClipOverrides(options.clipOverrides);
  },

  GetActiveScene() {
    return { name: this.active, buildIndex: Assets.data.buildScenes.indexOf(this.active) };
  },

  LoadScene(scene) {
    const name = typeof scene === 'number' ? Assets.data.buildScenes[scene] : scene;
    Engine.pendingLoad = name;
  },

  loadNow(name) {
    Engine.loading = true;
    try {
      return this.loadScene(name);
    } finally {
      Engine.loading = false;
    }
  },

  loadScene(name) {
    const sceneData = Assets.data.scenes[name];
    if (!sceneData) {
      if (this.onMissingScene) this.onMissingScene(name);
      else console.warn('Scene ' + name + ' is not part of this playable');
      return false;
    }
    for (const root of Engine.roots.slice()) {
      if (!root._persistent) Destroy(root);
    }
    Engine.flushDestroy();
    Engine.coroutines = Engine.coroutines.filter((coroutine) => !coroutine.owner._destroyed);
    Engine.invokes = Engine.invokes.filter((invoke) => !invoke.owner._destroyed);
    PointerInput.reset();
    this.active = name;
    const unit = { ids: new Map(), roots: [], pending: [] };
    buildUnit(sceneData, unit);
    finishUnit(unit);
    applyOverrides(unit.roots, this.overrides, name);
    for (const root of unit.roots) Engine.roots.push(root);
    for (const root of unit.roots) {
      if (root.activeSelf && !root._destroyed) activateRoot(root);
    }
    for (const listener of sceneLoadedListeners.slice()) listener({ name }, 0);
    return true;
  },
};

function activateRoot(root) {
  root.activeSelf = false;
  root.SetActive(true);
}

Engine.loadScene = (name) => SceneManager.loadNow(name);
