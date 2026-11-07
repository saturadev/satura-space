import { info } from './remote-e2e'

const SLICE_CLEAR = 4
const COUNTER = 8
const CAPTURE = 8
const TAG = 16
const TAIL = 0xe5

function own(b: Uint8Array): ArrayBuffer {
  return b.slice().buffer as ArrayBuffer
}

export function videoFrameKey(secret: Uint8Array, salt: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', own(secret), 'HKDF', false, ['deriveKey']).then((base) =>
    crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: own(salt), info: own(info('video frames')) }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
  )
}

function clearEnd(data: Uint8Array): number {
  for (let i = 2; i + 1 < data.length; i++) {
    if (data[i] !== 1 || data[i - 1] !== 0 || data[i - 2] !== 0) continue
    const type = data[i + 1] & 0x1f
    if (type === 1 || type === 5) return i + 2 + SLICE_CLEAR < data.length ? i + 2 + SLICE_CLEAR : -1
  }
  return -1
}

function zerosBefore(data: Uint8Array, end: number): number {
  return data[end - 1] !== 0 ? 0 : data[end - 2] !== 0 ? 1 : 2
}

function escape(src: Uint8Array, zeros: number): Uint8Array {
  const out = new Uint8Array(src.length + (src.length >> 1) + 2)
  let o = 0
  let z = zeros
  for (const b of src) {
    if (z >= 2 && b <= 3) {
      out[o++] = 3
      z = 0
    }
    out[o++] = b
    z = b === 0 ? z + 1 : 0
  }
  return out.subarray(0, o)
}

function unescape(src: Uint8Array, zeros: number): Uint8Array {
  const out = new Uint8Array(src.length)
  let o = 0
  let z = zeros
  for (const b of src) {
    if (z >= 2 && b === 3) {
      z = 0
      continue
    }
    out[o++] = b
    z = b === 0 ? z + 1 : 0
  }
  return out.subarray(0, o)
}

function ivOf(counter: Uint8Array): ArrayBuffer {
  const iv = new Uint8Array(12)
  iv.set(counter, 12 - COUNTER)
  return iv.buffer
}

export async function sealFrame(key: CryptoKey, n: number, data: Uint8Array, captureMs: number): Promise<Uint8Array | null> {
  const end = clearEnd(data)
  if (end < 0) return null
  const plain = new Uint8Array(data.length - end + CAPTURE)
  plain.set(data.subarray(end))
  new DataView(plain.buffer).setFloat64(plain.length - CAPTURE, captureMs)
  const counter = new Uint8Array(COUNTER)
  new DataView(counter.buffer).setBigUint64(0, BigInt(n))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: ivOf(counter), additionalData: own(data.subarray(end - 1 - SLICE_CLEAR, end)) }, key, plain.buffer))
  const body = new Uint8Array(COUNTER + sealed.length + 1)
  body.set(counter)
  body.set(sealed, COUNTER)
  body[body.length - 1] = TAIL
  const esc = escape(body, zerosBefore(data, end))
  const out = new Uint8Array(end + esc.length)
  out.set(data.subarray(0, end))
  out.set(esc, end)
  return out
}

export async function openFrame(key: CryptoKey, data: Uint8Array): Promise<{ data: Uint8Array; captureMs: number } | null> {
  const end = clearEnd(data)
  if (end < 0) return null
  const body = unescape(data.subarray(end), zerosBefore(data, end))
  if (body.length < COUNTER + TAG + CAPTURE + 1 || body[body.length - 1] !== TAIL) return null
  let plain: Uint8Array
  try {
    plain = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: ivOf(body.subarray(0, COUNTER)), additionalData: own(data.subarray(end - 1 - SLICE_CLEAR, end)) }, key, own(body.subarray(COUNTER, body.length - 1))))
  } catch {
    return null
  }
  const out = new Uint8Array(end + plain.length - CAPTURE)
  out.set(data.subarray(0, end))
  out.set(plain.subarray(0, plain.length - CAPTURE), end)
  return { data: out, captureMs: new DataView(plain.buffer).getFloat64(plain.length - CAPTURE) }
}
