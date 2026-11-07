export type Rect = { x: number, y: number, width: number, height: number };
export type TimeoutOptions = { timeout?: number };
export type Rpc = (method: string, params: Record<string, unknown>) => Promise<unknown>;

type Options = Record<string, unknown>;

export function functionSource(pageFunction: Function | string): { source: string, isFunction: boolean } {
  if (typeof pageFunction === 'string')
    return { source: pageFunction, isFunction: false };
  if (typeof pageFunction !== 'function')
    throw new Error('Expected a function or a string');
  return { source: pageFunction.toString(), isFunction: true };
}

export class Frame {
  constructor(private _rpc: Rpc, readonly _window: number | null, private _page: unknown) {}

  page() {
    return this._page;
  }

  _call(action: string, selector: string, options: Options = {}): Promise<unknown> {
    return this._rpc('frame', { window: this._window, action, selector, options });
  }

  _shot(selector: string, options: Options = {}): Promise<unknown> {
    return this._rpc('shot', { window: this._window, selector, options });
  }

  _evaluate(action: string, selector: string, pageFunction: Function | string, arg: unknown, options: Options = {}): Promise<unknown> {
    const { source, isFunction } = functionSource(pageFunction);
    return this._rpc('frame', { window: this._window, action, selector, options: { ...options, source, isFunction, arg } });
  }

  async click(selector: string, options: Options = {}): Promise<void> {
    await this._call('click', selector, options);
  }

  async dblclick(selector: string, options: Options = {}): Promise<void> {
    await this._call('dblclick', selector, options);
  }

  async dragAndDrop(source: string, target: string, options: Options = {}): Promise<void> {
    await this._call('dragAndDrop', source, { ...options, target });
  }

  async focus(selector: string, options: Options = {}): Promise<void> {
    await this._call('focus', selector, options);
  }

  async blur(selector: string, options: Options = {}): Promise<void> {
    await this._call('blur', selector, options);
  }

  async hover(selector: string, options: Options = {}): Promise<void> {
    await this._call('hover', selector, options);
  }

  async fill(selector: string, value: string, options: Options = {}): Promise<void> {
    await this._call('fill', selector, { ...options, value });
  }

  async press(selector: string, key: string, options: Options = {}): Promise<void> {
    await this._call('press', selector, { ...options, key });
  }

  async type(selector: string, text: string, options: Options = {}): Promise<void> {
    await this._call('type', selector, { ...options, text });
  }

  async _queryCount(selector: string, options?: Options): Promise<number> {
    return await this._call('count', selector, options) as number;
  }

  async getAttribute(selector: string, name: string, options: Options = {}): Promise<string | null> {
    return await this._call('getAttribute', selector, { ...options, name }) as string | null;
  }

  async innerHTML(selector: string, options: Options = {}): Promise<string> {
    return await this._call('innerHTML', selector, options) as string;
  }

  async innerText(selector: string, options: Options = {}): Promise<string> {
    return await this._call('innerText', selector, options) as string;
  }

  async inputValue(selector: string, options: Options = {}): Promise<string> {
    return await this._call('inputValue', selector, options) as string;
  }

  async textContent(selector: string, options: Options = {}): Promise<string | null> {
    return await this._call('textContent', selector, options) as string | null;
  }

  async isChecked(selector: string, options: Options = {}): Promise<boolean> {
    return await this._call('isChecked', selector, options) as boolean;
  }

  async isDisabled(selector: string, options: Options = {}): Promise<boolean> {
    return await this._call('isDisabled', selector, options) as boolean;
  }

  async isEditable(selector: string, options: Options = {}): Promise<boolean> {
    return await this._call('isEditable', selector, options) as boolean;
  }

  async isEnabled(selector: string, options: Options = {}): Promise<boolean> {
    return await this._call('isEnabled', selector, options) as boolean;
  }

  async isHidden(selector: string, options: Options = {}): Promise<boolean> {
    return await this._call('isHidden', selector, options) as boolean;
  }

  async isVisible(selector: string, options: Options = {}): Promise<boolean> {
    return await this._call('isVisible', selector, options) as boolean;
  }
}
