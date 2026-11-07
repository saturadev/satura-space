declare module 'monaco-editor/esm/vs/editor/common/core/range.js' {
  export { Range } from 'monaco-editor'
}

declare module 'monaco-editor/esm/vs/editor/common/core/position.js' {
  export { Position } from 'monaco-editor'
}

declare module 'monaco-editor/esm/vs/editor/common/core/selection.js' {
  export { Selection } from 'monaco-editor'
}

declare module 'monaco-editor/esm/vs/editor/editor.api.js' {
  export * from 'monaco-editor'
}

declare module 'monaco-editor/esm/vs/base/common/lifecycle.js' {
  export interface IDisposable {
    dispose(): void
  }
  export function toDisposable(fn: () => void): IDisposable
  export class DisposableStore implements IDisposable {
    get isDisposed(): boolean
    add<T extends IDisposable>(o: T): T
    clear(): void
    dispose(): void
  }
  export abstract class Disposable implements IDisposable {
    static readonly None: IDisposable
    protected readonly _store: DisposableStore
    protected _register<T extends IDisposable>(o: T): T
    dispose(): void
  }
  export class MutableDisposable<T extends IDisposable> implements IDisposable {
    get value(): T | undefined
    set value(value: T | undefined)
    clear(): void
    dispose(): void
  }
}

declare module 'monaco-editor/esm/vs/base/common/event.js' {
  import type { IDisposable, DisposableStore } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
  export interface Event<T> {
    (listener: (e: T) => unknown, thisArgs?: unknown, disposables?: IDisposable[] | DisposableStore): IDisposable
  }
  export namespace Event {
    const None: Event<unknown>
    function any<T>(...events: Event<T>[]): Event<T>
    function any(...events: Event<unknown>[]): Event<void>
    function runAndSubscribe<T>(event: Event<T>, handler: (e: T | undefined) => unknown): IDisposable
  }
  export class Emitter<T> {
    constructor()
    get event(): Event<T>
    fire(event: T): void
    dispose(): void
  }
}

declare module 'monaco-editor/esm/vs/base/common/errors.js' {
  export class BugIndicatingError extends Error {
    constructor(message?: string)
  }
  export function onUnexpectedError(e: unknown): undefined
}

declare module 'monaco-editor/esm/vs/base/common/observableInternal/base.js' {
  import type { DisposableStore } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
  export interface IObservable<T> extends IObservableWithChange<T, unknown> {}
  export interface IObservableWithChange<T, TChange = unknown> {
    get(): T
    reportChanges(): void
    addObserver(observer: IObserver): void
    removeObserver(observer: IObserver): void
    read(reader: IReader | undefined): T
    recomputeInitiallyAndOnChange(store: DisposableStore, handleValue?: (value: T) => void): IObservable<T>
    map<TNew>(fn: (value: T, reader: IReader) => TNew): IObservable<TNew>
    map<TNew>(owner: object, fn: (value: T, reader: IReader) => TNew): IObservable<TNew>
    readonly debugName: string
    readonly TChange: TChange
  }
  export interface IObserver {
    beginUpdate<T>(observable: IObservable<T>): void
    endUpdate<T>(observable: IObservable<T>): void
    handlePossibleChange<T>(observable: IObservable<T>): void
    handleChange<T, TChange>(observable: IObservableWithChange<T, TChange>, change: TChange): void
  }
  export interface IReader {
    readObservable<T>(observable: IObservableWithChange<T, any>): T
  }
  export interface IReaderWithStore extends IReader {
    get store(): DisposableStore
    get delayedStore(): DisposableStore
  }
  export interface ISettable<T, TChange = void> {
    set(value: T, transaction: ITransaction | undefined, change: TChange): void
  }
  export interface ITransaction {
    updateObserver(observer: IObserver, observable: IObservableWithChange<any, any>): void
  }
  export interface ISettableObservable<T, TChange = void> extends IObservableWithChange<T, TChange>, ISettable<T, TChange> {}
  export interface IObservableSignal<TChange> extends IObservableWithChange<void, TChange> {
    trigger(tx: ITransaction | undefined, change: TChange): void
  }
  export interface IChangeContext {
    readonly changedObservable: IObservableWithChange<any, any>
    readonly change: unknown
    didChange<T, TChange>(observable: IObservableWithChange<T, TChange>): this is { change: TChange }
  }
  export interface IChangeTracker<TChangeSummary> {
    createChangeSummary(previousChangeSummary: TChangeSummary | undefined): TChangeSummary
    handleChange(ctx: IChangeContext, change: TChangeSummary): boolean
    beforeUpdate?<T>(reader: IReader, changeSummary: TChangeSummary): void
  }
  export type DebugOwner = object | undefined
}

declare module 'monaco-editor/esm/vs/base/common/observableInternal/observables/observableValue.js' {
  import type { ISettableObservable } from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
  export function observableValue<T, TChange = void>(name: string, initialValue: T): ISettableObservable<T, TChange>
  export function observableValue<T, TChange = void>(owner: object, initialValue: T): ISettableObservable<T, TChange>
}

declare module 'monaco-editor/esm/vs/base/common/observableInternal/observables/derived.js' {
  import type { IObservable, IReaderWithStore, DebugOwner } from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
  export function derived<T>(computeFn: (reader: IReaderWithStore) => T): IObservable<T>
  export function derived<T>(owner: DebugOwner, computeFn: (reader: IReaderWithStore) => T): IObservable<T>
  export function derivedOpts<T>(
    options: { owner?: DebugOwner; debugName?: string | (() => string | undefined); equalsFn?: (a: T, b: T) => boolean; onLastObserverRemoved?: () => void },
    computeFn: (reader: IReaderWithStore) => T
  ): IObservable<T>
}

declare module 'monaco-editor/esm/vs/base/common/observableInternal/reactions/autorun.js' {
  import type { IDisposable, DisposableStore } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
  import type { IReaderWithStore, IChangeTracker, DebugOwner } from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
  export function autorun(fn: (reader: IReaderWithStore) => void): IDisposable
  export function autorunOpts(options: { owner?: DebugOwner; debugName?: string | (() => string | undefined) }, fn: (reader: IReaderWithStore) => void): IDisposable
  export function autorunHandleChanges<TChangeSummary>(
    options: { owner?: DebugOwner; debugName?: string | (() => string | undefined); changeTracker: IChangeTracker<TChangeSummary> },
    fn: (reader: IReaderWithStore, changeSummary: TChangeSummary) => void
  ): IDisposable
  export function autorunWithStore(fn: (reader: IReaderWithStore, store: DisposableStore) => void): IDisposable
}

declare module 'monaco-editor/esm/vs/base/common/observableInternal/transaction.js' {
  import type { ITransaction } from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
  export function transaction(fn: (tx: ITransaction) => void, getDebugName?: () => string): void
}

declare module 'monaco-editor/esm/vs/base/common/observableInternal/observables/observableSignal.js' {
  import type { IObservableSignal } from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
  export function observableSignal<TChange = void>(debugName: string): IObservableSignal<TChange>
  export function observableSignal<TChange = void>(owner: object): IObservableSignal<TChange>
}

declare module 'monaco-editor/esm/vs/base/common/observableInternal/observables/observableSignalFromEvent.js' {
  import type { Event } from 'monaco-editor/esm/vs/base/common/event.js'
  import type { IObservable, DebugOwner } from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
  export function observableSignalFromEvent(owner: DebugOwner | string, event: Event<any>): IObservable<void>
}

declare module 'monaco-editor/esm/vs/base/common/observableInternal/observables/observableFromEvent.js' {
  import type { Event } from 'monaco-editor/esm/vs/base/common/event.js'
  import type { IObservable, DebugOwner } from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
  export function observableFromEvent<T, TArgs = unknown>(owner: DebugOwner, event: Event<TArgs>, getValue: (args: TArgs | undefined) => T): IObservable<T>
}

declare module 'monaco-editor/esm/vs/base/common/observableInternal/observables/constObservable.js' {
  import type { IObservable } from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
  export function constObservable<T>(value: T): IObservable<T>
}

declare module 'monaco-editor/esm/vs/base/common/observableInternal/utils/utilsCancellation.js' {
  import type { IObservable } from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
  export function waitForState<T>(observable: IObservable<T>, predicate: (state: T) => boolean): Promise<T>
}

declare module 'monaco-editor/esm/vs/base/common/observableInternal/utils/utils.js' {
  import type { IObserver } from 'monaco-editor/esm/vs/base/common/observableInternal/base.js'
  export class KeepAliveObserver implements IObserver {
    constructor(forceRecompute: boolean, handleValue: ((value: any) => void) | undefined)
    beginUpdate(): void
    endUpdate(): void
    handlePossibleChange(): void
    handleChange(): void
  }
}

declare module 'monaco-editor/esm/vs/base/browser/dom.js' {
  import type { IDisposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
  export function h(tag: string, ...args: any[]): { root: HTMLElement } & Record<string, HTMLElement>
  export function $<T extends HTMLElement>(description: string, attrs?: { [key: string]: any }, ...children: Array<Node | string>): T
  export function reset(parent: HTMLElement, ...children: Array<Node | string>): void
  export function addDisposableListener<K extends keyof HTMLElementEventMap>(node: EventTarget, type: K, handler: (event: HTMLElementEventMap[K]) => void, useCapture?: boolean): IDisposable
  export function addDisposableListener(node: EventTarget, type: string, handler: (event: any) => void, useCapture?: boolean): IDisposable
  export const EventType: { readonly MOUSE_DOWN: 'mousedown' }
  export function isInShadowDOM(domNode: Node): boolean
}

declare module 'monaco-editor/esm/vs/base/browser/domStylesheets.js' {
  import type { DisposableStore } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
  export function createStyleSheet(container?: HTMLElement, beforeAppend?: (style: HTMLStyleElement) => void, disposableStore?: DisposableStore): HTMLStyleElement
}

declare module 'monaco-editor/esm/vs/base/browser/ui/iconLabel/iconLabels.js' {
  export function renderLabelWithIcons(text: string): Array<HTMLSpanElement | string>
}

declare module 'monaco-editor/esm/vs/base/common/hash.js' {
  export function hash(obj: unknown): number
}

declare module 'monaco-editor/esm/vs/base/common/codicons.js' {
  export interface ThemeIcon {
    readonly id: string
  }
  export const Codicon: Record<string, ThemeIcon>
}

declare module 'monaco-editor/esm/vs/base/browser/ui/toggle/toggle.js' {
  import type { Disposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
  import type { Event } from 'monaco-editor/esm/vs/base/common/event.js'
  import type { ThemeIcon } from 'monaco-editor/esm/vs/base/common/codicons.js'
  export class Toggle extends Disposable {
    constructor(opts: { isChecked: boolean; title: string; icon?: ThemeIcon; [key: string]: unknown })
    readonly domNode: HTMLElement
    get onChange(): Event<boolean>
    get checked(): boolean
    set checked(value: boolean)
    setIcon(icon: ThemeIcon | undefined): void
    setTitle(title: string): void
    enable(): void
    disable(): void
  }
}

declare module 'monaco-editor/esm/vs/platform/theme/browser/defaultStyles.js' {
  export const defaultToggleStyles: Record<string, string | undefined>
}

declare module 'monaco-editor/esm/vs/base/common/actions.js' {
  export interface IAction {
    readonly id: string
    label: string
    tooltip: string
    class: string | undefined
    enabled: boolean
    checked?: boolean
    run(...args: unknown[]): unknown
  }
  export class Action implements IAction {
    constructor(id: string, label?: string, cssClass?: string, enabled?: boolean, actionCallback?: (event?: unknown) => unknown)
    readonly id: string
    label: string
    tooltip: string
    class: string | undefined
    enabled: boolean
    checked?: boolean
    run(...args: unknown[]): unknown
    dispose(): void
  }
  export class Separator implements IAction {
    readonly id: string
    label: string
    tooltip: string
    class: string | undefined
    enabled: boolean
    checked: boolean
    run(): unknown
  }
}

declare module 'monaco-editor/esm/vs/base/browser/ui/actionbar/actionbar.js' {
  import type { Disposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
  import type { IAction } from 'monaco-editor/esm/vs/base/common/actions.js'
  export class ActionBar extends Disposable {
    constructor(container: HTMLElement, options?: Record<string, unknown>)
    push(arg: IAction | ReadonlyArray<IAction>, options?: { icon?: boolean; label?: boolean }): void
    clear(): void
  }
}

declare module 'monaco-editor/esm/vs/platform/instantiation/common/instantiation.js' {
  export interface ServiceIdentifier<T> {
    (...args: any[]): void
    type: T
  }
}

declare module 'monaco-editor/esm/vs/platform/undoRedo/common/undoRedo.js' {
  import type { Uri } from 'monaco-editor'
  import type { ServiceIdentifier } from 'monaco-editor/esm/vs/platform/instantiation/common/instantiation.js'
  export class UndoRedoGroup {
    constructor()
  }
  export interface IResourceUndoRedoElement {
    readonly type: 0
    readonly resource: Uri
    readonly label: string
    readonly code: string
    undo(): Promise<void> | void
    redo(): Promise<void> | void
  }
  export interface IUndoRedoService {
    pushElement(element: IResourceUndoRedoElement, group?: UndoRedoGroup): void
  }
  export const IUndoRedoService: ServiceIdentifier<IUndoRedoService>
}

declare module 'monaco-editor/esm/vs/platform/contextview/browser/contextView.js' {
  import type { IAction } from 'monaco-editor/esm/vs/base/common/actions.js'
  import type { ServiceIdentifier } from 'monaco-editor/esm/vs/platform/instantiation/common/instantiation.js'
  export interface IContextMenuDelegate {
    getAnchor(): HTMLElement | { x: number; y: number }
    getActions(): readonly IAction[]
    onHide?(didCancel: boolean): void
  }
  export interface IContextMenuService {
    showContextMenu(delegate: IContextMenuDelegate): void
  }
  export const IContextMenuService: ServiceIdentifier<IContextMenuService>
}

declare module 'monaco-editor/esm/vs/editor/common/services/editorWorker.js' {
  import type { Uri, Range } from 'monaco-editor'
  import type { ServiceIdentifier } from 'monaco-editor/esm/vs/platform/instantiation/common/instantiation.js'
  export interface IDiffLineRange {
    readonly startLineNumber: number
    readonly endLineNumberExclusive: number
    readonly length: number
  }
  export interface IDiffRangeMapping {
    readonly originalRange: Range
    readonly modifiedRange: Range
  }
  export interface IDiffLineRangeMapping {
    readonly original: IDiffLineRange
    readonly modified: IDiffLineRange
    readonly innerChanges: readonly IDiffRangeMapping[] | undefined
  }
  export interface IDocumentDiff {
    readonly identical: boolean
    readonly quitEarly: boolean
    readonly changes: readonly IDiffLineRangeMapping[]
  }
  export interface IEditorWorkerService {
    computeDiff(
      original: Uri,
      modified: Uri,
      options: { ignoreTrimWhitespace: boolean; maxComputationTimeMs: number; computeMoves: boolean },
      algorithm: 'legacy' | 'advanced'
    ): Promise<IDocumentDiff | null>
  }
  export const IEditorWorkerService: ServiceIdentifier<IEditorWorkerService>
}

declare module 'monaco-editor/esm/vs/editor/common/diff/linesDiffComputers.js' {
  import type { IDiffLineRangeMapping } from 'monaco-editor/esm/vs/editor/common/services/editorWorker.js'
  export interface ILinesDiffComputer {
    computeDiff(
      originalLines: string[],
      modifiedLines: string[],
      options: { ignoreTrimWhitespace: boolean; maxComputationTimeMs: number; computeMoves: boolean }
    ): { readonly changes: readonly IDiffLineRangeMapping[]; readonly hitTimeout: boolean }
  }
  export const linesDiffComputers: {
    getLegacy(): ILinesDiffComputer
    getDefault(): ILinesDiffComputer
  }
}

declare module 'monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js' {
  import type { ServiceIdentifier } from 'monaco-editor/esm/vs/platform/instantiation/common/instantiation.js'
  export namespace StandaloneServices {
    function get<T>(serviceId: ServiceIdentifier<T>): T
  }
}

declare module 'monaco-editor/esm/vs/platform/theme/common/colorUtils.js' {
  export type ColorIdentifier = string
  export interface ColorTransform {
    readonly op: number
  }
  export type ColorValue = string | ColorIdentifier | ColorTransform
  export interface ColorDefaults {
    light: ColorValue | null
    dark: ColorValue | null
    hcDark: ColorValue | null
    hcLight: ColorValue | null
  }
  export function registerColor(id: string, defaults: ColorDefaults | ColorValue | null, description: string, needsTransparency?: boolean): ColorIdentifier
  export function transparent(colorValue: ColorValue, factor: number): ColorTransform
  export function asCssVariable(color: ColorIdentifier): string
}

declare module 'monaco-editor/esm/vs/platform/theme/common/colors/editorColors.js' {
  export const mergeCurrentHeaderBackground: string
  export const mergeIncomingHeaderBackground: string
}

declare module 'monaco-editor/esm/vs/editor/common/config/fontInfo.js' {
  export const EDITOR_FONT_DEFAULTS: { readonly fontFamily: string; readonly fontSize: number; readonly lineHeight: number }
}

declare module 'monaco-editor/esm/vs/base/browser/ui/splitview/splitview.js' {
  import type { Disposable } from 'monaco-editor/esm/vs/base/common/lifecycle.js'
  import type { Event } from 'monaco-editor/esm/vs/base/common/event.js'
  export interface IView<TLayoutContext = undefined> {
    readonly element: HTMLElement
    readonly minimumSize: number
    readonly maximumSize: number
    readonly onDidChange: Event<number | undefined>
    layout(size: number, offset: number, context: TLayoutContext | undefined): void
  }
  export interface ISplitViewDescriptor<TLayoutContext, TView extends IView<TLayoutContext>> {
    size: number
    views: { visible?: boolean; size: number; view: TView }[]
  }
  export class SplitView<TLayoutContext = undefined, TView extends IView<TLayoutContext> = IView<TLayoutContext>> extends Disposable {
    constructor(
      container: HTMLElement,
      options?: {
        orientation?: 0 | 1
        proportionalLayout?: boolean
        descriptor?: ISplitViewDescriptor<TLayoutContext, TView>
        styles?: { separatorBorder: { isTransparent(): boolean; toString(): string } }
      }
    )
    readonly el: HTMLElement
    layout(size: number, layoutContext?: TLayoutContext): void
  }
}

declare module 'monaco-editor/esm/vs/base/common/color.js' {
  export class Color {
    static fromHex(hex: string): Color
    static readonly transparent: Color
    isTransparent(): boolean
    toString(): string
  }
}

declare module 'monaco-editor/esm/vs/editor/standalone/common/standaloneTheme.js' {
  import type { ServiceIdentifier } from 'monaco-editor/esm/vs/platform/instantiation/common/instantiation.js'
  export interface IStandaloneThemeService {
    setColorMapOverride(colorMapOverride: unknown[] | null): void
  }
  export const IStandaloneThemeService: ServiceIdentifier<IStandaloneThemeService>
}
