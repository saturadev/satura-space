import type {
  Coords,
  LimitShiftOptions,
  SideObject,
} from '../core/index';
import {
  arrow as arrowCore,
  detectOverflow as detectOverflowCore,
  flip as flipCore,
  limitShift as limitShiftCore,
  offset as offsetCore,
  shift as shiftCore,
  size as sizeCore,
} from '../core/index';

import type {
  ArrowOptions,
  Derivable,
  DetectOverflowOptions,
  FlipOptions,
  Middleware,
  MiddlewareState,
  OffsetOptions,
  ShiftOptions,
  SizeOptions,
} from './types';

export const detectOverflow: (
  state: MiddlewareState,
  options?: DetectOverflowOptions | Derivable<DetectOverflowOptions>,
) => Promise<SideObject> = detectOverflowCore;

export const offset: (options?: OffsetOptions) => Middleware = offsetCore;

export const shift: (
  options?: ShiftOptions | Derivable<ShiftOptions>,
) => Middleware = shiftCore;

export const size: (
  options?: SizeOptions | Derivable<SizeOptions>,
) => Middleware = sizeCore;

export const flip: (
  options?: FlipOptions | Derivable<FlipOptions>,
) => Middleware = flipCore;

export const arrow: (
  options: ArrowOptions | Derivable<ArrowOptions>,
) => Middleware = arrowCore;

export const limitShift: (
  options?: LimitShiftOptions | Derivable<LimitShiftOptions>,
) => {
  options: any;
  fn: (state: MiddlewareState) => Coords;
} = limitShiftCore;
