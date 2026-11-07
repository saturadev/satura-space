import { execFileSync } from 'node:child_process'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'

const IV_BYTES = 12
const TAG_BYTES = 16

let key: Buffer | null = null

function machineId(): string {
  if (process.platform === 'darwin') {
    const out = execFileSync('ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8', timeout: 5000 })
    return /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1] ?? ''
  }
  if (process.platform === 'win32') {
    const out = execFileSync('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid'], { encoding: 'utf8', timeout: 5000 })
    return /MachineGuid\s+REG_SZ\s+(\S+)/.exec(out)?.[1] ?? ''
  }
  return readFileSync('/etc/machine-id', 'utf8').trim()
}

function sealKey(): Buffer {
  if (key) return key
  const id = machineId()
  if (!id) throw new Error("this computer's hardware id is not readable")
  key = Buffer.from(hkdfSync('sha256', `${id}\0${homedir()}`, 'satura-remote-host-file', 'v1', 32))
  return key
}

export function sealText(text: string): string {
  const iv = randomBytes(IV_BYTES)
  const c = createCipheriv('aes-256-gcm', sealKey(), iv)
  const data = Buffer.concat([c.update(text, 'utf8'), c.final()])
  return Buffer.concat([iv, c.getAuthTag(), data]).toString('base64')
}

export function openText(sealed: string): string {
  const raw = Buffer.from(sealed, 'base64')
  const d = createDecipheriv('aes-256-gcm', sealKey(), raw.subarray(0, IV_BYTES))
  d.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
  return Buffer.concat([d.update(raw.subarray(IV_BYTES + TAG_BYTES)), d.final()]).toString('utf8')
}
