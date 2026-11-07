import {computePosition as computePositionCore} from '../core/index';

import {platform} from './platform';
import type {
  ComputePositionConfig,
  FloatingElement,
  ReferenceElement,
} from './types';

export const computePosition = (
  reference: ReferenceElement,
  floating: FloatingElement,
  options?: Partial<ComputePositionConfig>,
) => {
  const cache = new Map<ReferenceElement, Array<Element>>();
  const mergedOptions = {platform, ...options};
  const platformWithCache = {...mergedOptions.platform, _c: cache};
  return computePositionCore(reference, floating, {
    ...mergedOptions,
    platform: platformWithCache,
  });
};

export {autoUpdate} from './autoUpdate';
export {
  arrow,
  detectOverflow,
  flip,
  limitShift,
  offset,
  shift,
  size,
} from './middleware';
export {platform} from './platform';
export type {
  ArrowOptions,
  AutoUpdateOptions,
  Boundary,
  ComputePositionConfig,
  Derivable,
  DetectOverflowOptions,
  Elements,
  FlipOptions,
  FloatingElement,
  Middleware,
  MiddlewareArguments,
  MiddlewareState,
  NodeScroll,
  OffsetOptions,
  Platform,
  ReferenceElement,
  ShiftOptions,
  SizeOptions,
  VirtualElement,
} from './types';
export type {
  AlignedPlacement,
  Alignment,
  Axis,
  ClientRectObject,
  ComputePositionReturn,
  Coords,
  Dimensions,
  ElementContext,
  ElementRects,
  Length,
  LimitShiftOptions,
  MiddlewareData,
  MiddlewareReturn,
  Padding,
  Placement,
  Rect,
  RootBoundary,
  Side,
  SideObject,
  Strategy,
} from '../core/index';
export {getOverflowAncestors} from '../utils/dom';
