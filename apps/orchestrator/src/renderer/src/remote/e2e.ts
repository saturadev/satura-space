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
  hex,
  info,
  isReply,
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
  type E2eMode,
  type E2eReply
} from '@shared/remote-e2e'

export interface PhoneIdentity {
  key: CryptoKey
  pub: string
  phoneId: string
  createdAt: number
}

export interface PhonePairing {
  hostId: string
  phoneId: string
  macPub: string
  hostName: string
  pairedAt: number
}

export interface PhoneHandshake {
  hello: E2eHello
  finish: (reply: unknown) => Promise<{ finish: E2eFinish; session: PhoneE2eSession; macPub: string; hostName: string }>
}

const DB_NAME = 'satura-remote'
const DB_STORE = 'keys'
const IDENTITY = 'identity'
const PAIRING = 'pairing'
const EMPTY = new Uint8Array(0)

let dbOpen: Promise<IDBDatabase> | null = null

export function e2eUnsupported(): string | null {
  if (typeof isSecureContext !== 'undefined' && !isSecureContext) return "This page isn't on a secure (HTTPS) connection, so it can't encrypt the link to your desktop."
  if (!globalThis.crypto?.subtle) return "This browser can't encrypt the link to your desktop (no Web Crypto)."
  if (typeof indexedDB === 'undefined') return "This browser can't keep this phone's key (no IndexedDB). Private browsing can do that."
  return null
}

function subtle(): SubtleCrypto {
  const s = globalThis.crypto?.subtle
  if (!s) throw new E2eError(e2eUnsupported() ?? 'no Web Crypto')
  return s
}

function buf(b: Uint8Array): ArrayBuffer {
  return b.byteOffset === 0 && b.byteLength === b.buffer.byteLength ? (b.buffer as ArrayBuffer) : (b.slice().buffer as ArrayBuffer)
}

function db(): Promise<IDBDatabase> {
  dbOpen ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE)
    }
    req.onsuccess = () => {
      const d = req.result
      d.onversionchange = () => {
        d.close()
        dbOpen = null
      }
      resolve(d)
    }
    req.onerror = () => {
      dbOpen = null
      reject(req.error ?? new Error("IndexedDB didn't open"))
    }
    req.onblocked = () => {
      dbOpen = null
      reject(new Error('IndexedDB is blocked by another tab'))
    }
  })
  return dbOpen
}

async function idb<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest | void): Promise<T | undefined> {
  const d = await db()
  return new Promise<T | undefined>((resolve, reject) => {
    const tx = d.transaction(DB_STORE, mode)
    const req = fn(tx.objectStore(DB_STORE))
    tx.oncomplete = () => resolve(req ? (req.result as T) : undefined)
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB write failed'))
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB write aborted'))
  })
}

async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest('SHA-256', buf(data)))
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, name: string): Promise<Uint8Array> {
  const base = await subtle().importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits'])
  return new Uint8Array(await subtle().deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: buf(info(name)) }, base, 256))
}

async function hmacKey(raw: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', buf(raw), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify'])
}

async function hmac(raw: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().sign('HMAC', await hmacKey(raw), buf(data)))
}

async function hmacOk(raw: Uint8Array, data: Uint8Array, mac: Uint8Array): Promise<boolean> {
  return subtle().verify('HMAC', await hmacKey(raw), buf(mac), buf(data))
}

async function phoneIdOf(pub: Uint8Array): Promise<string> {
  return hex(await sha256(pub)).slice(0, E2E_PHONE_ID_CHARS)
}

export async function macCommitOf(macPub: string): Promise<string> {
  return hex(await sha256(unb64u(macPub, E2E_KEY_BYTES))).slice(0, E2E_COMMIT_CHARS)
}

export async function askPersist(): Promise<boolean | null> {
  try {
    if (!navigator.storage?.persist) return null
    if (await navigator.storage.persisted?.()) return true
    return await navigator.storage.persist()
  } catch {
    return null
  }
}

function identityKey(hostId: string): string {
  return `${IDENTITY}:${hostId}`
}

function pairingKey(hostId: string): string {
  return `${PAIRING}:${hostId}`
}

function validPairing(p: PhonePairing | undefined): p is PhonePairing {
  return !!p && typeof p.hostId === 'string' && typeof p.macPub === 'string' && typeof p.phoneId === 'string'
}

export async function loadIdentity(hostId: string, make: boolean): Promise<PhoneIdentity | null> {
  const known = await idb<PhoneIdentity>('readonly', (s) => s.get(identityKey(hostId)))
  if (known?.key && typeof known.pub === 'string') return known
  if (!make) return null
  const pair = await subtle().generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify'])
  if (pair.privateKey.extractable) throw new E2eError('the browser made an extractable key')
  const pubRaw = new Uint8Array(await subtle().exportKey('raw', pair.publicKey))
  const identity: PhoneIdentity = { key: pair.privateKey, pub: b64u(pubRaw), phoneId: await phoneIdOf(pubRaw), createdAt: Date.now() }
  await idb('readwrite', (s) => s.put(identity, identityKey(hostId)))
  const stored = await idb<PhoneIdentity>('readonly', (s) => s.get(identityKey(hostId)))
  if (!stored?.key) throw new E2eError("the browser didn't keep this phone's key")
  return stored
}

export async function loadPairing(hostId: string): Promise<PhonePairing | null> {
  const p = await idb<PhonePairing>('readonly', (s) => s.get(pairingKey(hostId)))
  return validPairing(p) && p.hostId === hostId ? p : null
}

export async function listPairings(): Promise<PhonePairing[]> {
  const all = await idb<PhonePairing[]>('readonly', (s) => s.getAll(IDBKeyRange.bound(`${PAIRING}:`, `${PAIRING}:\uffff`)))
  return (all ?? []).filter(validPairing)
}

export async function savePairing(p: PhonePairing): Promise<void> {
  await idb('readwrite', (s) => s.put(p, pairingKey(p.hostId)))
}

export async function forgetPairing(hostId: string, alsoIdentity: boolean): Promise<void> {
  await idb('readwrite', (s) => {
    s.delete(pairingKey(hostId))
    if (alsoIdentity) s.delete(identityKey(hostId))
  })
}

export async function startPhoneHandshake(opts: { mode: E2eMode; hostId: string; identity: PhoneIdentity; secret?: string; commit?: string | null; pinned?: string }): Promise<PhoneHandshake> {
  const s = subtle()
  const { mode, hostId, identity } = opts
  if (mode === 'pair' && !opts.secret) throw new E2eError('pairing needs the code')
  if (mode === 'resume' && !opts.pinned) throw new E2eError("resuming needs the desktop's pinned key")
  const eph = await s.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, false, ['deriveBits'])
  const phoneEph = new Uint8Array(await s.exportKey('raw', eph.publicKey))
  const phoneNonce = crypto.getRandomValues(new Uint8Array(E2E_NONCE_BYTES))
  const phonePub = unb64u(identity.pub, E2E_KEY_BYTES)
  const pairKey = mode === 'pair' ? await hkdf(utf8(opts.secret as string), utf8(hostId), 'pair') : null
  const hello: E2eHello = {
    v: 1,
    mode,
    phoneId: identity.phoneId,
    eph: b64u(phoneEph),
    nonce: b64u(phoneNonce),
    ...(pairKey ? { pub: identity.pub, proof: b64u(await hmac(pairKey, pairProofInput(hostId, phonePub, phoneEph, phoneNonce))) } : {})
  }
  const finish = async (raw: unknown): Promise<{ finish: E2eFinish; session: PhoneE2eSession; macPub: string; hostName: string }> => {
    if (!isReply(raw)) throw new E2eError("the desktop's answer is malformed")
    const r = raw as E2eReply
    const macPub = unb64u(r.pub, E2E_KEY_BYTES)
    if (opts.pinned && r.pub !== opts.pinned) throw new E2eError("the desktop's key is not the one this phone paired with")
    if (opts.commit && (await macCommitOf(r.pub)) !== opts.commit) throw new E2eError("the desktop's key does not match the QR code")
    const macEph = unb64u(r.eph, E2E_KEY_BYTES)
    const macNonce = unb64u(r.nonce, E2E_NONCE_BYTES)
    const hostName = String(r.name).slice(0, 120)
    const th = await sha256(transcriptInput({ hostId, mode, phoneId: identity.phoneId, phonePub, macPub, phoneEph, phoneNonce, macEph, macNonce, hostName }))
    if (pairKey) {
      if (typeof r.proof !== 'string' || !(await hmacOk(pairKey, signedInput('pair-mac', th), unb64u(r.proof, 32)))) throw new E2eError("the desktop didn't prove it knows the pairing code")
    }
    const macKey = await s.importKey('raw', buf(macPub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify'])
    const okSig = await s.verify({ name: 'ECDSA', hash: 'SHA-256' }, macKey, buf(unb64u(r.sig, E2E_SIG_BYTES)), buf(signedInput('mac', th)))
    if (!okSig) throw new E2eError("the desktop's signature doesn't check out")
    const peer = await s.importKey('raw', buf(macEph), { name: 'ECDH', namedCurve: 'P-256' }, false, [])
    const shared = new Uint8Array(await s.deriveBits({ name: 'ECDH', public: peer }, eph.privateKey, 256))
    if (!(await hmacOk(await hkdf(shared, th, 'fin mac'), signedInput('mac', th), unb64u(r.fin, 32)))) throw new E2eError("the desktop's finished check failed")
    const sig = new Uint8Array(await s.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.key, buf(signedInput('phone', th))))
    const fin = await hmac(await hkdf(shared, th, 'fin phone'), signedInput('phone', th))
    const session = await PhoneE2eSession.create(await hkdf(shared, th, 'p2m'), await hkdf(shared, th, 'm2p'), await hkdf(shared, th, 'video'))
    shared.fill(0)
    return { finish: { v: 1, sig: b64u(sig), fin: b64u(fin) }, session, macPub: r.pub, hostName }
  }
  return { hello, finish }
}

class Direction {
  private secret: Uint8Array
  key: CryptoKey
  n = 0
  frames = 0
  bytes = 0
  at = Date.now()
  epochs = 0

  private constructor(
    readonly dir: E2eDir,
    secret: Uint8Array,
    key: CryptoKey
  ) {
    this.secret = secret
    this.key = key
  }

  static async create(dir: E2eDir, secret: Uint8Array): Promise<Direction> {
    return new Direction(dir, secret, await aesKey(secret))
  }

  async ratchet(): Promise<void> {
    const next = await hkdf(this.secret, EMPTY, 'next')
    this.secret.fill(0)
    this.secret = next
    this.key = await aesKey(next)
    this.frames = 0
    this.bytes = 0
    this.at = Date.now()
    this.epochs++
  }

  wipe(): void {
    this.secret.fill(0)
  }
}

async function aesKey(secret: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey('raw', buf(await hkdf(secret, EMPTY, 'key')), 'AES-GCM', false, ['encrypt', 'decrypt'])
}

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export class PhoneE2eSession {
  private sendChain: Promise<unknown> = Promise.resolve()
  private openChain: Promise<unknown> = Promise.resolve()
  readonly startedAt = Date.now()
  closed = false
  sealMs = 0
  openMs = 0

  private constructor(
    private out: Direction,
    private inbound: Direction,
    readonly video: Uint8Array
  ) {}

  static async create(p2m: Uint8Array, m2p: Uint8Array, video: Uint8Array): Promise<PhoneE2eSession> {
    return new PhoneE2eSession(await Direction.create('p2m', p2m), await Direction.create('m2p', m2p), video)
  }

  seal(text: string): Promise<Uint8Array> {
    const next = this.sendChain.then(() => this.sealNow(text))
    this.sendChain = next.catch(() => {})
    return next
  }

  open(bytes: Uint8Array): Promise<string> {
    const next = this.openChain.then(() => this.openNow(bytes))
    this.openChain = next.catch(() => {})
    return next
  }

  private async sealNow(text: string): Promise<Uint8Array> {
    if (this.closed) throw new E2eError('the session is closed')
    const t0 = performance.now()
    const d = this.out
    let flags = 0
    if (d.frames >= E2E_EPOCH_FRAMES || d.bytes >= E2E_EPOCH_BYTES || Date.now() - d.at >= E2E_EPOCH_MS) {
      await d.ratchet()
      flags |= E2E_FLAG_NEXT
    }
    const n = d.n++
    const plain = encoder.encode(text)
    const sealed = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv: buf(nonceFor(n)), additionalData: buf(aadFor(d.dir, n, flags)), tagLength: 128 }, d.key, buf(plain)))
    d.frames++
    d.bytes += plain.length
    this.sealMs = performance.now() - t0
    return packFrame(flags, n, sealed)
  }

  private async openNow(bytes: Uint8Array): Promise<string> {
    if (this.closed) throw new E2eError('the session is closed')
    const t0 = performance.now()
    const d = this.inbound
    const f = readFrame(bytes, false)
    if (f.n !== d.n) throw new E2eError(f.n < d.n ? `frame ${f.n} was already seen (replayed), expected ${d.n}` : `frame ${f.n} came before ${d.n} (dropped or reordered)`)
    if (f.flags & ~E2E_FLAG_NEXT) throw new E2eError(`unknown frame flags ${f.flags}`)
    if (f.flags & E2E_FLAG_NEXT) await d.ratchet()
    else if (d.frames >= E2E_EPOCH_HARD_FRAMES) throw new E2eError('the desktop did not rotate its key in time')
    let plain: Uint8Array
    try {
      plain = new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv: buf(nonceFor(f.n)), additionalData: buf(aadFor(d.dir, f.n, f.flags)), tagLength: 128 }, d.key, buf(f.sealed)))
    } catch {
      throw new E2eError(`frame ${f.n} failed authentication (altered, injected or under the wrong key)`)
    }
    d.n++
    d.frames++
    d.bytes += plain.length
    this.openMs = performance.now() - t0
    return decoder.decode(plain)
  }

  stats(): { sent: number; received: number; epochsOut: number; epochsIn: number; ageMs: number; sealMs: number; openMs: number } {
    return { sent: this.out.n, received: this.inbound.n, epochsOut: this.out.epochs, epochsIn: this.inbound.epochs, ageMs: Date.now() - this.startedAt, sealMs: Math.round(this.sealMs * 1000) / 1000, openMs: Math.round(this.openMs * 1000) / 1000 }
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.out.wipe()
    this.inbound.wipe()
    this.video.fill(0)
  }
}
