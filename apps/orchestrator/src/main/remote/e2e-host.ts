import { createCipheriv, createDecipheriv, createECDH, createHash, createHmac, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, timingSafeEqual, verify, type KeyObject } from 'node:crypto'
import {
  E2E_COMMIT_CHARS,
  E2E_EPOCH_BYTES,
  E2E_EPOCH_FRAMES,
  E2E_EPOCH_HARD_FRAMES,
  E2E_EPOCH_MS,
  E2E_FLAG_NEXT,
  E2E_KEY_BYTES,
  E2E_NONCE_BYTES,
  E2E_PHONE_ID_CHARS,
  E2E_SIG_BYTES,
  E2eError,
  aadFor,
  b64u,
  info,
  isFinish,
  nonceFor,
  packFrame,
  pairProofInput,
  readFrame,
  signedInput,
  transcriptInput,
  unb64u,
  utf8,
  type E2eDir,
  type E2eFinish,
  type E2eHello,
  type E2eReply
} from '@shared/remote-e2e'

export interface MacE2eKey {
  x: string
  y: string
  d: string
}

export interface HostHandshake {
  phoneId: string
  phonePub: string
  reply: E2eReply
  finish: (raw: unknown) => HostE2eSession
}

const EMPTY = Buffer.alloc(0)

function sha256(data: Uint8Array): Buffer {
  return createHash('sha256').update(data).digest()
}

function hkdf(ikm: Uint8Array, salt: Uint8Array, name: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info(name), 32))
}

function hmac(key: Uint8Array, data: Uint8Array): Buffer {
  return createHmac('sha256', key).update(data).digest()
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && timingSafeEqual(a, b)
}

function rawOf(x: string, y: string): Uint8Array {
  return Buffer.concat([Buffer.from([4]), Buffer.from(x, 'base64url'), Buffer.from(y, 'base64url')])
}

function publicFromRaw(raw: Uint8Array): KeyObject {
  if (raw.length !== E2E_KEY_BYTES || raw[0] !== 4) throw new E2eError('not an uncompressed P-256 key')
  const b = Buffer.from(raw)
  return createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b.subarray(1, 33).toString('base64url'), y: b.subarray(33).toString('base64url') }, format: 'jwk' })
}

export function newMacKey(): MacE2eKey {
  const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })
  return { x: String(jwk.x), y: String(jwk.y), d: String(jwk.d) }
}

export function isMacKey(k: unknown): k is MacE2eKey {
  const key = k as Partial<MacE2eKey> | null
  return typeof key?.x === 'string' && typeof key.y === 'string' && typeof key.d === 'string' && key.x.length === 43 && key.y.length === 43 && key.d.length === 43
}

export function macPublic(key: MacE2eKey): string {
  return b64u(rawOf(key.x, key.y))
}

export function macCommit(key: MacE2eKey): string {
  return sha256(rawOf(key.x, key.y)).toString('hex').slice(0, E2E_COMMIT_CHARS)
}

export function phoneIdOf(pub: Uint8Array): string {
  return sha256(pub).toString('hex').slice(0, E2E_PHONE_ID_CHARS)
}

export function pairKey(hostId: string, secret: string): Buffer {
  return hkdf(utf8(secret), utf8(hostId), 'pair')
}

export function checkPairProof(hello: E2eHello, hostId: string, secret: string): boolean {
  if (hello.mode !== 'pair' || typeof hello.proof !== 'string' || typeof hello.pub !== 'string') return false
  try {
    const pub = unb64u(hello.pub, E2E_KEY_BYTES)
    const want = hmac(pairKey(hostId, secret), pairProofInput(hostId, pub, unb64u(hello.eph, E2E_KEY_BYTES), unb64u(hello.nonce, E2E_NONCE_BYTES)))
    return sameBytes(want, unb64u(hello.proof, 32))
  } catch {
    return false
  }
}

export function startHostHandshake(opts: { hello: E2eHello; hostId: string; hostName: string; mac: MacE2eKey; phonePub: string; secret?: string }): HostHandshake {
  const { hello, hostId, hostName, mac } = opts
  const phonePub = unb64u(opts.phonePub, E2E_KEY_BYTES)
  const phoneId = phoneIdOf(phonePub)
  if (hello.phoneId !== phoneId) throw new E2eError('the phone id does not match its key')
  const phoneKey = publicFromRaw(phonePub)
  const phoneEph = unb64u(hello.eph, E2E_KEY_BYTES)
  const phoneNonce = unb64u(hello.nonce, E2E_NONCE_BYTES)
  const ecdh = createECDH('prime256v1')
  const macEph = ecdh.generateKeys()
  let shared: Buffer
  try {
    shared = ecdh.computeSecret(Buffer.from(phoneEph))
  } catch {
    throw new E2eError('the phone sent an invalid ephemeral key')
  }
  const macNonce = randomBytes(E2E_NONCE_BYTES)
  const macPub = rawOf(mac.x, mac.y)
  const th = sha256(transcriptInput({ hostId, mode: hello.mode, phoneId, phonePub, macPub, phoneEph, phoneNonce, macEph, macNonce, hostName }))
  const macSigning = createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: mac.x, y: mac.y, d: mac.d }, format: 'jwk' })
  const sig = sign('sha256', signedInput('mac', th), { key: macSigning, dsaEncoding: 'ieee-p1363' })
  const finMac = hkdf(shared, th, 'fin mac')
  const finPhone = hkdf(shared, th, 'fin phone')
  const reply: E2eReply = {
    v: 1,
    pub: b64u(macPub),
    eph: b64u(macEph),
    nonce: b64u(macNonce),
    name: hostName,
    sig: b64u(sig),
    fin: b64u(hmac(finMac, signedInput('mac', th))),
    ...(opts.secret !== undefined ? { proof: b64u(hmac(pairKey(hostId, opts.secret), signedInput('pair-mac', th))) } : {})
  }
  const finish = (raw: unknown): HostE2eSession => {
    if (!isFinish(raw)) throw new E2eError('the phone did not finish the handshake')
    const f = raw as E2eFinish
    const okSig = verify('sha256', signedInput('phone', th), { key: phoneKey, dsaEncoding: 'ieee-p1363' }, unb64u(f.sig, E2E_SIG_BYTES))
    if (!okSig) throw new E2eError("the phone's signature does not match its pinned key")
    if (!sameBytes(hmac(finPhone, signedInput('phone', th)), unb64u(f.fin, 32))) throw new E2eError("the phone's finished check failed")
    return new HostE2eSession(hkdf(shared, th, 'm2p'), hkdf(shared, th, 'p2m'), hkdf(shared, th, 'video'))
  }
  return { phoneId, phonePub: b64u(phonePub), reply, finish }
}

class Direction {
  private secret: Buffer
  private key: Buffer
  n = 0
  frames = 0
  bytes = 0
  at = Date.now()
  epochs = 0

  constructor(
    readonly dir: E2eDir,
    secret: Buffer
  ) {
    this.secret = secret
    this.key = hkdf(secret, EMPTY, 'key')
  }

  ratchet(): void {
    const next = hkdf(this.secret, EMPTY, 'next')
    this.secret.fill(0)
    this.key.fill(0)
    this.secret = next
    this.key = hkdf(next, EMPTY, 'key')
    this.frames = 0
    this.bytes = 0
    this.at = Date.now()
    this.epochs++
  }

  get aesKey(): Buffer {
    return this.key
  }

  wipe(): void {
    this.secret.fill(0)
    this.key.fill(0)
  }
}

export class HostE2eSession {
  private out: Direction
  private in: Direction
  readonly startedAt = Date.now()
  closed = false

  constructor(m2p: Buffer, p2m: Buffer, readonly video: Buffer) {
    this.out = new Direction('m2p', m2p)
    this.in = new Direction('p2m', p2m)
  }

  seal(text: string, cid: string): Uint8Array {
    if (this.closed) throw new E2eError('the session is closed')
    const d = this.out
    let flags = 0
    if (d.frames >= E2E_EPOCH_FRAMES || d.bytes >= E2E_EPOCH_BYTES || Date.now() - d.at >= E2E_EPOCH_MS) {
      d.ratchet()
      flags |= E2E_FLAG_NEXT
    }
    const n = d.n++
    const plain = Buffer.from(text, 'utf8')
    const c = createCipheriv('aes-256-gcm', d.aesKey, Buffer.from(nonceFor(n)))
    c.setAAD(aadFor(d.dir, n, flags))
    const sealed = Buffer.concat([c.update(plain), c.final(), c.getAuthTag()])
    d.frames++
    d.bytes += plain.length
    return packFrame(flags, n, sealed, cid)
  }

  open(bytes: Uint8Array): string {
    if (this.closed) throw new E2eError('the session is closed')
    const d = this.in
    const f = readFrame(bytes, true)
    if (f.n !== d.n) throw new E2eError(f.n < d.n ? `frame ${f.n} was already seen (replayed), expected ${d.n}` : `frame ${f.n} came before ${d.n} (dropped or reordered)`)
    if (f.flags & ~E2E_FLAG_NEXT) throw new E2eError(`unknown frame flags ${f.flags}`)
    if (f.flags & E2E_FLAG_NEXT) d.ratchet()
    else if (d.frames >= E2E_EPOCH_HARD_FRAMES) throw new E2eError('the phone did not rotate its key in time')
    const body = Buffer.from(f.sealed)
    const tag = body.subarray(body.length - 16)
    const c = createDecipheriv('aes-256-gcm', d.aesKey, Buffer.from(nonceFor(f.n)))
    c.setAAD(aadFor(d.dir, f.n, f.flags))
    c.setAuthTag(tag)
    let plain: Buffer
    try {
      plain = Buffer.concat([c.update(body.subarray(0, body.length - 16)), c.final()])
    } catch {
      throw new E2eError(`frame ${f.n} failed authentication (altered, injected or under the wrong key)`)
    }
    d.n++
    d.frames++
    d.bytes += plain.length
    return plain.toString('utf8')
  }

  stats(): { sent: number; received: number; epochsOut: number; epochsIn: number; ageMs: number } {
    return { sent: this.out.n, received: this.in.n, epochsOut: this.out.epochs, epochsIn: this.in.epochs, ageMs: Date.now() - this.startedAt }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.out.wipe()
    this.in.wipe()
    this.video.fill(0)
  }
}
