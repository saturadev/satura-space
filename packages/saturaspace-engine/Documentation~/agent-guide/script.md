# The script

```js
try {
  await unity.refresh()
} catch (e) {
  return `${e.name}: ${e.message}`
}
const [status, errors] = await Promise.all([unity.status(), unity.logs({ severity: 'error' })])
console.log(status)
return { errors }
```

- `return` anything JSON can hold. Strings come back as text, objects as `key: value` lines.
- The reply: return value, `Steps:` (each call with its time, `FAILED` on the one that threw), `Notes:` (unsaved scenes, files written, compile errors: act on them), `Console:`, images.
- Editor calls queue behind each other. `logs`, `status`, `source` and `docs` don't wait.
- An unknown option throws: `{ timout: 5 }` is a TypeError listing the real options.
- No `require`, `import`, `process`, `fetch` or file access. Use your own tools for files.
- Text with an apostrophe goes in double quotes or backticks.

## Errors

| `e.name` | Means |
|---|---|
| `CompileError` | the message lists the compile errors |
| `HandleError` | a handle threw or doesn't exist; has its stack and log lines |
| `HandleTimeout` | a coroutine outlived its timeout and still runs; names the run |
| `DialogBlocked` | a modal dialog blocks the editor: `unity.dialogs()` |
| `InputSystemRequired` | the project isn't Input System only: [input system](input-system.md) |
| `NoGraphicsError` | a rendering call in `headless-nographics` mode |
| `UnityTimeout`, `UnityError` | the message says why |
| `TypeError` | a wrong argument or option |

## Timeouts

```js
await unity.exec(bakeLightmaps, { timeout: 900 })
```

- The tool's `timeout` limits the whole script: 300 s by default, 3600 at most.
- A call's `{ timeout }` is the most it waits while Unity keeps working, up to 900 s, and up to 3600 s for a relaunch, which also waits while Unity Hub installs the project's Unity version. Defaults: exec 300, refresh 300, play 60 per player plus the compile, relaunch 180, coroutine handle 60.
- Waits end early with the reason: Unity isn't running, exited, didn't start (the message quotes the editor log), or showed no progress for 30 s. A longer timeout won't fix that.

When a wait ends early:

```js
const status = await unity.status()
const log = await unity.logs({ source: 'editor', lines: 80 })
return { status, log }
```

Fix what the log shows (compile errors, say), then `await unity.relaunch()`. If Unity Hub isn't running or a relaunch doesn't help, ask the user. A failed or stopped script has its running video and awaited handle stopped for it; the notes say so.
