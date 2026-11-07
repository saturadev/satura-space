import type {Rect} from '../../core/index';
import {max} from '../../utils/index';
import {getComputedStyle, getNodeScroll} from '../../utils/dom';

import {getDocumentElement} from '../platform/getDocumentElement';
import {getWindowScrollBarX} from './getWindowScrollBarX';

export function getDocumentRect(element: HTMLElement): Rect {
  const html = getDocumentElement(element);
  const scroll = getNodeScroll(element);
  const body = element.ownerDocument.body;

  const width = max(
    html.scrollWidth,
    html.clientWidth,
    body.scrollWidth,
    body.clientWidth,
  );
  const height = max(
    html.scrollHeight,
    html.clientHeight,
    body.scrollHeight,
    body.clientHeight,
  );

  let x = -scroll.scrollLeft + getWindowScrollBarX(element);
  const y = -scroll.scrollTop;

  if (getComputedStyle(body).direction === 'rtl') {
    x += max(html.clientWidth, body.clientWidth) - width;
  }

  return {
    width,
    height,
    x,
    y,
  };
}
