import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto'

const KEY = /^[A-Za-z0-9_-]{43}$/
const SIG = /^[A-Za-z0-9_-]{86}$/

export const HOST_ID_LENGTH = 16

export function hostIdForKey(key) {
  if (typeof key !== 'string' || !KEY.test(key)) return null
  return createHash('sha256').update(Buffer.from(key, 'base64url')).digest('hex').slice(0, HOST_ID_LENGTH)
}

export function hostChallenge() {
  return randomBytes(32).toString('base64url')
}

export function hostProofMessage(nonce, hostId) {
  return `satura-relay-host:${nonce}:${hostId}`
}

export function verifyHostProof({ key, hostId, nonce, sig }) {
  if (hostIdForKey(key) !== hostId || typeof sig !== 'string' || !SIG.test(sig)) return false
  try {
    const pub = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: key }, format: 'jwk' })
    return verify(null, Buffer.from(hostProofMessage(nonce, hostId)), pub, Buffer.from(sig, 'base64url'))
  } catch {
    return false
  }
}
