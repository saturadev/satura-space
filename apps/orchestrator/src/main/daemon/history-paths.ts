export function getHistorySessionDirName(sessionId: string): string {
  return encodeURIComponent(sessionId)
}
