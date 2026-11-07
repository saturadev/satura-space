import { app, shell } from 'electron'

const NEW_ISSUE_URL = 'https://github.com/saturadev/satura-space/issues/new'

function osLabel(): string {
  const version = process.getSystemVersion()
  if (process.platform === 'darwin') {
    return `macOS ${version} (${process.arch === 'arm64' ? 'Apple Silicon' : 'Intel'})`
  }
  if (process.platform === 'win32') {
    const build = Number(version.split('.')[2] ?? '')
    const name = Number.isFinite(build) && build >= 22000 ? 'Windows 11' : 'Windows 10'
    return `${name} (build ${build || version}, ${process.arch})`
  }
  return `${process.platform} ${version} (${process.arch})`
}

export function bugReportUrl(): string {
  const params = new URLSearchParams({
    template: 'bug_report.yml',
    version: app.getVersion(),
    os: osLabel()
  })
  return `${NEW_ISSUE_URL}?${params.toString()}`
}

export async function openBugReport(): Promise<void> {
  await shell.openExternal(bugReportUrl())
}
