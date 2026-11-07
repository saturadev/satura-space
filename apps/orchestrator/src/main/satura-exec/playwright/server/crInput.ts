import { isString } from '../isomorphic/stringUtils';
import * as input from './input';
import { macEditingCommands } from './macEditingCommands';
import { toButtonsMask, toModifiersMask } from './crProtocolHelper';

import type * as types from './types';
import type { CRPage, CRSession } from './cdp';
import type { DragManager } from './crDragDrop';
import type { Progress } from './progress';

export class RawKeyboardImpl implements input.RawKeyboard {
  constructor(
    private _client: CRSession,
    private _isMac: boolean,
    private _dragManger: DragManager,
  ) { }

  _commandsForCode(code: string, modifiers: Set<types.KeyboardModifier>) {
    if (!this._isMac)
      return [];
    const parts = [];
    for (const modifier of (['Shift', 'Control', 'Alt', 'Meta']) as types.KeyboardModifier[]) {
      if (modifiers.has(modifier))
        parts.push(modifier);
    }
    parts.push(code);
    const shortcut = parts.join('+');
    let commands = macEditingCommands[shortcut] || [];
    if (isString(commands))
      commands = [commands];
    commands = commands.filter(x => !x.startsWith('insert'));
    return commands.map(c => c.substring(0, c.length - 1));
  }

  async keydown(progress: Progress, modifiers: Set<types.KeyboardModifier>, keyName: string, description: input.KeyDescription, autoRepeat: boolean): Promise<void> {
    const { code, key, location, text } = description;
    if (code === 'Escape' && await progress.race(this._dragManger.cancelDrag()))
      return;
    const commands = this._commandsForCode(code, modifiers);
    await progress.race(this._client.send('Input.dispatchKeyEvent', {
      type: text ? 'keyDown' : 'rawKeyDown',
      modifiers: toModifiersMask(modifiers),
      windowsVirtualKeyCode: description.keyCodeWithoutLocation,
      code,
      commands,
      key,
      text,
      unmodifiedText: text,
      autoRepeat,
      location,
      isKeypad: location === input.keypadLocation
    }));
  }

  async keyup(progress: Progress, modifiers: Set<types.KeyboardModifier>, keyName: string, description: input.KeyDescription): Promise<void> {
    const { code, key, location } = description;
    await progress.race(this._client.send('Input.dispatchKeyEvent', {
      type: 'keyUp',
      modifiers: toModifiersMask(modifiers),
      key,
      windowsVirtualKeyCode: description.keyCodeWithoutLocation,
      code,
      location
    }));
  }

  async sendText(progress: Progress, text: string): Promise<void> {
    await progress.race(this._client.send('Input.insertText', { text }));
  }
}

export class RawMouseImpl implements input.RawMouse {
  private _client: CRSession;
  private _page: CRPage;
  private _dragManager: DragManager;

  constructor(page: CRPage, client: CRSession, dragManager: DragManager) {
    this._page = page;
    this._client = client;
    this._dragManager = dragManager;
  }

  async move(progress: Progress, x: number, y: number, button: types.MouseButton | 'none', buttons: Set<types.MouseButton>, modifiers: Set<types.KeyboardModifier>, forClick: boolean): Promise<void> {
    const actualMove = async (progress: Progress) => {
      await progress.race(this._client.send('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        button,
        buttons: toButtonsMask(buttons),
        x,
        y,
        modifiers: toModifiersMask(modifiers),
        force: buttons.size > 0 ? 0.5 : 0,
      }));
    };
    if (forClick) {
      await actualMove(progress);
      return;
    }
    await this._dragManager.interceptDragCausedByMove(progress, x, y, button, buttons, modifiers, actualMove);
  }

  async down(progress: Progress, x: number, y: number, button: types.MouseButton, buttons: Set<types.MouseButton>, modifiers: Set<types.KeyboardModifier>, clickCount: number): Promise<void> {
    if (this._dragManager.isDragging())
      return;
    await progress.race(this._client.send('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      button,
      buttons: toButtonsMask(buttons),
      x,
      y,
      modifiers: toModifiersMask(modifiers),
      clickCount,
      force: buttons.size > 0 ? 0.5 : 0,
    }));
  }

  async up(progress: Progress, x: number, y: number, button: types.MouseButton, buttons: Set<types.MouseButton>, modifiers: Set<types.KeyboardModifier>, clickCount: number): Promise<void> {
    if (this._dragManager.isDragging()) {
      await this._dragManager.drop(progress, x, y, modifiers);
      return;
    }
    await progress.race(this._client.send('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      button,
      buttons: toButtonsMask(buttons),
      x,
      y,
      modifiers: toModifiersMask(modifiers),
      clickCount
    }));
  }

  async wheel(progress: Progress, x: number, y: number, buttons: Set<types.MouseButton>, modifiers: Set<types.KeyboardModifier>, deltaX: number, deltaY: number): Promise<void> {
    await progress.race(this._client.send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      modifiers: toModifiersMask(modifiers),
      deltaX,
      deltaY,
    }));
  }
}

export class RawTouchscreenImpl implements input.RawTouchscreen {
  private _client: CRSession;

  constructor(client: CRSession) {
    this._client = client;
  }
  async tap(progress: Progress, x: number, y: number, modifiers: Set<types.KeyboardModifier>) {
    await progress.race(Promise.all([
      this._client.send('Input.dispatchTouchEvent', {
        type: 'touchStart',
        modifiers: toModifiersMask(modifiers),
        touchPoints: [{
          x, y
        }]
      }),
      this._client.send('Input.dispatchTouchEvent', {
        type: 'touchEnd',
        modifiers: toModifiersMask(modifiers),
        touchPoints: []
      }),
    ]));
  }
}
