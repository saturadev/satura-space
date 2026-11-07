import { spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { debugLog } from '@shared/debug-log'

const POSIX_HELPER = `
use strict;
use Fcntl qw(:flock);
use IO::Select;
use Time::HiRes qw(time);
$| = 1;
my %held;
my %wait;
my $sel = IO::Select->new(\\*STDIN);
my $buf = '';
while (1) {
  my @ready = $sel->can_read(%wait ? 0.1 : undef);
  if (@ready) {
    my $chunk;
    my $n = sysread(STDIN, $chunk, 65536);
    exit 0 unless $n;
    $buf .= $chunk;
    while ($buf =~ s/^([^\\n]*)\\n//) {
      my ($cmd, $id, $secs, $path) = split / /, $1, 4;
      next unless defined $id;
      if ($cmd eq 'lock') {
        my $f;
        if (open($f, '>>', $path)) { $wait{$id} = [$f, time() + $secs]; }
        else { print "error $id open: $!\\n"; }
      } elsif ($cmd eq 'unlock') {
        if (my $f = delete $held{$id}) { flock($f, LOCK_UN); close($f); }
        if (my $w = delete $wait{$id}) { close($w->[0]); }
      }
    }
  }
  for my $id (keys %wait) {
    my ($f, $until) = @{$wait{$id}};
    if (flock($f, LOCK_EX | LOCK_NB)) { $held{$id} = $f; delete $wait{$id}; print "locked $id\\n"; }
    elsif (time() > $until) { close($f); delete $wait{$id}; print "timeout $id\\n"; }
  }
}
`

const WIN_HELPER = `
$held = @{}
$wait = @{}
$reader = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$task = $reader.ReadLineAsync()
while ($true) {
  if ($task.Wait(100)) {
    $line = $task.Result
    if ($line -eq $null) { break }
    $p = $line.Split(' ', 4)
    if ($p[0] -eq 'lock' -and $p.Length -eq 4) {
      try {
        $fs = [IO.File]::Open($p[3], 'OpenOrCreate', 'ReadWrite', 'ReadWrite')
        $wait[$p[1]] = @{ fs = $fs; until = (Get-Date).AddSeconds([double]$p[2]) }
      } catch {
        [Console]::Out.WriteLine('error ' + $p[1] + ' open: ' + $_.Exception.Message)
      }
    } elseif ($p[0] -eq 'unlock') {
      if ($held.ContainsKey($p[1])) { $fs = $held[$p[1]]; try { $fs.Unlock(0, 1) } catch {}; $fs.Close(); $held.Remove($p[1]) }
      if ($wait.ContainsKey($p[1])) { $wait[$p[1]].fs.Close(); $wait.Remove($p[1]) }
    }
    $task = $reader.ReadLineAsync()
  }
  foreach ($id in @($wait.Keys)) {
    $w = $wait[$id]
    try {
      $w.fs.Lock(0, 1)
      $held[$id] = $w.fs
      $wait.Remove($id)
      [Console]::Out.WriteLine('locked ' + $id)
    } catch {
      if ((Get-Date) -gt $w.until) { $w.fs.Close(); $wait.Remove($id); [Console]::Out.WriteLine('timeout ' + $id) }
    }
  }
  [Console]::Out.Flush()
}
foreach ($fs in $held.Values) { $fs.Close() }
`

class ExecLockHelperError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExecLockHelperError'
  }
}

class ExecLockBusyError extends Error {
  constructor(waitS: number) {
    super(`Unity is busy with another exec (the exec lock stayed taken for ${waitS} s). The dashboard tries again on its next poll.`)
    this.name = 'ExecLockBusyError'
  }
}

type Waiter = { resolve: () => void; reject: (err: Error) => void }

type HelperCommand = { command: string; args: string[] }

function defaultHelperCommand(): HelperCommand {
  if (process.platform === 'win32') {
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(WIN_HELPER, 'utf16le').toString('base64')]
    }
  }
  return { command: '/usr/bin/perl', args: ['-e', POSIX_HELPER] }
}

class ExecLockHelper {
  private child: ChildProcess | null = null
  private buffer = ''
  private waiters = new Map<string, Waiter>()
  private held = new Set<string>()
  private nextId = 0
  private helper: HelperCommand

  constructor(helper: HelperCommand = defaultHelperCommand()) {
    this.helper = helper
  }

  get pid(): number | null {
    return this.child?.pid ?? null
  }

  acquire(lockPath: string, waitS: number): Promise<string> {
    const child = this.ensureChild()
    const id = String(++this.nextId)
    return new Promise<string>((resolve, reject) => {
      this.waiters.set(id, {
        resolve: () => {
          this.held.add(id)
          resolve(id)
        },
        reject
      })
      this.send(child, `lock ${id} ${waitS} ${lockPath}\n`)
    })
  }

  release(id: string): void {
    this.held.delete(id)
    if (this.child) this.send(this.child, `unlock ${id}\n`)
  }

  stop(): void {
    const child = this.child
    this.child = null
    child?.stdin?.end()
  }

  private send(child: ChildProcess, line: string): void {
    try {
      child.stdin?.write(line)
    } catch {
    }
  }

  private ensureChild(): ChildProcess {
    if (this.child) return this.child
    const child = spawn(this.helper.command, this.helper.args, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    this.child = child
    this.buffer = ''
    child.stdin?.on('error', () => {})
    child.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString()
      let nl = this.buffer.indexOf('\n')
      while (nl !== -1) {
        this.handleLine(this.buffer.slice(0, nl).replace(/\r$/, ''))
        this.buffer = this.buffer.slice(nl + 1)
        nl = this.buffer.indexOf('\n')
      }
    })
    child.once('error', (err) => {
      if (this.child === child) this.child = null
      this.failAll(new ExecLockHelperError(`The exec lock helper could not start (${this.helper.command}: ${err.message})`))
    })
    child.once('exit', (code, signal) => {
      if (this.child === child) this.child = null
      if (this.held.size > 0) {
        debugLog(`[dashboard] exec lock helper exited (code ${code}, signal ${signal}) while holding ${this.held.size} lock(s); they are released`)
        this.held.clear()
      }
      this.failAll(new ExecLockHelperError(`The exec lock helper exited (code ${code ?? 'none'}${signal ? `, signal ${signal}` : ''})`))
    })
    return child
  }

  private handleLine(line: string): void {
    const [kind, id, ...rest] = line.split(' ')
    const waiter = id ? this.waiters.get(id) : undefined
    if (!waiter) return
    this.waiters.delete(id)
    if (kind === 'locked') waiter.resolve()
    else if (kind === 'timeout') waiter.reject(new ExecLockBusyError(-1))
    else waiter.reject(new ExecLockHelperError(`The exec lock helper failed: ${rest.join(' ') || line}`))
  }

  private failAll(err: Error): void {
    const waiters = [...this.waiters.values()]
    this.waiters.clear()
    for (const waiter of waiters) waiter.reject(err)
  }
}

let sharedHelper: ExecLockHelper | null = null

function helperInstance(): ExecLockHelper {
  sharedHelper ??= new ExecLockHelper()
  return sharedHelper
}

export async function withExecLock<T>(project: string, op: string, waitS: number, job: () => Promise<T>): Promise<T> {
  const sspace = join(project, '.sspace')
  mkdirSync(sspace, { recursive: true })
  const lock = join(sspace, '.mcp_exec.lock')
  const owner = join(sspace, '.mcp_exec.lock.owner')
  const helper = helperInstance()
  const t0 = Date.now()
  let id: string
  try {
    id = await helper.acquire(lock, waitS)
  } catch (err) {
    if (err instanceof ExecLockBusyError) throw new ExecLockBusyError(waitS)
    throw err
  }
  const waited = Date.now() - t0
  const slow = waited > 300
  if (slow) debugLog(`[dashboard] ${op} got the exec lock at ${new Date().toISOString()} after waiting ${waited} ms in ${project}`)
  try {
    writeFileSync(owner, JSON.stringify({ pid: process.pid, op, since: Date.now() / 1000 }))
  } catch {
  }
  try {
    return await job()
  } finally {
    try {
      rmSync(owner, { force: true })
    } catch {
    }
    if (slow) debugLog(`[dashboard] ${op} released the exec lock at ${new Date().toISOString()}`)
    helper.release(id)
  }
}

export async function withFileLock<T>(lock: string, waitS: number, busy: string, job: () => Promise<T>): Promise<T> {
  const helper = helperInstance()
  let id: string
  try {
    id = await helper.acquire(lock, waitS)
  } catch (err) {
    if (err instanceof ExecLockBusyError) throw new Error(busy)
    throw err
  }
  try {
    return await job()
  } finally {
    helper.release(id)
  }
}
