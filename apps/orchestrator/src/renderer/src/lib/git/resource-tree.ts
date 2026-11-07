export interface IResourceNode<T> {
  readonly relativePath: string
  readonly name: string
  readonly element: T | undefined
  readonly children: Iterable<IResourceNode<T>>
  readonly childrenCount: number
  readonly parent: IResourceNode<T> | undefined
  get(childName: string): IResourceNode<T> | undefined
}

class Node<T> implements IResourceNode<T> {
  private _children = new Map<string, Node<T>>()

  get childrenCount(): number {
    return this._children.size
  }

  get children(): Iterable<Node<T>> {
    return this._children.values()
  }

  get name(): string {
    const i = this.relativePath.lastIndexOf('/')
    return i === -1 ? this.relativePath : this.relativePath.substring(i + 1)
  }

  constructor(
    readonly relativePath: string,
    public element: T | undefined = undefined,
    readonly parent: IResourceNode<T> | undefined = undefined
  ) {}

  get(path: string): Node<T> | undefined {
    return this._children.get(path)
  }

  set(path: string, child: Node<T>): void {
    this._children.set(path, child)
  }

  delete(path: string): void {
    this._children.delete(path)
  }

  clear(): void {
    this._children.clear()
  }
}

function collect<T>(node: IResourceNode<T>, result: T[]): T[] {
  if (typeof node.element !== 'undefined') {
    result.push(node.element)
  }

  for (const child of node.children) {
    collect(child, result)
  }

  return result
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0)
}

export class ResourceTree<T extends NonNullable<unknown>> {
  readonly root: Node<T>

  static getRoot<T>(node: IResourceNode<T>): IResourceNode<T> {
    while (node.parent) {
      node = node.parent
    }

    return node
  }

  static collect<T>(node: IResourceNode<T>): T[] {
    return collect(node, [])
  }

  static isResourceNode<T>(obj: unknown): obj is IResourceNode<T> {
    return obj instanceof Node
  }

  constructor() {
    this.root = new Node('')
  }

  add(path: string, element: T | undefined): void {
    const names = segments(path)
    let node = this.root
    let relativePath = ''

    for (let i = 0; i < names.length; i++) {
      const name = names[i]
      const last = i === names.length - 1
      relativePath = relativePath ? `${relativePath}/${name}` : name

      let child = node.get(name)

      if (!child) {
        child = new Node(relativePath, last ? element : undefined, node)
        node.set(name, child)
      } else if (last && element !== undefined) {
        child.element = element
      }

      node = child
    }
  }

  delete(path: string): T | undefined {
    return this._delete(this.root, segments(path))
  }

  private _delete(node: Node<T>, names: string[]): T | undefined {
    const name = names[0]
    const child = node.get(name)

    if (!child) {
      return undefined
    }

    if (names.length > 1) {
      const result = this._delete(child, names.slice(1))

      if (typeof result !== 'undefined' && child.childrenCount === 0) {
        node.delete(name)
      }

      return result
    }

    node.delete(name)
    return child.element
  }

  clear(): void {
    this.root.clear()
  }

  getNode(path: string): IResourceNode<T> | undefined {
    let node: Node<T> | undefined = this.root

    for (const name of segments(path)) {
      node = node.get(name)
      if (!node) {
        return undefined
      }
    }

    return node
  }
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })

export function compareFileNames(one: string | null, other: string | null): number {
  const a = one || ''
  const b = other || ''
  const result = collator.compare(a, b)

  if (result === 0 && a !== b) {
    return a < b ? -1 : 1
  }

  return result
}

export function isFolderNode<T>(node: IResourceNode<T>): boolean {
  return node.element === undefined || node.childrenCount > 0
}

export function sortedChildren<T>(node: IResourceNode<T>): IResourceNode<T>[] {
  return [...node.children].sort((one, other) => {
    const oneIsDirectory = isFolderNode(one)
    const otherIsDirectory = isFolderNode(other)

    if (oneIsDirectory !== otherIsDirectory) {
      return oneIsDirectory ? -1 : 1
    }

    return compareFileNames(one.name, other.name)
  })
}

export interface TreeRow<T> {
  readonly kind: 'folder' | 'file' | 'more'
  readonly path: string
  readonly label: string
  readonly depth: number
  readonly node: IResourceNode<T>
  readonly collapsed: boolean
  readonly remaining?: number
}

export function compressFolder<T>(
  node: IResourceNode<T>,
  isIncompressible: (node: IResourceNode<T>) => boolean = () => false
): { node: IResourceNode<T>; label: string } {
  const labels = [node.name]
  let current = node
  while (current.childrenCount === 1 && !isIncompressible(current)) {
    const only = current.children[Symbol.iterator]().next().value as IResourceNode<T>
    if (!isFolderNode(only) || only.element !== undefined) break
    current = only
    labels.push(current.name)
  }
  return { node: current, label: labels.join('/') }
}

export function flattenResourceTree<T>(
  root: IResourceNode<T>,
  isCollapsed: (path: string) => boolean,
  options: {
    depth?: number
    isIncompressible?: (node: IResourceNode<T>) => boolean
    pageSize?: number
    shown?: (folderPath: string) => number
  } = {}
): TreeRow<T>[] {
  const out: TreeRow<T>[] = []
  const visit = (parent: IResourceNode<T>, depth: number): void => {
    const children = sortedChildren(parent)
    const limit = options.pageSize
      ? Math.max(options.pageSize, options.shown?.(parent.relativePath) ?? 0)
      : children.length
    for (const child of children.slice(0, limit)) {
      if (isFolderNode(child)) {
        const { node, label } = compressFolder(child, options.isIncompressible)
        const collapsed = isCollapsed(node.relativePath)
        out.push({ kind: 'folder', path: node.relativePath, label, depth, node, collapsed })
        if (!collapsed) visit(node, depth + 1)
      } else {
        out.push({ kind: 'file', path: child.relativePath, label: child.name, depth, node: child, collapsed: false })
      }
    }
    if (children.length > limit) {
      out.push({
        kind: 'more',
        path: parent.relativePath,
        label: '',
        depth,
        node: parent,
        collapsed: false,
        remaining: children.length - limit
      })
    }
  }
  visit(root, options.depth ?? 0)
  return out
}

export function descendantFolderPaths<T>(node: IResourceNode<T>): string[] {
  const out: string[] = []
  const visit = (n: IResourceNode<T>): void => {
    for (const child of n.children) {
      if (isFolderNode(child)) {
        out.push(child.relativePath)
        visit(child)
      }
    }
  }
  visit(node)
  return out
}

export function countFiles<T>(root: IResourceNode<T>): Map<string, number> {
  const counts = new Map<string, number>()
  const visit = (node: IResourceNode<T>): number => {
    if (!isFolderNode(node)) return 1
    let total = 0
    for (const child of node.children) total += visit(child)
    counts.set(node.relativePath, total)
    return total
  }
  visit(root)
  return counts
}
