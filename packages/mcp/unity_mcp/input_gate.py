import json
import os
import re
from pathlib import Path

HEAD = "INPUT SYSTEM REQUIRED"
PACKAGE = "com.unity.inputsystem"
HANDLER = re.compile(r"^\s*activeInputHandler:\s*(\d+)", re.M)


def _read(path: Path) -> str | None:
    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def _has_package(root: Path) -> bool:
    if (root / "Packages" / PACKAGE).is_dir():
        return True
    text = _read(root / "Packages" / "manifest.json")
    if not text:
        return False
    try:
        return PACKAGE in ((json.loads(text) or {}).get("dependencies") or {})
    except (ValueError, AttributeError):
        return f'"{PACKAGE}"' in text


def problem(root) -> dict | None:
    root = Path(root)
    text = _read(root / "ProjectSettings" / "ProjectSettings.asset")
    if text is None or not text.startswith("%YAML"):
        return None
    m = HANDLER.search(text)
    handler = int(m.group(1)) if m else 0
    missing = not _has_package(root)
    if handler == 1 and not missing:
        return None
    return {"handler": handler, "packageMissing": missing}


def message(root, p: dict) -> str:
    found = []
    if p["handler"] == 0:
        found.append("Active Input Handling is set to Input Manager (Old).")
    elif p["handler"] == 2:
        found.append("Active Input Handling is set to Both.")
    elif p["handler"] != 1:
        found.append(f"Active Input Handling has an unknown value ({p['handler']}).")
    if p["packageMissing"]:
        found.append(f"The Input System package ({PACKAGE}) isn't installed.")
    return "\n".join([
        f"{HEAD}: Satura Space didn't start Unity for {Path(root).name}. {' '.join(found)}",
        "Satura Space works only with the Input System. The old Input Manager reads input straight from the OS, so keys and clicks in the Satura panel never reach it, and Both has the same problem.",
        "To fix it in Unity: Edit > Project Settings > Player > Other Settings > Active Input Handling > Input System Package (New), then install Input System from Window > Package Manager.",
        f"To fix it without Unity: set activeInputHandler: 1 in ProjectSettings/ProjectSettings.asset and add \"{PACKAGE}\": \"<version>\" to the dependencies in Packages/manifest.json, with a version Package Manager lists for your Unity.",
        "Then launch again.",
    ])


def refusal(root) -> str | None:
    p = problem(root)
    return message(root, p) if p else None


LEGACY_MEMBERS = {
    "GetKey": "Keyboard.current.<key>Key.isPressed",
    "GetKeyDown": "Keyboard.current.<key>Key.wasPressedThisFrame",
    "GetKeyUp": "Keyboard.current.<key>Key.wasReleasedThisFrame",
    "GetMouseButton": "Mouse.current.leftButton.isPressed (rightButton, middleButton)",
    "GetMouseButtonDown": "Mouse.current.leftButton.wasPressedThisFrame",
    "GetMouseButtonUp": "Mouse.current.leftButton.wasReleasedThisFrame",
    "mousePosition": "Mouse.current.position.ReadValue()",
    "mousePositionDelta": "Mouse.current.delta.ReadValue()",
    "mouseScrollDelta": "Mouse.current.scroll.ReadValue()",
    "GetAxis": "an InputAction (a Vector2 Move action, or Mouse.current.delta for look)",
    "GetAxisRaw": "an InputAction (a Vector2 Move action, or Mouse.current.delta for look)",
    "GetButton": "an InputAction's IsPressed()",
    "GetButtonDown": "an InputAction's WasPressedThisFrame()",
    "GetButtonUp": "an InputAction's WasReleasedThisFrame()",
    "anyKey": "Keyboard.current.anyKey.isPressed",
    "anyKeyDown": "Keyboard.current.anyKey.wasPressedThisFrame",
    "inputString": "Keyboard.current.onTextInput",
    "touches": "Touchscreen.current or EnhancedTouch.Touch.activeTouches",
    "touchCount": "EnhancedTouch.Touch.activeTouches.Count",
    "GetTouch": "EnhancedTouch.Touch.activeTouches[i]",
    "acceleration": "Accelerometer.current",
    "gyro": "Gyroscope.current",
    "compositionString": "Keyboard.current.onIMECompositionChange",
    "imeCompositionMode": "Keyboard.current.SetIMEEnabled()",
}
LEGACY_CALL = re.compile(r"(?<![\w.])(?:UnityEngine\.)?Input\.([A-Za-z_]\w*)")
LEGACY_MODULE = re.compile(r"\b(StandaloneInputModule|TouchInputModule)\b")
MODULE_GUIDS = {
    "4f231c4fb786f3946a6b90b886c48677": "StandaloneInputModule",
    "2d49b7c1bcd2e07499844da127be038d": "TouchInputModule",
}
MODULE_IDS = re.compile(r"EventSystems\.(StandaloneInputModule|TouchInputModule)\b")
SKIP_DIRS = {"Library", "Temp", "Logs", "obj", "UserSettings", ".git", ".sspace"}
MAX_ASSET_BYTES = 64 * 1024 * 1024
SHOWN = 10

_cache: dict[str, dict[str, tuple[float, int, list[str]]]] = {}


def _scan_cs(rel: str, text: str) -> list[str]:
    out = []
    block = False
    for i, line in enumerate(text.splitlines(), 1):
        code = line
        if block:
            end = code.find("*/")
            if end < 0:
                continue
            code = code[end + 2:]
            block = False
        code = re.sub(r"/\*.*?\*/", "", code)
        start = code.find("/*")
        if start >= 0:
            code = code[:start]
            block = True
        code = code.split("//", 1)[0]
        for m in LEGACY_CALL.finditer(code):
            member = m.group(1)
            use = LEGACY_MEMBERS.get(member, "an Input System device (Keyboard.current, Mouse.current, Gamepad.current) or an InputAction")
            out.append(f"{rel}:{i}: Input.{member} → {use}")
        for m in LEGACY_MODULE.finditer(code):
            out.append(f"{rel}:{i}: {m.group(1)} → InputSystemUIInputModule")
    return out


def _scan_asset(rel: str, path: Path) -> list[str]:
    try:
        if path.stat().st_size > MAX_ASSET_BYTES:
            return []
        data = path.read_bytes()
    except OSError:
        return []
    if not any(g.encode() in data for g in MODULE_GUIDS) and b"EventSystems." not in data:
        return []
    out = []
    by_guid = any(g.encode() in data for g in MODULE_GUIDS)
    for i, line in enumerate(data.decode("utf-8", errors="replace").splitlines(), 1):
        if by_guid:
            name = next((n for g, n in MODULE_GUIDS.items() if g in line), None)
        else:
            m = MODULE_IDS.search(line)
            name = m.group(1) if m else None
        if name:
            out.append(f"{rel}:{i}: an EventSystem uses {name} → select it and press Replace with InputSystemUIInputModule, or swap the component")
    return out


def _sources(root: Path):
    bases = [root / "Assets"]
    pk = root / "Packages"
    if pk.is_dir():
        for d in sorted(pk.iterdir()):
            if d.is_dir() and not d.name.startswith("com.saturaspace."):
                bases.append(d)
    for base in bases:
        if not base.is_dir():
            continue
        for dirpath, dirnames, filenames in os.walk(base):
            dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS and not d.startswith(".") and not d.endswith("~")]
            for f in filenames:
                if f.endswith((".cs", ".unity", ".prefab")):
                    yield Path(dirpath) / f


CACHE_FILE = ".legacy_input_scan.json"


def _load(root: Path) -> dict | None:
    try:
        data = json.loads((root / ".sspace" / CACHE_FILE).read_text(encoding="utf-8"))
        return {k: (v[0], v[1], list(v[2])) for k, v in data.items()}
    except (OSError, ValueError, TypeError, IndexError, AttributeError):
        return None


def _save(root: Path, cur: dict) -> None:
    try:
        d = root / ".sspace"
        if d.is_dir():
            (d / CACHE_FILE).write_text(json.dumps(cur), encoding="utf-8")
    except OSError:
        pass


def legacy_input_findings(root) -> tuple[list[str], list[str]]:
    root = Path(root)
    key = str(root.resolve())
    prev = _cache.get(key)
    if prev is None:
        prev = _load(root)
    cur: dict[str, tuple[float, int, list[str]]] = {}
    fresh: list[str] = []
    known: list[str] = []
    for path in _sources(root):
        try:
            st = path.stat()
        except OSError:
            continue
        rel = path.relative_to(root).as_posix()
        old = (prev or {}).get(rel)
        if old and old[0] == st.st_mtime and old[1] == st.st_size:
            cur[rel] = old
            known.extend(old[2])
            continue
        if path.suffix == ".cs":
            text = _read(path) or ""
            found = _scan_cs(rel, text) if "Input" in text else []
        else:
            found = _scan_asset(rel, path)
        cur[rel] = (st.st_mtime, st.st_size, found)
        (fresh if prev is not None else known).extend(found)
    _cache[key] = cur
    _save(root, cur)
    if prev is None:
        return known, []
    return fresh, known


VENDOR = re.compile(r"^(Packages/[^/:]+|Assets/(?:[^/:]+/)*?(?:ThirdParty|Third Party|Third-Party|Plugins|Vendor|AssetStore)/[^/:]+)/", re.I)


def _vendor(finding: str) -> str | None:
    m = VENDOR.match(finding)
    return m.group(1) if m else None


def legacy_input_note(root) -> str | None:
    try:
        fresh, known = legacy_input_findings(root)
    except Exception:
        return None
    own = [f for f in fresh if not _vendor(f)]
    vendors: dict[str, int] = {}
    for f in fresh:
        v = _vendor(f)
        if v:
            vendors[v] = vendors.get(v, 0) + 1
    if not own and not vendors:
        return None
    lines = []
    if own:
        shown = own[:SHOWN]
        more = len(own) - len(shown)
        lines.append(
            "Legacy input: this project runs on the Input System only, so the old Input Manager is off. "
            "UnityEngine.Input calls throw InvalidOperationException in Play Mode, and StandaloneInputModule "
            "or TouchInputModule leaves uGUI without clicks. Use Keyboard.current, Mouse.current, InputAction "
            "and InputSystemUIInputModule (namespace UnityEngine.InputSystem) instead:"
        )
        lines += [f"  {s}" for s in shown]
        if more:
            lines.append(f"  and {more} more")
    if vendors:
        where = ", ".join(f"{v} ({n})" for v, n in sorted(vendors.items(), key=lambda x: -x[1]))
        lead = "Third-party code also uses the old Input" if own else "Legacy input in third-party code (this project runs on the Input System only, so these calls throw InvalidOperationException in Play Mode)"
        lines.append(f"{lead}: {where}. Leave it unless the user asks to port it.")
    if known and own:
        lines.append(f"  ({len(known)} earlier finding(s) in files that haven't changed are not repeated)")
    return "\n".join(lines)
