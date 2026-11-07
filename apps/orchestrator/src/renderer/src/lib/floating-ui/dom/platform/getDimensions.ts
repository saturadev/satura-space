import type {Dimensions} from '../../core/index';

import {getCssDimensions} from '../utils/getCssDimensions';

export function getDimensions(element: Element): Dimensions {
  const {width, height} = getCssDimensions(element);
  return {width, height};
}
