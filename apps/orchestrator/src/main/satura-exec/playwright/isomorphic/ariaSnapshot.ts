export type AriaRole = 'alert' | 'alertdialog' | 'application' | 'article' | 'banner' | 'blockquote' | 'button' | 'caption' | 'cell' | 'checkbox' | 'code' | 'columnheader' | 'combobox' |
  'complementary' | 'contentinfo' | 'definition' | 'deletion' | 'dialog' | 'directory' | 'document' | 'emphasis' | 'feed' | 'figure' | 'form' | 'generic' | 'grid' |
  'gridcell' | 'group' | 'heading' | 'img' | 'insertion' | 'link' | 'list' | 'listbox' | 'listitem' | 'log' | 'main' | 'mark' | 'marquee' | 'math' | 'meter' | 'menu' |
  'menubar' | 'menuitem' | 'menuitemcheckbox' | 'menuitemradio' | 'navigation' | 'none' | 'note' | 'option' | 'paragraph' | 'presentation' | 'progressbar' | 'radio' | 'radiogroup' |
  'region' | 'row' | 'rowgroup' | 'rowheader' | 'scrollbar' | 'search' | 'searchbox' | 'separator' | 'slider' |
  'spinbutton' | 'status' | 'strong' | 'subscript' | 'superscript' | 'switch' | 'tab' | 'table' | 'tablist' | 'tabpanel' | 'term' | 'textbox' | 'time' | 'timer' |
  'toolbar' | 'tooltip' | 'tree' | 'treegrid' | 'treeitem';

export type AriaProps = {
  checked?: boolean | 'mixed';
  disabled?: boolean;
  expanded?: boolean;
  active?: boolean;
  invalid?: boolean | 'grammar' | 'spelling';
  level?: number;
  pressed?: boolean | 'mixed';
  selected?: boolean;
};

export type AriaBox = {
  visible: boolean;
  inline: boolean;
  cursor?: string;
};

export type AriaNode = AriaProps & {
  role: AriaRole | 'fragment' | 'iframe';
  name: string;
  ref?: string;
  children: (AriaNode | string)[];
  box: AriaBox;
  receivesPointerEvents: boolean;
  props: Record<string, string>;
};

export function ariaNodesEqual(a: AriaNode, b: AriaNode): boolean {
  if (a.role !== b.role || a.name !== b.name)
    return false;
  if (!ariaPropsEqual(a, b) || hasPointerCursor(a) !== hasPointerCursor(b))
    return false;
  const aKeys = Object.keys(a.props);
  const bKeys = Object.keys(b.props);
  return aKeys.length === bKeys.length && aKeys.every(k => a.props[k] === b.props[k]);
}

export function hasPointerCursor(ariaNode: AriaNode): boolean {
  return ariaNode.box.cursor === 'pointer';
}

function ariaPropsEqual(a: AriaProps, b: AriaProps): boolean {
  return a.active === b.active && a.checked === b.checked && a.disabled === b.disabled && a.expanded === b.expanded && a.invalid === b.invalid && a.selected === b.selected && a.level === b.level && a.pressed === b.pressed;
}

export type AriaRegex = { pattern: string };

export type AriaTextValue = {
  raw: string;
  normalized: string;
};

export function findNewNode(from: AriaNode | undefined, to: AriaNode): AriaNode | undefined {
  type ByRoleAndName = Map<string, Map<string, { node: AriaNode, sizeAndPosition: number }>>;

  function fillMap(root: AriaNode, map: ByRoleAndName, position: number) {
    let size = 1;
    let childPosition = position + size;
    for (const child of root.children || []) {
      if (typeof child === 'string') {
        size++;
        childPosition++;
      } else {
        size += fillMap(child, map, childPosition);
        childPosition += size;
      }
    }
    if (!['none', 'presentation', 'fragment', 'iframe', 'generic'].includes(root.role) && root.name) {
      let byRole = map.get(root.role);
      if (!byRole) {
        byRole = new Map();
        map.set(root.role, byRole);
      }
      const existing = byRole.get(root.name);
      const sizeAndPosition = size * 100 - position;
      if (!existing || existing.sizeAndPosition < sizeAndPosition)
        byRole.set(root.name, { node: root, sizeAndPosition });
    }
    return size;
  }

  const fromMap: ByRoleAndName = new Map();
  if (from)
    fillMap(from, fromMap, 0);

  const toMap: ByRoleAndName = new Map();
  fillMap(to, toMap, 0);

  const result: { node: AriaNode, sizeAndPosition: number }[] = [];
  for (const [role, byRole] of toMap) {
    for (const [name, byName] of byRole) {
      const inFrom = fromMap.get(role)?.get(name);
      if (!inFrom)
        result.push(byName);
    }
  }
  result.sort((a, b) => b.sizeAndPosition - a.sizeAndPosition);
  return result[0]?.node;
}
