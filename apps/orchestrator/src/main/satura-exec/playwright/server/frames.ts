import * as dom from './dom';
import { ExecutionContext, isJavaScriptErrorInEvaluate, isStaleContextError, type JSHandle } from './js';
import { AbortedError } from './progress';
import { parseSelector, isInvalidSelectorError, type ParsedSelector } from '../isomorphic/selectorParser';

import type { ElementStateWithoutStable, InjectedScript } from './injectedTypes';
import type { CRSession } from './cdp';
import type { Page } from './page';
import type { Progress } from './progress';
import type * as types from './types';

type ElementCallback<T, R> = (injected: InjectedScript, element: Element, data: T) => R;
type SelectorInfo = { parsed: ParsedSelector, strict: boolean };

const UTILITY_WORLD = '__satura_exec_utility__';

export class Frame {
  readonly _page: Page;
  private _session: CRSession;
  private _injectedSource: string;
  private _utility: Promise<ExecutionContext> | null = null;
  private _main: Promise<ExecutionContext> | null = null;
  private _worldName: string;

  constructor(page: Page, session: CRSession, injectedSource: string, worldName = UTILITY_WORLD) {
    this._page = page;
    this._session = session;
    this._injectedSource = injectedSource;
    this._worldName = worldName;
  }

  parentFrame(): Frame | null {
    return null;
  }

  async frameElement(progress: Progress): Promise<dom.ElementHandle> {
    throw new Error('The main frame has no frame element');
  }

  _createElementHandle(context: ExecutionContext, objectId: string): dom.ElementHandle {
    return new dom.ElementHandle(context, objectId);
  }

  async raceAgainstEvaluationStallingEvents<T>(cb: () => Promise<T>): Promise<T> {
    return cb();
  }

  async utilityContext(): Promise<ExecutionContext> {
    if (!this._utility) {
      this._utility = this._createUtilityContext();
      this._utility.catch(() => { this._utility = null; });
    }
    return this._utility;
  }

  async mainContext(): Promise<ExecutionContext> {
    if (!this._main) {
      this._main = this._createMainContext();
      this._main.catch(() => { this._main = null; });
    }
    return this._main;
  }

  invalidateContexts() {
    this._utility = null;
    this._main = null;
  }

  private async _frameId(): Promise<string> {
    const tree = await this._session.send('Page.getFrameTree');
    return tree.frameTree.frame.id;
  }

  private async _createUtilityContext(): Promise<ExecutionContext> {
    const frameId = await this._frameId();
    const { executionContextId } = await this._session.send('Page.createIsolatedWorld', {
      frameId,
      worldName: this._worldName,
      grantUniveralAccess: true,
    });
    return new ExecutionContext(this._session, executionContextId, this, this._injectedSource);
  }

  private async _createMainContext(): Promise<ExecutionContext> {
    const handle = await this._session.send('Runtime.evaluate', { expression: 'globalThis', returnByValue: false });
    if (!handle?.result?.objectId)
      throw new Error('Cannot find default execution context');
    return new MainWorldContext(this._session, this, handle.result.objectId);
  }

  async _injected(): Promise<JSHandle<InjectedScript>> {
    const utility = await this.utilityContext();
    return utility.injectedScript();
  }

  async resolveInjectedForSelector(selector: string, options?: types.StrictOptions): Promise<{ injected: JSHandle<InjectedScript>, info: SelectorInfo }> {
    const info = { parsed: parseSelector(selector), strict: !!options?.strict };
    try {
      return { injected: await this._injected(), info };
    } catch (e) {
      if (isStaleContextError(e))
        this.invalidateContexts();
      throw e;
    }
  }

  isNonRetriableError(e: Error) {
    if (e instanceof AbortedError || e?.name === 'TimeoutError')
      return true;
    if (isJavaScriptErrorInEvaluate(e) || this._page.isClosed())
      return true;
    if (dom.isNonRecoverableDOMError(e) || isInvalidSelectorError(e))
      return true;
    if (isStaleContextError(e))
      this.invalidateContexts();
    return false;
  }

  async retryWithProgressAndBackoff<R>(progress: Progress, action: (progress: Progress, continuePolling: symbol) => Promise<R | symbol>): Promise<R> {
    const backoffScale = [20, 50, 100, 100, 500];
    if (progress.timeout) {
      while (backoffScale.length && backoffScale[backoffScale.length - 1] > progress.timeout / 5)
        backoffScale.pop();
    }
    return await this.retryWithProgressAndTimeouts<R>(progress, backoffScale, action);
  }

  async retryWithProgressAndTimeouts<R>(progress: Progress, timeouts: number[], action: (progress: Progress, continuePolling: symbol) => Promise<R | symbol>): Promise<R> {
    const continuePolling = Symbol('continuePolling');
    timeouts = [0, ...timeouts];
    let timeoutIndex = 0;
    while (true) {
      const timeout = timeouts[Math.min(timeoutIndex++, timeouts.length - 1)];
      if (timeout)
        await progress.wait(timeout);
      try {
        const result = await action(progress, continuePolling);
        if (result === continuePolling)
          continue;
        return result as R;
      } catch (e) {
        if (this.isNonRetriableError(e as Error))
          throw e;
        continue;
      }
    }
  }

  private async _retryWithProgressIfNotConnected<R>(
    progress: Progress,
    selector: string,
    options: { strict?: boolean, noAutoWaiting?: boolean, force?: boolean, performActionPreChecks?: boolean },
    action: (progress: Progress, handle: dom.ElementHandle<Element>) => Promise<R | 'error:notconnected'>): Promise<R> {
    progress.log(`waiting for ${selector}`);
    const noAutoWaiting = options.noAutoWaiting;
    return this.retryWithProgressAndBackoff(progress, async (progress, continuePolling) => {
      const resolved = await progress.race(this.resolveInjectedForSelector(selector, { strict: options.strict }));
      const result = await progress.race(resolved.injected.evaluateHandle((injected, { info }) => {
        const elements = injected.querySelectorAll(info.parsed, document);
        const element = elements[0] as Element | undefined;
        let log = '';
        if (elements.length > 1) {
          if (info.strict)
            throw injected.strictModeViolationError(info.parsed, elements);
          log = `  locator resolved to ${elements.length} elements. Proceeding with the first one: ${injected.previewNode(elements[0])}`;
        } else if (element) {
          log = `  locator resolved to ${injected.previewNode(element)}`;
        }
        return { log, success: !!element, element };
      }, { info: resolved.info }));
      const { log, success } = await progress.race(result.evaluate(r => ({ log: r.log, success: r.success })));
      if (log)
        progress.log(log);
      if (!success) {
        if (noAutoWaiting)
          throw new dom.NonRecoverableDOMError('Element(s) not found');
        result.dispose();
        this._page.instrumentation.onActionWaiting?.(null, progress.metadata, 'nomatch');
        return continuePolling;
      }
      const element = await progress.race(result.evaluateHandle(r => r.element)) as unknown as dom.ElementHandle<Element>;
      result.dispose();
      try {
        const result = await action(progress, element);
        if (result === 'error:notconnected') {
          if (noAutoWaiting)
            throw new dom.NonRecoverableDOMError('Element is not attached to the DOM');
          progress.log('element was detached from the DOM, retrying');
          return continuePolling;
        }
        return result;
      } finally {
        element?.dispose();
      }
    });
  }

  async waitForSelector(progress: Progress, selector: string, options: types.WaitForElementOptions): Promise<dom.ElementHandle<Element> | null> {
    const { state = 'visible' } = options;
    if (!['attached', 'detached', 'visible', 'hidden'].includes(state))
      throw new Error(`state: expected one of (attached|detached|visible|hidden)`);
    progress.log(`waiting for ${selector}${state === 'attached' ? '' : ' to be ' + state}`);
    return this.retryWithProgressAndBackoff(progress, async (progress, continuePolling) => {
      const resolved = await progress.race(this.resolveInjectedForSelector(selector, options));
      const result = await progress.race(resolved.injected.evaluateHandle((injected, { info }) => {
        const elements = injected.querySelectorAll(info.parsed, document);
        const element: Element | undefined  = elements[0];
        const visible = element ? injected.utils.isElementVisible(element) : false;
        let log = '';
        if (elements.length > 1) {
          if (info.strict)
            throw injected.strictModeViolationError(info.parsed, elements);
          log = `  locator resolved to ${elements.length} elements. Proceeding with the first one: ${injected.previewNode(elements[0])}`;
        } else if (element) {
          log = `  locator resolved to ${visible ? 'visible' : 'hidden'} ${injected.previewNode(element)}`;
        }
        return { log, element, visible, attached: !!element };
      }, { info: resolved.info }));
      const { log, visible, attached } = await progress.race(result.evaluate(r => ({ log: r.log, visible: r.visible, attached: r.attached })));
      if (log)
        progress.log(log);
      const success = { attached, detached: !attached, visible, hidden: !visible }[state];
      if (!success) {
        result.dispose();
        if (state === 'attached' || state === 'visible')
          this._page.instrumentation.onActionWaiting?.(null, progress.metadata, attached ? 'not visible' : 'nomatch');
        return continuePolling;
      }
      if (options.omitReturnValue) {
        result.dispose();
        return null;
      }
      const element = state === 'attached' || state === 'visible' ? await progress.race(result.evaluateHandle(r => r.element)) as unknown as dom.ElementHandle<Element> : null;
      result.dispose();
      return element;
    });
  }

  async queryCount(progress: Progress, selector: string): Promise<number> {
    try {
      const resolved = await progress.race(this.resolveInjectedForSelector(selector));
      return await progress.race(resolved.injected.evaluate((injected, { info }) => {
        return injected.querySelectorAll(info.parsed, document).length;
      }, { info: resolved.info }));
    } catch (e) {
      if (this.isNonRetriableError(e as Error))
        throw e;
      return 0;
    }
  }

  async click(progress: Progress, selector: string, options: { noWaitAfter?: boolean } & types.MouseClickOptions & types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options, (progress, handle) => handle._click(progress, { ...options, waitAfter: !options.noWaitAfter })));
  }

  async dblclick(progress: Progress, selector: string, options: types.MouseMultiClickOptions & types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options, (progress, handle) => handle._dblclick(progress, options)));
  }

  async dragAndDrop(progress: Progress, source: string, target: string, options: types.DragActionOptions & types.PointerActionWaitOptions) {
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, source, options, async (progress, handle) => {
      return handle._retryPointerAction(progress, 'move and down', false, async (progress, point) => {
        await this._page.mouse.move(progress, point.x, point.y);
        await this._page.mouse.down(progress);
      }, {
        ...options,
        waitAfter: 'disabled',
        position: options.sourcePosition,
      });
    }));
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, target, { ...options, performActionPreChecks: false }, async (progress, handle) => {
      return handle._retryPointerAction(progress, 'move and up', false, async (progress, point) => {
        await this._page.mouse.move(progress, point.x, point.y, { steps: options.steps });
        await this._page.mouse.up(progress);
      }, {
        ...options,
        waitAfter: 'disabled',
        position: options.targetPosition,
      });
    }));
  }

  async fill(progress: Progress, selector: string, value: string, options: types.CommonActionOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options, (progress, handle) => handle._fill(progress, value, options)));
  }

  async focus(progress: Progress, selector: string, options: types.StrictOptions & { noAutoWaiting?: boolean }) {
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options, (progress, handle) => handle._focus(progress)));
  }

  async blur(progress: Progress, selector: string, options: types.StrictOptions & { noAutoWaiting?: boolean }) {
    dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options, (progress, handle) => handle._blur(progress)));
  }

  async hover(progress: Progress, selector: string, options: types.PointerActionOptions & types.PointerActionWaitOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options, (progress, handle) => handle._hover(progress, options)));
  }

  async type(progress: Progress, selector: string, text: string, options: { delay?: number, noAutoWaiting?: boolean } & types.StrictOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options, (progress, handle) => handle._type(progress, text, options)));
  }

  async press(progress: Progress, selector: string, key: string, options: { delay?: number, noWaitAfter?: boolean, noAutoWaiting?: boolean } & types.StrictOptions) {
    return dom.assertDone(await this._retryWithProgressIfNotConnected(progress, selector, options, (progress, handle) => handle._press(progress, key, options)));
  }

  async scrollIntoViewIfNeeded(progress: Progress, selector: string, options: types.StrictOptions) {
    await this._retryWithProgressIfNotConnected(progress, selector, options, async (progress, handle) => {
      await handle.scrollIntoViewIfNeeded(progress);
      return 'done' as const;
    });
  }

  async boundingBox(progress: Progress, selector: string): Promise<types.Rect | null> {
    const handle = await this.waitForSelector(progress, selector, { strict: true, state: 'attached' });
    if (!handle)
      throw new Error(`Could not resolve ${selector} to DOM Element`);
    try {
      return await handle.boundingBox(progress);
    } finally {
      handle.dispose();
    }
  }

  async textContent(progress: Progress, selector: string, options: types.QueryOnSelectorOptions): Promise<string | null> {
    return this._callOnElementOnceMatches(progress, selector, (injected, element) => element.textContent, undefined, options);
  }

  async innerText(progress: Progress, selector: string, options: types.QueryOnSelectorOptions): Promise<string> {
    return this._callOnElementOnceMatches(progress, selector, (injectedScript, element) => {
      if (element.namespaceURI !== 'http://www.w3.org/1999/xhtml')
        throw injectedScript.createStacklessError('Node is not an HTMLElement');
      return (element as HTMLElement).innerText;
    }, undefined, options);
  }

  async innerHTML(progress: Progress, selector: string, options: types.QueryOnSelectorOptions): Promise<string> {
    return this._callOnElementOnceMatches(progress, selector, (injected, element) => element.innerHTML, undefined, options);
  }

  async getAttribute(progress: Progress, selector: string, name: string, options: types.QueryOnSelectorOptions): Promise<string | null> {
    return this._callOnElementOnceMatches(progress, selector, (injected, element, data) => element.getAttribute(data.name), { name }, options);
  }

  async inputValue(progress: Progress, selector: string, options: types.StrictOptions): Promise<string> {
    return this._callOnElementOnceMatches(progress, selector, (injectedScript, node) => {
      const element = injectedScript.retarget(node, 'follow-label');
      if (!element || (element.nodeName !== 'INPUT' && element.nodeName !== 'TEXTAREA' && element.nodeName !== 'SELECT'))
        throw injectedScript.createStacklessError('Node is not an <input>, <textarea> or <select> element');
      return (element as any).value;
    }, undefined, options);
  }

  private async _elementState(progress: Progress, selector: string, state: ElementStateWithoutStable, options: types.QueryOnSelectorOptions): Promise<boolean> {
    const result = await this._callOnElementOnceMatches(progress, selector, (injected, element, data) => {
      return injected.elementState(element, data.state);
    }, { state }, options);
    if (result.received === 'error:notconnected')
      dom.throwElementIsNotAttached();
    return result.matches;
  }

  async isVisible(progress: Progress, selector: string, options: types.StrictOptions = {}): Promise<boolean> {
    progress.log(`  checking visibility of ${selector}`);
    try {
      const resolved = await progress.race(this.resolveInjectedForSelector(selector, options));
      return await progress.race(resolved.injected.evaluate((injected, { info }) => {
        const element = injected.querySelector(info.parsed, document, info.strict);
        const state = element ? injected.elementState(element, 'visible') : { matches: false, received: 'error:notconnected' };
        return state.matches;
      }, { info: resolved.info }));
    } catch (e) {
      if (this.isNonRetriableError(e as Error))
        throw e;
      return false;
    }
  }

  async isHidden(progress: Progress, selector: string, options: types.StrictOptions = {}): Promise<boolean> {
    return !(await this.isVisible(progress, selector, options));
  }

  async isDisabled(progress: Progress, selector: string, options: types.QueryOnSelectorOptions): Promise<boolean> {
    return this._elementState(progress, selector, 'disabled', options);
  }

  async isEnabled(progress: Progress, selector: string, options: types.QueryOnSelectorOptions): Promise<boolean> {
    return this._elementState(progress, selector, 'enabled', options);
  }

  async isEditable(progress: Progress, selector: string, options: types.QueryOnSelectorOptions): Promise<boolean> {
    return this._elementState(progress, selector, 'editable', options);
  }

  async isChecked(progress: Progress, selector: string, options: types.QueryOnSelectorOptions): Promise<boolean> {
    return this._elementState(progress, selector, 'checked', options);
  }

  async evaluateOnSelector(progress: Progress, selector: string, source: string, isFunction: boolean, arg: unknown): Promise<unknown> {
    const handle = await this.waitForSelector(progress, selector, { strict: true, state: 'attached' });
    if (!handle)
      throw new Error(`Could not resolve ${selector} to DOM Element`);
    try {
      const main = await progress.race(this.mainContext()) as MainWorldContext;
      return await progress.race(main.evaluateOnElement(handle, source, isFunction, arg));
    } finally {
      handle.dispose();
    }
  }

  async evaluateExpression(progress: Progress, source: string, isFunction: boolean, arg: unknown): Promise<unknown> {
    const main = await progress.race(this.mainContext()) as MainWorldContext;
    return progress.race(main.evaluateInMain(source, isFunction, arg));
  }

  async nonStallingEvaluateInExistingContext(expression: string, world: 'utility'): Promise<any> {
    const utility = await this.utilityContext();
    return utility.evaluateExpression(expression);
  }

  private async _callOnElementOnceMatches<T, R>(progress: Progress, selector: string, body: ElementCallback<T, R>, taskData: T, options: types.StrictOptions): Promise<R> {
    const callbackText = body.toString();
    progress.log(`waiting for ${selector}`);
    const pageFunction = `(injected, { info, taskData }) => {
      const callback = (${callbackText});
      const element = injected.querySelector(info.parsed, document, info.strict);
      if (!element)
        return { success: false };
      const log = '  locator resolved to ' + injected.previewNode(element);
      return { log, success: true, value: callback(injected, element, taskData) };
    }`;
    return this.retryWithProgressAndBackoff(progress, async (progress, continuePolling) => {
      const resolved = await progress.race(this.resolveInjectedForSelector(selector, options));
      const { log, success, value } = await progress.race(resolved.injected.evaluate(pageFunction as any, { info: resolved.info, taskData })) as { log?: string, success: boolean, value?: R };
      if (log)
        progress.log(log);
      if (!success)
        return continuePolling;
      return value!;
    });
  }
}

export class MainWorldContext extends ExecutionContext {
  constructor(session: CRSession, frame: Frame, private _globalObjectId: string) {
    super(session, 0, frame, null);
  }

  async evaluateInMain(source: string, isFunction: boolean, arg: unknown): Promise<unknown> {
    const functionDeclaration = isFunction
      ? `async function(__arg) { return await (${source})(__arg); }`
      : `async function() { return await (${source}); }`;
    const res = await this.session.send('Runtime.callFunctionOn', {
      functionDeclaration,
      objectId: this._globalObjectId,
      arguments: isFunction ? [{ value: arg }] : [],
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    });
    return unwrap(res);
  }

  async evaluateOnElement(handle: dom.ElementHandle, source: string, isFunction: boolean, arg: unknown): Promise<unknown> {
    const node = await this.session.send('DOM.describeNode', { objectId: handle._objectId });
    const resolved = await this.session.send('DOM.resolveNode', { backendNodeId: node.node.backendNodeId });
    const objectId = resolved.object.objectId as string;
    try {
      const functionDeclaration = isFunction
        ? `async function(__arg) { return await (${source})(this, __arg); }`
        : `async function() { return await (${source}); }`;
      const res = await this.session.send('Runtime.callFunctionOn', {
        functionDeclaration,
        objectId,
        arguments: isFunction ? [{ value: arg }] : [],
        returnByValue: true,
        awaitPromise: true,
        userGesture: true,
      });
      return unwrap(res);
    } finally {
      void this.session._sendMayFail('Runtime.releaseObject', { objectId });
    }
  }
}

function unwrap(res: any): unknown {
  if (res.exceptionDetails) {
    const details = res.exceptionDetails;
    const message = details.exception?.description || details.text || 'Evaluation failed';
    throw new EvaluationError(message);
  }
  const result = res.result;
  if (result.unserializableValue !== undefined) {
    if (result.unserializableValue === 'NaN') return NaN;
    if (result.unserializableValue === 'Infinity') return Infinity;
    if (result.unserializableValue === '-Infinity') return -Infinity;
    if (result.unserializableValue === '-0') return -0;
    return result.unserializableValue;
  }
  return result.value;
}

export class EvaluationError extends Error {
  override name = 'EvaluationError';
}
