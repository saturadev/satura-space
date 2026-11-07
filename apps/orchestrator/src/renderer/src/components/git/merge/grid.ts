import { SplitView, type IView as ISplitViewView } from 'monaco-editor/esm/vs/base/browser/ui/splitview/splitview.js'
import { Event } from 'monaco-editor/esm/vs/base/common/event.js'
import { Disposable, type IDisposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
import type { IView } from './editors/codeEditorView'

export type GridNodeDescriptor =
  | { readonly size?: number; readonly data: IView }
  | { readonly size?: number; readonly groups: GridNodeDescriptor[] }

const VERTICAL = 0
const HORIZONTAL = 1

type Orientation = typeof VERTICAL | typeof HORIZONTAL

const separatorBorder = {
  isTransparent: () => false,
  toString: () => 'var(--merge-editor-separator)'
}

class LeafNode implements ISplitViewView<number> {
  readonly onDidChange = Event.None as Event<number | undefined>

  constructor(private readonly view: IView, private readonly orientation: Orientation) { }

  get element(): HTMLElement {
    return this.view.element
  }

  get minimumSize(): number {
    return this.orientation === VERTICAL ? this.view.minimumHeight : this.view.minimumWidth
  }

  get maximumSize(): number {
    return this.orientation === VERTICAL ? this.view.maximumHeight : this.view.maximumWidth
  }

  get orthogonalMinimumSize(): number {
    return this.orientation === VERTICAL ? this.view.minimumWidth : this.view.minimumHeight
  }

  get orthogonalMaximumSize(): number {
    return this.orientation === VERTICAL ? this.view.maximumWidth : this.view.maximumHeight
  }

  layout(size: number, _offset: number, orthogonalSize: number | undefined): void {
    const orthogonal = orthogonalSize ?? 0
    if (this.orientation === VERTICAL) {
      this.view.layout(orthogonal, size, 0, 0)
    } else {
      this.view.layout(size, orthogonal, 0, 0)
    }
  }
}

class BranchNode extends Disposable implements ISplitViewView<number> {
  readonly element = document.createElement('div')
  readonly onDidChange = Event.None as Event<number | undefined>
  private readonly children: (LeafNode | BranchNode)[]
  private readonly splitView: SplitView<number, ISplitViewView<number>>

  constructor(groups: GridNodeDescriptor[], private readonly orientation: Orientation) {
    super()
    this.element.style.width = '100%'
    this.element.style.height = '100%'
    const childOrientation: Orientation = orientation === VERTICAL ? HORIZONTAL : VERTICAL
    this.children = groups.map((g) => createNode(g, childOrientation))
    for (const child of this.children) {
      if (child instanceof BranchNode) this._register(child)
    }
    this.splitView = this._register(new SplitView<number, ISplitViewView<number>>(this.element, {
      orientation: childOrientation,
      proportionalLayout: true,
      styles: { separatorBorder },
      descriptor: {
        size: 100,
        views: groups.map((g, i) => ({ size: g.size ?? 100 / groups.length, view: this.children[i] }))
      }
    }))
  }

  get minimumSize(): number {
    return Math.max(0, ...this.children.map((c) => c.orthogonalMinimumSize))
  }

  get maximumSize(): number {
    return Math.min(Number.POSITIVE_INFINITY, ...this.children.map((c) => c.orthogonalMaximumSize))
  }

  get orthogonalMinimumSize(): number {
    return this.children.reduce((r, c) => r + c.minimumSize, 0)
  }

  get orthogonalMaximumSize(): number {
    return this.children.reduce((r, c) => r + c.maximumSize, 0)
  }

  layout(size: number, _offset: number, orthogonalSize: number | undefined): void {
    this.splitView.layout(orthogonalSize ?? 0, size)
  }
}

function createNode(descriptor: GridNodeDescriptor, orientation: Orientation): LeafNode | BranchNode {
  return 'data' in descriptor ? new LeafNode(descriptor.data, orientation) : new BranchNode(descriptor.groups, orientation)
}

export class MergeEditorGrid implements IDisposable {
  readonly element: HTMLElement
  private readonly root: BranchNode
  private _width = -1
  private _height = -1

  constructor(groups: GridNodeDescriptor[]) {
    this.root = new BranchNode(groups, HORIZONTAL)
    this.element = this.root.element
  }

  get width(): number {
    return this._width
  }

  get height(): number {
    return this._height
  }

  layout(width: number, height: number): void {
    this._width = width
    this._height = height
    this.root.layout(width, 0, height)
  }

  dispose(): void {
    this.root.dispose()
  }
}
