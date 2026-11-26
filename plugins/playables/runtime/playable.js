import { Random, Screen, Time } from './core.js';
import { Engine, FindObjectsOfType, MonoBehaviour, GameObject } from './object.js';
import { Camera } from './components.js';
import { PointerInput, Canvas } from './ui.js';
import { SceneManager, Assets } from './scene.js';
import { CanvasRenderer2D } from './render.js';
import { Ad } from './ad.js';

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = document.createElement('img');
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('atlas failed to decode'));
    image.src = url;
  });
}

function withDeadline(promise, milliseconds) {
  return Promise.race([promise, new Promise((resolve) => setTimeout(resolve, milliseconds))]);
}

export const Playable = {
  config: null,
  stage: null,
  canvas: null,
  renderer: null,
  seed: null,
  paused: false,
  started: false,
  lastTime: 0,
  frames: 0,
  errors: [],
  engine: Engine,
  assets: Assets,
  scenes: SceneManager,
  ad: Ad,
  time: Time,
  random: Random,

  async boot(payload) {
    this.config = payload.config;
    const data = payload.data;
    this.stage = document.getElementById('stage');
    this.canvas = document.getElementById('game');
    window.addEventListener('error', (event) => this.errors.push(String(event.message)));

    const images = await Promise.all(payload.atlases.map((url) => loadImage(url)));
    if (document.fonts && data.fonts.length > 0) {
      await withDeadline(Promise.all(data.fonts.map((font, index) => (font.file ? document.fonts.load('32px "pf' + index + '"') : null))), 1500);
    }

    this.renderer = new CanvasRenderer2D(this.canvas, images, {
      background: (this.config.stage && this.config.stage.background) || '#000',
      sortingLayers: data.sortingLayers,
    });
    SceneManager.init(data, { overrides: this.config.overrides, clipOverrides: this.config.clipOverrides, files: payload.files });
    SceneManager.sceneLoaded.AddListener(() => {
      if (this.seed !== null && this.seed !== undefined) Random.InitState(this.seed);
    });

    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.bindPointer();
    Ad.init(this);

    const query = new URLSearchParams(window.location.search);
    if (query.has('seed')) this.seed = Number(query.get('seed')) >>> 0;
    else if (this.config.seed !== undefined && this.config.seed !== null) this.seed = this.config.seed >>> 0;

    Ad.whenReady(() => this.start());
  },

  start() {
    if (this.started) return;
    this.started = true;
    SceneManager.loadNow(this.config.startScene);
    this.lastTime = performance.now();
    const tick = (now) => {
      requestAnimationFrame(tick);
      const delta = Math.min((now - this.lastTime) / 1000, 0.1);
      this.lastTime = now;
      if (this.paused || delta <= 0) return;
      Engine.frame(delta);
      this.renderer.render();
      this.frames++;
    };
    requestAnimationFrame(tick);
  },

  resize() {
    const stageConfig = this.config.stage || {};
    const aspect = (stageConfig.width || 9) / (stageConfig.height || 16);
    const viewWidth = window.innerWidth;
    const viewHeight = window.innerHeight;
    let width = Math.min(viewWidth, viewHeight * aspect);
    let height = width / aspect;
    if (height > viewHeight) {
      height = viewHeight;
      width = height * aspect;
    }
    const style = this.stage.style;
    style.width = width + 'px';
    style.height = height + 'px';
    style.left = (viewWidth - width) / 2 + 'px';
    style.top = (viewHeight - height) / 2 + 'px';
    style.setProperty('--u', width / 100 + 'px');
    const maxHeight = stageConfig.maxPixelHeight || 1920;
    const ratio = Math.min(window.devicePixelRatio || 1, maxHeight / Math.max(1, height));
    this.canvas.width = Math.max(1, Math.round(width * ratio));
    this.canvas.height = Math.max(1, Math.round(height * ratio));
    Screen.width = this.canvas.width;
    Screen.height = this.canvas.height;
    if (this.started && this.renderer) this.renderer.render();
  },

  toScreen(clientX, clientY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: ((clientX - rect.left) * this.canvas.width) / rect.width,
      y: ((rect.bottom - clientY) * this.canvas.height) / rect.height,
    };
  },

  toClient(screenX, screenY) {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: rect.left + (screenX * rect.width) / this.canvas.width,
      y: rect.bottom - (screenY * rect.height) / this.canvas.height,
    };
  },

  worldToClient(point) {
    const camera = Camera.main;
    const screen = camera.WorldToScreenPoint(point);
    return this.toClient(screen.x, screen.y);
  },

  clientPointOf(name) {
    const gameObject = GameObject.Find(name);
    if (!gameObject) return null;
    const position = gameObject.transform.position;
    if (gameObject.GetComponentInParent(Canvas)) return this.toClient(position.x, position.y);
    return this.worldToClient(position);
  },

  pointer(type, clientX, clientY, id = 1, touch = false) {
    const point = this.toScreen(clientX, clientY);
    PointerInput.push({ type, id, x: point.x, y: point.y, button: 0, touch });
    if (type === 'down') Ad.interaction();
  },

  bindPointer() {
    const canvas = this.canvas;
    const push = (type) => (event) => {
      if (type === 'down' && canvas.setPointerCapture) {
        try {
          canvas.setPointerCapture(event.pointerId);
        } catch (error) {
          this.captureFailed = true;
        }
      }
      this.pointer(type, event.clientX, event.clientY, event.pointerId, event.pointerType === 'touch');
      event.preventDefault();
    };
    canvas.addEventListener('pointerdown', push('down'));
    canvas.addEventListener('pointermove', push('move'));
    canvas.addEventListener('pointerup', push('up'));
    canvas.addEventListener('pointercancel', push('cancel'));
    canvas.addEventListener('contextmenu', (event) => event.preventDefault());
    document.addEventListener('touchmove', (event) => event.preventDefault(), { passive: false });
    document.addEventListener('visibilitychange', () => this.broadcastPause(document.hidden));
  },

  broadcastPause(paused) {
    if (!this.started) return;
    for (const behaviour of FindObjectsOfType(MonoBehaviour)) {
      if (typeof behaviour.OnApplicationPause === 'function') behaviour.OnApplicationPause(paused);
      if (typeof behaviour.OnApplicationFocus === 'function') behaviour.OnApplicationFocus(!paused);
    }
    this.lastTime = performance.now();
  },

  pause() {
    this.paused = true;
  },

  resume() {
    this.paused = false;
    this.lastTime = performance.now();
  },

  step(delta = 1 / 60, count = 1) {
    for (let i = 0; i < count; i++) Engine.frame(delta);
  },

  render() {
    this.renderer.render();
  },

  restart(seed) {
    this.loadScene(SceneManager.active || this.config.startScene, seed);
  },

  loadScene(name, seed) {
    if (seed !== undefined) this.seed = seed === null ? null : seed >>> 0;
    return SceneManager.loadNow(name);
  },
};
