import { createCipheriv, createECDH, createHash, hkdfSync, randomBytes } from 'node:crypto'
import { PUSH_INNER_AAD, PUSH_INNER_VERSION, type PushNote } from '@shared/remote-push'

const RECORD_SIZE = 4096
const HEADER_BYTES = 86
const TAG_BYTES = 16
const PAD_TO = 256
const MAX_PLAIN = RECORD_SIZE - HEADER_BYTES - TAG_BYTES - 1

export interface PushSubscriptionKeys {
  p256dh: string
  auth: string
}

function unb64u(text: string, bytes?: number): Buffer {
  if (typeof text !== 'string' || !/^[A-Za-z0-9_-]+$/.test(text)) throw new Error('not base64url')
  const out = Buffer.from(text, 'base64url')
  if (bytes !== undefined && out.length !== bytes) throw new Error(`expected ${bytes} bytes, got ${out.length}`)
  return out
}

export function checkSubscriptionKeys(keys: PushSubscriptionKeys): string | null {
  try {
    const pub = unb64u(keys.p256dh, 65)
    if (pub[0] !== 4) return 'p256dh is not an uncompressed P-256 point'
    const probe = createECDH('prime256v1')
    probe.generateKeys()
    probe.computeSecret(pub)
    unb64u(keys.auth, 16)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export function checkPushKey(key: string): string | null {
  try {
    unb64u(key, 32)
    return null
  } catch (e) {
    return (e as Error).message
  }
}

export function encryptWebPush(keys: PushSubscriptionKeys, plaintext: Buffer): Buffer {
  if (plaintext.length > MAX_PLAIN) throw new Error(`a push holds at most ${MAX_PLAIN} bytes, this one is ${plaintext.length}`)
  const uaPublic = unb64u(keys.p256dh, 65)
  const authSecret = unb64u(keys.auth, 16)
  const ecdh = createECDH('prime256v1')
  const asPublic = ecdh.generateKeys()
  const shared = ecdh.computeSecret(uaPublic)
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic])
  const ikm = Buffer.from(hkdfSync('sha256', shared, authSecret, keyInfo, 32))
  const salt = randomBytes(16)
  const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16))
  const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12))
  const padded = Math.min(MAX_PLAIN + 1, Math.ceil((plaintext.length + 1) / PAD_TO) * PAD_TO)
  const record = Buffer.alloc(padded)
  plaintext.copy(record)
  record[plaintext.length] = 2
  const cipher = createCipheriv('aes-128-gcm', cek, nonce)
  const sealed = Buffer.concat([cipher.update(record), cipher.final(), cipher.getAuthTag()])
  const header = Buffer.alloc(HEADER_BYTES)
  salt.copy(header, 0)
  header.writeUInt32BE(RECORD_SIZE, 16)
  header[20] = 65
  asPublic.copy(header, 21)
  shared.fill(0)
  ikm.fill(0)
  cek.fill(0)
  return Buffer.concat([header, sealed])
}

export function sealPushNote(key: string, note: PushNote): Buffer {
  const k = unb64u(key, 32)
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', k, iv)
  cipher.setAAD(Buffer.from(PUSH_INNER_AAD))
  const sealed = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(note))), cipher.final(), cipher.getAuthTag()])
  return Buffer.from(JSON.stringify({ v: PUSH_INNER_VERSION, n: iv.toString('base64url'), c: sealed.toString('base64url') }))
}

export function pushTopic(key: string, tag: string): string {
  return createHash('sha256').update(`satura-push-topic\0${key}\0${tag}`).digest('base64url').slice(0, 32)
}

export const PUSH_MAX_PLAIN = MAX_PLAIN
