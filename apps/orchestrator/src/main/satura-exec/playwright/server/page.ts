import { DragManager } from './crDragDrop';
import { RawKeyboardImpl, RawMouseImpl } from './crInput';
import { Frame } from './frames';
import { Keyboard, Mouse } from './input';

import type { CRPage, CRSession } from './cdp';
import type * as dom from './dom';
import type { Progress } from './progress';
import type * as types from './types';

export interface InputInstrumentation {
  onBeforeInputAction(target: unknown, metadata: Record<string, unknown>, point?: types.Point, box?: types.Rect): Promise<void>;
  onActionWaiting?(target: unknown, metadata: Record<string, unknown>, reason: string): void;
  onScrollIntoView?(handle: dom.ElementHandle, rect?: types.Rect): Promise<void>;
}

class CRPageDelegate {
  constructor(private _client: CRSession, private _instrumentation?: InputInstrumentation) {}

  async getBoundingBox(handle: dom.ElementHandle): Promise<types.Rect | null> {
    const result = await this._client._sendMayFail('DOM.getBoxModel', {
      objectId: handle._objectId
    });
    if (!result)
      return null;
    const quad = result.model.border;
    const x = Math.min(quad[0], quad[2], quad[4], quad[6]);
    const y = Math.min(quad[1], quad[3], quad[5], quad[7]);
    const width = Math.max(quad[0], quad[2], quad[4], quad[6]) - x;
    const height = Math.max(quad[1], quad[3], quad[5], quad[7]) - y;
    const position = { x: 0, y: 0 };
    return { x: x + position.x, y: y + position.y, width, height };
  }

  async scrollRectIntoViewIfNeeded(handle: dom.ElementHandle, rect?: types.Rect): Promise<'error:notvisible' | 'error:notconnected' | 'done'> {
    await this._instrumentation?.onScrollIntoView?.(handle, rect).catch(() => {});
    return await this._client.send('DOM.scrollIntoViewIfNeeded', {
      objectId: handle._objectId,
      rect,
    }).then(() => 'done' as const).catch(e => {
      if (e instanceof Error && e.message.includes('Node does not have a layout object'))
        return 'error:notvisible';
      if (e instanceof Error && e.message.includes('Node is detached from document'))
        return 'error:notconnected';
      throw e;
    });
  }

  async getContentQuads(handle: dom.ElementHandle): Promise<types.Quad[] | null | 'error:notconnected'> {
    const result = await this._client._sendMayFail('DOM.getContentQuads', {
      objectId: handle._objectId
    });
    if (!result)
      return null;
    const position = { x: 0, y: 0 };
    return result.quads.map((quad: number[]) => [
      { x: quad[0] + position.x, y: quad[1] + position.y },
      { x: quad[2] + position.x, y: quad[3] + position.y },
      { x: quad[4] + position.x, y: quad[5] + position.y },
      { x: quad[6] + position.x, y: quad[7] + position.y }
    ]);
  }
}

export class Page {
  readonly keyboard: Keyboard;
  readonly mouse: Mouse;
  readonly delegate: CRPageDelegate;
  readonly instrumentation: InputInstrumentation;
  readonly frameManager = {
    waitForSignalsCreatedBy: <T>(progress: Progress, waitAfter: boolean, action: (progress: Progress) => Promise<T>): Promise<T> => action(progress),
  };
  readonly browserContext = { _browser: { options: { name: 'chromium' } }, _options: { hasTouch: false } };
  private _frame: Frame;
  private _closed = false;

  constructor(session: CRSession, injectedSource: string, instrumentation: InputInstrumentation, isMac: boolean, worldName?: string) {
    this.instrumentation = instrumentation;
    this.delegate = new CRPageDelegate(session, instrumentation);
    this._frame = new Frame(this, session, injectedSource, worldName);
    const frame = this._frame;
    const crPage: CRPage = {
      _mainFrameSession: { _client: session },
      _page: {
        safeNonStallingEvaluateInAllFrames: async (expression, world) => {
          await frame.nonStallingEvaluateInExistingContext(expression, world).catch(() => {});
        },
        frames: () => [frame],
      },
    };
    const dragManager = new DragManager(crPage);
    this.keyboard = new Keyboard(new RawKeyboardImpl(session, isMac, dragManager), this);
    this.mouse = new Mouse(new RawMouseImpl(crPage, session, dragManager), this);
  }

  mainFrame(): Frame {
    return this._frame;
  }

  isClosed(): boolean {
    return this._closed;
  }

  markClosed() {
    this._closed = true;
  }

  async performActionPreChecks(progress: Progress): Promise<void> {}
}
