# Input System only

Unity starts only when Active Input Handling is Input System Package (New) and `com.unity.inputsystem` is installed. Otherwise a call that would launch Unity throws `InputSystemRequired`. The old Input Manager reads the OS, so input from the panel never reaches it.

Switching over, after asking the user:

```yaml
# ProjectSettings/ProjectSettings.asset
activeInputHandler: 1
```

```json
// Packages/manifest.json
"com.unity.inputsystem": "<a version Package Manager lists for this Unity>"
```

```js
await unity.relaunch()
```

Reading input:

```csharp
using UnityEngine.InputSystem;

var move = new InputAction("Move", InputActionType.Value);
move.AddCompositeBinding("2DVector").With("Up", "<Keyboard>/w").With("Down", "<Keyboard>/s").With("Left", "<Keyboard>/a").With("Right", "<Keyboard>/d");
move.Enable();
Vector2 dir = move.ReadValue<Vector2>();
if (Keyboard.current.spaceKey.wasPressedThisFrame) Jump();
if (Mouse.current.leftButton.wasPressedThisFrame) Fire(Mouse.current.position.ReadValue());
```

- `UnityEngine.Input` (GetKey, GetAxis, mousePosition, touches) throws in Play Mode.
- uGUI needs an EventSystem with `InputSystemUIInputModule`; `StandaloneInputModule` gets no clicks.
- `unity.refresh()` notes list every script, scene and prefab line that still uses the old API, with the call to use instead.
- The phone (Satura Remote) builds its game controls from the Input System assets. Change them with `ProjectSettings/SaturaRemote/controls.overrides.json`, see [phone controls](remote-controls.md).
