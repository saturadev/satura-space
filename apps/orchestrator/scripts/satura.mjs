import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TEST_PROJECT } from './test-project.mjs'

const USAGE = `Drive a Satura Space dev instance from the terminal.

  node scripts/satura.mjs [--instance alt | --endpoint <file>] [--project <path>] [--as <name>] [--timeout <s>] [--wait <s>] [--logs <n|all>] [--drift] <command>

  handles [filter]            list the app handles, optionally filtered by name or description
  handle <name> ['<json>']    call one handle with params, print status, value and the logs it caused
  result <run> [--wait <s>]   read a long handle's run
  stop <run>                  stop a long handle's run
  exec '<js>' | exec -        run a satura_exec script (from the argument or stdin); --drift shows Drift.
                              unity.*, handles.* and video.* run through packages/mcp/.venv, like an agent's MCP

The project defaults to ${TEST_PROJECT}. One caller drives the instance at a time: while a call runs, others get busy: <name>, where name is --as or $SATURA_AS. Screenshots from exec are saved as files and their paths printed.`

function parseArgs(argv) {
  const opts = { instance: 'alt', endpoint: '', project: TEST_PROJECT, as: process.env.SATURA_AS || '', timeout: 0, wait: undefined, logs: '40', drift: false }
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--instance') opts.instance = argv[++i]
    else if (a === '--endpoint') opts.endpoint = argv[++i]
    else if (a === '--project') opts.project = argv[++i]
    else if (a === '--as') opts.as = argv[++i]
    else if (a === '--timeout') opts.timeout = Number(argv[++i])
    else if (a === '--wait') opts.wait = Number(argv[++i])
    else if (a === '--logs') opts.logs = argv[++i]
    else if (a === '--drift') opts.drift = true
    else if (a === '-h' || a === '--help') rest.unshift('help')
    else rest.push(a)
  }
  return { opts, rest }
}

function appData() {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support')
  if (process.platform === 'win32') return process.env.APPDATA || join(homedir(), 'AppData', 'Roaming')
  return process.env.XDG_CONFIG_HOME || join(homedir(), '.config')
}

function endpointFile(opts) {
  if (opts.endpoint) return opts.endpoint
  if (!/^[a-z0-9][a-z0-9-]{0,31}$/.test(opts.instance)) throw new Error(`Bad instance name "${opts.instance}".`)
  return join(appData(), `satura-space-dev-${opts.instance}`, 'agent-hooks', 'endpoint')
}

function endpoint(file, instance) {
  let text
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    throw new Error(`No endpoint at ${file}. Is dev instance "${instance}" running? Start it with apps/orchestrator/scripts/macos/dev-instance.sh ${instance}.`)
  }
  const port = Number(/^port=(\d+)/m.exec(text)?.[1])
  const token = /^token=(\S+)/m.exec(text)?.[1]
  if (!port || !token) throw new Error(`The endpoint file ${file} is incomplete.`)
  return { port, token, file }
}

function mcpPython() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'packages', 'mcp')
  const python = join(dir, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python')
  return existsSync(python) ? { dir, python } : null
}

function viaMcp(mcp, ep, body, timeoutS) {
  return new Promise((resolve, reject) => {
    const child = spawn(mcp.python, ['-m', 'unity_mcp.exec_cli', '--endpoint', ep.file, '--root', body.projectRoot, '--deadline', String(timeoutS + 30)], { cwd: mcp.dir, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = ''
    let err = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (c) => (out += c))
    child.stderr.on('data', (c) => (err += c))
    child.on('error', (e) => reject(new Error(`Can't start ${mcp.python}: ${e.message}`)))
    child.on('close', (code) => {
      const line = out.trim().split('\n').pop() ?? ''
      try {
        resolve(JSON.parse(line))
      } catch {
        reject(new Error(`The MCP helper exited with ${code} and no reply.${err ? `\n${err.trim().slice(-2000)}` : ''}`))
      }
    })
    child.stdin.end(JSON.stringify(body))
  })
}

function post(ep, body, timeoutS) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body)
    const req = request(
      { host: '127.0.0.1', port: ep.port, path: '/exec', method: 'POST', headers: { 'content-type': 'application/json', 'x-satura-hook-token': ep.token, 'content-length': Buffer.byteLength(data) } },
      (res) => {
        let text = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (text += c))
        res.on('end', () => {
          if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} from the app${res.statusCode === 403 ? ': the token is stale, the instance restarted' : ''}.`))
          try {
            resolve(JSON.parse(text.trim()))
          } catch {
            reject(new Error(`The app sent a reply that is not JSON: ${text.slice(0, 300)}`))
          }
        })
      }
    )
    req.setTimeout((timeoutS + 30) * 1000, () => req.destroy(new Error('The app did not answer in time.')))
    req.on('error', (e) => reject(new Error(`Can't reach the app on port ${ep.port}: ${e.message}`)))
    req.end(data)
  })
}

function readStdin() {
  return new Promise((resolve) => {
    let text = ''
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (c) => (text += c))
    process.stdin.on('end', () => resolve(text))
  })
}

function saveShots(shots) {
  if (!shots?.length) return []
  const dir = join(tmpdir(), 'satura-cli')
  mkdirSync(dir, { recursive: true })
  const stamp = Date.now()
  return shots.map((s, i) => {
    const file = join(dir, `shot-${stamp}-${i + 1}.${s.mime === 'image/jpeg' ? 'jpg' : 'png'}`)
    writeFileSync(file, Buffer.from(s.data, 'base64'))
    return `${file} (${s.width}x${s.height})`
  })
}

function pretty(value) {
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2)
}

function tail(lines, limit) {
  if (limit === 'all') return lines
  const n = Math.max(0, Number(limit) || 0)
  if (n === 0) return []
  return lines.length > n ? [`… ${lines.length - n} more`, ...lines.slice(-n)] : lines
}

function printHandleResult(r, limit) {
  const head = [`${r.handle || 'run'}: ${r.status}`, `${r.ms} ms`]
  if (r.run) head.push(`run ${r.run}`)
  if (r.mark) head.push(`mark ${r.mark}`)
  console.log(head.join('  |  '))
  if (r.error) console.log(`error: ${r.error}`)
  for (const d of r.dialogs ?? []) console.log(`dialog: ${d}`)
  if (r.value !== undefined) console.log(pretty(r.value))
  const logs = tail(r.logs ?? [], limit)
  if (logs.length) console.log(`--- logs (${(r.logs ?? []).length}) ---\n${logs.join('\n')}`)
  if (r.status === 'running') console.log(`still running: node scripts/satura.mjs result ${r.run} --wait 60`)
}

function printList(list) {
  for (const h of list) {
    console.log(`${h.name}${h.long ? ' (long)' : ''}  [${h.side}]  ${JSON.stringify(h.params)}`)
    console.log(`  ${h.description}`)
  }
  console.log(`${list.length} handle(s)`)
}

async function main() {
  const { opts, rest } = parseArgs(process.argv.slice(2))
  const [command, ...args] = rest
  if (!command || command === 'help') {
    console.log(USAGE)
    return 0
  }
  const waitArg = opts.wait === undefined ? 'undefined' : String(opts.wait)
  let code
  let kind = 'handle'
  let timeout = opts.timeout || 0
  if (command === 'handles') {
    code = `return await app.handles(${JSON.stringify(args[0] ?? '')})`
    kind = 'list'
  } else if (command === 'handle') {
    if (!args[0]) throw new Error('handle needs a name. List them with: handles')
    const params = args[1] ? JSON.parse(args[1]) : {}
    code = `return await app.handle(${JSON.stringify(args[0])}, ${JSON.stringify(params)}, { wait: ${waitArg} })`
    timeout ||= Math.max(120, (opts.wait ?? 30) + 60)
  } else if (command === 'result') {
    code = `return await app.result(${Number(args[0])}, { wait: ${waitArg} })`
    timeout ||= Math.max(120, (opts.wait ?? 0) + 60)
  } else if (command === 'stop') {
    code = `return await app.stop(${Number(args[0])})`
  } else if (command === 'exec') {
    code = args[0] === '-' || args[0] === undefined ? await readStdin() : args[0]
    kind = 'exec'
  } else {
    console.error(`Unknown command ${command}.\n\n${USAGE}`)
    return 2
  }
  timeout ||= 120
  const ep = endpoint(endpointFile(opts), opts.instance)
  const body = { code, projectRoot: opts.project, timeout, caller: opts.as || `terminal (${userInfo().username})`, ...(opts.drift ? { drift: true } : {}) }
  const mcp = kind === 'exec' ? mcpPython() : null
  if (kind === 'exec' && !mcp) console.error('No packages/mcp/.venv next to this script: unity.*, handles.* and video.* calls will fail. Set it up with packages/mcp/run.sh.')
  const reply = mcp ? await viaMcp(mcp, ep, body, timeout) : await post(ep, body, timeout)
  const shots = saveShots(reply.shots)
  const logs = (reply.logs ?? []).map((l) => (l.level && l.level !== 'log' ? `[${l.level}] ${l.text}` : l.text))
  let failed = !reply.ok
  if (!reply.ok) {
    console.log(`failed: ${reply.error ?? `${reply.failure?.name}: ${reply.failure?.message}`}`)
    if (reply.failure?.stack) console.log(reply.failure.stack)
  } else {
    const value = reply.result === undefined ? undefined : JSON.parse(reply.result)
    if (kind === 'list') printList(value ?? [])
    else if (kind === 'handle' && value && typeof value === 'object' && 'status' in value) {
      printHandleResult(value, opts.logs)
      failed = value.status === 'error' || value.status === 'blocked'
    } else if (value !== undefined) console.log(pretty(value))
    else console.log(`ok in ${reply.ms} ms`)
  }
  if (logs.length) console.log(`--- script console ---\n${tail(logs, opts.logs).join('\n')}`)
  if (reply.steps?.length) console.log(`steps: ${reply.steps.map((s) => `${s.ok ? '' : 'FAILED '}${s.label}${s.ms >= 500 ? ` ${(s.ms / 1000).toFixed(1)}s` : ''}`).join(' · ')}`)
  for (const n of reply.notes ?? []) console.log(`note: ${n}`)
  if (reply.drift) console.log(`drift: ${reply.drift}`)
  for (const s of shots) console.log(`shot: ${s}`)
  return failed ? 1 : 0
}

main().then(
  (code) => process.stdout.write('', () => process.exit(code)),
  (e) => {
    console.error(e.message)
    process.exit(1)
  }
)
