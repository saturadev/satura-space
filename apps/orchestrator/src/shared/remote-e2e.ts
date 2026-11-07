export const E2E_LABEL = 'satura-remote-e2e/1'
export const E2E_FRAME = 0x45
export const E2E_CID_CHARS = 8
export const E2E_HEAD_BYTES = 10
export const E2E_FLAG_NEXT = 1
export const E2E_EPOCH_FRAMES = 1 << 16
export const E2E_EPOCH_HARD_FRAMES = 1 << 17
export const E2E_EPOCH_BYTES = 256 * 1024 * 1024
export const E2E_EPOCH_MS = 20 * 60_000
export const E2E_SESSION_SOFT_MS = 12 * 3600_000
export const E2E_SESSION_HARD_MS = 24 * 3600_000
export const E2E_PHONE_ID_CHARS = 24
export const E2E_COMMIT_CHARS = 32
export const E2E_KEY_BYTES = 65
export const E2E_SIG_BYTES = 64
export const E2E_NONCE_BYTES = 32

export type E2eMode = 'pair' | 'resume'
export type E2eDir = 'p2m' | 'm2p'

export interface E2eHello {
  v: 1
  mode: E2eMode
  phoneId: string
  pub?: string
  eph: string
  nonce: string
  proof?: string
}

export interface E2eReply {
  v: 1
  pub: string
  eph: string
  nonce: string
  name: string
  sig: string
  fin: string
  proof?: string
}

export interface E2eFinish {
  v: 1
  sig: string
  fin: string
}

export interface E2eTranscript {
  hostId: string
  mode: E2eMode
  phoneId: string
  phonePub: Uint8Array
  macPub: Uint8Array
  phoneEph: Uint8Array
  phoneNonce: Uint8Array
  macEph: Uint8Array
  macNonce: Uint8Array
  hostName: string
}

export interface E2ePairCode {
  hostId: string
  secret: string
  commit: string | null
}

export class E2eError extends Error {}

const enc = new TextEncoder()
const dec = new TextDecoder()

export function utf8(text: string): Uint8Array {
  return enc.encode(text)
}

export function fromUtf8(bytes: Uint8Array): string {
  return dec.decode(bytes)
}

export function b64u(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function unb64u(text: unknown, bytes?: number): Uint8Array {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]*$/.test(text) || text.length > 4096) throw new E2eError('not base64url')
  const s = atob(text.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((text.length + 3) % 4))
  const out = new Uint8Array(s.length)
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i)
  if (bytes !== undefined && out.length !== bytes) throw new E2eError(`expected ${bytes} bytes, got ${out.length}`)
  return out
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

export function lp(...parts: (Uint8Array | string)[]): Uint8Array {
  const chunks = parts.map((p) => (typeof p === 'string' ? utf8(p) : p))
  const out = new Uint8Array(chunks.reduce((n, c) => n + 4 + c.length, 0))
  const view = new DataView(out.buffer)
  let at = 0
  for (const c of chunks) {
    view.setUint32(at, c.length)
    out.set(c, at + 4)
    at += 4 + c.length
  }
  return out
}

export function info(name: string): Uint8Array {
  return utf8(`${E2E_LABEL} ${name}`)
}

export function transcriptInput(t: E2eTranscript): Uint8Array {
  return lp(E2E_LABEL, 'transcript', t.hostId, t.mode, t.phoneId, t.phonePub, t.macPub, t.phoneEph, t.phoneNonce, t.macEph, t.macNonce, t.hostName)
}

export function pairProofInput(hostId: string, phonePub: Uint8Array, phoneEph: Uint8Array, phoneNonce: Uint8Array): Uint8Array {
  return lp(E2E_LABEL, 'pair-phone', hostId, phonePub, phoneEph, phoneNonce)
}

export function signedInput(role: 'mac' | 'phone' | 'pair-mac', th: Uint8Array): Uint8Array {
  return lp(E2E_LABEL, role, th)
}

export function nonceFor(n: number): Uint8Array {
  const out = new Uint8Array(12)
  const view = new DataView(out.buffer)
  view.setUint32(4, Math.floor(n / 0x100000000))
  view.setUint32(8, n >>> 0)
  return out
}

export function aadFor(dir: E2eDir, n: number, flags: number): Uint8Array {
  return utf8(`${E2E_LABEL}|${dir}|${n}|${flags}`)
}

export function packFrame(flags: number, n: number, sealed: Uint8Array, cid?: string): Uint8Array {
  const pre = cid ? E2E_CID_CHARS : 0
  const out = new Uint8Array(E2E_HEAD_BYTES + pre + sealed.length)
  const view = new DataView(out.buffer)
  out[0] = E2E_FRAME
  if (cid) out.set(utf8(cid.slice(0, E2E_CID_CHARS).padEnd(E2E_CID_CHARS, '0')), 1)
  out[1 + pre] = flags
  view.setUint32(2 + pre, Math.floor(n / 0x100000000))
  view.setUint32(6 + pre, n >>> 0)
  out.set(sealed, E2E_HEAD_BYTES + pre)
  return out
}

export function readFrame(bytes: Uint8Array, withCid: boolean): { cid: string; flags: number; n: number; sealed: Uint8Array } {
  const pre = withCid ? E2E_CID_CHARS : 0
  if (bytes.length < E2E_HEAD_BYTES + pre + 16 || bytes[0] !== E2E_FRAME) throw new E2eError('not an encrypted frame')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const cid = withCid ? fromUtf8(bytes.subarray(1, 1 + pre)) : ''
  const flags = bytes[1 + pre]
  const n = view.getUint32(2 + pre) * 0x100000000 + view.getUint32(6 + pre)
  return { cid, flags, n, sealed: bytes.subarray(E2E_HEAD_BYTES + pre) }
}

export function parsePairCode(raw: string): E2ePairCode | null {
  const parts = String(raw ?? '').replace(/\s+/g, '').toLowerCase().split(':')
  if (parts.length < 2 || parts.length > 3) return null
  const [hostId, secret, commit] = parts
  if (!/^[a-z0-9]{6,32}$/.test(hostId) || !/^[0-9a-f]{16,64}$/.test(secret)) return null
  if (commit !== undefined && !new RegExp(`^[0-9a-f]{${E2E_COMMIT_CHARS}}$`).test(commit)) return null
  return { hostId, secret, commit: commit ?? null }
}

export function isHello(v: unknown): v is E2eHello {
  const h = v as Partial<E2eHello> | null
  return !!h && h.v === 1 && (h.mode === 'pair' || h.mode === 'resume') && typeof h.phoneId === 'string' && typeof h.eph === 'string' && typeof h.nonce === 'string'
}

export function isReply(v: unknown): v is E2eReply {
  const r = v as Partial<E2eReply> | null
  return !!r && r.v === 1 && typeof r.pub === 'string' && typeof r.eph === 'string' && typeof r.nonce === 'string' && typeof r.name === 'string' && typeof r.sig === 'string' && typeof r.fin === 'string'
}

export function isFinish(v: unknown): v is E2eFinish {
  const f = v as Partial<E2eFinish> | null
  return !!f && f.v === 1 && typeof f.sig === 'string' && typeof f.fin === 'string'
}
