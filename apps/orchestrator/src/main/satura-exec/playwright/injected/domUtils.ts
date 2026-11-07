type GlobalOptions = {
  browserNameForWorkarounds?: string;
};
let globalOptions: GlobalOptions = {};
export function setGlobalOptions(options: GlobalOptions) {
  globalOptions = options;
}
export function getGlobalOptions(): GlobalOptions {
  return globalOptions;
}

export function isInsideScope(scope: Node, element: Element | undefined): boolean {
  while (element) {
    if (scope.contains(element))
      return true;
    element = enclosingShadowHost(element);
  }
  return false;
}

export function enclosingElement(node: Node) {
  if (node.nodeType === 1)
    return node as Element;
  return node.parentElement ?? undefined;
}

export function parentElementOrShadowHost(element: Element): Element | undefined {
  if (element.parentElement)
    return element.parentElement;
  if (!element.parentNode)
    return;
  if (element.parentNode.nodeType === 11 && (element.parentNode as ShadowRoot).host)
    return (element.parentNode as ShadowRoot).host;
}

export function enclosingShadowRootOrDocument(element: Element): Document | ShadowRoot | undefined {
  let node: Node = element;
  while (node.parentNode)
    node = node.parentNode;
  if (node.nodeType === 11 || node.nodeType === 9)
    return node as Document | ShadowRoot;
}

function enclosingShadowHost(element: Element): Element | undefined {
  while (element.parentElement)
    element = element.parentElement;
  return parentElementOrShadowHost(element);
}

export function closestCrossShadow(element: Element | undefined, css: string, scope?: Document | Element): Element | undefined {
  while (element) {
    const closest = element.closest(css);
    if (scope && closest !== scope && closest?.contains(scope))
      return;
    if (closest)
      return closest;
    element = enclosingShadowHost(element);
  }
}

export function getElementComputedStyle(element: Element, pseudo?: string): CSSStyleDeclaration | undefined {
  const cache = pseudo === '::before' ? cacheStyleBefore : pseudo === '::after' ? cacheStyleAfter : cacheStyle;
  if (cache && cache.has(element))
    return cache.get(element);
  const style = element.ownerDocument && element.ownerDocument.defaultView ? element.ownerDocument.defaultView.getComputedStyle(element, pseudo) : undefined;
  cache?.set(element, style);
  return style;
}

export function isElementStyleVisibilityVisible(element: Element, style?: CSSStyleDeclaration): boolean {
  style = style ?? getElementComputedStyle(element);
  if (!style)
    return true;
  if ((Element.prototype as any).checkVisibility && globalOptions.browserNameForWorkarounds !== 'webkit') {
    if (!element.checkVisibility())
      return false;
  } else {
    const detailsOrSummary = element.closest('details,summary');
    if (detailsOrSummary !== element && detailsOrSummary?.nodeName === 'DETAILS' && !(detailsOrSummary as HTMLDetailsElement).open)
      return false;
  }
  if (style.visibility !== 'visible')
    return false;
  return true;
}

export function computeBox(element: Element) {
  const style = getElementComputedStyle(element);
  if (!style)
    return { visible: true, inline: false };
  const cursor = style.cursor;
  if (style.display === 'contents') {
    for (let child = element.firstChild; child; child = child.nextSibling) {
      if (child.nodeType === 1 && isElementVisible(child as Element))
        return { visible: true, inline: false, cursor };
      if (child.nodeType === 3 && isVisibleTextNode(child as Text))
        return { visible: true, inline: true, cursor };
    }
    return { visible: false, inline: false, cursor };
  }
  if (!isElementStyleVisibilityVisible(element, style))
    return { cursor, visible: false, inline: false };
  const rect = element.getBoundingClientRect();
  return { cursor, visible: rect.width > 0 && rect.height > 0, inline: style.display === 'inline' };
}

export function isElementVisible(element: Element): boolean {
  return computeBox(element).visible;
}

export function isVisibleTextNode(node: Text) {
  const range = node.ownerDocument.createRange();
  range.selectNode(node);
  const rect = range.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

export function elementSafeTagName(element: Element) {
  const tagName = element.tagName;
  if (typeof tagName === 'string')
    return tagName.toUpperCase();
  if (element instanceof HTMLFormElement)
    return 'FORM';
  return element.tagName.toUpperCase();
}

let cacheStyle: Map<Element, CSSStyleDeclaration | undefined> | undefined;
let cacheStyleBefore: Map<Element, CSSStyleDeclaration | undefined> | undefined;
let cacheStyleAfter: Map<Element, CSSStyleDeclaration | undefined> | undefined;
let cachesCounter = 0;

export function beginDOMCaches() {
  ++cachesCounter;
  cacheStyle ??= new Map();
  cacheStyleBefore ??= new Map();
  cacheStyleAfter ??= new Map();
}

export function endDOMCaches() {
  if (!--cachesCounter) {
    cacheStyle = undefined;
    cacheStyleBefore = undefined;
    cacheStyleAfter = undefined;
  }
}
