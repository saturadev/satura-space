import { splitTestIdAttributeNames } from '../isomorphic/locatorUtils';
import { parseAttributeSelector, parseSelector, stringifySelector, visitAllSelectorParts } from '../isomorphic/selectorParser';
import { cacheNormalizedWhitespaces, normalizeWhiteSpace, trimStringWithEllipsis } from '../isomorphic/stringUtils';

import { beginDOMCaches, enclosingShadowRootOrDocument, endDOMCaches, isElementVisible, isInsideScope, parentElementOrShadowHost, setGlobalOptions } from './domUtils';
import { kLayoutSelectorNames, layoutSelectorScore } from './layoutSelectorUtils';
import { createRoleEngine } from './roleSelectorEngine';
import { beginAriaCaches, endAriaCaches, getAriaDisabled, getAriaRole, getCheckedAllowMixed, getCheckedWithoutMixed, getElementAccessibleDescription, getElementAccessibleErrorMessage, getElementAccessibleName, getReadonly } from './roleUtils';
import { SelectorEvaluatorImpl, sortInDOMOrder } from './selectorEvaluator';
import { elementMatchesText, elementText, getElementLabels } from './selectorUtils';
import { XPathEngine } from './xpathSelectorEngine';
import { generateAriaTree, renderAriaTree } from './ariaSnapshot';

import type { CSSComplexSelectorList } from '../isomorphic/cssParser';
import type { AttributeSelectorPart, NestedSelectorBody, ParsedSelector, ParsedSelectorPart } from '../isomorphic/selectorParser';
import type { LayoutSelectorName } from './layoutSelectorUtils';
import type { SelectorEngine, SelectorRoot } from './selectorEngine';
import type { ElementText, TextMatcher } from './selectorUtils';
import type { AriaSnapshot, AriaTreeOptions } from './ariaSnapshot';

export type Builtins = {
  requestAnimationFrame: (callback: (time: number) => void) => void;
  performance: { now: () => number };
};

export type ElementState = 'visible' | 'hidden' | 'enabled' | 'disabled' | 'editable' | 'checked' | 'unchecked' | 'indeterminate' | 'stable';
export type ElementStateWithoutStable = Exclude<ElementState, 'stable'>;
export type ElementStateQueryResult = { matches: boolean, received?: string | 'error:notconnected', isRadio?: boolean };

export type HitTargetInterceptionResult = {
  stop: () => 'done' | { hitTargetDescription: string };
};

interface WebKitLegacyDeviceOrientationEvent extends DeviceOrientationEvent {
  readonly initDeviceOrientationEvent: (type: string, bubbles: boolean, cancelable: boolean, alpha: number, beta: number, gamma: number, absolute: boolean) => void;
}

interface WebKitLegacyDeviceMotionEvent extends DeviceMotionEvent {
  readonly initDeviceMotionEvent: (type: string, bubbles: boolean, cancelable: boolean, acceleration: DeviceMotionEventAcceleration, accelerationIncludingGravity: DeviceMotionEventAcceleration, rotationRate: DeviceMotionEventRotationRate, interval: number) => void;
}

export type InjectedScriptOptions = {
  isUnderTest: boolean;
  testIdAttributeName: string;
  stableRafCount: number;
  browserName: string;
  shouldPrependErrorPrefix?: boolean;
  isUtilityWorld?: boolean;
  customEngines: { name: string, source: string }[];
  builtins: Builtins;
};

export class InjectedScript {
  private _engines: Map<string, SelectorEngine>;
  protected _lastAriaSnapshotForQuery: AriaSnapshot | undefined;
  readonly _evaluator: SelectorEvaluatorImpl;
  private _stableRafCount: number;
  private _browserName: string;
  private _shouldPrependErrorPrefix: boolean;
  private _isUtilityWorld: boolean;
  readonly onGlobalListenersRemoved: Set<() => void>;
  private _hitTargetInterceptor: undefined | ((event: MouseEvent | PointerEvent | TouchEvent) => void);
  readonly isUnderTest: boolean;
  private _testIdAttributeNameForStrictErrorAndConsoleCodegen: string = 'data-testid';
  readonly window: Window & typeof globalThis;
  readonly document: Document;

  readonly utils = {
    cacheNormalizedWhitespaces,
    elementText,
    getAriaRole,
    getElementAccessibleDescription,
    getElementAccessibleName,
    isElementVisible,
    isInsideScope,
    normalizeWhiteSpace,
    builtins: null as unknown as Builtins,
  };

  private _autoClosingTags: Set<string>;
  private _booleanAttributes: Set<string>;
  private _eventTypes: Map<string, 'mouse' | 'keyboard' | 'touch' | 'pointer' | 'focus' | 'drag' | 'wheel' | 'deviceorientation' | 'devicemotion'>;
  private _hoverHitTargetInterceptorEvents: Set<string>;
  private _tapHitTargetInterceptorEvents: Set<string>;
  private _mouseHitTargetInterceptorEvents: Set<string>;
  private _allHitTargetInterceptorEvents: Set<string>;

  constructor(window: Window & typeof globalThis, options: InjectedScriptOptions) {
    this.window = window;
    this.document = window.document;
    this.isUnderTest = options.isUnderTest;
    this.utils.builtins = options.builtins;
    this._testIdAttributeNameForStrictErrorAndConsoleCodegen = options.testIdAttributeName;
    this._evaluator = new SelectorEvaluatorImpl();

    this.onGlobalListenersRemoved = new Set();
    this._autoClosingTags = new Set(['AREA', 'BASE', 'BR', 'COL', 'COMMAND', 'EMBED', 'HR', 'IMG', 'INPUT', 'KEYGEN', 'LINK', 'MENUITEM', 'META', 'PARAM', 'SOURCE', 'TRACK', 'WBR']);
    this._booleanAttributes = new Set(['checked', 'selected', 'disabled', 'readonly', 'multiple']);
    this._eventTypes = new Map([
      ['auxclick', 'mouse'],
      ['click', 'mouse'],
      ['dblclick', 'mouse'],
      ['mousedown', 'mouse'],
      ['mouseeenter', 'mouse'],
      ['mouseleave', 'mouse'],
      ['mousemove', 'mouse'],
      ['mouseout', 'mouse'],
      ['mouseover', 'mouse'],
      ['mouseup', 'mouse'],
      ['mouseleave', 'mouse'],
      ['mousewheel', 'mouse'],

      ['keydown', 'keyboard'],
      ['keyup', 'keyboard'],
      ['keypress', 'keyboard'],
      ['textInput', 'keyboard'],

      ['touchstart', 'touch'],
      ['touchmove', 'touch'],
      ['touchend', 'touch'],
      ['touchcancel', 'touch'],

      ['pointerover', 'pointer'],
      ['pointerout', 'pointer'],
      ['pointerenter', 'pointer'],
      ['pointerleave', 'pointer'],
      ['pointerdown', 'pointer'],
      ['pointerup', 'pointer'],
      ['pointermove', 'pointer'],
      ['pointercancel', 'pointer'],
      ['gotpointercapture', 'pointer'],
      ['lostpointercapture', 'pointer'],

      ['focus', 'focus'],
      ['blur', 'focus'],

      ['drag', 'drag'],
      ['dragstart', 'drag'],
      ['dragend', 'drag'],
      ['dragover', 'drag'],
      ['dragenter', 'drag'],
      ['dragleave', 'drag'],
      ['dragexit', 'drag'],
      ['drop', 'drag'],

      ['wheel', 'wheel'],

      ['deviceorientation', 'deviceorientation'],
      ['deviceorientationabsolute', 'deviceorientation'],

      ['devicemotion', 'devicemotion'],
    ]);
    this._hoverHitTargetInterceptorEvents = new Set(['mousemove']);
    this._tapHitTargetInterceptorEvents = new Set(['pointerdown', 'pointerup', 'touchstart', 'touchend', 'touchcancel']);
    this._mouseHitTargetInterceptorEvents = new Set(['mousedown', 'mouseup', 'pointerdown', 'pointerup', 'click', 'auxclick', 'dblclick', 'contextmenu']);
    this._allHitTargetInterceptorEvents = new Set([...this._hoverHitTargetInterceptorEvents, ...this._tapHitTargetInterceptorEvents, ...this._mouseHitTargetInterceptorEvents]);

    this._engines = new Map();
    this._engines.set('xpath', XPathEngine);
    this._engines.set('xpath:light', XPathEngine);
    this._engines.set('role', createRoleEngine(false));
    this._engines.set('text', this._createTextEngine(true, false));
    this._engines.set('text:light', this._createTextEngine(false, false));
    this._engines.set('id', this._createAttributeEngine('id', true));
    this._engines.set('id:light', this._createAttributeEngine('id', false));
    this._engines.set('data-testid', this._createAttributeEngine('data-testid', true));
    this._engines.set('data-testid:light', this._createAttributeEngine('data-testid', false));
    this._engines.set('data-test-id', this._createAttributeEngine('data-test-id', true));
    this._engines.set('data-test-id:light', this._createAttributeEngine('data-test-id', false));
    this._engines.set('data-test', this._createAttributeEngine('data-test', true));
    this._engines.set('data-test:light', this._createAttributeEngine('data-test', false));
    this._engines.set('css', this._createCSSEngine());
    this._engines.set('nth', { queryAll: () => [] });
    this._engines.set('visible', this._createVisibleEngine());
    this._engines.set('internal:control', this._createControlEngine());
    this._engines.set('internal:has', this._createHasEngine());
    this._engines.set('internal:has-not', this._createHasNotEngine());
    this._engines.set('internal:and', { queryAll: () => [] });
    this._engines.set('internal:or', { queryAll: () => [] });
    this._engines.set('internal:chain', this._createInternalChainEngine());
    this._engines.set('internal:label', this._createInternalLabelEngine());
    this._engines.set('internal:text', this._createTextEngine(true, true));
    this._engines.set('internal:has-text', this._createInternalHasTextEngine());
    this._engines.set('internal:has-not-text', this._createInternalHasNotTextEngine());
    this._engines.set('internal:attr', this._createNamedAttributeEngine());
    this._engines.set('internal:testid', this._createTestIdEngine());
    this._engines.set('internal:role', createRoleEngine(true));
    this._engines.set('internal:describe', this._createDescribeEngine());
    this._engines.set('aria-ref', this._createAriaRefEngine());

    for (const { name, source } of options.customEngines)
      this._engines.set(name, this.eval(source));

    this._stableRafCount = options.stableRafCount;
    this._browserName = options.browserName;
    this._shouldPrependErrorPrefix = !!options.shouldPrependErrorPrefix;
    this._isUtilityWorld = !!options.isUtilityWorld;
    setGlobalOptions({ browserNameForWorkarounds: options.browserName });

    this._setupGlobalListenersRemovalDetection();
    this._setupHitTargetInterceptors();

    if (this.isUnderTest)
      (this.window as any).__injectedScript = this;
  }

  eval(expression: string): any {
    return this.window.eval(expression);
  }

  testIdAttributeNameForStrictErrorAndConsoleCodegen(): string {
    return this._testIdAttributeNameForStrictErrorAndConsoleCodegen;
  }

  parseSelector(selector: string): ParsedSelector {
    const result = parseSelector(selector);
    visitAllSelectorParts(result, part => {
      if (!this._engines.has(part.name))
        throw this.createStacklessError(`Unknown engine "${part.name}" while parsing selector ${selector}`);
    });
    return result;
  }

  querySelector(selector: ParsedSelector, root: Node, strict: boolean): Element | undefined {
    const result = this.querySelectorAll(selector, root);
    if (strict && result.length > 1)
      throw this.strictModeViolationError(selector, result);
    this.checkDeprecatedSelectorUsage(selector, result);
    return result[0];
  }

  private _queryNth(elements: Set<Element>, part: ParsedSelectorPart): Set<Element> {
    const list = [...elements];
    let nth = +part.body;
    if (nth === -1)
      nth = list.length - 1;
    return new Set<Element>(list.slice(nth, nth + 1));
  }

  private _queryLayoutSelector(elements: Set<Element>, part: ParsedSelectorPart, originalRoot: Node): Set<Element> {
    const name = part.name as LayoutSelectorName;
    const body = part.body as NestedSelectorBody;
    const result: { element: Element, score: number }[] = [];
    const inner = this.querySelectorAll(body.parsed, originalRoot);
    for (const element of elements) {
      const score = layoutSelectorScore(name, element, inner, body.distance);
      if (score !== undefined)
        result.push({ element, score });
    }
    result.sort((a, b) => a.score - b.score);
    return new Set<Element>(result.map(r => r.element));
  }

  querySelectorAll(selector: ParsedSelector, root: Node): Element[] {
    if (selector.capture !== undefined) {
      if (selector.parts.some(part => part.name === 'nth'))
        throw this.createStacklessError(`Can't query n-th element in a request with the capture.`);
      const withHas: ParsedSelector = { parts: selector.parts.slice(0, selector.capture + 1) };
      if (selector.capture < selector.parts.length - 1) {
        const parsed: ParsedSelector = { parts: selector.parts.slice(selector.capture + 1) };
        const has: ParsedSelectorPart = { name: 'internal:has', body: { parsed }, source: stringifySelector(parsed) };
        withHas.parts.push(has);
      }
      return this.querySelectorAll(withHas, root);
    }

    if (!(root as any)['querySelectorAll'])
      throw this.createStacklessError('Node is not queryable.');

    if (selector.capture !== undefined) {
      throw this.createStacklessError('Internal error: there should not be a capture in the selector.');
    }

    if (root.nodeType === 11 && selector.parts.length === 1 && selector.parts[0].name === 'css' && selector.parts[0].source === ':scope')
      return [root as Element];

    this._evaluator.begin();
    try {
      let roots = new Set<Element>([root as Element]);
      for (const part of selector.parts) {
        if (part.name === 'nth') {
          roots = this._queryNth(roots, part);
        } else if (part.name === 'internal:and') {
          const andElements = this.querySelectorAll((part.body as NestedSelectorBody).parsed, root);
          roots = new Set(andElements.filter(e => roots.has(e)));
        } else if (part.name === 'internal:or') {
          const orElements = this.querySelectorAll((part.body as NestedSelectorBody).parsed, root);
          roots = new Set(sortInDOMOrder(new Set([...roots, ...orElements])));
        } else if (kLayoutSelectorNames.includes(part.name as LayoutSelectorName)) {
          roots = this._queryLayoutSelector(roots, part, root);
        } else {
          const next = new Set<Element>();
          for (const root of roots) {
            const all = this._queryEngineAll(part, root);
            for (const one of all)
              next.add(one);
          }
          roots = next;
        }
      }
      return [...roots];
    } finally {
      this._evaluator.end();
    }
  }

  private _queryEngineAll(part: ParsedSelectorPart, root: SelectorRoot): Element[] {
    const result = this._engines.get(part.name)!.queryAll(root, part.body);
    for (const element of result) {
      if (!('nodeName' in element))
        throw this.createStacklessError(`Expected a Node but got ${Object.prototype.toString.call(element)}`);
    }
    return result;
  }

  private _createAttributeEngine(attribute: string, shadow: boolean): SelectorEngine {
    const toCSS = (selector: string): CSSComplexSelectorList => {
      const css = `[${attribute}=${JSON.stringify(selector)}]`;
      return [{ simples: [{ selector: { css, functions: [] }, combinator: '' }] }];
    };
    return {
      queryAll: (root: SelectorRoot, selector: string): Element[] => {
        return this._evaluator.query({ scope: root as Document | Element, pierceShadow: shadow }, toCSS(selector));
      }
    };
  }

  private _createCSSEngine(): SelectorEngine {
    return {
      queryAll: (root: SelectorRoot, body: any) => {
        return this._evaluator.query({ scope: root as Document | Element, pierceShadow: true }, body);
      }
    };
  }

  private _createTextEngine(shadow: boolean, internal: boolean): SelectorEngine {
    const queryAll = (root: SelectorRoot, selector: string): Element[] => {
      const { matcher, kind } = createTextMatcher(selector, internal);
      const result: Element[] = [];
      let lastDidNotMatchSelf: Element | null = null;

      const appendElement = (element: Element) => {
        if (kind === 'lax' && lastDidNotMatchSelf && lastDidNotMatchSelf.contains(element))
          return false;
        const matches = elementMatchesText(this._evaluator._cacheText, element, matcher);
        if (matches === 'none')
          lastDidNotMatchSelf = element;
        if (matches === 'self' || (matches === 'selfAndChildren' && kind === 'strict' && !internal))
          result.push(element);
      };

      if (root.nodeType === Node.ELEMENT_NODE)
        appendElement(root as Element);
      const elements = this._evaluator._queryCSS({ scope: root as Document | Element, pierceShadow: shadow }, '*');
      for (const element of elements)
        appendElement(element);
      return result;
    };
    return { queryAll };
  }

  private _createInternalHasTextEngine(): SelectorEngine {
    return {
      queryAll: (root: SelectorRoot, selector: string): Element[] => {
        if (root.nodeType !== 1)
          return [];
        const element = root as Element;
        const text = elementText(this._evaluator._cacheText, element);
        const { matcher } = createTextMatcher(selector, true);
        return matcher(text) ? [element] : [];
      }
    };
  }

  private _createInternalHasNotTextEngine(): SelectorEngine {
    return {
      queryAll: (root: SelectorRoot, selector: string): Element[] => {
        if (root.nodeType !== 1)
          return [];
        const element = root as Element;
        const text = elementText(this._evaluator._cacheText, element);
        const { matcher } = createTextMatcher(selector, true);
        return matcher(text) ? [] : [element];
      }
    };
  }

  private _createInternalLabelEngine(): SelectorEngine {
    return {
      queryAll: (root: SelectorRoot, selector: string): Element[] => {
        const { matcher } = createTextMatcher(selector, true);
        const allElements = this._evaluator._queryCSS({ scope: root as Document | Element, pierceShadow: true }, '*');
        return allElements.filter(element => {
          return getElementLabels(this._evaluator._cacheText, element).some(label => matcher(label));
        });
      }
    };
  }

  private _createNamedAttributeEngine(): SelectorEngine {
    const queryAll = (root: SelectorRoot, selector: string): Element[] => {
      const parsed = parseAttributeSelector(selector, true);
      if (parsed.name || parsed.attributes.length !== 1)
        throw new Error('Malformed attribute selector: ' + selector);
      const { name } = parsed.attributes[0];
      const matcher = createAttributeMatcher(parsed.attributes[0]);
      const held = name === 'title' ? ',[data-title-held]' : '';
      const elements = this._evaluator._queryCSS({ scope: root as Document | Element, pierceShadow: true }, `[${name}]${held}`);
      return elements.filter(e => matcher((e.getAttribute(name) ?? e.getAttribute('data-title-held'))!));
    };
    return { queryAll };
  }

  private _createTestIdEngine(): SelectorEngine {
    const queryAll = (root: SelectorRoot, selector: string): Element[] => {
      const parsed = parseAttributeSelector(selector, true);
      if (parsed.name || parsed.attributes.length !== 1)
        throw new Error('Malformed test id selector: ' + selector);
      const names = splitTestIdAttributeNames(parsed.attributes[0].name);
      const matcher = createAttributeMatcher(parsed.attributes[0]);
      const cssQuery = names.map(n => `[${n}]`).join(',');
      const elements = this._evaluator._queryCSS({ scope: root as Document | Element, pierceShadow: true }, cssQuery);
      return elements.filter(e => names.some(n => {
        const actual = e.getAttribute(n);
        return actual !== null && matcher(actual);
      }));
    };
    return { queryAll };
  }

  ariaSnapshot(node: Node, options: AriaTreeOptions): string {
    if (node.nodeType !== Node.ELEMENT_NODE)
      throw this.createStacklessError('Can only capture aria snapshot of Element nodes.');
    const ariaSnapshot = generateAriaTree(node as Element, options);
    this._lastAriaSnapshotForQuery = ariaSnapshot;
    return renderAriaTree(ariaSnapshot, options).text;
  }

  _createAriaRefEngine() {
    const queryAll = (root: SelectorRoot, selector: string): Element[] => {
      const result = this._lastAriaSnapshotForQuery?.elements?.get(selector);
      return result && result.isConnected ? [result] : [];
    };
    return { queryAll };
  }

  private _createDescribeEngine(): SelectorEngine {
    const queryAll = (root: SelectorRoot): Element[] => {
      if (root.nodeType !== 1)
        return [];
      return [root as Element];
    };
    return { queryAll };
  }

  private _createControlEngine(): SelectorEngine {
    return {
      queryAll(root: SelectorRoot, body: any) {
        if (body === 'enter-frame')
          return [];
        if (body === 'return-empty')
          return [];
        if (body === 'component') {
          if (root.nodeType !== 1)
            return [];
          return [root.childElementCount === 1 ? root.firstElementChild! : root as Element];
        }
        throw new Error(`Internal error, unknown internal:control selector ${body}`);
      }
    };
  }

  private _createHasEngine(): SelectorEngine {
    const queryAll = (root: SelectorRoot, body: NestedSelectorBody) => {
      if (root.nodeType !== 1)
        return [];
      const has = !!this.querySelector(body.parsed, root, false);
      return has ? [root as Element] : [];
    };
    return { queryAll };
  }

  private _createHasNotEngine(): SelectorEngine {
    const queryAll = (root: SelectorRoot, body: NestedSelectorBody) => {
      if (root.nodeType !== 1)
        return [];
      const has = !!this.querySelector(body.parsed, root, false);
      return has ? [] : [root as Element];
    };
    return { queryAll };
  }

  private _createVisibleEngine(): SelectorEngine {
    const queryAll = (root: SelectorRoot, body: string) => {
      if (root.nodeType !== 1)
        return [];
      const visible = body === 'true';
      return isElementVisible(root as Element) === visible ? [root as Element] : [];
    };
    return { queryAll };
  }

  private _createInternalChainEngine(): SelectorEngine {
    const queryAll = (root: SelectorRoot, body: NestedSelectorBody) => {
      return this.querySelectorAll(body.parsed, root);
    };
    return { queryAll };
  }

  async viewportRatio(element: Element): Promise<number> {
    return await new Promise(resolve => {
      const observer = new IntersectionObserver(entries => {
        resolve(entries[0].intersectionRatio);
        observer.disconnect();
      });
      observer.observe(element);
      this.utils.builtins.requestAnimationFrame(() => {});
    });
  }

  getElementBorderWidth(node: Node): { left: number; top: number; } {
    if (node.nodeType !== Node.ELEMENT_NODE || !node.ownerDocument || !node.ownerDocument.defaultView)
      return { left: 0, top: 0 };
    const style = node.ownerDocument.defaultView.getComputedStyle(node as Element);
    return { left: parseInt(style.borderLeftWidth || '', 10), top: parseInt(style.borderTopWidth || '', 10) };
  }

  describeIFrameStyle(iframe: Element): 'error:notconnected' | 'transformed' | { left: number, top: number } {
    if (!iframe.ownerDocument || !iframe.ownerDocument.defaultView)
      return 'error:notconnected';
    const defaultView = iframe.ownerDocument.defaultView;
    for (let e: Element | undefined = iframe; e; e = parentElementOrShadowHost(e)) {
      if (defaultView.getComputedStyle(e).transform !== 'none')
        return 'transformed';
    }
    const iframeStyle = defaultView.getComputedStyle(iframe);
    return {
      left: parseInt(iframeStyle.borderLeftWidth || '', 10) + parseInt(iframeStyle.paddingLeft || '', 10),
      top: parseInt(iframeStyle.borderTopWidth || '', 10) + parseInt(iframeStyle.paddingTop || '', 10),
    };
  }

  retarget(node: Node, behavior: 'none' | 'follow-label' | 'no-follow-label' | 'button-link'): Element | null {
    let element = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
    if (!element)
      return null;
    if (behavior === 'none')
      return element;
    if (!element.matches('input, textarea, select') && !(element as any).isContentEditable) {
      if (behavior === 'button-link')
        element = element.closest('button, [role=button], a, [role=link]') || element;
      else
        element = element.closest('button, [role=button], [role=checkbox], [role=radio]') || element;
    }
    if (behavior === 'follow-label') {
      if (!element.matches('a, input, textarea, button, select, [role=link], [role=button], [role=checkbox], [role=radio]') &&
        !(element as any).isContentEditable) {
        const enclosingLabel: HTMLLabelElement | null = element.closest('label');
        if (enclosingLabel && enclosingLabel.control)
          element = enclosingLabel.control;
      }
    }
    return element;
  }

  async checkElementStates(node: Node, states: ElementState[]): Promise<'error:notconnected' | { missingState: ElementState } | undefined> {
    if (states.includes('stable')) {
      const stableResult = await this._checkElementIsStable(node);
      if (stableResult === false)
        return { missingState: 'stable' };
      if (stableResult === 'error:notconnected')
        return 'error:notconnected';
    }
    for (const state of states) {
      if (state !== 'stable') {
        const result = this.elementState(node, state);
        if (result.received === 'error:notconnected')
          return 'error:notconnected';
        if (!result.matches)
          return { missingState: state };
      }
    }
  }

  private async _checkElementIsStable(node: Node): Promise<'error:notconnected' | boolean> {
    const continuePolling = Symbol('continuePolling');
    let lastRect: { x: number, y: number, width: number, height: number } | undefined;
    let stableRafCounter = 0;
    let lastTime = 0;

    const check = () => {
      const element = this.retarget(node, 'no-follow-label');
      if (!element)
        return 'error:notconnected';

      const time = this.utils.builtins.performance.now();
      if (this._stableRafCount > 1 && time - lastTime < 15)
        return continuePolling;
      lastTime = time;

      const clientRect = element.getBoundingClientRect();
      const rect = { x: clientRect.top, y: clientRect.left, width: clientRect.width, height: clientRect.height };
      if (lastRect) {
        const samePosition = rect.x === lastRect.x && rect.y === lastRect.y && rect.width === lastRect.width && rect.height === lastRect.height;
        if (!samePosition)
          return false;
        if (++stableRafCounter >= this._stableRafCount)
          return true;
      }
      lastRect = rect;
      return continuePolling;
    };

    let fulfill: (result: 'error:notconnected' | boolean) => void;
    let reject: (error: Error) => void;
    const result = new Promise<'error:notconnected' | boolean>((f, r) => { fulfill = f; reject = r; });

    const raf = () => {
      try {
        const success = check();
        if (success !== continuePolling)
          fulfill(success);
        else
          this.utils.builtins.requestAnimationFrame(raf);
      } catch (e: any) {
        reject(e);
      }
    };
    this.utils.builtins.requestAnimationFrame(raf);

    return result;
  }

  elementState(node: Node, state: ElementStateWithoutStable): ElementStateQueryResult {
    const element = this.retarget(node, ['visible', 'hidden'].includes(state) ? 'none' : 'follow-label');
    if (!element || !element.isConnected) {
      if (state === 'hidden')
        return { matches: true, received: 'hidden' };
      return { matches: false, received: 'error:notconnected' };
    }

    if (state === 'visible' || state === 'hidden') {
      const visible = isElementVisible(element);
      return {
        matches: state === 'visible' ? visible : !visible,
        received: visible ? 'visible' : 'hidden'
      };
    }

    if (state === 'disabled' || state === 'enabled') {
      const disabled = getAriaDisabled(element);
      return {
        matches: state === 'disabled' ? disabled : !disabled,
        received: disabled ? 'disabled' : 'enabled'
      };
    }

    if (state === 'editable') {
      const disabled = getAriaDisabled(element);
      const readonly = getReadonly(element);
      if (readonly === 'error')
        throw this.createStacklessError('Element is not an <input>, <textarea>, <select> or [contenteditable] and does not have a role allowing [aria-readonly]');
      return {
        matches: !disabled && !readonly,
        received: disabled ? 'disabled' : readonly ? 'readOnly' : 'editable'
      };
    }

    if (state === 'checked' || state === 'unchecked') {
      const need = state === 'checked';
      const checked = getCheckedWithoutMixed(element);
      if (checked === 'error')
        throw this.createStacklessError('Not a checkbox or radio button');
      const isRadio = element.nodeName === 'INPUT' && (element as HTMLInputElement).type === 'radio';
      return {
        matches: need === checked,
        received: checked ? 'checked' : 'unchecked',
        isRadio,
      };
    }

    if (state === 'indeterminate') {
      const checked = getCheckedAllowMixed(element);
      if (checked === 'error')
        throw this.createStacklessError('Not a checkbox or radio button');
      return {
        matches: checked === 'mixed',
        received: checked === true ? 'checked' : checked === false ? 'unchecked' : 'mixed',
      };
    }
    throw this.createStacklessError(`Unexpected element state "${state}"`);
  }

  selectOptions(node: Node, optionsToSelect: (Node | { valueOrLabel?: string, value?: string, label?: string, index?: number })[]): string[] | 'error:notconnected' | 'error:optionsnotfound' | 'error:optionnotenabled' {
    const element = this.retarget(node, 'follow-label');
    if (!element)
      return 'error:notconnected';
    if (element.nodeName.toLowerCase() !== 'select')
      throw this.createStacklessError('Element is not a <select> element');
    const select = element as HTMLSelectElement;
    const options = [...select.options];
    const selectedOptions = [];
    let remainingOptionsToSelect = optionsToSelect.slice();
    for (let index = 0; index < options.length; index++) {
      const option = options[index];
      const normalizedOptionLabel = normalizeWhiteSpace(option.label);
      const filter = (optionToSelect: Node | { valueOrLabel?: string, value?: string, label?: string, index?: number }) => {
        if (optionToSelect instanceof Node)
          return option === optionToSelect;
        const matchesLabel = (label: string) => label === option.label || normalizeWhiteSpace(label) === normalizedOptionLabel;
        let matches = true;
        if (optionToSelect.valueOrLabel !== undefined)
          matches = matches && (optionToSelect.valueOrLabel === option.value || matchesLabel(optionToSelect.valueOrLabel));
        if (optionToSelect.value !== undefined)
          matches = matches && optionToSelect.value === option.value;
        if (optionToSelect.label !== undefined)
          matches = matches && matchesLabel(optionToSelect.label);
        if (optionToSelect.index !== undefined)
          matches = matches && optionToSelect.index === index;
        return matches;
      };
      if (!remainingOptionsToSelect.some(filter))
        continue;
      if (!this.elementState(option, 'enabled').matches)
        return 'error:optionnotenabled';
      selectedOptions.push(option);
      if (select.multiple) {
        remainingOptionsToSelect = remainingOptionsToSelect.filter(o => !filter(o));
      } else {
        remainingOptionsToSelect = [];
        break;
      }
    }
    if (remainingOptionsToSelect.length)
      return 'error:optionsnotfound';
    select.value = undefined as any;
    selectedOptions.forEach(option => option.selected = true);
    select.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return selectedOptions.map(option => option.value);
  }

  fill(node: Node, value: string): 'error:notconnected' | 'needsinput' | 'done' {
    const element = this.retarget(node, 'follow-label');
    if (!element)
      return 'error:notconnected';
    if (element.nodeName.toLowerCase() === 'input') {
      const input = element as HTMLInputElement;
      const type = input.type.toLowerCase();
      const kInputTypesToSetValue = new Set(['color', 'date', 'time', 'datetime-local', 'month', 'range', 'week']);
      const kInputTypesToTypeInto = new Set(['', 'email', 'number', 'password', 'search', 'tel', 'text', 'url']);
      if (!kInputTypesToTypeInto.has(type) && !kInputTypesToSetValue.has(type))
        throw this.createStacklessError(`Input of type "${type}" cannot be filled`);
      if (type === 'number') {
        value = value.trim();
        if (isNaN(Number(value)))
          throw this.createStacklessError('Cannot type text into input[type=number]');
      }
      if (type === 'color')
        value = value.toLowerCase();
      if (kInputTypesToSetValue.has(type)) {
        value = value.trim();
        input.focus();
        input.value = value;
        if (input.value !== value)
          throw this.createStacklessError('Malformed value');
        element.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        element.dispatchEvent(new Event('change', { bubbles: true }));
        return 'done';
      }
    } else if (element.nodeName.toLowerCase() === 'textarea') {
    } else if (!(element as HTMLElement).isContentEditable) {
      throw this.createStacklessError('Element is not an <input>, <textarea> or [contenteditable] element');
    }
    this.selectText(element);
    return 'needsinput';
  }

  selectText(node: Node): 'error:notconnected' | 'done' {
    const element = this.retarget(node, 'follow-label');
    if (!element)
      return 'error:notconnected';
    if (element.nodeName.toLowerCase() === 'input') {
      const input = element as HTMLInputElement;
      input.select();
      input.focus();
      return 'done';
    }
    if (element.nodeName.toLowerCase() === 'textarea') {
      const textarea = element as HTMLTextAreaElement;
      textarea.selectionStart = 0;
      textarea.selectionEnd = textarea.value.length;
      textarea.focus();
      return 'done';
    }
    (element as HTMLElement | SVGElement).focus();
    const range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    const selection = element.ownerDocument.defaultView!.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return 'done';
  }

  private _activelyFocused(node: Node): { activeElement: Element | null, isFocused: boolean } {
    const activeElement = (node.getRootNode() as (Document | ShadowRoot)).activeElement;
    const isFocused = activeElement === node && !!node.ownerDocument && node.ownerDocument.hasFocus();
    return { activeElement, isFocused };
  }

  focusNode(node: Node, resetSelectionIfNotFocused?: boolean): 'error:notconnected' | 'done' {
    if (!node.isConnected)
      return 'error:notconnected';
    if (node.nodeType !== Node.ELEMENT_NODE)
      throw this.createStacklessError('Node is not an element');

    const { activeElement, isFocused: wasFocused } = this._activelyFocused(node);
    if ((node as HTMLElement).isContentEditable && !wasFocused && activeElement && (activeElement as HTMLElement | SVGElement).blur) {
      (activeElement as HTMLElement | SVGElement).blur();
    }
    (node as HTMLElement | SVGElement).focus();
    (node as HTMLElement | SVGElement).focus();

    if (resetSelectionIfNotFocused && !wasFocused && node.nodeName.toLowerCase() === 'input') {
      try {
        const input = node as HTMLInputElement;
        input.setSelectionRange(0, 0);
      } catch (e) {
      }
    }
    return 'done';
  }

  blurNode(node: Node): 'error:notconnected' | 'done' {
    if (!node.isConnected)
      return 'error:notconnected';
    if (node.nodeType !== Node.ELEMENT_NODE)
      throw this.createStacklessError('Node is not an element');
    (node as HTMLElement | SVGElement).blur();
    return 'done';
  }

  setInputFiles(node: Node, payloads: { name: string, mimeType: string, buffer: string, lastModifiedMs?: number }[]) {
    if (node.nodeType !== Node.ELEMENT_NODE)
      return 'Node is not of type HTMLElement';
    const element: Element | undefined = node as Element;
    if (element.nodeName !== 'INPUT')
      return 'Not an <input> element';
    const input = element as HTMLInputElement;
    const type = (input.getAttribute('type') || '').toLowerCase();
    if (type !== 'file')
      return 'Not an input[type=file] element';

    const files = payloads.map(file => {
      const bytes = Uint8Array.from(atob(file.buffer), c => c.charCodeAt(0));
      return new File([bytes], file.name, { type: file.mimeType, lastModified: file.lastModifiedMs });
    });
    const dt = new DataTransfer();
    for (const file of files)
      dt.items.add(file);
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  expectHitTarget(hitPoint: { x: number, y: number }, targetElement: Element) {
    const roots: (Document | ShadowRoot)[] = [];

    let parentElement = targetElement;
    while (parentElement) {
      const root = enclosingShadowRootOrDocument(parentElement);
      if (!root)
        break;
      roots.push(root);
      if (root.nodeType === 9)
        break;
      parentElement = (root as ShadowRoot).host;
    }

    let hitElement: Element | undefined;
    for (let index = roots.length - 1; index >= 0; index--) {
      const root = roots[index];
      const elements: Element[] = root.elementsFromPoint(hitPoint.x, hitPoint.y);
      const singleElement = root.elementFromPoint(hitPoint.x, hitPoint.y);
      if (singleElement && elements[0] && parentElementOrShadowHost(singleElement) === elements[0]) {
        const style = this.window.getComputedStyle(singleElement);
        if (style?.display === 'contents') {
          elements.unshift(singleElement);
        }
      }
      if (elements[0] && elements[0].shadowRoot === root && elements[1] === singleElement) {
        elements.shift();
      }
      const innerElement = elements[0] as Element | undefined;
      if (!innerElement)
        break;
      hitElement = innerElement;
      if (index && innerElement !== (roots[index - 1] as ShadowRoot).host)
        break;
    }

    const hitParents: Element[] = [];
    while (hitElement && hitElement !== targetElement) {
      hitParents.push(hitElement);
      hitElement = hitElement.assignedSlot ?? parentElementOrShadowHost(hitElement);
    }
    if (hitElement === targetElement)
      return 'done';

    const hitTargetDescription = this.previewNode(hitParents[0] || this.document.documentElement);
    let rootHitTargetDescription: string | undefined;
    let element: Element | undefined = targetElement;
    while (element) {
      const index = hitParents.indexOf(element);
      if (index !== -1) {
        if (index > 1)
          rootHitTargetDescription = this.previewNode(hitParents[index - 1]);
        break;
      }
      element = parentElementOrShadowHost(element);
    }
    if (rootHitTargetDescription)
      return { hitTargetDescription: `${hitTargetDescription} from ${rootHitTargetDescription} subtree` };
    return { hitTargetDescription };
  }

  setupHitTargetInterceptor(node: Node, action: 'hover' | 'tap' | 'mouse' | 'drag', hitPoint: { x: number, y: number } | undefined, blockAllEvents: boolean): HitTargetInterceptionResult | 'error:notconnected' | string {
    const element = this.retarget(node, 'button-link');
    if (!element || !element.isConnected)
      return 'error:notconnected';

    if (hitPoint) {
      const preliminaryResult = this.expectHitTarget(hitPoint, element);
      if (preliminaryResult !== 'done')
        return preliminaryResult.hitTargetDescription;
    }

    if (action === 'drag')
      return { stop: () => 'done' };

    const events = {
      'hover': this._hoverHitTargetInterceptorEvents,
      'tap': this._tapHitTargetInterceptorEvents,
      'mouse': this._mouseHitTargetInterceptorEvents,
    }[action];
    let result: 'done' | { hitTargetDescription: string } | undefined;

    const listener = (event: PointerEvent | MouseEvent | TouchEvent) => {
      if (!events.has(event.type))
        return;

      if (!event.isTrusted && !(event as any).__pwTrustedSynthetic)
        return;

      const point = (!!this.window.TouchEvent && (event instanceof this.window.TouchEvent)) ? event.touches[0] : (event as MouseEvent | PointerEvent);

      if (result === undefined && point)
        result = this.expectHitTarget({ x: point.clientX, y: point.clientY }, element);

      if (blockAllEvents || (result !== 'done' && result !== undefined)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };

    const stop = () => {
      if (this._hitTargetInterceptor === listener)
        this._hitTargetInterceptor = undefined;
      return result || 'done';
    };

    this._hitTargetInterceptor = listener;
    return { stop };
  }

  dispatchEvent(node: Node, type: string, eventInitObj: Object) {
    let event;
    const eventInit: any = { bubbles: true, cancelable: true, composed: true, ...eventInitObj };
    switch (this._eventTypes.get(type)) {
      case 'mouse': event = new MouseEvent(type, eventInit); break;
      case 'keyboard': event = new KeyboardEvent(type, eventInit); break;
      case 'touch': {
        if (this._browserName === 'webkit') {
          const createTouch = (t: any) => {
            if (t instanceof Touch)
              return t;
            let pageX = t.pageX;
            if (pageX === undefined && t.clientX !== undefined)
              pageX = t.clientX + (this.document.scrollingElement?.scrollLeft || 0);
            let pageY = t.pageY;
            if (pageY === undefined && t.clientY !== undefined)
              pageY = t.clientY + (this.document.scrollingElement?.scrollTop || 0);
            return (this.document as any).createTouch(this.window, t.target ?? node, t.identifier, pageX, pageY, t.screenX, t.screenY, t.radiusX, t.radiusY, t.rotationAngle, t.force);
          };
          const createTouchList = (touches: any) => {
            if (touches instanceof TouchList || !touches)
              return touches;
            return (this.document as any).createTouchList(...touches.map(createTouch));
          };
          eventInit.target ??= node;
          eventInit.touches = createTouchList(eventInit.touches);
          eventInit.targetTouches = createTouchList(eventInit.targetTouches);
          eventInit.changedTouches = createTouchList(eventInit.changedTouches);
          event = new TouchEvent(type, eventInit);
        } else {
          eventInit.target ??= node;
          eventInit.touches = eventInit.touches?.map((t: any) => t instanceof Touch ? t : new Touch({ ...t, target: t.target ?? node }));
          eventInit.targetTouches = eventInit.targetTouches?.map((t: any) => t instanceof Touch ? t : new Touch({ ...t, target: t.target ?? node }));
          eventInit.changedTouches = eventInit.changedTouches?.map((t: any) => t instanceof Touch ? t : new Touch({ ...t, target: t.target ?? node }));
          event = new TouchEvent(type, eventInit);
        }
        break;
      }
      case 'pointer': event = new PointerEvent(type, eventInit); break;
      case 'focus': event = new FocusEvent(type, eventInit); break;
      case 'drag': event = new DragEvent(type, eventInit); break;
      case 'wheel': event = new WheelEvent(type, eventInit); break;
      case 'deviceorientation':
        try {
          event = new DeviceOrientationEvent(type, eventInit);
        } catch {
          const { bubbles, cancelable, alpha, beta, gamma, absolute } = eventInit as {bubbles: boolean, cancelable: boolean, alpha: number, beta: number, gamma: number, absolute: boolean};
          event = this.document.createEvent('DeviceOrientationEvent') as WebKitLegacyDeviceOrientationEvent;
          event.initDeviceOrientationEvent(type, bubbles, cancelable, alpha, beta, gamma, absolute);
        }
        break;
      case 'devicemotion':
        try {
          event = new DeviceMotionEvent(type, eventInit);
        } catch {
          const { bubbles, cancelable, acceleration, accelerationIncludingGravity, rotationRate, interval } = eventInit as {bubbles: boolean, cancelable: boolean, acceleration: DeviceMotionEventAcceleration, accelerationIncludingGravity: DeviceMotionEventAcceleration, rotationRate: DeviceMotionEventRotationRate, interval: number};
          event = this.document.createEvent('DeviceMotionEvent') as WebKitLegacyDeviceMotionEvent;
          event.initDeviceMotionEvent(type, bubbles, cancelable, acceleration, accelerationIncludingGravity, rotationRate, interval);
        }
        break;
      default: event = new Event(type, eventInit); break;
    }
    node.dispatchEvent(event);
  }

  previewNode(node: Node): string {
    if (node.nodeType === Node.TEXT_NODE)
      return oneLine(`#text=${node.nodeValue || ''}`);
    if (node.nodeType !== Node.ELEMENT_NODE)
      return oneLine(`<${node.nodeName.toLowerCase()} />`);
    const element = node as Element;

    const attrs = [];
    for (let i = 0; i < element.attributes.length; i++) {
      const { name, value } = element.attributes[i];
      if (name === 'style')
        continue;
      if (!value && this._booleanAttributes.has(name))
        attrs.push(` ${name}`);
      else
        attrs.push(` ${name}="${value}"`);
    }
    attrs.sort((a, b) => a.length - b.length);
    const attrText = trimStringWithEllipsis(attrs.join(''), 500);
    if (this._autoClosingTags.has(element.nodeName))
      return oneLine(`<${element.nodeName.toLowerCase()}${attrText}/>`);

    const children = element.childNodes;
    let onlyText = false;
    if (children.length <= 5) {
      onlyText = true;
      for (let i = 0; i < children.length; i++)
        onlyText = onlyText && children[i].nodeType === Node.TEXT_NODE;
    }
    const text = onlyText ? (element.textContent || '') : (children.length ? '\u2026' : '');
    return oneLine(`<${element.nodeName.toLowerCase()}${attrText}>${trimStringWithEllipsis(text, 50)}</${element.nodeName.toLowerCase()}>`);
  }

  private _generateSelectors(elements: Element[]) {
    this._evaluator.begin();
    beginAriaCaches();
    beginDOMCaches();
    try {
      return elements.slice(0, 10).map((m, i) => `${i + 1}) ${this.previewNode(m)}`);
    } finally {
      endDOMCaches();
      endAriaCaches();
      this._evaluator.end();
    }
  }

  strictModeViolationError(selector: ParsedSelector, matches: Element[]): Error {
    const lines = this._generateSelectors(matches).map(line => `\n    ` + line);
    if (lines.length < matches.length)
      lines.push('\n    ...');
    return this.createStacklessError(`strict mode violation: ${stringifySelector(selector)} resolved to ${matches.length} elements:${lines.join('')}\n`);
  }

  checkDeprecatedSelectorUsage(selector: ParsedSelector, matches: Element[]) {
    const kDeprecatedSelectors = new Set(['_react', '_vue', 'xpath:light', 'text:light', 'id:light',
      'data-testid:light', 'data-test-id:light', 'data-test:light']);
    if (!matches.length)
      return;
    const deperecated = selector.parts.find(part => kDeprecatedSelectors.has(part.name));
    if (!deperecated)
      return;
    const lines = this._generateSelectors(matches).map(line => `\n    ` + line);
    if (lines.length < matches.length)
      lines.push('\n    ...');
    throw this.createStacklessError(`"${deperecated.name}" selector is not supported: ${stringifySelector(selector)} resolved to ${matches.length} element${matches.length === 1 ? '' : 's'}:${lines.join('')}\n`);
  }

  createStacklessError(message: string): Error {
    const error = this._shouldPrependErrorPrefix ? new Error('Error: ' + message) : new Error(message);
    if (this._browserName === 'firefox') {
      error.stack = '';
      return error;
    }
    delete error.stack;
    return error;
  }

  private _setupGlobalListenersRemovalDetection() {
    const customEventName = '__playwright_global_listeners_check__';

    let seenEvent = false;
    const handleCustomEvent = () => seenEvent = true;
    this.window.addEventListener(customEventName, handleCustomEvent);

    new MutationObserver(entries => {
      const newDocumentElement = entries.some(entry => Array.from(entry.addedNodes).includes(this.document.documentElement));
      if (!newDocumentElement)
        return;

      seenEvent = false;
      this.window.dispatchEvent(new CustomEvent(customEventName));
      if (seenEvent)
        return;

      this.window.addEventListener(customEventName, handleCustomEvent);
      for (const callback of this.onGlobalListenersRemoved)
        callback();
    }).observe(this.document, { childList: true });
  }

  private _setupHitTargetInterceptors() {
    const listener = (event: PointerEvent | MouseEvent | TouchEvent) => this._hitTargetInterceptor?.(event);
    const addHitTargetInterceptorListeners = () => {
      for (const event of this._allHitTargetInterceptorEvents)
        this.window.addEventListener(event as any, listener, { capture: true, passive: false });
    };
    addHitTargetInterceptorListeners();
    this.onGlobalListenersRemoved.add(addHitTargetInterceptorListeners);
  }

}

function oneLine(s: string): string {
  return s.replace(/\n/g, '↵').replace(/\t/g, '⇆');
}

function createAttributeMatcher(part: AttributeSelectorPart): (s: string) => boolean {
  const { value, caseSensitive } = part;
  if (value instanceof RegExp)
    return s => !!s.match(value);
  if (caseSensitive)
    return s => s === value;
  const lowerCaseValue = value.toLowerCase();
  return s => s.toLowerCase().includes(lowerCaseValue);
}

function cssUnquote(s: string): string {
  s = s.substring(1, s.length - 1);
  if (!s.includes('\\'))
    return s;
  const r: string[] = [];
  let i = 0;
  while (i < s.length) {
    if (s[i] === '\\' && i + 1 < s.length)
      i++;
    r.push(s[i++]);
  }
  return r.join('');
}

function createTextMatcher(selector: string, internal: boolean): { matcher: TextMatcher, kind: 'regex' | 'strict' | 'lax' } {
  if (selector[0] === '/' && selector.lastIndexOf('/') > 0) {
    const lastSlash = selector.lastIndexOf('/');
    const re = new RegExp(selector.substring(1, lastSlash), selector.substring(lastSlash + 1));
    return { matcher: (elementText: ElementText) => re.test(elementText.full), kind: 'regex' };
  }
  const unquote = internal ? JSON.parse.bind(JSON) : cssUnquote;
  let strict = false;
  if (selector.length > 1 && selector[0] === '"' && selector[selector.length - 1] === '"') {
    selector = unquote(selector);
    strict = true;
  } else if (internal && selector.length > 1 && selector[0] === '"' && selector[selector.length - 2] === '"' && selector[selector.length - 1] === 'i') {
    selector = unquote(selector.substring(0, selector.length - 1));
    strict = false;
  } else if (internal && selector.length > 1 && selector[0] === '"' && selector[selector.length - 2] === '"' && selector[selector.length - 1] === 's') {
    selector = unquote(selector.substring(0, selector.length - 1));
    strict = true;
  } else if (selector.length > 1 && selector[0] === "'" && selector[selector.length - 1] === "'") {
    selector = unquote(selector);
    strict = true;
  }
  selector = normalizeWhiteSpace(selector);
  if (strict) {
    if (internal)
      return { kind: 'strict', matcher: (elementText: ElementText) => elementText.normalized === selector };

    const strictTextNodeMatcher = (elementText: ElementText) => {
      if (!selector && !elementText.immediate.length)
        return true;
      return elementText.immediate.some(s => normalizeWhiteSpace(s) === selector);
    };
    return { matcher: strictTextNodeMatcher, kind: 'strict' };
  }
  selector = selector.toLowerCase();
  return { kind: 'lax', matcher: (elementText: ElementText) => elementText.normalized.toLowerCase().includes(selector) };
}
