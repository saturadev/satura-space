export const BELL = '#8aa4ff'
export const TENDRIL = '#4a5bb5'
export const EYE = '#05060c'

const PAL: Record<string, string> = { a: BELL, d: TENDRIL, k: EYE, h: '#ffffff', e: '#45527f' }

const FRAMES = {
  idle: ['............', '..aaaaa.....', '.aaaaaaa....', 'aaaaaaaaa...', 'aakaaakaa...', 'aaaaaaaaa...', '.d.d.d.d....', '..d.d.d.....', '............', '............'],
  swim: ['............', '............', '..aaaaa.....', '.aaaaaaa....', 'aaaaaaaaa...', 'aakaaakaa...', 'aaaaaaaaa...', 'd.d.d.d.d...', '.d.d.d.d....', '............'],
  reach: ['............', '..aaaaa.....', '.aaaaaaa....', 'aaaaaaaaa...', 'aakaaakaa...', 'aaaaaaaaa...', '.d.d.d.d.d..', '..d.d.d...d.', '...........d', '...........h'],
  press: ['............', '............', '..aaaaa.....', 'aaaaaaaaa...', 'aakaaakaa...', 'aaaaaaaaa...', '.d.d.d.d.d..', '..d.d.d...d.', '...........d', '...........h'],
  up: ['...........h', '..........d.', '.........d..', '..aaaaa.d...', '.aaaaaaad...', 'aaaaaaaaa...', 'aakaaakaa...', 'aaaaaaaaa...', '.d.d.d.d....', '..d.d.d.....'],
  side: ['............', '..aaaaa.....', '.aaaaaaa....', 'aaaaaaaaa...', 'aakaaakaaaah', 'aaaaaaaaa...', '.d.d.d.d....', '..d.d.d.....', '............', '............'],
  sidePress: ['............', '............', '..aaaaa.....', 'aaaaaaaaa...', 'aakaaakaaaah', 'aaaaaaaaa...', '.d.d.d.d....', '..d.d.d.....', '............', '............'],
  waveA: ['............', '..aaaaa.....', '.aaaaaaa....', 'aaaaaaaaa.d.', 'aakaaakaa.d.', 'aaaaaaaaad..', '.d.d.d.d....', '..d.d.d.....', '............', '............'],
  waveB: ['............', '..aaaaa.....', '.aaaaaaa....', 'aaaaaaaaa...', 'aakaaakaa..d', 'aaaaaaaaadd.', '.d.d.d.d....', '..d.d.d.....', '............', '............'],
  limp: ['............', '..aaaaa.....', '.aaaaaaa....', 'aaaaaaaaa...', 'aakaaakaa...', 'aaaaaaaaa...', '.d.d.d.d....', '.d.d.d.d....', '............', '............'],
  ring: ['............', '............', '...a.a......', '..a...a.....', '.a.....a....', '.a.....a....', '..a...a.....', '...a.a......', '............', '............'],
  dust: ['............', '............', '............', '..e...e.....', '....e.......', 'e.......e...', '...e.e......', '............', '............', '............']
} as const

export type Body = keyof typeof FRAMES

export type FaceKind = 'none' | 'look' | 'wide' | 'closed' | 'happy' | 'lines' | 'puzzled' | 'low'

export interface Face {
  e: FaceKind
  dx?: number
  dy?: number
  keep?: boolean
}

export const COLS = 12
export const ROWS = 10

export const FLOAT_MS = 3000
const WIGGLE_SEQ = [1, 0, -1, 0]

export function wiggleAt(now: number): number {
  const phase = (((now % FLOAT_MS) + FLOAT_MS) % FLOAT_MS) / FLOAT_MS
  return WIGGLE_SEQ[Math.floor(phase * WIGGLE_SEQ.length) % WIGGLE_SEQ.length]
}

function armCells(g: string[][]): Set<string> {
  const arm = new Set<string>()
  let at: [number, number] | null = null
  g.forEach((r, y) => r.forEach((c, x) => { if (c === 'h') at = [x, y] }))
  while (at) {
    const [x, y]: [number, number] = at
    arm.add(`${x},${y}`)
    const next: [number, number][] = []
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const nx = x + dx
      const ny = y + dy
      if ((dx || dy) && g[ny]?.[nx] === 'd' && !arm.has(`${nx},${ny}`)) next.push([nx, ny])
    }
    at = next.length === 1 ? next[0] : null
  }
  return arm
}

export function wiggle(g: string[][], shift: number): string[][] {
  if (!shift) return g
  let bell = -1
  g.forEach((r, y) => { if (r.includes('a') || r.includes('k')) bell = y })
  const arm = armCells(g)
  let tips = -1
  g.forEach((r, y) => { if (y > bell && r.some((c, x) => c === 'd' && !arm.has(`${x},${y}`))) tips = y })
  if (tips < 0) return g
  const row = g[tips]
  const cells = row.map((c, x) => (c === 'd' && !arm.has(`${x},${tips}`) ? x : -1)).filter((x) => x >= 0)
  if (cells.length < 2) return g
  const mid = (cells[0] + cells[cells.length - 1]) / 2
  for (const x of cells) row[x] = '.'
  const free = (to: number): boolean => to >= 0 && to < row.length && row[to] === '.' && !arm.has(`${to},${tips}`)
  const put = (...tries: number[]): void => {
    const to = tries.find(free)
    if (to !== undefined) row[to] = 'd'
  }
  if (shift < 0) {
    put(Math.round(mid) - 1)
    put(Math.round(mid) + 1)
    return g
  }
  const odd = cells.includes(mid)
  for (const x of cells) {
    const side = Math.sign(x - mid)
    if (!side) {
      put(x - 1, x)
      put(x + 1)
    } else put(...(odd && (x === cells[0] || x === cells[cells.length - 1]) ? [x + side * 2] : []), x + side, x)
  }
  return g
}

export function build(name: Body, mirror: boolean, face: Face, tipDim: boolean, shift = 0): string[][] {
  let g = FRAMES[name].map((r) => r.split(''))
  if (mirror) g = g.map((r) => r.reverse())
  g = wiggle(g, shift)
  const eyes: [number, number][] = []
  g.forEach((r, y) =>
    r.forEach((c, x) => {
      if (c === 'k') {
        eyes.push([x, y])
        r[x] = 'a'
      }
    })
  )
  eyes.sort((p, q) => p[0] - q[0])
  if (tipDim) g.forEach((r) => r.forEach((c, x) => { if (c === 'h') r[x] = 'd' }))
  if (eyes.length === 2) {
    const [L, R] = eyes
    const hole = (p: [number, number], dx: number, dy: number): void => {
      const x = p[0] + dx
      const y = p[1] + dy
      if (g[y] && g[y][x] === 'a') g[y][x] = 'k'
    }
    const both = (dx: number, dy: number): void => {
      hole(L, dx, dy)
      hole(R, dx, dy)
    }
    switch (face.e) {
      case 'look':
        both(face.dx || 0, face.dy || 0)
        break
      case 'wide':
        both(0, 0)
        both(0, -1)
        break
      case 'closed':
        break
      case 'happy':
        both(0, -1)
        both(-1, 0)
        both(1, 0)
        break
      case 'lines':
        hole(L, -1, 0)
        hole(L, 0, 0)
        hole(R, 0, 0)
        hole(R, 1, 0)
        break
      case 'puzzled':
        hole(L, 0, -1)
        hole(R, 0, 0)
        break
      case 'low':
        both(0, 1)
        break
      default:
        both(0, 0)
    }
  }
  return g
}

export interface Run {
  x: number
  y: number
  w: number
  fill: string
}

export function runs(g: string[][]): Run[] {
  const out: Run[] = []
  for (let y = 0; y < g.length; y++) {
    const r = g[y]
    let x = 0
    while (x < COLS) {
      const fill = PAL[r[x]]
      if (!fill) {
        x++
        continue
      }
      let w = 1
      while (x + w < COLS && r[x + w] === r[x]) w++
      out.push({ x, y, w, fill })
      x += w
    }
  }
  return out
}

export function svgRects(g: string[][]): string {
  return runs(g)
    .map((r) => `<rect x="${r.x}" y="${r.y}" width="${r.w}" height="1" fill="${r.fill}"${r.fill === '#ffffff' ? ' fill-opacity="0.7"' : ''}/>`)
    .join('')
}

export const SHADE_DY = 0.5
export const SHADE_BLUR = 0.3

export interface Cells {
  x0: number
  y0: number
  x1: number
  y1: number
}

export function bellShade(name: Body, mirror: boolean): { rects: string; cells: Cells | null } {
  const rects: string[] = []
  let cells: Cells | null = null
  const rows = FRAMES[name]
  for (let y = 0; y < rows.length; y++) {
    const r = mirror ? rows[y].split('').reverse() : rows[y].split('')
    let x = 0
    while (x < COLS) {
      if (r[x] !== 'a' && r[x] !== 'k') {
        x++
        continue
      }
      let w = 1
      while (x + w < COLS && (r[x + w] === 'a' || r[x + w] === 'k')) w++
      rects.push(`<rect x="${x}" y="${y}" width="${w}" height="1"/>`)
      cells = cells ? { x0: Math.min(cells.x0, x), y0: cells.y0, x1: Math.max(cells.x1, x + w), y1: y + 1 } : { x0: x, y0: y, x1: x + w, y1: y + 1 }
      x += w
    }
  }
  return { rects: rects.join(''), cells }
}

export function shadeSvg(rects: string): string {
  const area = 'x="-2" y="-2" width="16" height="14"'
  return (
    `<defs><filter id="drift-blur" filterUnits="userSpaceOnUse" ${area}><feGaussianBlur stdDeviation="${SHADE_BLUR}"/></filter>` +
    `<mask id="drift-cut" maskUnits="userSpaceOnUse" ${area}><rect ${area} fill="#fff"/><g fill="#000" shape-rendering="crispEdges">${rects}</g></mask></defs>` +
    `<g mask="url(#drift-cut)"><g filter="url(#drift-blur)" transform="translate(0 ${SHADE_DY})">${rects}</g></g>`
  )
}

export function shadeBox(x: number, y: number, cells: Cells, S: number): { x: number; y: number; width: number; height: number } {
  const m = 2 * SHADE_BLUR * S
  return {
    x: x + cells.x0 * S - m,
    y: y + (cells.y0 + SHADE_DY) * S - m,
    width: (cells.x1 - cells.x0) * S + 2 * m,
    height: (cells.y1 - cells.y0) * S + 2 * m
  }
}

export function pixelSize(dpr: number, base = 3): number {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1
  return Math.max(1, Math.round(base * d)) / d
}

export function snap(v: number, dpr: number): number {
  const d = dpr > 0 && Number.isFinite(dpr) ? dpr : 1
  return Math.round(v * d) / d
}
