import { Screen } from './core.js';
import { Engine, matMul } from './object.js';
import { Camera, SpriteRenderer } from './components.js';
import { Canvas, CanvasGroup, Graphic } from './ui.js';

export class CanvasRenderer2D {
  constructor(canvas, atlases, options = {}) {
    this.canvas = canvas;
    this.context = canvas.getContext('2d', { alpha: !!CanvasRenderer2D.under });
    this.atlases = atlases;
    this.background = options.background || '#000';
    this.sortingLayers = new Map();
    for (const layer of options.sortingLayers || []) this.sortingLayers.set(layer.id, layer.value);
    this.tintCache = new Map();
  }

  setTransform(world) {
    const flipped = matMul([1, 0, 0, -1, 0, Screen.height], world);
    this.context.setTransform(flipped[0], flipped[1], flipped[2], flipped[3], flipped[4], flipped[5]);
    this.context.transform(1, 0, 0, -1, 0, 0);
  }

  tinted(sprite, color) {
    const r = Math.round(Math.min(1, Math.max(0, color.r)) * 255);
    const g = Math.round(Math.min(1, Math.max(0, color.g)) * 255);
    const b = Math.round(Math.min(1, Math.max(0, color.b)) * 255);
    if (r >= 254 && g >= 254 && b >= 254) return null;
    const key = sprite.index + ':' + r + ',' + g + ',' + b;
    let entry = this.tintCache.get(key);
    if (entry) {
      this.tintCache.delete(key);
      this.tintCache.set(key, entry);
      return entry;
    }
    entry = document.createElement('canvas');
    entry.width = sprite.w;
    entry.height = sprite.h;
    const context = entry.getContext('2d');
    context.drawImage(this.atlases[sprite.atlas], sprite.x, sprite.y, sprite.w, sprite.h, 0, 0, sprite.w, sprite.h);
    context.globalCompositeOperation = 'multiply';
    context.fillStyle = 'rgb(' + r + ',' + g + ',' + b + ')';
    context.fillRect(0, 0, sprite.w, sprite.h);
    context.globalCompositeOperation = 'destination-in';
    context.drawImage(this.atlases[sprite.atlas], sprite.x, sprite.y, sprite.w, sprite.h, 0, 0, sprite.w, sprite.h);
    this.tintCache.set(key, entry);
    if (this.tintCache.size > 96) this.tintCache.delete(this.tintCache.keys().next().value);
    return entry;
  }

  blit(sprite, sx, sy, sw, sh, x, y, width, height, color) {
    if (sw <= 0 || sh <= 0 || width <= 0 || height <= 0) return;
    const context = this.context;
    const tinted = this.tinted(sprite, color);
    context.globalAlpha = Math.min(1, Math.max(0, color.a));
    if (tinted) context.drawImage(tinted, sx, sy, sw, sh, x, -(y + height), width, height);
    else context.drawImage(this.atlases[sprite.atlas], sprite.x + sx, sprite.y + sy, sw, sh, x, -(y + height), width, height);
    context.globalAlpha = 1;
  }

  drawSprite(sprite, x, y, width, height, color) {
    this.blit(sprite, 0, 0, sprite.w, sprite.h, x, y, width, height, color);
  }

  drawSliced(sprite, x, y, width, height, color) {
    const [left, bottom, right, top] = sprite.border;
    const scale = Math.min(1, width / Math.max(1, left + right), height / Math.max(1, bottom + top));
    const l = left * scale;
    const r = right * scale;
    const b = bottom * scale;
    const t = top * scale;
    const sourceX = [0, left, sprite.w - right, sprite.w];
    const sourceY = [0, top, sprite.h - bottom, sprite.h];
    const targetX = [x, x + l, x + width - r, x + width];
    const targetY = [y + height, y + height - t, y + b, y];
    for (let row = 0; row < 3; row++) {
      for (let column = 0; column < 3; column++) {
        this.blit(
          sprite,
          sourceX[column],
          sourceY[row],
          sourceX[column + 1] - sourceX[column],
          sourceY[row + 1] - sourceY[row],
          targetX[column],
          targetY[row + 1],
          targetX[column + 1] - targetX[column],
          targetY[row] - targetY[row + 1],
          color
        );
      }
    }
  }

  fillRect(x, y, width, height, color) {
    this.context.fillStyle = color.css();
    this.context.fillRect(x, -(y + height), width, height);
  }

  drawText(lines, font, align, x, top, lineHeight, baselineOffset, color) {
    const context = this.context;
    context.font = font;
    context.textAlign = align;
    context.textBaseline = 'alphabetic';
    context.fillStyle = color.css();
    for (let i = 0; i < lines.length; i++) {
      context.fillText(lines[i], x, -(top - i * lineHeight - baselineOffset));
    }
  }

  collectSprites(gameObject, list) {
    if (!gameObject.activeSelf) return;
    for (const component of gameObject.components) {
      if (component instanceof SpriteRenderer && component.enabled && component.sprite) list.push(component);
    }
    for (const child of gameObject.transform._children) this.collectSprites(child.gameObject, list);
  }

  drawWorld(camera) {
    const sprites = [];
    for (const root of Engine.roots) this.collectSprites(root, sprites);
    const entries = sprites.map((renderer) => ({
      renderer,
      layer: this.sortingLayers.get(renderer.sortingLayerID) || 0,
      order: renderer.sortingOrder,
      z: renderer.transform._worldZ(),
      id: renderer._id,
    }));
    entries.sort((a, b) => a.layer - b.layer || a.order - b.order || b.z - a.z || a.id - b.id);
    const view = camera._screenMatrix();
    for (const entry of entries) {
      const renderer = entry.renderer;
      const sprite = renderer.sprite;
      const color = renderer._color;
      if (color.a <= 0) continue;
      this.setTransform(matMul(view, renderer.transform._worldMatrix()));
      if (renderer.flipX || renderer.flipY) this.context.scale(renderer.flipX ? -1 : 1, renderer.flipY ? -1 : 1);
      const unit = 1 / sprite.pixelsPerUnit;
      this.drawSprite(sprite, -sprite.px * unit, -sprite.py * unit, sprite.w * unit, sprite.h * unit, color);
    }
  }

  drawGraphics(gameObject, alpha) {
    if (!gameObject.activeSelf) return;
    const group = gameObject.GetComponent(CanvasGroup);
    if (group && group._enabled) alpha *= group.alpha;
    for (const component of gameObject.components) {
      if (component instanceof Graphic && component._enabled) component._draw(this, alpha);
    }
    for (const child of gameObject.transform._children) this.drawGraphics(child.gameObject, alpha);
  }

  collectCanvases(gameObject, list) {
    if (!gameObject.activeSelf) return;
    const canvas = gameObject.GetComponent(Canvas);
    if (canvas && canvas._enabled) {
      list.push(canvas);
      return;
    }
    for (const child of gameObject.transform._children) this.collectCanvases(child.gameObject, list);
  }

  render() {
    const context = this.context;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.globalAlpha = 1;
    const under = !!CanvasRenderer2D.under && CanvasRenderer2D.under.render(this.canvas, this.background);
    context.fillStyle = this.background;
    if (under) context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    else context.fillRect(0, 0, this.canvas.width, this.canvas.height);
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    for (const camera of Camera.all) {
      if (under && !camera.orthographic) continue;
      if (!under && camera.clearFlags <= 2) {
        context.setTransform(1, 0, 0, 1, 0, 0);
        const background = camera.backgroundColor.clone();
        background.a = 1;
        context.fillStyle = background.css();
        context.fillRect(0, 0, this.canvas.width, this.canvas.height);
      }
      this.drawWorld(camera);
    }
    const canvases = [];
    for (const root of Engine.roots) this.collectCanvases(root, canvases);
    canvases.sort((a, b) => a.sortingOrder - b.sortingOrder);
    for (const canvas of canvases) this.drawGraphics(canvas.gameObject, 1);
    context.setTransform(1, 0, 0, 1, 0, 0);
  }
}

CanvasRenderer2D.under = null;
