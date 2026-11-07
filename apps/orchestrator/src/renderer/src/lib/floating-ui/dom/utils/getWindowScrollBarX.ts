import {getNodeScroll} from '../../utils/dom';

import {getDocumentElement} from '../platform/getDocumentElement';
import {getBoundingClientRect} from './getBoundingClientRect';

export function getWindowScrollBarX(element: Element, rect?: DOMRect): number {
  const leftScroll = getNodeScroll(element).scrollLeft;

  if (!rect) {
    return getBoundingClientRect(getDocumentElement(element)).left + leftScroll;
  }

  return rect.left + leftScroll;
}
