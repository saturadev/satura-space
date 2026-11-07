# Debugging

## Logs

Works while an editor boots, after a crash and when it's off.

```js
await unity.logs()                                    // compile errors, then console; raw editor log while booting
await unity.logs({ severity: 'error', grep: /null/i, lines: 50 })
await unity.logs({ source: 'editor' })                // raw, unfiltered
await unity.logs({ source: 'compile' })
await unity.logs({ source: 'tags' })                  // lists SaturaLog tags
await unity.logs({ tag: 'fish', player: 2, collapse: false })
```

`console` and `tags` clear on Play. `lines` is per section, 400 by default, 0 for all. `player`: 'all', 'primary', 'clones', an id or a number.

## Who moves this? unity.trace

A data breakpoint that doesn't pause: which code writes an object's components, in what order within a frame. Start it in Play Mode; entering Play or a recompile wipes it.

```js
await unity.trace('Player', { seconds: 10 })
await handles.call('Dash')
return await unity.traceReport()                      // { stop: false } peeks and keeps tracing
```

```js
await unity.trace('Player', { members: 'Rigidbody.linearVelocity, Rigidbody.AddForce' })
```

The report opens with the answer: the script that writes it (file:line, count, phase), whether Unity moves it (physics, interpolation, Animator, a moving parent), and who drives its Rigidbody, CharacterController or NavMeshAgent. Then CONFLICTS, every writer, a timeline and stacks. More options: `player`, `ancestors`, `maxEvents`, `collapse`, `maxLines`.

## Unity API questions

Answers for this project's exact Unity version, not memory.

```js
await unity.source('find', 'Transform.SetParent')         // file:line and signatures
await unity.source('signatures', 'Rigidbody')
await unity.source('body', 'Rigidbody.AddForce')
await unity.source('grep', 'interpolat', { glob: '**/Physics/**' })
await unity.source('body', 'X', { path, startLine: 10, endLine: 80 })
await unity.source('find', 'PlayerController.Jump')      // project symbols: declaration, uses, body
await unity.docs('Transform.SetParent')                  // ScriptReference; typos get "did you mean"
```
