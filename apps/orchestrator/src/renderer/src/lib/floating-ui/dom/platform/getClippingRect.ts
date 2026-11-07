import type {
  Boundary,
  ClientRectObject,
  Rect,
  RootBoundary,
  Strategy,
} from '../../core/index';
import {rectToClientRect} from '../../core/index';
import {createCoords, max, min} from '../../utils/index';
import {
  getComputedStyle,
  getDocumentElement,
  getNodeName,
  getOverflowAncestors,
  getParentNode,
  isContainingBlock,
  isHTMLElement,
  isLastTraversableNode,
  isOverflowElement,
  isTopLayer,
} from '../../utils/dom';

import type {Platform, ReferenceElement} from '../types';
import {getBoundingClientRect} from '../utils/getBoundingClientRect';
import {getDocumentRect} from '../utils/getDocumentRect';
import {getViewportRect} from '../utils/getViewportRect';
import {getVisualOffsets} from '../utils/getVisualOffsets';
import {getScale} from './getScale';
import {isElement} from './isElement';

const absoluteOrFixed = new Set(['absolute', 'fixed']);

type PlatformWithCache = Platform & {
  _c: Map<ReferenceElement, Element[]>;
};

function getInnerBoundingClientRect(
  element: Element,
  strategy: Strategy,
): Rect {
  const clientRect = getBoundingClientRect(element, true, strategy === 'fixed');
  const top = clientRect.top + element.clientTop;
  const left = clientRect.left + element.clientLeft;
  const scale = isHTMLElement(element) ? getScale(element) : createCoords(1);
  const width = element.clientWidth * scale.x;
  const height = element.clientHeight * scale.y;
  const x = left * scale.x;
  const y = top * scale.y;

  return {
    width,
    height,
    x,
    y,
  };
}

function getClientRectFromClippingAncestor(
  element: Element,
  clippingAncestor: Element | RootBoundary,
  strategy: Strategy,
): ClientRectObject {
  let rect: Rect;

  if (clippingAncestor === 'viewport') {
    rect = getViewportRect(element, strategy);
  } else if (clippingAncestor === 'document') {
    rect = getDocumentRect(getDocumentElement(element));
  } else if (isElement(clippingAncestor)) {
    rect = getInnerBoundingClientRect(clippingAncestor, strategy);
  } else {
    const visualOffsets = getVisualOffsets(element);
    rect = {
      x: clippingAncestor.x - visualOffsets.x,
      y: clippingAncestor.y - visualOffsets.y,
      width: clippingAncestor.width,
      height: clippingAncestor.height,
    };
  }

  return rectToClientRect(rect);
}

function hasFixedPositionAncestor(element: Element, stopNode: Node): boolean {
  const parentNode = getParentNode(element);
  if (
    parentNode === stopNode ||
    !isElement(parentNode) ||
    isLastTraversableNode(parentNode)
  ) {
    return false;
  }

  return (
    getComputedStyle(parentNode).position === 'fixed' ||
    hasFixedPositionAncestor(parentNode, stopNode)
  );
}

function getClippingElementAncestors(
  element: Element,
  cache: PlatformWithCache['_c'],
): Array<Element> {
  const cachedResult = cache.get(element);
  if (cachedResult) {
    return cachedResult;
  }

  let result = getOverflowAncestors(element, [], false).filter(
    (el) => isElement(el) && getNodeName(el) !== 'body',
  ) as Array<Element>;
  let currentContainingBlockComputedStyle: CSSStyleDeclaration | null = null;
  const elementIsFixed = getComputedStyle(element).position === 'fixed';
  let currentNode: Node | null = elementIsFixed
    ? getParentNode(element)
    : element;

  while (isElement(currentNode) && !isLastTraversableNode(currentNode)) {
    const computedStyle = getComputedStyle(currentNode);
    const currentNodeIsContaining = isContainingBlock(currentNode);

    if (!currentNodeIsContaining && computedStyle.position === 'fixed') {
      currentContainingBlockComputedStyle = null;
    }

    const shouldDropCurrentNode = elementIsFixed
      ? !currentNodeIsContaining && !currentContainingBlockComputedStyle
      : (!currentNodeIsContaining &&
          computedStyle.position === 'static' &&
          !!currentContainingBlockComputedStyle &&
          absoluteOrFixed.has(currentContainingBlockComputedStyle.position)) ||
        (isOverflowElement(currentNode) &&
          !currentNodeIsContaining &&
          hasFixedPositionAncestor(element, currentNode));

    if (shouldDropCurrentNode) {
      result = result.filter((ancestor) => ancestor !== currentNode);
    } else {
      currentContainingBlockComputedStyle = computedStyle;
    }

    currentNode = getParentNode(currentNode);
  }

  cache.set(element, result);

  return result;
}

export function getClippingRect(
  this: PlatformWithCache,
  {
    element,
    boundary,
    rootBoundary,
    strategy,
  }: {
    element: Element;
    boundary: Boundary;
    rootBoundary: RootBoundary;
    strategy: Strategy;
  },
): Rect {
  const elementClippingAncestors =
    boundary === 'clippingAncestors'
      ? isTopLayer(element)
        ? []
        : getClippingElementAncestors(element, this._c)
      : [].concat(boundary);
  const clippingAncestors = [...elementClippingAncestors, rootBoundary];
  const firstClippingAncestor = clippingAncestors[0];

  const clippingRect = clippingAncestors.reduce(
    (accRect: ClientRectObject, clippingAncestor) => {
      const rect = getClientRectFromClippingAncestor(
        element,
        clippingAncestor,
        strategy,
      );

      accRect.top = max(rect.top, accRect.top);
      accRect.right = min(rect.right, accRect.right);
      accRect.bottom = min(rect.bottom, accRect.bottom);
      accRect.left = max(rect.left, accRect.left);

      return accRect;
    },
    getClientRectFromClippingAncestor(element, firstClippingAncestor, strategy),
  );

  return {
    width: clippingRect.right - clippingRect.left,
    height: clippingRect.bottom - clippingRect.top,
    x: clippingRect.left,
    y: clippingRect.top,
  };
}
