const ECC_PER_BLOCK = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28]
]
const NUM_BLOCKS = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49]
]
const FORMAT_BITS = [1, 0]

type Ecl = 0 | 1

function bit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0
}

function push(val: number, len: number, bb: number[]): void {
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1)
}

function rawModules(ver: number): number {
  let n = (16 * ver + 128) * ver + 64
  if (ver >= 2) {
    const align = Math.floor(ver / 7) + 2
    n -= (25 * align - 10) * align - 55
    if (ver >= 7) n -= 36
  }
  return n
}

function dataCodewords(ver: number, ecl: Ecl): number {
  return Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ecl][ver] * NUM_BLOCKS[ecl][ver]
}

function gfMul(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number): number[] {
  const out = new Array<number>(degree - 1).fill(0)
  out.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < out.length; j++) {
      out[j] = gfMul(out[j], root)
      if (j + 1 < out.length) out[j] ^= out[j + 1]
    }
    root = gfMul(root, 0x02)
  }
  return out
}

function rsRemainder(data: number[], divisor: number[]): number[] {
  const out = divisor.map(() => 0)
  for (const b of data) {
    const factor = b ^ (out.shift() as number)
    out.push(0)
    divisor.forEach((c, i) => (out[i] ^= gfMul(c, factor)))
  }
  return out
}

class Grid {
  readonly size: number
  readonly dark: boolean[][]
  readonly fixed: boolean[][]

  constructor(readonly ver: number, readonly ecl: Ecl) {
    this.size = ver * 4 + 17
    this.dark = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.fixed = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }

  set(x: number, y: number, dark: boolean): void {
    this.dark[y][x] = dark
    this.fixed[y][x] = true
  }

  alignmentPositions(): number[] {
    if (this.ver === 1) return []
    const n = Math.floor(this.ver / 7) + 2
    const step = this.ver === 32 ? 26 : Math.ceil((this.ver * 4 + 4) / (n * 2 - 2)) * 2
    const out = [6]
    for (let pos = this.size - 7; out.length < n; pos -= step) out.splice(1, 0, pos)
    return out
  }

  drawPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.set(6, i, i % 2 === 0)
      this.set(i, 6, i % 2 === 0)
    }
    for (const [cx, cy] of [
      [3, 3],
      [this.size - 4, 3],
      [3, this.size - 4]
    ]) {
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const d = Math.max(Math.abs(dx), Math.abs(dy))
          const x = cx + dx
          const y = cy + dy
          if (x >= 0 && x < this.size && y >= 0 && y < this.size) this.set(x, y, d !== 2 && d !== 4)
        }
    }
    const pos = this.alignmentPositions()
    const n = pos.length
    for (let i = 0; i < n; i++)
      for (let j = 0; j < n; j++) {
        if ((i === 0 && j === 0) || (i === 0 && j === n - 1) || (i === n - 1 && j === 0)) continue
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++) this.set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
      }
    this.drawFormat(0)
    if (this.ver >= 7) {
      let rem = this.ver
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
      const bits = (this.ver << 12) | rem
      for (let i = 0; i < 18; i++) {
        const a = this.size - 11 + (i % 3)
        const b = Math.floor(i / 3)
        this.set(a, b, bit(bits, i))
        this.set(b, a, bit(bits, i))
      }
    }
  }

  drawFormat(mask: number): void {
    const data = (FORMAT_BITS[this.ecl] << 3) | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = ((data << 10) | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(bits, i))
    this.set(8, 7, bit(bits, 6))
    this.set(8, 8, bit(bits, 7))
    this.set(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) this.set(this.size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) this.set(8, this.size - 15 + i, bit(bits, i))
    this.set(8, this.size - 8, true)
  }

  drawCodewords(data: number[]): void {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vert = 0; vert < this.size; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const y = ((right + 1) & 2) === 0 ? this.size - 1 - vert : vert
          if (!this.fixed[y][x] && i < data.length * 8) {
            this.dark[y][x] = bit(data[i >>> 3], 7 - (i & 7))
            i++
          }
        }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++)
      for (let x = 0; x < this.size; x++) {
        const invert = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        ][mask]
        if (!this.fixed[y][x] && invert) this.dark[y][x] = !this.dark[y][x]
      }
  }

  penalty(): number {
    let result = 0
    const lines = (get: (a: number, b: number) => boolean): void => {
      for (let a = 0; a < this.size; a++) {
        let color = false
        let run = 0
        const history = [0, 0, 0, 0, 0, 0, 0]
        const add = (len: number): void => {
          if (history[0] === 0) len += this.size
          history.pop()
          history.unshift(len)
        }
        const count = (): number => {
          const n = history[1]
          const core = n > 0 && history[2] === n && history[3] === n * 3 && history[4] === n && history[5] === n
          return (core && history[0] >= n * 4 && history[6] >= n ? 1 : 0) + (core && history[6] >= n * 4 && history[0] >= n ? 1 : 0)
        }
        for (let b = 0; b < this.size; b++) {
          if (get(a, b) === color) {
            run++
            if (run === 5) result += 3
            else if (run > 5) result++
          } else {
            add(run)
            if (!color) result += count() * 40
            color = get(a, b)
            run = 1
          }
        }
        if (color) {
          add(run)
          run = 0
        }
        add(run + this.size)
        result += count() * 40
      }
    }
    lines((y, x) => this.dark[y][x])
    lines((x, y) => this.dark[y][x])
    for (let y = 0; y < this.size - 1; y++)
      for (let x = 0; x < this.size - 1; x++) {
        const c = this.dark[y][x]
        if (c === this.dark[y][x + 1] && c === this.dark[y + 1][x] && c === this.dark[y + 1][x + 1]) result += 3
      }
    let dark = 0
    for (const row of this.dark) for (const c of row) if (c) dark++
    const total = this.size * this.size
    result += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10
    return result
  }
}

export function qrMatrix(text: string): boolean[][] {
  const bytes = Array.from(new TextEncoder().encode(text))
  let ecl: Ecl = 0
  let ver = 1
  const bitsFor = (v: number): number => 4 + (v < 10 ? 8 : 16) + bytes.length * 8
  while (bitsFor(ver) > dataCodewords(ver, 0) * 8) {
    ver++
    if (ver > 40) throw new RangeError('Text too long for a QR code')
  }
  if (bitsFor(ver) <= dataCodewords(ver, 1) * 8) ecl = 1
  const capacity = dataCodewords(ver, ecl) * 8
  const bb: number[] = []
  push(0x4, 4, bb)
  push(bytes.length, ver < 10 ? 8 : 16, bb)
  for (const b of bytes) push(b, 8, bb)
  push(0, Math.min(4, capacity - bb.length), bb)
  push(0, (8 - (bb.length % 8)) % 8, bb)
  for (let pad = 0xec; bb.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8, bb)
  const data = new Array<number>(bb.length / 8).fill(0)
  bb.forEach((b, i) => (data[i >>> 3] |= b << (7 - (i & 7))))

  const blocksN = NUM_BLOCKS[ecl][ver]
  const eccLen = ECC_PER_BLOCK[ecl][ver]
  const raw = Math.floor(rawModules(ver) / 8)
  const shortN = blocksN - (raw % blocksN)
  const shortLen = Math.floor(raw / blocksN)
  const divisor = rsDivisor(eccLen)
  const blocks: number[][] = []
  for (let i = 0, k = 0; i < blocksN; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < shortN ? 0 : 1))
    k += dat.length
    const ecc = rsRemainder(dat, divisor)
    if (i < shortN) dat.push(0)
    blocks.push(dat.concat(ecc))
  }
  const all: number[] = []
  for (let i = 0; i < blocks[0].length; i++)
    blocks.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= shortN) all.push(block[i])
    })

  const grid = new Grid(ver, ecl)
  grid.drawPatterns()
  grid.drawCodewords(all)
  let best = 0
  let min = Infinity
  for (let m = 0; m < 8; m++) {
    grid.applyMask(m)
    grid.drawFormat(m)
    const p = grid.penalty()
    if (p < min) {
      min = p
      best = m
    }
    grid.applyMask(m)
  }
  grid.applyMask(best)
  grid.drawFormat(best)
  return grid.dark
}

export function qrSvgPath(matrix: boolean[][], quiet = 2): { path: string; size: number } {
  let path = ''
  matrix.forEach((row, y) =>
    row.forEach((dark, x) => {
      if (dark) path += `M${x + quiet} ${y + quiet}h1v1h-1z`
    })
  )
  return { path, size: matrix.length + quiet * 2 }
}
