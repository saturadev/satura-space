import { Vector2, Vector3, Vector4, Quaternion, Color, Random, Time, Screen } from './core.js';
import { Engine, FindObjectsOfType, GameObject, Component, UnityObject, RectTransform } from './object.js';
import { Camera, lookupComponentType } from './components.js';
import { Canvas, PointerInput } from './ui.js';
import { SceneManager } from './scene.js';

function round(value, digits) {
  const scale = Math.pow(10, digits);
  return Math.round(value * scale) / scale;
}

function isInt(value) {
  return Number.isInteger(value);
}

export function ProbeValue(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (value instanceof UnityObject && value._destroyed) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return isInt(value) ? value : round(value, 3);
  if (value instanceof Vector2) return [round(value.x, 3), round(value.y, 3)];
  if (value instanceof Vector3) return [round(value.x, 3), round(value.y, 3), round(value.z, 3)];
  if (value instanceof Vector4) return [round(value.x, 3), round(value.y, 3), round(value.z, 3), round(value.w, 3)];
  if (value instanceof Quaternion) {
    const euler = value.eulerAngles;
    return [round(euler.x, 2), round(euler.y, 2), round(euler.z, 2)];
  }
  if (value instanceof Color) return [round(value.r, 3), round(value.g, 3), round(value.b, 3), round(value.a, 3)];
  if (value instanceof GameObject) return value._name;
  if (value instanceof Component) return value.gameObject._name;
  if (value instanceof UnityObject) return value._name;
  if (Array.isArray(value) && depth < 2) return value.slice(0, 256).map((item) => ProbeValue(item, depth + 1));
  return String(value);
}

export function ProbeMember(target, path) {
  let current = target;
  for (const part of String(path || '').split('.')) {
    if (current === null || current === undefined) return null;
    if (current instanceof UnityObject && current._destroyed) return null;
    if (!part) continue;
    if ((part === 'length' || part === 'Count') && Array.isArray(current)) current = current.length;
    else current = current[part];
  }
  return current;
}

function pathOf(transform) {
  let path = transform.gameObject._name;
  let current = transform._parent;
  while (current) {
    path = current.gameObject._name + '/' + path;
    current = current._parent;
  }
  return path;
}

export function FindPath(path) {
  const parts = path.split('/');
  for (const root of Engine.roots) {
    if (root._destroyed || root._name !== parts[0]) continue;
    let current = root.transform;
    for (let i = 1; i < parts.length && current; i++) {
      current = current._children.find((child) => child.gameObject._name === parts[i] && !child.gameObject._destroyed) || null;
    }
    if (current) return current.gameObject;
  }
  return null;
}

export function CaptureProbes(probes) {
  const result = {};
  for (const probe of probes || []) {
    const type = lookupComponentType(probe.type);
    const rows = [];
    if (type) {
      for (const component of FindObjectsOfType(type, !!probe.inactive)) {
        const row = { path: pathOf(component.transform) };
        for (const member of probe.members || []) row[member] = ProbeValue(ProbeMember(component, member));
        rows.push(JSON.stringify(row));
      }
    }
    rows.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    result[probe.type] = { found: !!type, rows };
  }
  return result;
}

function screenOf(pointer, toScreen) {
  if (pointer.target) {
    const gameObject = FindPath(pointer.target);
    if (gameObject) {
      const transform = gameObject.transform;
      if (transform instanceof RectTransform && gameObject.GetComponentInParent(Canvas)) {
        const rect = transform.rect;
        return toScreen(transform.TransformPoint(new Vector3(rect.x + rect.width / 2, rect.y + rect.height / 2, 0)), true);
      }
      return toScreen(transform.position, false);
    }
  }
  return toScreen(pointer.world, false);
}

function vec(value) {
  if (!value || value.length === 0) return new Vector3(0, 0, 0);
  return new Vector3(value[0], value[1] || 0, value[2] || 0);
}

function expand(step) {
  const frames = Math.max(1, step.frames || 12);
  const kind = String(step.kind || 'tap').toLowerCase();
  const timeline = [];
  if (kind === 'wait') {
    for (let i = 0; i < frames; i++) timeline.push(null);
    return timeline;
  }
  const from = { world: vec(step.from), target: step.target || null, down: false };
  if (kind === 'move') return [from];
  timeline.push(from);
  timeline.push({ ...from, down: true });
  if (kind === 'drag') {
    const a = vec(step.from);
    const b = vec(step.to);
    for (let i = 1; i <= frames; i++) timeline.push({ world: Vector3.LerpUnclamped(a, b, i / frames), target: null, down: true });
    timeline.push({ world: b, target: null, down: false });
  } else if (kind === 'hold') {
    for (let i = 0; i < frames; i++) timeline.push({ ...from, down: true });
    timeline.push({ ...from, down: false });
  } else {
    timeline.push({ ...from, down: false });
  }
  return timeline;
}

function settleList(settle) {
  if (!settle) return [];
  return (Array.isArray(settle) ? settle : [settle]).filter((item) => item && item.type);
}

function settled(settle) {
  for (const condition of settleList(settle)) {
    const type = lookupComponentType(condition.type);
    if (!type) continue;
    for (const component of FindObjectsOfType(type)) {
      const value = ProbeMember(component, condition.member);
      const text = value === null || value === undefined ? 'null' : String(value);
      if (text.toLowerCase() !== String(condition.equals).toLowerCase()) return false;
    }
  }
  return true;
}

export function RngCheck() {
  const saved = Random.state;
  Random.InitState(12345);
  const ints = [];
  for (let i = 0; i < 16; i++) ints.push(Random.Range(0, 6));
  ints.push(Random.Range(-5, 5));
  ints.push(Random.Range(0, 1000000));
  const floats = [round(Random.value, 6), round(Random.RangeFloat(2.5, 7.5), 6)];
  Random.state = saved;
  return { seed: 12345, ints, floats };
}

function toScreen(point, ui) {
  if (ui) return { x: point.x, y: point.y };
  const camera = Camera.main;
  if (!camera) return { x: 0, y: 0 };
  const screen = camera.WorldToScreenPoint(point);
  return { x: screen.x, y: screen.y };
}

export class VerifySession {
  constructor(playable, script) {
    this.playable = playable;
    this.script = script;
    this.delta = 1 / (script.fps || 60);
    this.settleMax = script.settleMax || 600;
    this.finalWait = script.finalWait === undefined ? 360 : script.finalWait;
    this.need = settleList(script.settle).reduce((n, item) => Math.max(n, item.frames || 1), 1);
    this.runs = [];
    this.input = [];
    this.error = null;
    this.done = false;
    this.run = -1;
    this.wasPaused = playable.paused;
    playable.pause();
    if (script.screen && playable.canvas) {
      playable.canvas.width = Screen.width = script.screen[0];
      playable.canvas.height = Screen.height = script.screen[1];
    }
    this.nextRun();
  }

  nextRun() {
    this.run++;
    if (this.run >= this.script.runs.length) {
      this.finish();
      return;
    }
    const run = this.script.runs[this.run];
    this.playable.loadScene(run.scene, run.seed);
    this.states = [];
    this.frame = 0;
    this.step = 0;
    this.wasDown = false;
    this.last = null;
    this.timeline = [];
    this.phase = 'settle';
    this.calm = 0;
    this.waited = 0;
  }

  snapshot(timedOut) {
    const state = { step: this.step, frame: this.frame, probes: CaptureProbes(this.script.probes) };
    if (timedOut) state.settleTimeout = true;
    this.states.push(state);
  }

  tick() {
    if (this.done) return false;
    try {
      this.frame++;
      for (const hook of Engine.early) hook(this.delta);
      const run = this.script.runs[this.run];
      let entered = false;
      if (this.phase === 'settle') {
        this.waited++;
        this.calm = settled(this.script.settle) ? this.calm + 1 : 0;
        if (this.calm >= this.need || this.waited >= this.settleMax) {
          this.snapshot(this.waited >= this.settleMax && this.calm < this.need);
          if (this.step >= (run.steps || []).length) {
            this.phase = 'final';
            this.waited = 0;
            entered = true;
          } else {
            this.timeline = expand(run.steps[this.step]);
            this.step++;
            this.phase = 'act';
          }
        }
      }
      let pushed = false;
      if (this.phase === 'act') {
        if (this.timeline.length === 0) {
          this.phase = 'settle';
          this.calm = 0;
          this.waited = 0;
        } else {
          const next = this.timeline.shift();
          if (next) {
            const point = screenOf(next, toScreen);
            const type = next.down && !this.wasDown ? 'down' : !next.down && this.wasDown ? 'up' : 'move';
            PointerInput.push({ type, id: 1, x: point.x, y: point.y, button: 0, touch: false });
            pushed = true;
            this.last = point;
            this.wasDown = next.down;
            this.input.push({ run: this.run, frame: this.frame, x: round(point.x, 2), y: round(point.y, 2), down: next.down });
          }
        }
      } else if (this.phase === 'final' && !entered) {
        this.waited++;
        if (this.waited >= this.finalWait) {
          this.snapshot(false);
          this.runs.push({ scene: run.scene, seed: run.seed, states: this.states });
          this.nextRun();
          return !this.done;
        }
      }
      if (!pushed && this.last) PointerInput.push({ type: 'hover', id: 1, x: this.last.x, y: this.last.y, button: 0, touch: false });
      Engine.frame(this.delta);
    } catch (e) {
      this.error = String((e && e.stack) || e);
      this.finish();
    }
    return !this.done;
  }

  advance(count = 1) {
    for (let i = 0; i < count && !this.done; i++) this.tick();
    this.playable.render();
    return { run: this.run, frame: this.frame, step: this.step, phase: this.phase, done: this.done, time: Time.time };
  }

  finish() {
    if (this.done) return;
    this.done = true;
    if (!this.wasPaused) this.playable.resume();
  }

  result() {
    return { side: 'html', exit: this.error ? 1 : 0, error: this.error, rng: RngCheck(), runs: this.runs, input: this.input, frames: Time.frameCount };
  }
}

export const Harness = {
  playable: null,

  session(script) {
    return new VerifySession(this.playable, script);
  },

  run(script) {
    const session = new VerifySession(this.playable, script);
    const started = Date.now();
    const deadline = (script.deadline || 600) * 1000;
    while (!session.done) {
      if (Date.now() - started > deadline) {
        session.error = 'deadline passed in run ' + session.run + ' step ' + session.step;
        session.finish();
        break;
      }
      session.tick();
    }
    this.playable.render();
    return session.result();
  },

  stepper() {
    const playable = this.playable;
    playable.pause();
    let frame = 0;
    return {
      advance: (count = 1, delta = 1 / 60) => {
        for (let i = 0; i < count; i++) {
          Engine.frame(delta);
          frame++;
        }
        playable.render();
        return { frame, time: Time.time };
      },
      pointer: (type, world, target) => {
        const point = screenOf({ world: vec(world), target }, toScreen);
        PointerInput.push({ type, id: 1, x: point.x, y: point.y, button: 0, touch: false });
        return point;
      },
    };
  },
};
