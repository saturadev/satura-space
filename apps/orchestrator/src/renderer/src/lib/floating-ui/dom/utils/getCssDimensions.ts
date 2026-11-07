import type {Dimensions} from '../../core/index';
import {round} from '../../utils/index';
import {getComputedStyle, isHTMLElement} from '../../utils/dom';

export function getCssDimensions(element: Element): Dimensions & {$: boolean} {
  const css = getComputedStyle(element);
  let width = parseFloat(css.width) || 0;
  let height = parseFloat(css.height) || 0;
  const hasOffset = isHTMLElement(element);
  const offsetWidth = hasOffset ? element.offsetWidth : width;
  const offsetHeight = hasOffset ? element.offsetHeight : height;
  const shouldFallback =
    round(width) !== offsetWidth || round(height) !== offsetHeight;

  if (shouldFallback) {
    width = offsetWidth;
    height = offsetHeight;
  }

  return {
    width,
    height,
    $: shouldFallback,
  };
}
