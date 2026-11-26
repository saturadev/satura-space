import { Vector2, Color, Mathf, Screen, Time } from './core.js';
import { Behaviour, MonoBehaviour, RectTransform, Engine, FindObjectsOfType, cloneValue, matApply, matInvert } from './object.js';
import { Camera, Collider2D, registerComponentType } from './components.js';

export class UnityEvent {
  constructor() {
    this._calls = [];
    this._listeners = [];
  }
  AddListener(listener) {
    this._listeners.push(listener);
  }
  RemoveListener(listener) {
    const index = this._listeners.indexOf(listener);
    if (index >= 0) this._listeners.splice(index, 1);
  }
  RemoveAllListeners() {
    this._listeners.length = 0;
  }
  Invoke(...args) {
    for (const call of this._calls) {
      const target = call.m_Target;
      if (!target || target._destroyed || call.m_CallState === 0) continue;
      const method = target[call.m_MethodName];
      if (typeof method !== 'function') {
        console.warn('UnityEvent: missing method ' + call.m_MethodName);
        continue;
      }
      const stored = call.m_Arguments || {};
      if (call.m_Mode === 0) method.apply(target, args);
      else if (call.m_Mode === 2) method.call(target, stored.m_ObjectArgument);
      else if (call.m_Mode === 3) method.call(target, stored.m_IntArgument);
      else if (call.m_Mode === 4) method.call(target, stored.m_FloatArgument);
      else if (call.m_Mode === 5) method.call(target, stored.m_StringArgument);
      else if (call.m_Mode === 6) method.call(target, stored.m_BoolArgument);
      else method.call(target);
    }
    for (const listener of this._listeners.slice()) listener(...args);
  }
  _loadEvent(value) {
    this._calls = (value && value.m_PersistentCalls && value.m_PersistentCalls.m_Calls) || [];
  }
  clone(map) {
    const copy = new UnityEvent();
    copy._calls = cloneValue(this._calls, map);
    return copy;
  }
}

export class Canvas extends Behaviour {
  constructor() {
    super();
    this.renderMode = 0;
    this.sortingOrder = 0;
  }
  static fields = ['renderMode', 'sortingOrder'];
  _load(props) {
    this.renderMode = props.m_RenderMode || 0;
    this.sortingOrder = props.m_SortingOrder || 0;
    if (this.renderMode === 2) console.warn('World space canvases are drawn as overlays');
  }
  get isRootCanvas() {
    const parent = this.transform._parent;
    return !parent || !parent.gameObject.GetComponentInParent(Canvas);
  }
  get scaleFactor() {
    const scaler = this.gameObject.GetComponent(CanvasScaler);
    return scaler && scaler._enabled ? scaler._scale() : 1;
  }
  _activate() {
    super._activate();
    if (!this.isRootCanvas) return;
    const canvas = this;
    this.transform._driver = {
      matrix() {
        const scale = canvas.scaleFactor;
        return [scale, 0, 0, scale, Screen.width / 2, Screen.height / 2];
      },
      size() {
        const scale = canvas.scaleFactor;
        return new Vector2(Screen.width / scale, Screen.height / scale);
      },
    };
  }
}

export class CanvasScaler extends Behaviour {
  constructor() {
    super();
    this.uiScaleMode = 0;
    this.scaleFactor = 1;
    this.referenceResolution = new Vector2(800, 600);
    this.screenMatchMode = 0;
    this.matchWidthOrHeight = 0;
  }
  static fields = ['uiScaleMode', 'scaleFactor', 'referenceResolution', 'screenMatchMode', 'matchWidthOrHeight'];
  _load(props, revive) {
    this.uiScaleMode = props.m_UiScaleMode;
    this.scaleFactor = props.m_ScaleFactor;
    this.referenceResolution = revive(props.m_ReferenceResolution);
    this.screenMatchMode = props.m_ScreenMatchMode;
    this.matchWidthOrHeight = props.m_MatchWidthOrHeight;
  }
  _scale() {
    if (this.uiScaleMode !== 1) return this.uiScaleMode === 0 ? this.scaleFactor : 1;
    const widthRatio = Screen.width / this.referenceResolution.x;
    const heightRatio = Screen.height / this.referenceResolution.y;
    if (this.screenMatchMode === 1) return Math.min(widthRatio, heightRatio);
    if (this.screenMatchMode === 2) return Math.max(widthRatio, heightRatio);
    return Math.pow(2, Mathf.LerpUnclamped(Math.log2(widthRatio), Math.log2(heightRatio), this.matchWidthOrHeight));
  }
}

export class CanvasGroup extends Behaviour {
  constructor() {
    super();
    this.alpha = 1;
    this.interactable = true;
    this.blocksRaycasts = true;
  }
  static fields = ['alpha', 'interactable', 'blocksRaycasts'];
  static animated = { m_Alpha: 'alpha' };
  _load(props) {
    this.alpha = props.m_Alpha;
    this.interactable = props.m_Interactable !== false;
    this.blocksRaycasts = props.m_BlocksRaycasts !== false;
  }
}

export class CanvasRenderer extends Behaviour {
  static fields = [];
  _load() {}
}

export class GraphicRaycaster extends Behaviour {
  static fields = [];
  _load() {}
}

export class Physics2DRaycaster extends Behaviour {
  static fields = [];
  _load() {}
}

export class Graphic extends Behaviour {
  constructor() {
    super();
    this._color = new Color(1, 1, 1, 1);
    this._tint = new Color(1, 1, 1, 1);
    this.raycastTarget = true;
  }
  get color() {
    return this._color.clone();
  }
  set color(value) {
    this._color = new Color(value.r, value.g, value.b, value.a);
  }
  get rectTransform() {
    return this.transform;
  }
  get canvas() {
    return this.gameObject.GetComponentInParent(Canvas);
  }
  _loadGraphic(props, revive) {
    if (props.m_Color) this._color = revive(props.m_Color);
    this.raycastTarget = props.m_RaycastTarget !== false;
  }
  _finalColor() {
    return new Color(this._color.r * this._tint.r, this._color.g * this._tint.g, this._color.b * this._tint.b, this._color.a * this._tint.a);
  }
  _draw() {}
}

export class Image extends Graphic {
  constructor() {
    super();
    this.sprite = null;
    this.type = 0;
    this.preserveAspect = false;
    this.fillAmount = 1;
  }
  static fields = ['_color', 'raycastTarget', 'sprite', 'type', 'preserveAspect', 'fillAmount'];
  static animated = { m_Color: '_color', m_Sprite: 'sprite', m_FillAmount: 'fillAmount', m_Enabled: 'enabled' };
  _load(props, revive) {
    this._loadGraphic(props, revive);
    this.sprite = revive(props.m_Sprite);
    this.type = props.m_Type || 0;
    this.preserveAspect = !!props.m_PreserveAspect;
    this.fillAmount = props.m_FillAmount === undefined ? 1 : props.m_FillAmount;
    if (this.type > 1) console.warn('Image type ' + this.type + ' is drawn as Simple');
  }
  SetNativeSize() {
    if (this.sprite) this.transform.sizeDelta = new Vector2(this.sprite.w, this.sprite.h);
  }
  _draw(renderer, alpha) {
    const color = this._finalColor();
    color.a *= alpha;
    if (color.a <= 0) return;
    const rect = this.transform.rect;
    renderer.setTransform(this.transform._worldMatrix());
    if (!this.sprite) {
      renderer.fillRect(rect.x, rect.y, rect.width, rect.height, color);
      return;
    }
    let x = rect.x;
    let y = rect.y;
    let width = rect.width;
    let height = rect.height;
    if (this.preserveAspect && this.sprite.w > 0 && this.sprite.h > 0) {
      const spriteRatio = this.sprite.w / this.sprite.h;
      const rectRatio = width / height;
      const pivot = this.transform._pv;
      if (spriteRatio > rectRatio) {
        const fitted = width / spriteRatio;
        y += (height - fitted) * pivot.y;
        height = fitted;
      } else {
        const fitted = height * spriteRatio;
        x += (width - fitted) * pivot.x;
        width = fitted;
      }
    }
    const border = this.sprite.border;
    if (this.type === 1 && (border[0] > 0 || border[1] > 0 || border[2] > 0 || border[3] > 0)) {
      renderer.drawSliced(this.sprite, x, y, width, height, color);
      return;
    }
    renderer.drawSprite(this.sprite, x, y, width, height, color);
  }
}

let measureContext = null;

function getMeasureContext() {
  if (!measureContext) measureContext = document.createElement('canvas').getContext('2d');
  return measureContext;
}

export class Text extends Graphic {
  constructor() {
    super();
    this._text = '';
    this.font = null;
    this.fontSize = 14;
    this.fontStyle = 0;
    this.alignment = 0;
    this.resizeTextForBestFit = false;
    this.resizeTextMinSize = 10;
    this.resizeTextMaxSize = 40;
    this.horizontalOverflow = 0;
    this.verticalOverflow = 0;
    this.lineSpacing = 1;
    this.supportRichText = true;
    this._layoutKey = '';
    this._layoutResult = null;
  }
  static fields = [
    '_color', 'raycastTarget', '_text', 'font', 'fontSize', 'fontStyle', 'alignment', 'resizeTextForBestFit',
    'resizeTextMinSize', 'resizeTextMaxSize', 'horizontalOverflow', 'verticalOverflow', 'lineSpacing', 'supportRichText',
  ];
  static animated = { m_Color: '_color', m_Enabled: 'enabled' };
  get text() {
    return this._text;
  }
  set text(value) {
    this._text = value == null ? '' : String(value);
  }
  _load(props, revive) {
    this._loadGraphic(props, revive);
    this._text = props.m_Text || '';
    const data = props.m_FontData || {};
    this.font = revive(data.m_Font);
    this.fontSize = data.m_FontSize;
    this.fontStyle = data.m_FontStyle || 0;
    this.alignment = data.m_Alignment || 0;
    this.resizeTextForBestFit = !!data.m_BestFit;
    this.resizeTextMinSize = data.m_MinSize;
    this.resizeTextMaxSize = data.m_MaxSize;
    this.horizontalOverflow = data.m_HorizontalOverflow || 0;
    this.verticalOverflow = data.m_VerticalOverflow || 0;
    this.lineSpacing = data.m_LineSpacing === undefined ? 1 : data.m_LineSpacing;
    this.supportRichText = data.m_RichText !== false;
  }
  _cssFont(size) {
    const style = (this.fontStyle & 2 ? 'italic ' : '') + (this.fontStyle & 1 ? 'bold ' : '');
    const family = this.font ? this.font.family : 'sans-serif';
    return style + size + 'px "' + family + '", sans-serif';
  }
  _wrap(context, text, size, width) {
    context.font = this._cssFont(size);
    const lines = [];
    let widest = 0;
    for (const paragraph of text.split('\n')) {
      if (this.horizontalOverflow !== 0) {
        lines.push(paragraph);
        widest = Math.max(widest, context.measureText(paragraph).width);
        continue;
      }
      let line = '';
      for (const word of paragraph.split(' ')) {
        const candidate = line === '' ? word : line + ' ' + word;
        if (line !== '' && context.measureText(candidate).width > width) {
          lines.push(line);
          widest = Math.max(widest, context.measureText(line).width);
          line = word;
        } else {
          line = candidate;
        }
      }
      lines.push(line);
      widest = Math.max(widest, context.measureText(line).width);
    }
    return { lines, widest };
  }
  _layoutText(width, height) {
    const key = this._text + '|' + width + '|' + height + '|' + this.fontSize + '|' + this.resizeTextForBestFit;
    if (key === this._layoutKey) return this._layoutResult;
    const context = getMeasureContext();
    const text = this.supportRichText ? this._text.replace(/<\/?(b|i|size|color|material|quad)(=[^>]*)?>/g, '') : this._text;
    const lineRatio = (this.font ? this.font.lineHeight : 1.15) * this.lineSpacing;
    let size = this.fontSize;
    let wrapped = null;
    if (this.resizeTextForBestFit) {
      let low = Math.max(1, this.resizeTextMinSize);
      let high = Math.max(low, this.resizeTextMaxSize);
      const fits = (candidate) => {
        const attempt = this._wrap(context, text, candidate, width);
        return attempt.widest <= width + 0.5 && attempt.lines.length * candidate * lineRatio <= height + 0.5;
      };
      if (fits(high)) {
        low = high;
      } else {
        while (high - low > 1) {
          const middle = Math.floor((low + high) / 2);
          if (fits(middle)) low = middle;
          else high = middle;
        }
      }
      size = low;
    }
    wrapped = this._wrap(context, text, size, width);
    context.font = this._cssFont(size);
    const metrics = context.measureText('Mg');
    const ascent = metrics.fontBoundingBoxAscent || size * 0.8;
    const descent = metrics.fontBoundingBoxDescent || size * 0.2;
    this._layoutKey = key;
    this._layoutResult = { size, lines: wrapped.lines, lineHeight: size * lineRatio, ascent, descent };
    return this._layoutResult;
  }
  _draw(renderer, alpha) {
    const color = this._finalColor();
    color.a *= alpha;
    if (color.a <= 0 || this._text === '') return;
    const rect = this.transform.rect;
    const layout = this._layoutText(rect.width, rect.height);
    renderer.setTransform(this.transform._worldMatrix());
    const column = this.alignment % 3;
    const row = Math.floor(this.alignment / 3);
    const blockHeight = layout.lines.length * layout.lineHeight;
    let top = rect.y + rect.height;
    if (row === 1) top = rect.y + rect.height / 2 + blockHeight / 2;
    else if (row === 2) top = rect.y + blockHeight;
    const anchorX = column === 0 ? rect.x : column === 1 ? rect.x + rect.width / 2 : rect.x + rect.width;
    const align = column === 0 ? 'left' : column === 1 ? 'center' : 'right';
    const inner = (layout.lineHeight - (layout.ascent + layout.descent)) / 2 + layout.ascent;
    renderer.drawText(layout.lines, this._cssFont(layout.size), align, anchorX, top, layout.lineHeight, inner, color);
  }
}

export class Selectable extends MonoBehaviour {
  constructor() {
    super();
    this.interactable = true;
    this.transition = 1;
    this.colors = null;
    this.targetGraphic = null;
    this._inside = false;
    this._pressed = false;
  }
  static fields = ['interactable', 'transition', 'colors', 'targetGraphic'];
  _loadSelectable(props, revive) {
    this.interactable = props.m_Interactable !== false;
    this.transition = props.m_Transition === undefined ? 1 : props.m_Transition;
    this.colors = revive(props.m_Colors);
    this.targetGraphic = revive(props.m_TargetGraphic);
    if (this.transition > 1) console.warn('Selectable transition ' + this.transition + ' is not supported');
  }
  IsInteractable() {
    if (!this.interactable) return false;
    let transform = this.transform;
    while (transform) {
      const group = transform.gameObject.GetComponent(CanvasGroup);
      if (group && group._enabled && !group.interactable) return false;
      transform = transform._parent;
    }
    return true;
  }
  OnPointerEnter() {
    this._inside = true;
  }
  OnPointerExit() {
    this._inside = false;
  }
  OnPointerDown() {
    this._pressed = true;
  }
  OnPointerUp() {
    this._pressed = false;
  }
  OnDisable() {
    this._inside = false;
    this._pressed = false;
  }
  Update() {
    const graphic = this.targetGraphic;
    if (this.transition !== 1 || !graphic || graphic._destroyed || !this.colors) return;
    const colors = this.colors;
    let target = colors.m_NormalColor;
    if (!this.IsInteractable()) target = colors.m_DisabledColor;
    else if (this._pressed) target = colors.m_PressedColor;
    else if (this._inside) target = colors.m_HighlightedColor;
    const multiplier = colors.m_ColorMultiplier === undefined ? 1 : colors.m_ColorMultiplier;
    const goal = new Color(target.r * multiplier, target.g * multiplier, target.b * multiplier, target.a);
    const duration = colors.m_FadeDuration || 0;
    const step = duration > 0 ? Mathf.Clamp01(Time.unscaledDeltaTime / duration) : 1;
    const tint = graphic._tint;
    tint.r += (goal.r - tint.r) * step;
    tint.g += (goal.g - tint.g) * step;
    tint.b += (goal.b - tint.b) * step;
    tint.a += (goal.a - tint.a) * step;
  }
}

export class Button extends Selectable {
  constructor() {
    super();
    this.onClick = new UnityEvent();
  }
  static fields = ['interactable', 'transition', 'colors', 'targetGraphic', 'onClick'];
  _load(props, revive) {
    this._loadSelectable(props, revive);
    this.onClick._loadEvent(revive(props.m_OnClick));
  }
  OnPointerClick(eventData) {
    if (eventData.button !== 0 || !this.isActiveAndEnabled || !this.IsInteractable()) return;
    this.onClick.Invoke();
  }
}

export class PointerEventData {
  constructor() {
    this.pointerId = 0;
    this.button = 0;
    this.position = new Vector2();
    this.pressPosition = new Vector2();
    this.delta = new Vector2();
    this.pointerEnter = null;
    this.pointerPress = null;
    this.rawPointerPress = null;
    this.pointerClick = null;
    this.pointerDrag = null;
    this.dragging = false;
    this.eligibleForClick = false;
    this.pointerCurrentRaycast = { gameObject: null };
    this.pointerPressRaycast = { gameObject: null };
    this.hovered = [];
    this._down = false;
  }
  static InputButton = { Left: 0, Right: 1, Middle: 2 };
}

export class EventSystem extends Behaviour {
  constructor() {
    super();
    this.pixelDragThreshold = 10;
  }
  static fields = ['pixelDragThreshold'];
  static current = null;
  _load(props) {
    this.pixelDragThreshold = props.m_DragThreshold === undefined ? 10 : props.m_DragThreshold;
  }
  _activate() {
    super._activate();
    EventSystem.current = this;
  }
  _deactivate() {
    super._deactivate();
    if (EventSystem.current === this) EventSystem.current = null;
  }
  IsPointerOverGameObject() {
    for (const state of pointerStates.values()) {
      if (state.pointerEnter && state.pointerEnter.GetComponentInParent(Canvas)) return true;
    }
    return false;
  }
}

const pointerStates = new Map();

export const PointerInput = {
  queue: [],
  push(event) {
    this.queue.push(event);
  },
  reset() {
    this.queue.length = 0;
    pointerStates.clear();
  },
};

function collectGraphics(gameObject, list, blocked) {
  if (!gameObject.activeSelf) return;
  const group = gameObject.GetComponent(CanvasGroup);
  if (group && group._enabled && !group.blocksRaycasts) blocked = true;
  if (!blocked) {
    for (const component of gameObject.components) {
      if (component instanceof Graphic && component._enabled && component.raycastTarget) list.push(component);
    }
  }
  for (const child of gameObject.transform._children) collectGraphics(child.gameObject, list, blocked);
}

function raycastGraphics(x, y) {
  const canvases = FindObjectsOfType(Canvas)
    .filter((canvas) => canvas._enabled && canvas.isRootCanvas)
    .sort((a, b) => b.sortingOrder - a.sortingOrder);
  for (const canvas of canvases) {
    const raycaster = canvas.gameObject.GetComponent(GraphicRaycaster);
    if (!raycaster || !raycaster._enabled) continue;
    const graphics = [];
    collectGraphics(canvas.gameObject, graphics, false);
    for (let i = graphics.length - 1; i >= 0; i--) {
      const graphic = graphics[i];
      const local = matApply(matInvert(graphic.transform._worldMatrix()), x, y);
      const rect = graphic.transform instanceof RectTransform ? graphic.transform.rect : null;
      if (rect && local[0] >= rect.x && local[0] <= rect.x + rect.width && local[1] >= rect.y && local[1] <= rect.y + rect.height) {
        return graphic.gameObject;
      }
    }
  }
  return null;
}

function raycastColliders(x, y) {
  const cameras = Camera.all.reverse();
  for (const camera of cameras) {
    const raycaster = camera.gameObject.GetComponent(Physics2DRaycaster);
    if (!raycaster || !raycaster._enabled) continue;
    const point = camera.ScreenToWorldPoint(new Vector2(x, y));
    let best = null;
    let bestZ = Infinity;
    let bestStamp = -1;
    for (const collider of FindObjectsOfType(Collider2D)) {
      if (!collider._enabled || !collider.OverlapPoint(point)) continue;
      const z = collider.transform._worldZ();
      const stamp = collider.transform._moveStamp();
      if (z < bestZ || (z === bestZ && stamp > bestStamp)) {
        best = collider;
        bestZ = z;
        bestStamp = stamp;
      }
    }
    if (best) return best.gameObject;
  }
  return null;
}

export function RaycastScreen(x, y) {
  return raycastGraphics(x, y) || raycastColliders(x, y);
}

function executeOn(gameObject, method, eventData) {
  if (!gameObject || gameObject._destroyed || !gameObject.activeInHierarchy) return false;
  let handled = false;
  for (const component of gameObject.components.slice()) {
    if (typeof component[method] !== 'function' || component._destroyed) continue;
    if (component instanceof Behaviour && !component._enabled) continue;
    component[method](eventData);
    handled = true;
  }
  return handled;
}

function hasHandler(gameObject, method) {
  return gameObject.components.some(
    (component) => typeof component[method] === 'function' && !component._destroyed && (!(component instanceof Behaviour) || component._enabled)
  );
}

function getEventHandler(gameObject, method) {
  let transform = gameObject && !gameObject._destroyed ? gameObject.transform : null;
  while (transform) {
    if (hasHandler(transform.gameObject, method)) return transform.gameObject;
    transform = transform._parent;
  }
  return null;
}

function executeHierarchy(gameObject, method, eventData) {
  const handler = getEventHandler(gameObject, method);
  if (handler && executeOn(handler, method, eventData)) return handler;
  return null;
}

function commonRoot(first, second) {
  if (!first || !second || first._destroyed || second._destroyed) return null;
  let a = first.transform;
  while (a) {
    let b = second.transform;
    while (b) {
      if (a === b) return a.gameObject;
      b = b._parent;
    }
    a = a._parent;
  }
  return null;
}

function handleEnterExit(state, target) {
  if (state.pointerEnter === target) return;
  if (!target) {
    for (const hovered of state.hovered) executeOn(hovered, 'OnPointerExit', state);
    state.hovered = [];
    state.pointerEnter = null;
    return;
  }
  const root = commonRoot(state.pointerEnter, target);
  if (state.pointerEnter && !state.pointerEnter._destroyed) {
    let transform = state.pointerEnter.transform;
    while (transform && transform.gameObject !== root) {
      executeOn(transform.gameObject, 'OnPointerExit', state);
      const index = state.hovered.indexOf(transform.gameObject);
      if (index >= 0) state.hovered.splice(index, 1);
      transform = transform._parent;
    }
  } else {
    state.hovered = [];
  }
  state.pointerEnter = target;
  let transform = target.transform;
  while (transform && transform.gameObject !== root) {
    executeOn(transform.gameObject, 'OnPointerEnter', state);
    state.hovered.push(transform.gameObject);
    transform = transform._parent;
  }
}

function processPointer(event) {
  let state = pointerStates.get(event.id);
  if (!state) {
    state = new PointerEventData();
    state.pointerId = event.id;
    pointerStates.set(event.id, state);
  }
  const position = new Vector2(event.x, event.y);
  state.delta = position.sub(state.position);
  state.position = position;
  state.button = event.button || 0;
  const hit = event.type === 'cancel' ? null : RaycastScreen(event.x, event.y);
  state.pointerCurrentRaycast = { gameObject: hit, screenPosition: position };

  if (event.type === 'hover') {
    handleEnterExit(state, hit);
    return;
  }

  if (event.type === 'down') {
    handleEnterExit(state, hit);
    state._down = true;
    state.eligibleForClick = true;
    state.pressPosition = position.clone();
    state.pointerPressRaycast = state.pointerCurrentRaycast;
    const clickHandler = getEventHandler(hit, 'OnPointerClick');
    state.pointerPress = executeHierarchy(hit, 'OnPointerDown', state) || clickHandler;
    state.rawPointerPress = hit;
    state.pointerClick = clickHandler;
    state.pointerDrag = getEventHandler(hit, 'OnDrag');
    state.dragging = false;
    return;
  }

  if (event.type === 'move') {
    handleEnterExit(state, hit);
    if (state._down && state.pointerDrag) {
      const threshold = EventSystem.current ? EventSystem.current.pixelDragThreshold : 10;
      if (!state.dragging && Vector2.Distance(state.pressPosition, position) >= threshold) {
        executeOn(state.pointerDrag, 'OnBeginDrag', state);
        state.dragging = true;
      }
      if (state.dragging) executeOn(state.pointerDrag, 'OnDrag', state);
    }
    return;
  }

  if (state._down) {
    if (state.pointerPress) executeOn(state.pointerPress, 'OnPointerUp', state);
    const clickHandler = getEventHandler(hit, 'OnPointerClick');
    if (event.type === 'up' && state.pointerClick && state.pointerClick === clickHandler && state.eligibleForClick) {
      executeOn(clickHandler, 'OnPointerClick', state);
    }
    if (state.pointerDrag && state.dragging) {
      executeHierarchy(hit, 'OnDrop', state);
      executeOn(state.pointerDrag, 'OnEndDrag', state);
    }
  }
  state._down = false;
  state.eligibleForClick = false;
  state.pointerPress = null;
  state.rawPointerPress = null;
  state.pointerClick = null;
  state.pointerDrag = null;
  state.dragging = false;
  if (event.touch || event.type === 'cancel') {
    handleEnterExit(state, null);
    pointerStates.delete(event.id);
  }
}

export function ProcessPointerQueue() {
  if (PointerInput.queue.length === 0) return;
  const events = PointerInput.queue.splice(0, PointerInput.queue.length);
  const system = EventSystem.current;
  if (!system || system._destroyed || !system._active) return;
  for (const event of events) processPointer(event);
}

Engine.preUpdate.push(ProcessPointerQueue);

class IgnoredBehaviour extends Behaviour {
  static fields = [];
  _load() {}
}

export class StandaloneInputModule extends IgnoredBehaviour {}
export class InputSystemUIInputModule extends IgnoredBehaviour {}
export class AudioListener extends IgnoredBehaviour {}
export class FlareLayer extends IgnoredBehaviour {}

registerComponentType('UnityEngine.RectTransform', RectTransform);
registerComponentType('UnityEngine.Canvas', Canvas);
registerComponentType('UnityEngine.CanvasGroup', CanvasGroup);
registerComponentType('UnityEngine.CanvasRenderer', CanvasRenderer);
registerComponentType('UnityEngine.UI.CanvasScaler', CanvasScaler);
registerComponentType('UnityEngine.UI.GraphicRaycaster', GraphicRaycaster);
registerComponentType('UnityEngine.UI.Image', Image);
registerComponentType('UnityEngine.UI.Text', Text);
registerComponentType('UnityEngine.UI.Button', Button);
registerComponentType('UnityEngine.EventSystems.EventSystem', EventSystem);
registerComponentType('UnityEngine.EventSystems.Physics2DRaycaster', Physics2DRaycaster);
registerComponentType('UnityEngine.EventSystems.StandaloneInputModule', StandaloneInputModule);
registerComponentType('UnityEngine.InputSystem.UI.InputSystemUIInputModule', InputSystemUIInputModule);
registerComponentType('UnityEngine.AudioListener', AudioListener);
registerComponentType('UnityEngine.FlareLayer', FlareLayer);
