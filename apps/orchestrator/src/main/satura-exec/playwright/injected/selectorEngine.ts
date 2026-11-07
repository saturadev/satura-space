export type SelectorRoot = Element | ShadowRoot | Document;

export interface SelectorEngine {
  queryAll(root: SelectorRoot, selector: string | any): Element[];
}
