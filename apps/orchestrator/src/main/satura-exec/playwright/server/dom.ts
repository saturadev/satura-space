import * as js from './js';

import type * as frames from './frames';
import type { ElementState, HitTargetInterceptionResult, InjectedScript } from './injectedTypes';
import type { Page } from './page';
import type { Progress } from './progress';
import type * as types from './types';


type ActionName = 'click' | 'hover' | 'dblclick' | 'tap' | 'move and up' | 'move and down' | 'drop';
type PerformActionResult = 'error:notvisible' | 'error:notconnected' | 'error:notinviewport' | 'error:optionsnotfound' | 'error:optionnotenabled' | { missingState: ElementState } | { hitTargetDescription: string } | 'done';

export class NonRecoverableDOMError extends Error {
}

export function isNonRecoverableDOMError(error: Error) {
  return error instanceof NonRecoverableDOMError;
}

export class ElementHandle<T extends Node = Node> extends js.JSHandle<T> {
  readonly _page: Page;
  declare readonly _objectId: string;
  readonly _frame: frames.Frame;

  constructor(context: js.ExecutionContext, objectId: string) {
    super(context, objectId);
    this._page = context.frame._page;
    this._frame = context.frame;
  }

  get instrumentation() {
    return this._page.instrumentation;
  }


  async evaluateInUtility<R, Arg>(pageFunction: js.Func1<[js.JSHandle<InjectedScript>, ElementHandle<T>, Arg], R>, arg: Arg): Promise<R | 'error:notconnected'> {
    try {
      const utility = await this._frame.utilityContext();
      return await utility.evaluate(pageFunction, [await utility.injectedScript(), this, arg]);
    } catch (e: any) {
      if (this._frame.isNonRetriableError(e))
        throw e;
      return 'error:notconnected';
    }
  }

  private async _evaluateHandleInUtility<R, Arg>(pageFunction: js.Func1<[js.JSHandle<InjectedScript>, ElementHandle<T>, Arg], R>, arg: Arg): Promise<js.JSHandle<R> | 'error:notconnected'> {
    try {
      const utility = await this._frame.utilityContext();
      return await utility.evaluateHandle(pageFunction, [await utility.injectedScript(), this, arg]);
    } catch (e: any) {
      if (this._frame.isNonRetriableError(e))
        throw e;
      return 'error:notconnected';
    }
  }

  async _scrollRectIntoViewIfNeeded(progress: Progress, rect?: types.Rect): Promise<'error:notvisible' | 'error:notconnected' | 'done'> {
    return await progress.race(this._page.delegate.scrollRectIntoViewIfNeeded(this, rect));
  }

  async _waitAndScrollIntoViewIfNeeded(progress: Progress, waitForVisible: boolean): Promise<void> {
    const result = await this._retryAction(progress, 'scroll into view', async progress => {
      progress.log(`  waiting for element to be stable`);
      const waitResult = await progress.race(this.evaluateInUtility(async ([injected, node, { waitForVisible }]) => {
        return await injected.checkElementStates(node, waitForVisible ? ['visible', 'stable'] : ['stable']);
      }, { waitForVisible }));
      if (waitResult)
        return waitResult;
      return await this._scrollRectIntoViewIfNeeded(progress);
    }, {});
    assertDone(throwRetargetableDOMError(result));
  }

  async scrollIntoViewIfNeeded(progress: Progress) {
    await this._waitAndScrollIntoViewIfNeeded(progress, false);
  }

  private async _clickablePoint(progress: Progress): Promise<{ point: types.Point, box: types.Rect } | 'error:notvisible' | 'error:notinviewport' | 'error:notconnected'> {
    const intersectQuadWithViewport = (quad: types.Quad): types.Quad => {
      return quad.map(point => ({
        x: Math.min(Math.max(point.x, 0), metrics.width),
        y: Math.min(Math.max(point.y, 0), metrics.height),
      })) as types.Quad;
    };

    const computeQuadArea = (quad: types.Quad) => {
      let area = 0;
      for (let i = 0; i < quad.length; ++i) {
        const p1 = quad[i];
        const p2 = quad[(i + 1) % quad.length];
        area += (p1.x * p2.y - p2.x * p1.y) / 2;
      }
      return Math.abs(area);
    };

    const [quads, metrics] = await progress.race(Promise.all([
      this._page.delegate.getContentQuads(this),
      this._page.mainFrame().utilityContext().then(utility => utility.evaluate(() => ({ width: innerWidth, height: innerHeight }))),
    ] as const));
    if (quads === 'error:notconnected')
      return quads;
    if (!quads || !quads.length)
      return 'error:notvisible';

    const filtered = quads.map(quad => intersectQuadWithViewport(quad)).filter(quad => computeQuadArea(quad) > 0.99);
    if (!filtered.length)
      return 'error:notinviewport';
    const quad = filtered[0];
    const box = quadToRect(quad);
    if (this._page.browserContext._browser.options.name === 'firefox') {
      for (const q of filtered) {
        const integerPoint = findIntegerPointInsideQuad(q);
        if (integerPoint)
          return { point: integerPoint, box };
      }
    }
    return { point: quadMiddlePoint(quad), box };
  }

  private async _offsetPoint(progress: Progress, offset: types.Point): Promise<{ point: types.Point, box: types.Rect } | 'error:notvisible' | 'error:notconnected'> {
    const [box, border] = await progress.race(Promise.all([
      this.boundingBox(progress),
      this.evaluateInUtility(([injected, node]) => injected.getElementBorderWidth(node), {}).catch(e => {}),
    ]));
    if (!box || !border)
      return 'error:notvisible';
    if (border === 'error:notconnected')
      return border;
    return {
      point: {
        x: box.x + border.left + offset.x,
        y: box.y + border.top + offset.y,
      },
      box,
    };
  }

  async _retryAction(progress: Progress, actionName: string, action: (progress: Progress, retry: number) => Promise<PerformActionResult>, options: { trial?: boolean, force?: boolean, skipActionPreChecks?: boolean, noAutoWaiting?: boolean }): Promise<'error:notconnected' | 'done'> {
    let retry = 0;
    const waitTime = [0, 20, 100, 100, 500];
    const noAutoWaiting = (options as any).__testHookNoAutoWaiting ?? options.noAutoWaiting;

    while (true) {
      if (retry) {
        progress.log(`retrying ${actionName} action${options.trial ? ' (trial run)' : ''}`);
        const timeout = waitTime[Math.min(retry - 1, waitTime.length - 1)];
        if (timeout) {
          progress.log(`  waiting ${timeout}ms`);
          const result = await progress.race(this.evaluateInUtility(([injected, node, timeout]) => new Promise<void>(f => setTimeout(f, timeout)), timeout));
          if (result === 'error:notconnected')
            return result;
        }
      } else {
        progress.log(`attempting ${actionName} action${options.trial ? ' (trial run)' : ''}`);
      }
      if (!options.skipActionPreChecks && !options.force && !noAutoWaiting)
        await this._frame._page.performActionPreChecks(progress);
      const result = await action(progress, retry);
      ++retry;
      if (result === 'error:notvisible' || result === 'error:notinviewport' || (typeof result === 'object' && ('hitTargetDescription' in result || 'missingState' in result)))
        this.instrumentation.onActionWaiting?.(this, progress.metadata, typeof result === 'string' ? result : 'hitTargetDescription' in result ? 'intercepted' : `not ${result.missingState}`);
      if (result === 'error:notvisible') {
        if (options.force || noAutoWaiting)
          throw new NonRecoverableDOMError('Element is not visible');
        progress.log('  element is not visible');
        continue;
      }
      if (result === 'error:notinviewport') {
        if (options.force || noAutoWaiting)
          throw new NonRecoverableDOMError('Element is outside of the viewport');
        progress.log('  element is outside of the viewport');
        continue;
      }
      if (result === 'error:optionsnotfound') {
        if (noAutoWaiting)
          throw new NonRecoverableDOMError('Did not find some options');
        progress.log('  did not find some options');
        continue;
      }
      if (result === 'error:optionnotenabled') {
        if (noAutoWaiting)
          throw new NonRecoverableDOMError('Option being selected is not enabled');
        progress.log('  option being selected is not enabled');
        continue;
      }
      if (typeof result === 'object' && 'hitTargetDescription' in result) {
        if (noAutoWaiting)
          throw new NonRecoverableDOMError(`${result.hitTargetDescription} intercepts pointer events`);
        progress.log(`  ${result.hitTargetDescription} intercepts pointer events`);
        continue;
      }
      if (typeof result === 'object' && 'missingState' in result) {
        if (noAutoWaiting)
          throw new NonRecoverableDOMError(`Element is not ${result.missingState}`);
        progress.log(`  element is not ${result.missingState}`);
        continue;
      }
      return result;
    }
  }

  async _retryPointerAction(progress: Progress, actionName: ActionName, waitForEnabled: boolean, action: (progress: Progress, point: types.Point) => Promise<void>,
    options: { waitAfter: boolean | 'disabled' } & types.PointerActionOptions & types.PointerActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    const skipActionPreChecks = actionName === 'move and up';
    return await this._retryAction(progress, actionName, async (progress, retry) => {
      const scrollOptions: (ScrollIntoViewOptions | undefined)[] = [
        undefined,
        { block: 'end', inline: 'end' },
        { block: 'center', inline: 'center' },
        { block: 'start', inline: 'start' },
      ];
      const forceScrollOptions = scrollOptions[retry % scrollOptions.length];
      return await this._performPointerAction(progress, actionName, waitForEnabled, action, forceScrollOptions, options);
    }, { ...options, skipActionPreChecks });
  }

  async _performPointerAction(
    progress: Progress,
    actionName: ActionName,
    waitForEnabled: boolean,
    action: (progress: Progress, point: types.Point) => Promise<void>,
    forceScrollOptions: ScrollIntoViewOptions | undefined,
    options: { waitAfter: boolean | 'disabled' } & types.PointerActionOptions & types.PointerActionWaitOptions,
  ): Promise<PerformActionResult> {
    const { force = false, position } = options;

    const doScrollIntoView = async (progress: Progress) => {
      if (forceScrollOptions) {
        return await progress.race(this.evaluateInUtility(([injected, node, options]) => {
          if (node.nodeType === 1)
            (node as Node as Element).scrollIntoView(options);
          return 'done' as const;
        }, forceScrollOptions));
      }
      return await this._scrollRectIntoViewIfNeeded(progress, position ? { x: position.x, y: position.y, width: 0, height: 0 } : undefined);
    };

    if (this._frame.parentFrame()) {
      await doScrollIntoView(progress).catch(() => {});
    }

    if ((options as any).__testHookBeforeStable)
      await progress.race((options as any).__testHookBeforeStable());

    if (!force) {
      const elementStates: ElementState[] = waitForEnabled ? ['visible', 'enabled', 'stable'] : ['visible', 'stable'];
      progress.log(`  waiting for element to be ${waitForEnabled ? 'visible, enabled and stable' : 'visible and stable'}`);
      const result = await progress.race(this.evaluateInUtility(async ([injected, node, { elementStates }]) => {
        return await injected.checkElementStates(node, elementStates);
      }, { elementStates }));
      if (result)
        return result;
      progress.log(`  element is ${waitForEnabled ? 'visible, enabled and stable' : 'visible and stable'}`);
    }

    if ((options as any).__testHookAfterStable)
      await progress.race((options as any).__testHookAfterStable());

    progress.log('  scrolling into view if needed');
    const scrolled = await doScrollIntoView(progress);
    if (scrolled !== 'done')
      return scrolled;
    progress.log('  done scrolling');

    const maybeResult = position ? await this._offsetPoint(progress, position) : await this._clickablePoint(progress);
    if (typeof maybeResult === 'string')
      return maybeResult;
    let point = roundPoint(maybeResult.point);
    let box = maybeResult.box;
    for (let pass = 0; ; pass++) {
      await progress.race(this.instrumentation.onBeforeInputAction(this, progress.metadata, point, box));
      if (pass >= 2)
        break;
      const again = position ? await this._offsetPoint(progress, position) : await this._clickablePoint(progress);
      if (typeof again === 'string')
        return again;
      const next = roundPoint(again.point);
      if (Math.abs(next.x - point.x) < 1 && Math.abs(next.y - point.y) < 1)
        break;
      progress.log(`  element moved to (${next.x}, ${next.y}) while the pointer approached`);
      point = next;
      box = again.box;
    }

    let hitTargetInterceptionHandle: js.JSHandle<HitTargetInterceptionResult> | undefined;
    if (force) {
      progress.log(`  forcing action`);
    } else {
      if ((options as any).__testHookBeforeHitTarget)
        await progress.race((options as any).__testHookBeforeHitTarget());

      const frameCheckResult = await this._checkFrameIsHitTarget(progress, point);
      if (frameCheckResult === 'error:notconnected' || ('hitTargetDescription' in frameCheckResult))
        return frameCheckResult;
      const hitPoint = frameCheckResult.framePoint;
      const actionType = actionName === 'move and up' ? 'drag' : ((actionName === 'hover' || actionName === 'tap') ? actionName : 'mouse');
      const handle = await progress.race(this._evaluateHandleInUtility(([injected, node, { actionType, hitPoint, trial }]) => injected.setupHitTargetInterceptor(node, actionType, hitPoint, trial), { actionType, hitPoint, trial: !!options.trial } as const));
      if (handle === 'error:notconnected')
        return handle;
      if (!handle._objectId) {
        const error = handle.rawValue() as string;
        if (error === 'error:notconnected')
          return error;
        return { hitTargetDescription: error };
      }
      hitTargetInterceptionHandle = handle as any;
    }

    const actionResult = await this._page.frameManager.waitForSignalsCreatedBy(progress, options.waitAfter === true, async progress => {
      if ((options as any).__testHookBeforePointerAction)
        await progress.race((options as any).__testHookBeforePointerAction());
      let restoreModifiers: types.KeyboardModifier[] | undefined;
      if (options && options.modifiers)
        restoreModifiers = await this._page.keyboard.ensureModifiers(progress, options.modifiers);
      progress.log(`  performing ${actionName} action`);
      await action(progress, point);
      if (restoreModifiers)
        await this._page.keyboard.ensureModifiers(progress, restoreModifiers);
      if (hitTargetInterceptionHandle) {
        const stopHitTargetInterception = this._frame.raceAgainstEvaluationStallingEvents(() => {
          return hitTargetInterceptionHandle.evaluate(h => h.stop());
        }).catch(e => 'done' as const).finally(() => {
          hitTargetInterceptionHandle?.dispose();
        });
        if (options.waitAfter !== false) {
          const hitTargetResult = await progress.race(stopHitTargetInterception);
          if (hitTargetResult !== 'done')
            return hitTargetResult;
        }
      }
      progress.log(`  ${options.trial ? 'trial ' : ''}${actionName} action done`);
      progress.log('  waiting for scheduled navigations to finish');
      if ((options as any).__testHookAfterPointerAction)
        await progress.race((options as any).__testHookAfterPointerAction());
      return 'done';
    }).finally(() => {
      const stopPromise = hitTargetInterceptionHandle?.evaluate(h => h.stop()).catch(() => {});
      stopPromise?.then(() => hitTargetInterceptionHandle?.dispose());
    });
    if (actionResult !== 'done')
      return actionResult;
    progress.log('  navigations have finished');
    return 'done';
  }

  async hover(progress: Progress, options: types.PointerActionOptions & types.PointerActionWaitOptions): Promise<void> {
    const result = await this._hover(progress, options);
    return assertDone(throwRetargetableDOMError(result));
  }

  _hover(progress: Progress, options: types.PointerActionOptions & types.PointerActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    return this._retryPointerAction(progress, 'hover', false, (progress, point) => this._page.mouse.move(progress, point.x, point.y), { ...options, waitAfter: 'disabled' });
  }

  async click(progress: Progress, options: { noWaitAfter?: boolean } & types.MouseClickOptions & types.PointerActionWaitOptions): Promise<void> {
    const result = await this._click(progress, { ...options, waitAfter: !options.noWaitAfter });
    return assertDone(throwRetargetableDOMError(result));
  }

  _click(progress: Progress, options: { waitAfter: boolean | 'disabled' } & types.MouseClickOptions & types.PointerActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    return this._retryPointerAction(progress, 'click', true, (progress, point) => this._page.mouse.click(progress, point.x, point.y, options), options);
  }

  async dblclick(progress: Progress, options: types.MouseMultiClickOptions & types.PointerActionWaitOptions): Promise<void> {
    const result = await this._dblclick(progress, options);
    return assertDone(throwRetargetableDOMError(result));
  }

  _dblclick(progress: Progress, options: types.MouseMultiClickOptions & types.PointerActionWaitOptions): Promise<'error:notconnected' | 'done'> {
    return this._retryPointerAction(progress, 'dblclick', true, (progress, point) => this._page.mouse.click(progress, point.x, point.y, { ...options, clickCount: 2 }), { ...options, waitAfter: 'disabled' });
  }

  async fill(progress: Progress, value: string, options: types.CommonActionOptions): Promise<void> {
    const result = await this._fill(progress, value, options);
    assertDone(throwRetargetableDOMError(result));
  }

  async _fill(progress: Progress, value: string, options: types.CommonActionOptions): Promise<'error:notconnected' | 'done'> {
    progress.log(`  fill("${value}")`);
    return await this._retryAction(progress, 'fill', async progress => {
      await progress.race(this.instrumentation.onBeforeInputAction(this, progress.metadata));
      if (!options.force)
        progress.log('  waiting for element to be visible, enabled and editable');
      const result = await progress.race(this.evaluateInUtility(async ([injected, node, { value, force }]) => {
        if (!force) {
          const checkResult = await injected.checkElementStates(node, ['visible', 'enabled', 'editable']);
          if (checkResult)
            return checkResult;
        }
        return injected.fill(node, value);
      }, { value, force: options.force }));
      if (result === 'needsinput') {
        if (value)
          await this._page.keyboard.insertText(progress, value);
        else
          await this._page.keyboard.press(progress, 'Delete');
        return 'done';
      } else {
        return result;
      }
    }, options);
  }

  async selectText(progress: Progress, options: types.CommonActionOptions): Promise<void> {
    const result = await this._retryAction(progress, 'selectText', async progress => {
      if (!options.force)
        progress.log('  waiting for element to be visible');
      return await progress.race(this.evaluateInUtility(async ([injected, node, { force }]) => {
        if (!force) {
          const checkResult = await injected.checkElementStates(node, ['visible']);
          if (checkResult)
            return checkResult;
        }
        return injected.selectText(node);
      }, { force: options.force }));
    }, options);
    assertDone(throwRetargetableDOMError(result));
  }

  async focus(progress: Progress): Promise<void> {
    const result = await this._focus(progress);
    return assertDone(throwRetargetableDOMError(result));
  }

  async _focus(progress: Progress, resetSelectionIfNotFocused?: boolean): Promise<'error:notconnected' | 'done'> {
    return await progress.race(this.evaluateInUtility(([injected, node, resetSelectionIfNotFocused]) => injected.focusNode(node, resetSelectionIfNotFocused), resetSelectionIfNotFocused));
  }

  async _blur(progress: Progress): Promise<'error:notconnected' | 'done'> {
    return await progress.race(this.evaluateInUtility(([injected, node]) => injected.blurNode(node), {}));
  }

  async type(progress: Progress, text: string, options: { delay?: number } & types.StrictOptions): Promise<void> {
    const result = await this._type(progress, text, options);
    return assertDone(throwRetargetableDOMError(result));
  }

  async _type(progress: Progress, text: string, options: { delay?: number } & types.StrictOptions): Promise<'error:notconnected' | 'done'> {
    progress.log(`elementHandle.type("${text}")`);
    await progress.race(this.instrumentation.onBeforeInputAction(this, progress.metadata));
    const result = await this._focus(progress, true);
    if (result !== 'done')
      return result;
    await this._page.keyboard.type(progress, text, options);
    return 'done';
  }

  async press(progress: Progress, key: string, options: { delay?: number, noWaitAfter?: boolean } & types.StrictOptions): Promise<void> {
    const result = await this._press(progress, key, options);
    return assertDone(throwRetargetableDOMError(result));
  }

  async _press(progress: Progress, key: string, options: { delay?: number, noWaitAfter?: boolean } & types.StrictOptions): Promise<'error:notconnected' | 'done'> {
    progress.log(`elementHandle.press("${key}")`);
    await progress.race(this.instrumentation.onBeforeInputAction(this, progress.metadata));
    return this._page.frameManager.waitForSignalsCreatedBy(progress, !options.noWaitAfter, async progress => {
      const result = await this._focus(progress, true);
      if (result !== 'done')
        return result;
      await this._page.keyboard.press(progress, key, options);
      return 'done';
    });
  }

  async boundingBox(progress: Progress): Promise<types.Rect | null> {
    return await progress.race(this._page.delegate.getBoundingBox(this));
  }

  async waitForElementState(progress: Progress, state: 'visible' | 'hidden' | 'stable' | 'enabled' | 'disabled' | 'editable'): Promise<void> {
    const actionName = `wait for ${state}`;
    const result = await this._retryAction(progress, actionName, async progress => {
      return await progress.race(this.evaluateInUtility(async ([injected, node, state]) => {
        return (await injected.checkElementStates(node, [state])) || 'done';
      }, state));
    }, {});
    assertDone(throwRetargetableDOMError(result));
  }

  async _checkFrameIsHitTarget(progress: Progress, point: types.Point): Promise<{ framePoint: types.Point | undefined } | 'error:notconnected' | { hitTargetDescription: string }> {
    let frame = this._frame;
    const data: { frame: frames.Frame, frameElement: ElementHandle<Element> | null, pointInFrame: types.Point }[] = [];
    while (frame.parentFrame()) {
      const frameElement = await frame.frameElement(progress) as ElementHandle<Element>;
      const box = await frameElement.boundingBox(progress);
      const style = await progress.race(frameElement.evaluateInUtility(([injected, iframe]) => injected.describeIFrameStyle(iframe), {}).catch(e => 'error:notconnected' as const));
      if (!box || style === 'error:notconnected')
        return 'error:notconnected';
      if (style === 'transformed') {
        return { framePoint: undefined };
      }
      const pointInFrame = { x: point.x - box.x - style.left, y: point.y - box.y - style.top };
      data.push({ frame, frameElement, pointInFrame });
      frame = frame.parentFrame()!;
    }
    data.push({ frame, frameElement: null, pointInFrame: point });

    for (let i = data.length - 1; i > 0; i--) {
      const element = data[i - 1].frameElement!;
      const point = data[i].pointInFrame;
      const hitTargetResult = await progress.race(element.evaluateInUtility(([injected, element, hitPoint]) => {
        return injected.expectHitTarget(hitPoint, element);
      }, point));
      if (hitTargetResult !== 'done')
        return hitTargetResult;
    }
    return { framePoint: data[0].pointInFrame };
  }
}

export function throwRetargetableDOMError<T>(result: T | 'error:notconnected'): T {
  if (result === 'error:notconnected')
    throwElementIsNotAttached();
  return result;
}

export function throwElementIsNotAttached(): never {
  throw new Error('Element is not attached to the DOM');
}

export function assertDone(result: 'done'): void {
}

function roundPoint(point: types.Point): types.Point {
  return {
    x: (point.x * 100 | 0) / 100,
    y: (point.y * 100 | 0) / 100,
  };
}

function quadToRect(quad: types.Quad): types.Rect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const point of quad) {
    minX = Math.min(minX, point.x);
    minY = Math.min(minY, point.y);
    maxX = Math.max(maxX, point.x);
    maxY = Math.max(maxY, point.y);
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

function quadMiddlePoint(quad: types.Quad): types.Point {
  const result = { x: 0, y: 0 };
  for (const point of quad) {
    result.x += point.x / 4;
    result.y += point.y / 4;
  }
  return result;
}

function triangleArea(p1: types.Point, p2: types.Point, p3: types.Point): number {
  return Math.abs(p1.x * (p2.y - p3.y) + p2.x * (p3.y - p1.y) + p3.x * (p1.y - p2.y)) / 2;
}

function isPointInsideQuad(point: types.Point, quad: types.Quad): boolean {
  const area1 = triangleArea(point, quad[0], quad[1]) + triangleArea(point, quad[1], quad[2]) + triangleArea(point, quad[2], quad[3]) + triangleArea(point, quad[3], quad[0]);
  const area2 = triangleArea(quad[0], quad[1], quad[2]) + triangleArea(quad[1], quad[2], quad[3]);
  if (Math.abs(area1 - area2) > 0.1)
    return false;
  return point.x < Math.max(quad[0].x, quad[1].x, quad[2].x, quad[3].x) &&
         point.y < Math.max(quad[0].y, quad[1].y, quad[2].y, quad[3].y);
}

function findIntegerPointInsideQuad(quad: types.Quad): types.Point | undefined {
  const point = quadMiddlePoint(quad);
  point.x = Math.floor(point.x);
  point.y = Math.floor(point.y);
  if (isPointInsideQuad(point, quad))
    return point;
  point.x += 1;
  if (isPointInsideQuad(point, quad))
    return point;
  point.y += 1;
  if (isPointInsideQuad(point, quad))
    return point;
  point.x -= 1;
  if (isPointInsideQuad(point, quad))
    return point;
}
