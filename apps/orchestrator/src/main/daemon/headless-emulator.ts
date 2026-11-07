import './xterm-env-polyfill'
import { Terminal } from '@xterm/headless'
import { SerializeAddon } from '@xterm/addon-serialize'
import { Unicode11Addon } from '@xterm/addon-unicode11'
import { activateOrcaTerminalUnicodeProvider } from '../../shared/terminal-unicode-provider'
const OSC_TITLE_PATTERN = /\x1b\][02];([^\x07\x1b]*)(?:\x07|\x1b\\)/g
function extractLastOscTitle(data: string): string | null {
  let match: RegExpExecArray | null
  let last: string | null = null
  OSC_TITLE_PATTERN.lastIndex = 0
  while ((match = OSC_TITLE_PATTERN.exec(data))) last = match[1]
  return last
}
import { collectHeadlessOscLinkRanges } from './headless-osc-link-ranges'
import { extractOscScanTail, scanOsc7Uris } from './osc7-uri-extraction'
import { parseFileUriPath } from './osc7-file-uri'
import { TerminalPrivateModeTracker } from './terminal-private-mode-tracker'
import type { TerminalSnapshot, TerminalModes } from './types'
import type { TerminalOscLinkRange } from '../../shared/terminal-osc-link-ranges'

export type HeadlessEmulatorOptions = {
  cols: number
  rows: number
  scrollback?: number
  pathFlavor?: 'posix' | 'win32'
  remotePosixFileUriAuthority?: boolean
}

type TerminalWithSynchronousWrite = Terminal & {
  _core?: {
    writeSync?: (data: string) => void
  }
}

const DEFAULT_SCROLLBACK = 5000
const OSC_SCAN_TAIL_LIMIT = 4096

export class HeadlessEmulator {
  private terminal: Terminal
  private serializer: SerializeAddon
  private cwd: string | null = null
  private lastTitle: string | null = null
  private oscScanTail = ''
  private privateModes = new TerminalPrivateModeTracker()
  private restoredOscLinks: TerminalOscLinkRange[] = []
  private sawOscLink = false
  private disposed = false
  private readonly pathFlavor?: 'posix' | 'win32'
  private readonly remotePosixFileUriAuthority: boolean

  constructor(opts: HeadlessEmulatorOptions) {
    this.pathFlavor = opts.pathFlavor
    this.remotePosixFileUriAuthority = opts.remotePosixFileUriAuthority === true
    this.terminal = new Terminal({
      cols: opts.cols,
      rows: opts.rows,
      scrollback: opts.scrollback ?? DEFAULT_SCROLLBACK,
      allowProposedApi: true,
      logLevel: 'off'
    })

    this.serializer = new SerializeAddon()
    this.terminal.loadAddon(this.serializer)

    this.terminal.loadAddon(new Unicode11Addon())
    activateOrcaTerminalUnicodeProvider(this.terminal)
    this.terminal.parser.registerOscHandler(8, () => {
      this.sawOscLink = true
      return false
    })

  }

  write(data: string): Promise<void> {
    if (this.disposed) {
      return Promise.resolve()
    }

    if (this.tryWriteSync(data)) {
      return Promise.resolve()
    }
    this.scanInputForOscState(data)
    return new Promise<void>((resolve) => {
      this.terminal.write(data, () => {
        this.privateModes.scan(data)
        resolve()
      })
    })
  }

  writeSync(data: string): boolean {
    if (this.disposed) {
      return false
    }
    return this.tryWriteSync(data)
  }

  private tryWriteSync(data: string): boolean {
    const writeSync = (this.terminal as TerminalWithSynchronousWrite)._core?.writeSync
    if (typeof writeSync !== 'function') {
      return false
    }
    this.scanInputForOscState(data)
    writeSync.call((this.terminal as TerminalWithSynchronousWrite)._core, data)
    this.privateModes.scan(data)
    return true
  }

  private scanInputForOscState(data: string): void {
    const oscInput = this.oscScanTail + data
    this.oscScanTail = this.extractOscScanTail(oscInput)
    this.scanOsc7(oscInput)
    const lastTitle = extractLastOscTitle(oscInput)
    if (lastTitle !== null) {
      this.lastTitle = lastTitle
    }
  }

  resize(cols: number, rows: number): void {
    if (this.disposed) {
      return
    }
    this.restoredOscLinks = []
    this.terminal.resize(cols, rows)
  }

  getAppliedSize(): { cols: number; rows: number } {
    return { cols: this.terminal.cols, rows: this.terminal.rows }
  }

  getSnapshot(opts: { scrollbackRows?: number } = {}): TerminalSnapshot {
    const modes = this.getModes()
    const snapshotAnsi = this.normalizeSnapshotAnsiForModes(
      this.serializer.serialize({ scrollback: opts.scrollbackRows }),
      modes
    )
    return {
      snapshotAnsi,
      scrollbackAnsi: '',
      oscLinks: collectHeadlessOscLinkRanges(
        this.terminal,
        opts.scrollbackRows,
        this.restoredOscLinks,
        this.sawOscLink
      ),
      rehydrateSequences: this.buildRehydrateSequences(modes),
      cwd: this.cwd,
      modes,
      cols: this.terminal.cols,
      rows: this.terminal.rows,
      scrollbackLines: this.terminal.buffer.normal.length - this.terminal.rows,
      lastTitle: this.lastTitle ?? undefined
    }
  }

  get isAlternateScreen(): boolean {
    return this.terminal.buffer.active.type === 'alternate'
  }

  getCwd(): string | null {
    return this.cwd
  }

  setRestoredOscLinks(links: TerminalOscLinkRange[] | undefined): void {
    this.restoredOscLinks = links?.slice() ?? []
  }

  clearScrollback(): void {
    this.restoredOscLinks = []
    this.terminal.clear()
  }

  dispose(): void {
    this.disposed = true
    this.terminal.dispose()
  }

  private scanOsc7(data: string): void {
    scanOsc7Uris(data, (uri) => {
      this.parseOsc7Uri(uri)
    })
  }

  private extractOscScanTail(input: string): string {
    return extractOscScanTail(input, OSC_SCAN_TAIL_LIMIT)
  }

  private normalizeSnapshotAnsiForModes(snapshotAnsi: string, modes: TerminalModes): string {
    if (!modes.alternateScreen) {
      return snapshotAnsi
    }
    const alternateScreenMarker = '\x1b[?1049h'
    const start = snapshotAnsi.lastIndexOf(alternateScreenMarker)
    if (start === -1) {
      return snapshotAnsi
    }
    return snapshotAnsi.slice(start + alternateScreenMarker.length)
  }

  private parseOsc7Uri(uri: string): void {
    const parsed = parseFileUriPath(uri, {
      pathFlavor: this.pathFlavor,
      remotePosixAuthority: this.remotePosixFileUriAuthority
    })
    if (parsed) {
      this.cwd = parsed
    }
  }

  private getModes(): TerminalModes {
    const buffer = this.terminal.buffer.active
    const mouseTrackingMode = this.privateModes.mouseTrackingMode
    return {
      bracketedPaste: this.terminal.modes.bracketedPasteMode,
      mouseTracking: mouseTrackingMode !== 'none',
      mouseTrackingMode,
      sgrMouseMode: this.privateModes.sgrMouseMode,
      sgrMousePixelsMode: this.privateModes.sgrMousePixelsMode,
      applicationCursor:
        buffer.type === 'normal' ? this.terminal.modes.applicationCursorKeysMode : false,
      alternateScreen: buffer.type === 'alternate'
    }
  }

  private buildRehydrateSequences(modes: TerminalModes): string {
    const seqs: string[] = []
    if (modes.alternateScreen) {
      seqs.push('\x1b[?1049h')
    }
    if (modes.bracketedPaste) {
      seqs.push('\x1b[?2004h')
    }
    if (modes.applicationCursor) {
      seqs.push('\x1b[?1h')
    }
    switch (modes.mouseTracking ? (modes.mouseTrackingMode ?? 'vt200') : 'none') {
      case 'x10':
        seqs.push('\x1b[?9h')
        break
      case 'vt200':
        seqs.push('\x1b[?1000h')
        break
      case 'drag':
        seqs.push('\x1b[?1002h')
        break
      case 'any':
        seqs.push('\x1b[?1003h')
        break
      case 'none':
        break
    }
    if (modes.sgrMousePixelsMode) {
      seqs.push('\x1b[?1016h')
    } else if (modes.sgrMouseMode) {
      seqs.push('\x1b[?1006h')
    }
    return seqs.join('')
  }
}
