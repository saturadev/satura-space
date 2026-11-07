let restoreQuit = false
let quitting = false
let quitConfirmed = false
let closeTerminalsOnQuit = false
let relaunchOnQuit = false

export function markRelaunchOnQuit(): void {
  relaunchOnQuit = true
}

export function shouldRelaunchOnQuit(): boolean {
  return relaunchOnQuit
}

export function setCloseTerminalsOnQuit(value: boolean): void {
  closeTerminalsOnQuit = value
}

export function shouldCloseTerminalsOnQuit(): boolean {
  return closeTerminalsOnQuit
}

export function markRestoreQuit(): void {
  restoreQuit = true
}

export function clearRestoreQuit(): void {
  restoreQuit = false
}

export function isRestoreQuit(): boolean {
  return restoreQuit
}

export function markQuitConfirmed(): void {
  quitConfirmed = true
}

export function isQuitConfirmed(): boolean {
  return quitConfirmed
}

export function markQuitting(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}
