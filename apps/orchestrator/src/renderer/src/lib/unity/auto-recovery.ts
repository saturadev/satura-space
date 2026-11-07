export const MAX_AUTO_RELAUNCH_ATTEMPTS = 2

export interface AutoRelaunchInput {
  unreachable: boolean
  stopped: boolean
  relaunching: boolean
  attempts: number
}

export function shouldAutoRelaunch(s: AutoRelaunchInput): boolean {
  if (!s.unreachable || s.stopped || s.relaunching) return false
  return s.attempts < MAX_AUTO_RELAUNCH_ATTEMPTS
}
