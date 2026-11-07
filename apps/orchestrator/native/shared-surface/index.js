let native = null
try {
  native = require('./build/Release/shared_surface.node')
} catch {
  native = null
}

function available() {
  return native !== null
}

function lookupIOSurface(globalId, width, height) {
  if (!native || !native.lookup) return { error: 'unavailable' }
  const r = native.lookup(globalId >>> 0, (width || 0) >>> 0, (height || 0) >>> 0)
  if (r == null) return { error: 'missing' }
  if (Buffer.isBuffer(r)) return { handle: r, token: -1 - (globalId >>> 0) }
  return r
}

function releaseIOSurface(token) {
  if (!native || !native.release) return false
  if (token < 0) {
    native.release((-1 - token) >>> 0)
    return true
  }
  return !!native.release(token >>> 0)
}

function retainedIOSurfaces() {
  return native && native.retained ? native.retained() : 0
}

function duplicateHandle(pid, handleLow, handleHigh) {
  if (!native || !native.duplicate) return null
  return native.duplicate(pid >>> 0, handleLow >>> 0, handleHigh >>> 0)
}

function closeHandle(buf) {
  if (native && native.close) native.close(buf)
}

function launchWithHook(exe, argv, cwd, envBlock, dllPath) {
  if (!native || !native.launchWithHook) return null
  const r = native.launchWithHook(exe, argv, cwd || '', envBlock || '', dllPath)
  if (typeof r === 'number') return { pid: r, injected: true }
  return r
}

function startMouseDeltas(cb) {
  if (!native || !native.startMouseDeltas) return false
  return native.startMouseDeltas(cb) === true
}

function readback(handleBuf, width, height) {
  if (!native || !native.readback || !handleBuf) return null
  return native.readback(handleBuf, width >>> 0, height >>> 0)
}

function assignToKillJob(pid) {
  if (!native || !native.assignToKillJob || !pid) return false
  return native.assignToKillJob(pid >>> 0)
}

function setJobKillOnClose(enabled) {
  if (!native || !native.setJobKillOnClose) return false
  return native.setJobKillOnClose(!!enabled)
}

module.exports = {
  available,
  lookupIOSurface,
  releaseIOSurface,
  retainedIOSurfaces,
  duplicateHandle,
  closeHandle,
  launchWithHook,
  readback,
  assignToKillJob,
  setJobKillOnClose,
  startMouseDeltas
}
