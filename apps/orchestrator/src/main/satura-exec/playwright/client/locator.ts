import { getByAltTextSelector, getByLabelSelector, getByPlaceholderSelector, getByRoleSelector, getByTestIdSelector, getByTextSelector, getByTitleSelector } from '../isomorphic/locatorUtils';
import { escapeForTextSelector } from '../isomorphic/stringUtils';
import { isString } from '../isomorphic/rtti';

import type { Frame, Rect, TimeoutOptions } from './frame';
import type { ByRoleOptions } from '../isomorphic/locatorUtils';

type Options = Record<string, unknown> & TimeoutOptions;

export type LocatorOptions = {
  hasText?: string | RegExp;
  hasNotText?: string | RegExp;
  has?: Locator;
  hasNot?: Locator;
  visible?: boolean;
};

export class Locator {
  _frame: Frame;
  _selector: string;

  constructor(frame: Frame, selector: string, options?: LocatorOptions) {
    this._frame = frame;
    this._selector = selector;

    if (options?.hasText)
      this._selector += ` >> internal:has-text=${escapeForTextSelector(options.hasText, false)}`;

    if (options?.hasNotText)
      this._selector += ` >> internal:has-not-text=${escapeForTextSelector(options.hasNotText, false)}`;

    if (options?.has) {
      const locator = options.has;
      if (locator._frame !== frame)
        throw new Error(`Inner "has" locator must belong to the same frame.`);
      this._selector += ` >> internal:has=` + JSON.stringify(locator._selector);
    }

    if (options?.hasNot) {
      const locator = options.hasNot;
      if (locator._frame !== frame)
        throw new Error(`Inner "hasNot" locator must belong to the same frame.`);
      this._selector += ` >> internal:has-not=` + JSON.stringify(locator._selector);
    }

    if (options?.visible !== undefined)
      this._selector += ` >> visible=${options.visible ? 'true' : 'false'}`;
  }

  _equals(locator: Locator) {
    return this._frame === locator._frame && this._selector === locator._selector;
  }

  page() {
    return this._frame.page();
  }

  async click(options: Options = {}): Promise<void> {
    return await this._frame.click(this._selector, { strict: true, ...options });
  }

  async dblclick(options: Options = {}): Promise<void> {
    await this._frame.dblclick(this._selector, { strict: true, ...options });
  }

  async dragTo(target: Locator, options: Options = {}) {
    return await this._frame.dragAndDrop(this._selector, target._selector, {
      strict: true,
      ...options,
    });
  }

  locator(selectorOrLocator: string | Locator, options?: Omit<LocatorOptions, 'visible'>): Locator {
    if (isString(selectorOrLocator))
      return new Locator(this._frame, this._selector + ' >> ' + selectorOrLocator, options);
    if (selectorOrLocator._frame !== this._frame)
      throw new Error(`Locators must belong to the same frame.`);
    return new Locator(this._frame, this._selector + ' >> internal:chain=' + JSON.stringify(selectorOrLocator._selector), options);
  }

  getByTestId(testId: string | RegExp): Locator {
    return this.locator(getByTestIdSelector(testIdAttributeName(), testId));
  }

  getByAltText(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.locator(getByAltTextSelector(text, options));
  }

  getByLabel(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.locator(getByLabelSelector(text, options));
  }

  getByPlaceholder(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.locator(getByPlaceholderSelector(text, options));
  }

  getByText(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.locator(getByTextSelector(text, options));
  }

  getByTitle(text: string | RegExp, options?: { exact?: boolean }): Locator {
    return this.locator(getByTitleSelector(text, options));
  }

  getByRole(role: string, options: ByRoleOptions = {}): Locator {
    return this.locator(getByRoleSelector(role, options));
  }

  filter(options?: LocatorOptions): Locator {
    return new Locator(this._frame, this._selector, options);
  }

  first(): Locator {
    return new Locator(this._frame, this._selector + ' >> nth=0');
  }

  last(): Locator {
    return new Locator(this._frame, this._selector + ` >> nth=-1`);
  }

  nth(index: number): Locator {
    return new Locator(this._frame, this._selector + ` >> nth=${index}`);
  }

  and(locator: Locator): Locator {
    if (locator._frame !== this._frame)
      throw new Error(`Locators must belong to the same frame.`);
    return new Locator(this._frame, this._selector + ` >> internal:and=` + JSON.stringify(locator._selector));
  }

  or(locator: Locator): Locator {
    if (locator._frame !== this._frame)
      throw new Error(`Locators must belong to the same frame.`);
    return new Locator(this._frame, this._selector + ` >> internal:or=` + JSON.stringify(locator._selector));
  }

  async focus(options?: TimeoutOptions): Promise<void> {
    return await this._frame.focus(this._selector, { strict: true, ...options });
  }

  async blur(options?: TimeoutOptions): Promise<void> {
    await this._frame.blur(this._selector, { strict: true, ...options });
  }

  async count(_options?: {}): Promise<number> {
    return await this._frame._queryCount(this._selector, _options);
  }

  async getAttribute(name: string, options?: TimeoutOptions): Promise<string | null> {
    return await this._frame.getAttribute(this._selector, name, { strict: true, ...options });
  }

  async hover(options: Options = {}): Promise<void> {
    return await this._frame.hover(this._selector, { strict: true, ...options });
  }

  async innerHTML(options?: TimeoutOptions): Promise<string> {
    return await this._frame.innerHTML(this._selector, { strict: true, ...options });
  }

  async innerText(options?: TimeoutOptions): Promise<string> {
    return await this._frame.innerText(this._selector, { strict: true, ...options });
  }

  async inputValue(options?: TimeoutOptions): Promise<string> {
    return await this._frame.inputValue(this._selector, { strict: true, ...options });
  }

  async isChecked(options?: TimeoutOptions): Promise<boolean> {
    return await this._frame.isChecked(this._selector, { strict: true, ...options });
  }

  async isDisabled(options?: TimeoutOptions): Promise<boolean> {
    return await this._frame.isDisabled(this._selector, { strict: true, ...options });
  }

  async isEditable(options?: TimeoutOptions): Promise<boolean> {
    return await this._frame.isEditable(this._selector, { strict: true, ...options });
  }

  async isEnabled(options?: TimeoutOptions): Promise<boolean> {
    return await this._frame.isEnabled(this._selector, { strict: true, ...options });
  }

  async isHidden(options?: TimeoutOptions): Promise<boolean> {
    return await this._frame.isHidden(this._selector, { strict: true, ...options });
  }

  async isVisible(options?: TimeoutOptions): Promise<boolean> {
    return await this._frame.isVisible(this._selector, { strict: true, ...options });
  }

  async press(key: string, options: Options = {}): Promise<void> {
    return await this._frame.press(this._selector, key, { strict: true, ...options });
  }

  async textContent(options?: TimeoutOptions): Promise<string | null> {
    return await this._frame.textContent(this._selector, { strict: true, ...options });
  }

  async type(text: string, options: Options = {}): Promise<void> {
    return await this._frame.type(this._selector, text, { strict: true, ...options });
  }

  async pressSequentially(text: string, options: Options = {}): Promise<void> {
    return await this.type(text, options);
  }

  async all(): Promise<Locator[]> {
    return new Array(await this.count()).fill(0).map((e, i) => this.nth(i));
  }

  async boundingBox(options?: TimeoutOptions): Promise<Rect | null> {
    return await this._frame._call('boundingBox', this._selector, options) as Rect | null;
  }

  async fill(value: string, options: Options = {}): Promise<void> {
    await this._frame._call('fill', this._selector, { ...options, value });
  }

  async clear(options: Options = {}): Promise<void> {
    await this.fill('', options);
  }

  async evaluate(pageFunction: Function | string, arg?: unknown, options?: TimeoutOptions): Promise<any> {
    return await this._frame._evaluate('evaluateOn', this._selector, pageFunction, arg, options);
  }

  async evaluateAll(pageFunction: Function | string, arg?: unknown): Promise<any> {
    return await this._frame._evaluate('evaluateAll', this._selector, pageFunction, arg);
  }

  async allInnerTexts(): Promise<string[]> {
    return await this.evaluateAll((ee: Element[]) => ee.map(e => (e as HTMLElement).innerText));
  }

  async allTextContents(): Promise<string[]> {
    return await this.evaluateAll((ee: Element[]) => ee.map(e => e.textContent || ''));
  }

  async scrollIntoViewIfNeeded(options: Options = {}) {
    await this._frame._call('scrollIntoViewIfNeeded', this._selector, options);
  }

  async selectText(options: Options = {}): Promise<void> {
    await this._frame._call('selectText', this._selector, options);
  }

  async screenshot(options: Options = {}): Promise<unknown> {
    return await this._frame._shot(this._selector, options);
  }

  async waitFor(options?: Options): Promise<void> {
    await this._frame._call('waitFor', this._selector, { strict: true, ...options });
  }

  toString() {
    return `locator(${JSON.stringify(this._selector)})`;
  }

  toJSON() {
    return this.toString();
  }
}

let _testIdAttributeName: string = 'data-testid';

export function testIdAttributeName(): string {
  return _testIdAttributeName;
}
