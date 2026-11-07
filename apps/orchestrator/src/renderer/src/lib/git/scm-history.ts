export const SCMIncomingHistoryItemId = 'scm-graph-incoming-changes'
export const SCMOutgoingHistoryItemId = 'scm-graph-outgoing-changes'

export type HistoryItemRefIcon = 'head' | 'branch' | 'remoteBranch' | 'tag'

export interface ISCMHistoryItemRef {
  readonly id: string
  readonly name: string
  readonly revision?: string
  readonly category?: string
  readonly description?: string
  readonly color?: string
  readonly icon?: HistoryItemRefIcon
}

export interface ISCMHistoryItemStatistics {
  readonly files: number
  readonly insertions: number
  readonly deletions: number
}

export interface ISCMHistoryItem {
  readonly id: string
  readonly parentIds: string[]
  readonly subject: string
  readonly message: string
  readonly displayId?: string
  readonly author?: string
  readonly authorEmail?: string
  readonly timestamp?: number
  readonly statistics?: ISCMHistoryItemStatistics
  readonly references?: ISCMHistoryItemRef[]
}

export interface ISCMHistoryItemGraphNode {
  readonly id: string
  readonly color: string
}

export interface ISCMHistoryItemViewModel {
  readonly historyItem: ISCMHistoryItem
  readonly inputSwimlanes: ISCMHistoryItemGraphNode[]
  readonly outputSwimlanes: ISCMHistoryItemGraphNode[]
  readonly kind: 'HEAD' | 'node' | 'incoming-changes' | 'outgoing-changes'
}

export const SWIMLANE_HEIGHT = 22
export const SWIMLANE_WIDTH = 11
const SWIMLANE_CURVE_RADIUS = 5
const CIRCLE_RADIUS = 4
const CIRCLE_STROKE_WIDTH = 2

export const historyItemRefColor = '#8196ff'
export const historyItemRemoteRefColor = '#B180D7'
export const historyItemBaseRefColor = '#EA5C00'

export const historyItemHoverDefaultLabelForeground = '#d9dce1'
export const historyItemHoverDefaultLabelBackground = '#383c43'
export const historyItemHoverLabelForeground = 'var(--panel)'
export const historyItemHoverAdditionsForeground = '#4cc38a'
export const historyItemHoverDeletionsForeground = '#ef6e6b'

export const colorRegistry: string[] = ['#FFB000', '#DC267F', '#d08a3c', '#40B0A6', '#B66DFF']

export type GraphElement =
  | { readonly type: 'path'; readonly d: string; readonly color: string; readonly strokeWidth: number }
  | {
      readonly type: 'circle'
      readonly cx: number
      readonly cy: number
      readonly r: number
      readonly strokeWidth: number
      readonly fill?: string
      readonly stroke?: string
      readonly dashed?: boolean
    }

export interface GraphSvg {
  readonly width: number
  readonly height: number
  readonly elements: GraphElement[]
}

function rot(index: number, modulo: number): number {
  return (modulo + (index % modulo)) % modulo
}

function findLastIdx<T>(array: readonly T[], predicate: (item: T) => boolean): number {
  for (let i = array.length - 1; i >= 0; i--) {
    if (predicate(array[i])) {
      return i
    }
  }
  return -1
}

function getLabelColorIdentifier(
  historyItem: ISCMHistoryItem,
  colorMap: Map<string, string | undefined>
): string | undefined {
  if (historyItem.id === SCMIncomingHistoryItemId) {
    return historyItemRemoteRefColor
  } else if (historyItem.id === SCMOutgoingHistoryItemId) {
    return historyItemRefColor
  } else {
    for (const ref of historyItem.references ?? []) {
      const colorIdentifier = colorMap.get(ref.id)
      if (colorIdentifier !== undefined) {
        return colorIdentifier
      }
    }
  }

  return undefined
}

function createPath(color: string, d: string, strokeWidth = 1): GraphElement {
  return { type: 'path', d, color, strokeWidth }
}

function drawCircle(index: number, radius: number, strokeWidth: number, color?: string): GraphElement {
  return {
    type: 'circle',
    cx: SWIMLANE_WIDTH * (index + 1),
    cy: SWIMLANE_WIDTH,
    r: radius,
    strokeWidth,
    fill: color
  }
}

function drawDashedCircle(index: number, radius: number, strokeWidth: number, color: string): GraphElement {
  return {
    type: 'circle',
    cx: SWIMLANE_WIDTH * (index + 1),
    cy: SWIMLANE_WIDTH,
    r: CIRCLE_RADIUS + 1,
    strokeWidth,
    stroke: color,
    dashed: true
  }
}

function drawVerticalLine(x1: number, y1: number, y2: number, color: string, strokeWidth = 1): GraphElement {
  return createPath(color, `M ${x1} ${y1} V ${y2}`, strokeWidth)
}

function findLastIndex(nodes: ISCMHistoryItemGraphNode[], id: string): number {
  for (let i = nodes.length - 1; i >= 0; i--) {
    if (nodes[i].id === id) {
      return i
    }
  }

  return -1
}

export function renderSCMHistoryItemGraph(historyItemViewModel: ISCMHistoryItemViewModel): GraphSvg {
  const svg: GraphElement[] = []

  const historyItem = historyItemViewModel.historyItem
  const inputSwimlanes = historyItemViewModel.inputSwimlanes
  const outputSwimlanes = historyItemViewModel.outputSwimlanes

  const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id)

  const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length

  const circleColor =
    circleIndex < outputSwimlanes.length
      ? outputSwimlanes[circleIndex].color
      : circleIndex < inputSwimlanes.length
        ? inputSwimlanes[circleIndex].color
        : historyItemRefColor

  let outputSwimlaneIndex = 0
  for (let index = 0; index < inputSwimlanes.length; index++) {
    const color = inputSwimlanes[index].color

    if (inputSwimlanes[index].id === historyItem.id) {
      if (index !== circleIndex) {
        const d: string[] = []

        d.push(`M ${SWIMLANE_WIDTH * (index + 1)} 0`)
        d.push(`A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${SWIMLANE_WIDTH}`)

        d.push(`H ${SWIMLANE_WIDTH * (circleIndex + 1)}`)

        svg.push(createPath(color, d.join(' ')))
      } else {
        outputSwimlaneIndex++
      }
    } else {
      if (
        outputSwimlaneIndex < outputSwimlanes.length &&
        inputSwimlanes[index].id === outputSwimlanes[outputSwimlaneIndex].id
      ) {
        if (index === outputSwimlaneIndex) {
          svg.push(drawVerticalLine(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT, color))
        } else {
          const d: string[] = []

          d.push(`M ${SWIMLANE_WIDTH * (index + 1)} 0`)
          d.push(`V 6`)

          d.push(
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${SWIMLANE_WIDTH * (index + 1) - SWIMLANE_CURVE_RADIUS} ${SWIMLANE_HEIGHT / 2}`
          )

          d.push(`H ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1) + SWIMLANE_CURVE_RADIUS}`)

          d.push(
            `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)} ${SWIMLANE_HEIGHT / 2 + SWIMLANE_CURVE_RADIUS}`
          )

          d.push(`V ${SWIMLANE_HEIGHT}`)

          svg.push(createPath(color, d.join(' ')))
        }

        outputSwimlaneIndex++
      }
    }
  }

  for (let i = 1; i < historyItem.parentIds.length; i++) {
    const parentOutputIndex = findLastIndex(outputSwimlanes, historyItem.parentIds[i])
    if (parentOutputIndex === -1) {
      continue
    }

    const d: string[] = []

    d.push(`M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`)
    d.push(
      `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * (parentOutputIndex + 1)} ${SWIMLANE_HEIGHT}`
    )

    d.push(`M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`)
    d.push(`H ${SWIMLANE_WIDTH * (circleIndex + 1)} `)

    svg.push(createPath(outputSwimlanes[parentOutputIndex].color, d.join(' ')))
  }

  if (inputIndex !== -1) {
    svg.push(
      drawVerticalLine(
        SWIMLANE_WIDTH * (circleIndex + 1),
        0,
        SWIMLANE_HEIGHT / 2,
        inputSwimlanes[inputIndex].color
      )
    )
  }

  if (historyItem.parentIds.length > 0) {
    svg.push(
      drawVerticalLine(SWIMLANE_WIDTH * (circleIndex + 1), SWIMLANE_HEIGHT / 2, SWIMLANE_HEIGHT, circleColor)
    )
  }

  if (historyItemViewModel.kind === 'HEAD') {
    svg.push(drawCircle(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor))
    svg.push(drawCircle(circleIndex, CIRCLE_STROKE_WIDTH, CIRCLE_RADIUS))
  } else if (
    historyItemViewModel.kind === 'incoming-changes' ||
    historyItemViewModel.kind === 'outgoing-changes'
  ) {
    svg.push(drawCircle(circleIndex, CIRCLE_RADIUS + 3, CIRCLE_STROKE_WIDTH, circleColor))
    svg.push(drawCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH + 1))
    svg.push(drawDashedCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH - 1, circleColor))
  } else {
    if (historyItem.parentIds.length > 1) {
      svg.push(drawCircle(circleIndex, CIRCLE_RADIUS + 2, CIRCLE_STROKE_WIDTH, circleColor))
      svg.push(drawCircle(circleIndex, CIRCLE_RADIUS - 1, CIRCLE_STROKE_WIDTH, circleColor))
    } else {
      svg.push(drawCircle(circleIndex, CIRCLE_RADIUS + 1, CIRCLE_STROKE_WIDTH, circleColor))
    }
  }

  return {
    height: SWIMLANE_HEIGHT,
    width: SWIMLANE_WIDTH * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1),
    elements: svg
  }
}

export function renderSCMHistoryGraphPlaceholder(
  columns: ISCMHistoryItemGraphNode[],
  highlightIndex?: number
): GraphSvg {
  const elements: GraphElement[] = []

  for (let index = 0; index < columns.length; index++) {
    const strokeWidth = index === highlightIndex ? 3 : 1
    elements.push(
      drawVerticalLine(SWIMLANE_WIDTH * (index + 1), 0, SWIMLANE_HEIGHT, columns[index].color, strokeWidth)
    )
  }

  return { height: SWIMLANE_HEIGHT, width: SWIMLANE_WIDTH * (columns.length + 1), elements }
}

export function toISCMHistoryItemViewModelArray(
  historyItems: ISCMHistoryItem[],
  colorMap = new Map<string, string | undefined>(),
  currentHistoryItemRef?: ISCMHistoryItemRef,
  currentHistoryItemRemoteRef?: ISCMHistoryItemRef,
  currentHistoryItemBaseRef?: ISCMHistoryItemRef,
  addIncomingChanges?: boolean,
  addOutgoingChanges?: boolean,
  mergeBase?: string
): ISCMHistoryItemViewModel[] {
  let colorIndex = -1
  const viewModels: ISCMHistoryItemViewModel[] = []

  for (let index = 0; index < historyItems.length; index++) {
    const historyItem = historyItems[index]

    const kind = historyItem.id === currentHistoryItemRef?.revision ? 'HEAD' : 'node'
    const outputSwimlanesFromPreviousItem = viewModels.at(-1)?.outputSwimlanes ?? []
    const inputSwimlanes = outputSwimlanesFromPreviousItem.map((i) => ({ ...i }))
    const outputSwimlanes: ISCMHistoryItemGraphNode[] = []

    let firstParentAdded = false

    if (historyItem.parentIds.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === historyItem.id) {
          if (!firstParentAdded) {
            outputSwimlanes.push({
              id: historyItem.parentIds[0],
              color: getLabelColorIdentifier(historyItem, colorMap) ?? node.color
            })
            firstParentAdded = true
          }

          continue
        }

        outputSwimlanes.push({ ...node })
      }
    }

    for (let i = firstParentAdded ? 1 : 0; i < historyItem.parentIds.length; i++) {
      let colorIdentifier: string | undefined

      if (i === 0) {
        colorIdentifier = getLabelColorIdentifier(historyItem, colorMap)
      } else {
        const historyItemParent = historyItems.find((h) => h.id === historyItem.parentIds[i])
        colorIdentifier = historyItemParent ? getLabelColorIdentifier(historyItemParent, colorMap) : undefined
      }

      if (!colorIdentifier) {
        colorIndex = rot(colorIndex + 1, colorRegistry.length)
        colorIdentifier = colorRegistry[colorIndex]
      }

      outputSwimlanes.push({
        id: historyItem.parentIds[i],
        color: colorIdentifier
      })
    }

    const references = (historyItem.references ?? []).map((ref) => {
      let color = colorMap.get(ref.id)
      if (colorMap.has(ref.id) && color === undefined) {
        const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id)

        const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length

        color =
          circleIndex < outputSwimlanes.length
            ? outputSwimlanes[circleIndex].color
            : circleIndex < inputSwimlanes.length
              ? inputSwimlanes[circleIndex].color
              : historyItemRefColor
      }

      return { ...ref, color }
    })

    references.sort((ref1, ref2) =>
      compareHistoryItemRefs(
        ref1,
        ref2,
        currentHistoryItemRef,
        currentHistoryItemRemoteRef,
        currentHistoryItemBaseRef
      )
    )

    viewModels.push({
      historyItem: {
        ...historyItem,
        references
      },
      kind,
      inputSwimlanes,
      outputSwimlanes
    } satisfies ISCMHistoryItemViewModel)
  }

  addIncomingOutgoingChangesHistoryItems(
    viewModels,
    currentHistoryItemRef,
    currentHistoryItemRemoteRef,
    addIncomingChanges,
    addOutgoingChanges,
    mergeBase
  )

  return viewModels
}

export function getHistoryItemIndex(historyItemViewModel: ISCMHistoryItemViewModel): number {
  const historyItem = historyItemViewModel.historyItem
  const inputSwimlanes = historyItemViewModel.inputSwimlanes

  const inputIndex = inputSwimlanes.findIndex((node) => node.id === historyItem.id)

  return inputIndex !== -1 ? inputIndex : inputSwimlanes.length
}

function addIncomingOutgoingChangesHistoryItems(
  viewModels: ISCMHistoryItemViewModel[],
  currentHistoryItemRef?: ISCMHistoryItemRef,
  currentHistoryItemRemoteRef?: ISCMHistoryItemRef,
  addIncomingChanges?: boolean,
  addOutgoingChanges?: boolean,
  mergeBase?: string
): void {
  if (currentHistoryItemRef?.revision !== currentHistoryItemRemoteRef?.revision && mergeBase) {
    if (
      addIncomingChanges &&
      currentHistoryItemRemoteRef &&
      currentHistoryItemRemoteRef.revision !== mergeBase
    ) {
      const beforeHistoryItemIndex = findLastIdx(viewModels, (vm) =>
        vm.outputSwimlanes.some((node) => node.id === mergeBase)
      )
      const afterHistoryItemIndex = viewModels.findIndex((vm) => vm.historyItem.id === mergeBase)

      if (beforeHistoryItemIndex !== -1 && afterHistoryItemIndex !== -1) {
        const incomingChangeMerged =
          viewModels[beforeHistoryItemIndex].historyItem.parentIds.length === 2 &&
          viewModels[beforeHistoryItemIndex].historyItem.parentIds.includes(mergeBase)

        if (!incomingChangeMerged) {
          viewModels[beforeHistoryItemIndex] = {
            ...viewModels[beforeHistoryItemIndex],
            inputSwimlanes: viewModels[beforeHistoryItemIndex].inputSwimlanes.map((node) => {
              return node.id === mergeBase && node.color === historyItemRemoteRefColor
                ? { ...node, id: SCMIncomingHistoryItemId }
                : node
            }),
            outputSwimlanes: viewModels[beforeHistoryItemIndex].outputSwimlanes.map((node) => {
              return node.id === mergeBase && node.color === historyItemRemoteRefColor
                ? { ...node, id: SCMIncomingHistoryItemId }
                : node
            })
          }

          const inputSwimlanes = viewModels[beforeHistoryItemIndex].outputSwimlanes.map((i) => ({ ...i }))
          const outputSwimlanes = viewModels[afterHistoryItemIndex].inputSwimlanes.map((i) => ({ ...i }))
          const displayIdLength = viewModels[0].historyItem.displayId?.length ?? 0

          const incomingChangesHistoryItem = {
            id: SCMIncomingHistoryItemId,
            displayId: '0'.repeat(displayIdLength),
            parentIds: [mergeBase],
            author: currentHistoryItemRemoteRef?.name,
            subject: 'Incoming Changes',
            message: ''
          } satisfies ISCMHistoryItem

          viewModels.splice(afterHistoryItemIndex, 0, {
            historyItem: incomingChangesHistoryItem,
            kind: 'incoming-changes',
            inputSwimlanes,
            outputSwimlanes
          })
        }
      }
    }

    if (
      addOutgoingChanges &&
      currentHistoryItemRef?.revision &&
      currentHistoryItemRef.revision !== mergeBase
    ) {
      const currentHistoryItemRefIndex = viewModels.findIndex(
        (vm) => vm.kind === 'HEAD' && vm.historyItem.id === currentHistoryItemRef.revision
      )

      if (currentHistoryItemRefIndex !== -1) {
        const outgoingChangesHistoryItem = {
          id: SCMOutgoingHistoryItemId,
          displayId: viewModels[0].historyItem.displayId
            ? '0'.repeat(viewModels[0].historyItem.displayId.length)
            : undefined,
          parentIds: [currentHistoryItemRef.revision],
          author: currentHistoryItemRef?.name,
          subject: 'Outgoing Changes',
          message: ''
        } satisfies ISCMHistoryItem

        const inputSwimlanes = viewModels[currentHistoryItemRefIndex].inputSwimlanes.slice(0)

        const outputSwimlanes = inputSwimlanes.slice(0).concat({
          id: currentHistoryItemRef.revision,
          color: historyItemRefColor
        } satisfies ISCMHistoryItemGraphNode)

        viewModels.splice(currentHistoryItemRefIndex, 0, {
          historyItem: outgoingChangesHistoryItem,
          kind: 'outgoing-changes',
          inputSwimlanes,
          outputSwimlanes
        })

        viewModels[currentHistoryItemRefIndex + 1].inputSwimlanes.push({
          id: currentHistoryItemRef.revision,
          color: historyItemRefColor
        } satisfies ISCMHistoryItemGraphNode)
      }
    }
  }
}

export function compareHistoryItemRefs(
  ref1: ISCMHistoryItemRef,
  ref2: ISCMHistoryItemRef,
  currentHistoryItemRef?: ISCMHistoryItemRef,
  currentHistoryItemRemoteRef?: ISCMHistoryItemRef,
  currentHistoryItemBaseRef?: ISCMHistoryItemRef
): number {
  const getHistoryItemRefOrder = (ref: ISCMHistoryItemRef): number => {
    if (ref.id === currentHistoryItemRef?.id) {
      return 1
    } else if (ref.id === currentHistoryItemRemoteRef?.id) {
      return 2
    } else if (ref.id === currentHistoryItemBaseRef?.id) {
      return 3
    } else if (ref.color !== undefined) {
      return 4
    }

    return 99
  }

  const ref1Order = getHistoryItemRefOrder(ref1)
  const ref2Order = getHistoryItemRefOrder(ref2)

  return ref1Order - ref2Order
}
