import type { SelectorEngine, SelectorRoot } from './selectorEngine';

export const XPathEngine: SelectorEngine = {
  queryAll(root: SelectorRoot, selector: string): Element[] {
    if (selector.startsWith('/') && root.nodeType !== Node.DOCUMENT_NODE)
      selector = '.' + selector;
    const result: Element[] = [];
    const document = root.ownerDocument || root;
    if (!document)
      return result;
    const it = document.evaluate(selector, root, null, XPathResult.ORDERED_NODE_ITERATOR_TYPE);
    for (let node = it.iterateNext(); node; node = it.iterateNext()) {
      if (node.nodeType === Node.ELEMENT_NODE)
        result.push(node as Element);
    }
    return result;
  }
};
