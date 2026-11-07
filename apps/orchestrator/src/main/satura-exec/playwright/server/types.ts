export type Point = { x: number, y: number };
export type Size = { width: number, height: number };
export type Rect = Size & Point;
export type Quad = [ Point, Point, Point, Point ];

export type StrictOptions = {
  strict?: boolean,
};

export type QueryOnSelectorOptions = StrictOptions;

export type WaitForElementOptions = StrictOptions & { state?: 'attached' | 'detached' | 'visible' | 'hidden' } & { omitReturnValue?: boolean };

export type CommonActionOptions = StrictOptions & {
  force?: boolean,
  noAutoWaiting?: boolean,
};

export type PointerActionWaitOptions = CommonActionOptions & {
  trial?: boolean;
};

export type KeyboardModifier = 'Alt' | 'Control' | 'Meta' | 'Shift';
export type SmartKeyboardModifier = KeyboardModifier |  'ControlOrMeta';
export type MouseButton = 'left' | 'right' | 'middle';

export type PointerActionOptions = {
  modifiers?: SmartKeyboardModifier[];
  position?: Point;
};

export type DragActionOptions = {
  sourcePosition?: Point;
  targetPosition?: Point;
  steps?: number;
};

export type MouseClickOptions = PointerActionOptions & {
  delay?: number;
  button?: MouseButton;
  clickCount?: number;
};

export type MouseMultiClickOptions = PointerActionOptions & {
  delay?: number;
  button?: MouseButton;
};
