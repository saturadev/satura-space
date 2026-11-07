import json
import os
import re
import uuid
from pathlib import Path
from typing import Annotated, Literal

from pydantic import Field

from .helpers import resolve_root, tool_guard
from .params import ProjectRoot
from .multiplayer import orchestrator_present, request_player_command, resolve_player_dir
from .sspace import ensure_sspace_for

_VIEW_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
_OBJECT_KEYS = ("path", "scene", "label", "components", "exclude", "children")
_UI_KEYS = ("path", "scene", "label", "components", "exclude")
_COMPONENT_KEYS = ("type", "index", "fields", "exclude")
_TYPE_NAME = re.compile(r"^[A-Za-z_][\w.+]*$")
_COMPONENT_KEY = re.compile(r"^([A-Za-z_][\w.+]*)(?:#(\d+))?$")
_FIELD_PATH = re.compile(r"^[A-Za-z_](?:[\w.\[\]]| (?=[\w\[]))*$")
_STATE_NAME = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
_METHOD = re.compile(r"^[A-Za-z_]\w*$")
_STATE_KEYS = ("name", "label", "note", "objects", "camera", "setup", "pause")
_ANIMATE_KEYS = ("path", "scene", "state", "clip", "layer", "time", "seconds")
_CALL_KEYS = ("type", "path", "scene", "component", "method")
_SET_KEYS = ("path", "scene", "component", "field", "value")
_ASSET_KEYS = ("path", "label", "fields", "exclude")
_BUTTON_KEYS = ("label", "method", "type", "path", "scene", "component", "asset", "tip", "mode", "step")
_ANIMATOR_KEYS = ("path", "clip")
_MAX_STATES = 16
_MAX_BUTTONS = 24


def _views_dir(root: Path) -> Path:
    return root / ".sspace" / "tuners"


def _clean_filter(where: str, raw: dict, problems: list[str]) -> dict | None:
    fields, exclude = raw.get("fields"), raw.get("exclude")
    if fields is not None and exclude is not None:
        problems.append(f"{where} has both fields and exclude: use fields for only these properties or exclude for all "
                        "but these")
        return None
    out: dict = {}
    for key, value in (("fields", fields), ("exclude", exclude)):
        if value is None:
            continue
        if not isinstance(value, list) or not all(isinstance(f, str) and _FIELD_PATH.match(f) for f in value):
            problems.append(f"{where}.{key} must be a list of serialized property paths like 'm_Size' or 'settings.speed'")
            return None
        if value or key == "fields":
            out[key] = list(dict.fromkeys(value))
    return out


def _clean_component(where: str, raw, problems: list[str]) -> dict | None:
    if isinstance(raw, str):
        m = _COMPONENT_KEY.match(raw.strip())
        if not m:
            problems.append(f"{where} must be a component type name like 'BoxCollider' or 'AudioSource#1', got {raw!r}")
            return None
        index = int(m.group(2) or 0)
        return {"type": m.group(1), "index": index} if index > 0 else {"type": m.group(1)}
    if not isinstance(raw, dict):
        problems.append(f"{where} must be a type name or an object {{type, index, fields or exclude}}")
        return None
    unknown = sorted(set(raw) - set(_COMPONENT_KEYS))
    if unknown:
        problems.append(f"{where} has unknown keys {unknown} (allowed: {', '.join(_COMPONENT_KEYS)})")
    t = raw.get("type")
    if not isinstance(t, str) or not _TYPE_NAME.match(t.strip()):
        problems.append(f"{where}.type must be a component type name, got {t!r}")
        return None
    out = {"type": t.strip()}
    index = raw.get("index", 0)
    if not isinstance(index, int) or isinstance(index, bool) or index < 0:
        problems.append(f"{where}.index must be a non-negative integer")
        return None
    if index > 0:
        out["index"] = index
    flt = _clean_filter(where, raw, problems)
    if flt is None:
        return None
    out.update(flt)
    return out


def _clean_component_keys(where: str, keys, problems: list[str]) -> list[str] | None:
    if not isinstance(keys, list):
        problems.append(f"{where} must be a list of component keys like 'Rigidbody' or 'AudioSource#1'")
        return None
    out: list[str] = []
    for j, k in enumerate(keys):
        m = _COMPONENT_KEY.match(k.strip()) if isinstance(k, str) else None
        if not m:
            problems.append(f"{where}[{j}] must be a component key like 'Rigidbody' or 'AudioSource#1', got {k!r}")
            return None
        index = int(m.group(2) or 0)
        key = f"{m.group(1)}#{index}" if index > 0 else m.group(1)
        if key not in out:
            out.append(key)
    return out


def _describe_filter(item: dict) -> str:
    if "fields" in item:
        return f" [{', '.join(item['fields'])}]" if item["fields"] else " [title bar only]"
    if item.get("exclude"):
        return f" [all but {', '.join(item['exclude'])}]"
    return ""


def _component_key(c: dict) -> str:
    return f"{c['type']}#{c['index']}" if c.get("index") else c["type"]


def _clean_object(where: str, raw, allowed: tuple, problems: list[str]) -> dict | None:
    if not isinstance(raw, dict):
        problems.append(f"{where} is not an object")
        return None
    if "fields" in raw and "fields" not in allowed:
        problems.append(f"{where}.fields is not an object key: filter properties per component, e.g. "
                        f"\"components\": [{{\"type\": \"Image\", \"fields\": [\"m_Color\"]}}]")
        raw = {k: v for k, v in raw.items() if k != "fields"}
    unknown = sorted(set(raw) - set(allowed))
    if unknown:
        problems.append(f"{where} has unknown keys {unknown} (allowed: {', '.join(allowed)})")
    path = raw.get("path")
    if not isinstance(path, str) or not path.strip("/ "):
        problems.append(f"{where}.path must be a hierarchy path like 'Level/Props/Crate'")
        return None
    obj = {"path": path.strip().strip("/")}
    for k in ("scene", "label"):
        v = raw.get(k)
        if v in (None, ""):
            continue
        if not isinstance(v, str):
            problems.append(f"{where}.{k} must be a string")
            continue
        obj[k] = v
    children = raw.get("children")
    if "children" in allowed and children is not None:
        if not isinstance(children, bool):
            problems.append(f"{where}.children must be true or false")
            return None
        if children:
            obj["children"] = True
    comps = raw.get("components")
    if comps is not None and raw.get("exclude") is not None:
        problems.append(f"{where} has both components and exclude: use components for only these or exclude for "
                        "every component but these")
        return None
    if comps is None:
        if raw.get("exclude") is not None:
            excluded = _clean_component_keys(f"{where}.exclude", raw["exclude"], problems)
            if excluded is None:
                return None
            if excluded:
                obj["exclude"] = excluded
        return obj
    if not isinstance(comps, list):
        problems.append(f"{where}.components must be a list, or leave it out to show every component")
        return None
    clean: list[dict] = []
    seen: set[str] = set()
    for j, c in enumerate(comps):
        spec = _clean_component(f"{where}.components[{j}]", c, problems)
        if spec is None:
            continue
        key = _component_key(spec)
        if key in seen:
            problems.append(f"{where}.components[{j}] repeats {key}")
            continue
        seen.add(key)
        clean.append(spec)
    obj["components"] = clean
    return obj


def _clean_objects(objects, prefix: str = "objects", allow_empty: bool = False) -> tuple[list[dict], list[str]]:
    out: list[dict] = []
    problems: list[str] = []
    if objects is None and allow_empty:
        return out, problems
    if not isinstance(objects, list) or (not objects and not allow_empty):
        return out, [f"{prefix} must be a non-empty list"]
    for i, raw in enumerate(objects):
        obj = _clean_object(f"{prefix}[{i}]", raw, _OBJECT_KEYS, problems)
        if obj is not None:
            out.append(obj)
    return out, problems


def _clean_ui(ui) -> tuple[dict | None, list[str]]:
    if ui is None:
        return None, []
    if isinstance(ui, str):
        ui = {"path": ui}
    problems: list[str] = []
    if not isinstance(ui, dict):
        return None, ["ui must be {\"path\": \"Canvas\" or \"Canvas/Panel\", \"scene\": \"...\"}"]
    obj = _clean_object("ui", ui, _UI_KEYS, problems)
    return obj, problems


def _in_scene(entries, scope: str):
    if entries is None:
        return None
    one = lambda e: {"path": e, "scene": scope} if isinstance(e, str) else ({**e, "scene": scope} if isinstance(e, dict) and not e.get("scene") else e)
    return [one(e) for e in entries] if isinstance(entries, list) else one(entries)


def _clean_scene(scene) -> tuple[str | bool | None, list[str]]:
    if scene is None or scene is False:
        return None, []
    if scene is True:
        return True, []
    if isinstance(scene, str) and scene.strip():
        return scene.strip(), []
    return None, ["scene must be true (every loaded scene) or the name or path of one scene"]


_MAX_PREFABS = 32


def _clean_prefabs(root: Path, prefabs) -> tuple[list[str], list[str]]:
    out: list[str] = []
    problems: list[str] = []
    if prefabs is None:
        return out, problems
    if not isinstance(prefabs, list) or not prefabs:
        return out, ["prefabs must be a non-empty list of prefab asset paths, e.g. [\"Assets/Prefabs/Crate.prefab\"]"]
    for i, raw in enumerate(prefabs):
        where = f"prefabs[{i}]"
        if isinstance(raw, dict):
            raw = raw.get("path")
        path = _asset_path(raw)
        if path is None or not path.startswith("Assets/") or not path.lower().endswith(".prefab"):
            problems.append(f"{where} must be an 'Assets/....prefab' path, got {raw!r}")
            continue
        if not (root / path).exists():
            problems.append(f"{where} not found on disk: {path}")
            continue
        if path not in out:
            out.append(path)
    if len(out) > _MAX_PREFABS:
        problems.append(f"a prefab Tuner holds {_MAX_PREFABS} prefabs at most")
    return out, problems


def _view_kind(view: dict | None) -> str:
    if not view:
        return ""
    if view.get("kind") == "prefabs":
        return "prefabs"
    if view.get("kind") == "scene":
        return "scene"
    if view.get("kind") != "objects" and isinstance(view.get("ui"), dict):
        return "ui"
    if view.get("objects") or any(isinstance(st, dict) and st.get("objects") for st in view.get("states") or []):
        return "objects"
    return ""


def _asset_path(raw) -> str | None:
    if not isinstance(raw, str):
        return None
    path = raw.strip().replace("\\", "/")
    if not path.startswith(("Assets/", "Packages/")) or ".." in path.split("/") or "\n" in path:
        return None
    return path


def _clean_assets(root: Path, assets) -> tuple[list[dict], list[str]]:
    out: list[dict] = []
    problems: list[str] = []
    if assets is None:
        return out, problems
    if not isinstance(assets, list):
        return out, ["assets must be a list of {\"path\": \"Assets/...\", \"label\": \"...\"}"]
    seen: set[str] = set()
    for i, raw in enumerate(assets):
        where = f"assets[{i}]"
        if isinstance(raw, str):
            raw = {"path": raw}
        if not isinstance(raw, dict):
            problems.append(f"{where} must be an asset path or {{\"path\", \"label\", \"fields\" or \"exclude\"}}")
            continue
        _unknown(where, raw, _ASSET_KEYS, problems)
        path = _asset_path(raw.get("path"))
        if path is None:
            problems.append(f"{where}.path must be an 'Assets/...' or 'Packages/...' path, got {raw.get('path')!r}")
            continue
        if path.startswith("Assets/") and not (root / path).exists():
            problems.append(f"{where}.path not found on disk: {path}")
            continue
        if path in seen:
            continue
        seen.add(path)
        item = {"path": path}
        label = raw.get("label")
        if isinstance(label, str) and label.strip():
            item["label"] = label.strip()
        elif label not in (None, ""):
            problems.append(f"{where}.label must be a string")
        flt = _clean_filter(where, raw, problems)
        if flt is None:
            continue
        item.update(flt)
        out.append(item)
    return out, problems


def _clean_buttons(root: Path, buttons) -> tuple[list[dict], list[str]]:
    out: list[dict] = []
    problems: list[str] = []
    if buttons is None:
        return out, problems
    if not isinstance(buttons, list):
        return out, ["buttons must be a list of button objects"]
    if len(buttons) > _MAX_BUTTONS:
        problems.append(f"buttons has {len(buttons)} entries; the limit is {_MAX_BUTTONS}")
    seen: set[str] = set()
    for i, raw in enumerate(buttons[:_MAX_BUTTONS]):
        where = f"buttons[{i}]"
        if not isinstance(raw, dict):
            problems.append(f"{where} is not an object")
            continue
        _unknown(where, raw, _BUTTON_KEYS, problems)
        label = raw.get("label")
        if not isinstance(label, str) or not label.strip() or len(label.strip()) > 40:
            problems.append(f"{where}.label must be a short text (1 to 40 characters)")
            continue
        label = label.strip()
        method = raw.get("method")
        if not isinstance(method, str) or not _METHOD.match(method):
            problems.append(f"{where}.method must be a parameterless method name like 'Respawn'")
            continue
        forms = [bool(raw.get("type")), bool(raw.get("path") or raw.get("component")), bool(raw.get("asset"))]
        if sum(forms) != 1:
            problems.append(f"{where} needs exactly one of \"type\" (static method), \"path\" + \"component\" "
                            f"(scene object) or \"asset\"")
            continue
        item = {"label": label, "method": method}
        if forms[0]:
            t = raw.get("type")
            if not isinstance(t, str) or not _TYPE_NAME.match(t.strip()):
                problems.append(f"{where}.type must be a type name, got {t!r}")
                continue
            item["type"] = t.strip()
        elif forms[1]:
            path = _hier_path(where, raw, problems)
            comp = raw.get("component")
            if not isinstance(comp, str) or not _TYPE_NAME.match(comp.strip()):
                problems.append(f"{where}.component must be a component type name")
                continue
            if path is None:
                continue
            item["path"] = path
            item["component"] = comp.strip()
            if isinstance(raw.get("scene"), str) and raw["scene"]:
                item["scene"] = raw["scene"]
        else:
            path = _asset_path(raw.get("asset"))
            if path is None:
                problems.append(f"{where}.asset must be an 'Assets/...' path, got {raw.get('asset')!r}")
                continue
            if path.startswith("Assets/") and not (root / path).exists():
                problems.append(f"{where}.asset not found on disk: {path}")
                continue
            item["asset"] = path
        tip = raw.get("tip")
        if tip is not None:
            if not isinstance(tip, str) or not tip.strip() or len(tip.strip()) > 400:
                problems.append(f"{where}.tip must be a short text (1 to 400 characters)")
                continue
            item["tip"] = tip.strip()
        mode = raw.get("mode")
        if mode is not None:
            if mode not in ("play", "edit"):
                problems.append(f"{where}.mode must be \"play\" or \"edit\", got {mode!r}")
                continue
            item["mode"] = mode
        step = raw.get("step")
        if step is not None:
            if not isinstance(step, str) or not step.strip() or len(step.strip()) > 40:
                problems.append(f"{where}.step must be the step list's title (1 to 40 characters)")
                continue
            item["step"] = step.strip()
        if label in seen:
            problems.append(f"{where}.label repeats {label!r}")
            continue
        seen.add(label)
        out.append(item)
    return out, problems


def _load_view(path: Path) -> dict | None:
    try:
        view = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(view, dict) or ("items" in view and "objects" not in view and "states" not in view):
        return None
    return view


def _merge_list(old, new: list[dict], key) -> list[dict]:
    out = [o for o in old if isinstance(o, dict)] if isinstance(old, list) else []
    for item in new:
        k = key(item)
        at = next((i for i, o in enumerate(out) if key(o) == k), -1)
        if at >= 0:
            out[at] = item
        else:
            out.append(item)
    return out


def _other_views(d: Path, name: str) -> list[str]:
    if not d.is_dir():
        return []
    return sorted(f.stem for f in d.glob("*.json") if f.stem != name and _load_view(f) is not None)


def _vec3(v) -> bool:
    return (isinstance(v, list) and len(v) == 3
            and all(isinstance(n, (int, float)) and not isinstance(n, bool) for n in v))


def _clean_camera(camera) -> tuple[dict | None, str | None]:
    if camera is None:
        return None, None
    if not isinstance(camera, dict) or set(camera) - {"position", "lookAt"}:
        return None, "camera must be {\"position\": [x, y, z], \"lookAt\": [x, y, z]}"
    if not _vec3(camera.get("position")) or not _vec3(camera.get("lookAt")):
        return None, "camera.position and camera.lookAt must be lists of 3 numbers"
    if list(camera["position"]) == list(camera["lookAt"]):
        return None, "camera.position and camera.lookAt must differ"
    return {"position": list(camera["position"]), "lookAt": list(camera["lookAt"])}, None


def _num(v) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool)


def _hier_path(where: str, raw: dict, problems: list[str]) -> str | None:
    path = raw.get("path")
    if not isinstance(path, str) or not path.strip("/ "):
        problems.append(f"{where}.path must be a hierarchy path like 'Hero' or 'Level/Door'")
        return None
    return path.strip().strip("/")


def _unknown(where: str, raw: dict, allowed: tuple, problems: list[str]) -> None:
    extra = sorted(set(raw) - set(allowed))
    if extra:
        problems.append(f"{where} has unknown keys {extra} (allowed: {', '.join(allowed)})")


def _clean_step(where: str, raw, problems: list[str]) -> tuple[dict | None, bool]:
    if not isinstance(raw, dict) or len(raw) != 1:
        problems.append(f"{where} must be one of {{\"animate\": {{...}}}}, {{\"call\": {{...}}}}, {{\"set\": {{...}}}} "
                        f"or {{\"pause\": true}}")
        return None, False
    kind, body = next(iter(raw.items()))
    if kind == "pause":
        if body is not True:
            problems.append(f"{where}.pause must be true")
        return None, body is True
    if kind not in ("animate", "call", "set") or not isinstance(body, dict):
        problems.append(f"{where} must be one of animate, call, set or pause, got {kind!r}")
        return None, False
    w = f"{where}.{kind}"
    if kind == "animate":
        _unknown(w, body, _ANIMATE_KEYS, problems)
        path = _hier_path(w, body, problems)
        out = {"path": path}
        for k in ("scene", "state", "clip"):
            v = body.get(k)
            if v in (None, ""):
                continue
            if not isinstance(v, str):
                problems.append(f"{w}.{k} must be a string")
                continue
            out[k] = v
        if "state" not in out and "clip" not in out:
            problems.append(f"{w} needs an Animator \"state\" or an AnimationClip \"clip\"")
        layer = body.get("layer")
        if layer is not None:
            if not isinstance(layer, int) or isinstance(layer, bool) or layer < 0:
                problems.append(f"{w}.layer must be a non-negative integer")
            else:
                out["layer"] = layer
        time = body.get("time")
        if time is not None:
            if not _num(time) or not 0 <= time <= 1:
                problems.append(f"{w}.time is the normalized time, a number from 0 to 1")
            else:
                out["time"] = time
        seconds = body.get("seconds")
        if seconds is not None:
            if "clip" not in out:
                problems.append(f"{w}.seconds only works with \"clip\"; use \"time\" (0 to 1) with \"state\"")
            elif not _num(seconds) or seconds < 0:
                problems.append(f"{w}.seconds must be a non-negative number")
            else:
                out["seconds"] = seconds
        return (out if path else None), False
    if kind == "call":
        _unknown(w, body, _CALL_KEYS, problems)
        method = body.get("method")
        if not isinstance(method, str) or not _METHOD.match(method):
            problems.append(f"{w}.method must be a parameterless method name like 'SpawnWave'")
            return None, False
        has_type = isinstance(body.get("type"), str) and bool(body["type"].strip())
        has_target = "path" in body or "component" in body
        if not has_type and not has_target:
            problems.append(f"{w} needs \"type\" for a static method, or \"path\" and \"component\"")
            return None, False
        if has_type and has_target:
            problems.append(f"{w} is either static (type) or on an object (path + component), not both")
            return None, False
        if has_type:
            if not _TYPE_NAME.match(body["type"].strip()):
                problems.append(f"{w}.type must be a type name, got {body['type']!r}")
                return None, False
            return {"type": body["type"].strip(), "method": method}, False
        path = _hier_path(w, body, problems)
        comp = body.get("component")
        if not isinstance(comp, str) or not _TYPE_NAME.match(comp.strip()):
            problems.append(f"{w}.component must be a component type name (or use \"type\" for a static method)")
            return None, False
        if not path:
            return None, False
        out = {"path": path, "component": comp.strip(), "method": method}
        if isinstance(body.get("scene"), str) and body["scene"]:
            out["scene"] = body["scene"]
        return out, False
    _unknown(w, body, _SET_KEYS, problems)
    path = _hier_path(w, body, problems)
    comp = body.get("component")
    field = body.get("field")
    value = body.get("value")
    ok = path is not None
    if not isinstance(comp, str) or not _TYPE_NAME.match(comp.strip()):
        problems.append(f"{w}.component must be a component type name")
        ok = False
    if not isinstance(field, str) or not _FIELD_PATH.match(field):
        problems.append(f"{w}.field must be a serialized property path like 'm_Size' or 'settings.speed'")
        ok = False
    if isinstance(value, bool):
        value = "true" if value else "false"
    elif _num(value):
        value = str(value)
    elif isinstance(value, list) and value and all(_num(n) for n in value):
        value = ",".join(str(n) for n in value)
    elif not isinstance(value, str):
        problems.append(f"{w}.value must be a string like \"2.5\" or \"1,0,0\" (numbers, booleans and number lists are converted)")
        ok = False
    if not ok:
        return None, False
    out = {"path": path, "component": comp.strip(), "field": field, "value": value}
    if isinstance(body.get("scene"), str) and body["scene"]:
        out["scene"] = body["scene"]
    return out, False


def _clean_states(states, shared: int) -> tuple[list[dict], list[str]]:
    out: list[dict] = []
    problems: list[str] = []
    if states is None:
        return out, problems
    if not isinstance(states, list) or not states:
        return out, ["states must be a non-empty list (or leave it out)"]
    if len(states) > _MAX_STATES:
        problems.append(f"states has {len(states)} entries; the limit is {_MAX_STATES}")
    seen: set[str] = set()
    for i, raw in enumerate(states[:_MAX_STATES]):
        where = f"states[{i}]"
        if not isinstance(raw, dict):
            problems.append(f"{where} is not an object")
            continue
        _unknown(where, raw, _STATE_KEYS, problems)
        name = raw.get("name")
        if not isinstance(name, str) or not _STATE_NAME.match(name):
            problems.append(f"{where}.name must match [A-Za-z0-9._-], e.g. \"frame-12\"")
            continue
        if name in seen:
            problems.append(f"{where}.name repeats {name!r}")
            continue
        seen.add(name)
        st = {"name": name}
        for k in ("label", "note"):
            v = raw.get(k)
            if v in (None, ""):
                continue
            if not isinstance(v, str):
                problems.append(f"{where}.{k} must be a string")
                continue
            st[k] = v
        objs, obj_problems = _clean_objects(raw.get("objects"), f"{where}.objects", allow_empty=True)
        problems.extend(obj_problems)
        if not objs and not shared and not obj_problems:
            problems.append(f"{where} has no objects to tune (give it \"objects\" or pass top-level objects)")
        st["objects"] = objs
        cam, cam_err = _clean_camera(raw.get("camera"))
        if cam_err:
            problems.append(f"{where}.{cam_err}")
        elif cam:
            st["camera"] = cam
        pause = raw.get("pause", False)
        if not isinstance(pause, bool):
            problems.append(f"{where}.pause must be true or false")
            pause = False
        setup = raw.get("setup") or []
        if not isinstance(setup, list):
            problems.append(f"{where}.setup must be a list of steps")
            setup = []
        steps = []
        for j, step in enumerate(setup):
            clean, is_pause = _clean_step(f"{where}.setup[{j}]", step, problems)
            if is_pause:
                pause = True
            elif clean is not None:
                steps.append({next(iter(step)): clean})
        st["setup"] = steps
        if pause:
            st["pause"] = True
        out.append(st)
    return out, problems


def _clean_animator(animator) -> tuple[dict | None, list[str]]:
    if animator is None:
        return None, []
    if isinstance(animator, str):
        animator = {"path": animator}
    if not isinstance(animator, dict):
        return None, ['animator must be {"path": "SaturaCube", "clip": "Bob"} (clip is optional)']
    problems: list[str] = []
    _unknown("animator", animator, _ANIMATOR_KEYS, problems)
    path = _hier_path("animator", animator, problems)
    out: dict = {"path": path} if path else {}
    clip = animator.get("clip")
    if clip is not None:
        if not isinstance(clip, str) or not clip.strip() or len(clip) > 512 or "\n" in clip:
            problems.append("animator.clip must be a clip name like \"Bob\" or an asset path like \"Assets/Anim/Cube/Bob.anim\"")
        else:
            out["clip"] = clip.strip()
    return (out if not problems else None), problems


def _loaded_scenes(root: Path) -> list[dict] | None:
    try:
        data = json.loads((root / ".sspace" / ".mcp_status.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    scenes = data.get("scenes") if isinstance(data, dict) else None
    if not isinstance(scenes, list):
        return None
    return [x for x in scenes if isinstance(x, dict) and x.get("loaded") is not False]


def _unloaded_scenes(root: Path, named: list[str]) -> str | None:
    loaded = _loaded_scenes(root)
    if not named or loaded is None:
        return None
    def is_loaded(want: str) -> bool:
        w = want.strip().replace("\\", "/")
        bare = w[:-6] if w.lower().endswith(".unity") else w
        for x in loaded:
            name = str(x.get("name") or "")
            path = str(x.get("path") or "")
            if w in (name, path) or bare == name or path.endswith("/" + w) or path.endswith("/" + bare + ".unity"):
                return True
        return False
    gone = [n for n in dict.fromkeys(named) if not is_loaded(n)]
    if not gone:
        return None
    open_now = ", ".join(str(x.get("path") or x.get("name")) for x in loaded) or "none"
    return (f"ERROR: {', '.join(gone)} isn't open in the Unity editor (open now: {open_now}). The Tuner shows only "
            f"loaded scenes and never switches scenes. Open it first with unity.openScene(), then call tuner.open() "
            f"again. Nothing was written.")


def _not_managed() -> str:
    return ("The Satura Space app is not managing this project, so no panel was opened. "
            "The user can open it from the + menu once the app is running.")


@tool_guard
async def unity_tuner(
    name: Annotated[str, Field(description="View id, [A-Za-z0-9._-]. The same name replaces the view, or adds to it with merge.")],
    objects: Annotated[list[dict] | None, Field(description="A hand-picked list of GameObjects, see WHAT TO SHOW and FILTERS.")] = None,
    ui: Annotated[dict | str | None, Field(description='A canvas or anything under one: "Canvas/ShopPanel" or {"path", "components" | "exclude"}.')] = None,
    scene: Annotated[bool | str | None, Field(description="True for every loaded scene, or a scene name or path for one scene.")] = None,
    prefabs: Annotated[list[str] | None, Field(description='Prefab asset paths ("Assets/....prefab"), edited like Unity\'s prefab mode.')] = None,
    assets: Annotated[list[dict | str] | None, Field(description='"Assets/..." or {path, label, fields | exclude}: ScriptableObjects, materials and other assets.')] = None,
    buttons: Annotated[list[dict] | None, Field(description="Footer buttons, see BUTTONS.")] = None,
    title: Annotated[str, Field(description="Tab title. Defaults to name.")] = "",
    note: Annotated[str, Field(description="Short instruction shown above the scene view: what to adjust and why.")] = "",
    camera: Annotated[dict | None, Field(description="{position, lookAt} start pose. Without it the objects are framed.")] = None,
    states: Annotated[list[dict] | None, Field(description="1-16 states {name, label, note, objects, camera, setup, pause}. Play Mode only, not with prefabs.")] = None,
    mode: Annotated[Literal["", "2d", "3d"], Field(description='"" picks 2D for sprites and UI on its own.')] = "",
    animator: Annotated[dict | None, Field(description="{path, clip} opens the timeline on that clip.")] = None,
    merge: Annotated[bool, Field(description="Add to the view instead of replacing it.")] = False,
    project_root: ProjectRoot = "",
    open_panel: Annotated[bool, Field(description="Open the Tuner tab for the user.")] = True,
) -> str:
    root, _ = resolve_player_dir(resolve_root(project_root))
    if not _VIEW_NAME.match(name or ""):
        return "ERROR: name must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}"
    d = _views_dir(root)
    target = d / f"{name}.json"
    existing = _load_view(target) if merge else None
    problems: list[str] = []
    scene_given = scene is not None and scene is not False
    if prefabs is not None and (scene_given or ui is not None or objects is not None):
        other = "scene" if scene_given else "ui" if ui is not None else "objects"
        return (f"ERROR: pass either prefabs or {other}, not both. A prefab Tuner edits prefab assets on their own, "
                f"like Unity's prefab mode, so it cannot show scene objects too. Make two views."
                + (" A prefab Tuner always shows the whole prefab; to show only a few fields, filter an instance of it in the scene with objects."
                   if other == "objects" else ""))
    if scene_given and (ui is not None) != (objects is not None):
        scope = scene.strip() if isinstance(scene, str) else ""
        scene, scene_given = None, False
        if scope:
            ui, objects = _in_scene(ui, scope), _in_scene(objects, scope)
    if scene_given and (ui is not None or objects is not None):
        other = "ui" if ui is not None else "objects"
        return (f"ERROR: pass either scene or {other}, not both. A Tuner shows a whole scene (scene), one canvas (ui) "
                f"or a set of GameObjects (objects), never two of them together. Make two views, one with scene and "
                f"one with {other}.")
    if ui is not None and objects is not None:
        return ("ERROR: pass either ui or objects, not both. A Tuner shows one canvas (ui) or a set of GameObjects "
                "(objects), never both together. Make two views, one with ui and one with objects.")
    clean_scene, scene_problems = _clean_scene(scene)
    problems.extend(scene_problems)
    clean_ui, ui_problems = _clean_ui(ui)
    problems.extend(ui_problems)
    clean, obj_problems = _clean_objects(objects, allow_empty=True) if objects is None else _clean_objects(objects)
    problems.extend(obj_problems)
    clean_assets, asset_problems = _clean_assets(root, assets)
    problems.extend(asset_problems)
    clean_buttons, button_problems = _clean_buttons(root, buttons)
    problems.extend(button_problems)
    clean_animator, animator_problems = _clean_animator(animator)
    problems.extend(animator_problems)
    clean_prefabs, prefab_problems = _clean_prefabs(root, prefabs)
    problems.extend(prefab_problems)
    old_kind = _view_kind(existing)
    if merge and old_kind == "prefabs" and (scene_given or ui is not None or objects is not None):
        return (f"ERROR: view '{name}' is a prefab Tuner, so merge cannot add scene objects to it. Pass merge=False "
                f"to replace it, or use another name.")
    if merge and old_kind in ("scene", "ui", "objects") and prefabs is not None:
        return (f"ERROR: view '{name}' is not a prefab Tuner, so merge cannot add prefabs to it. Pass merge=False "
                f"to replace it with a prefab Tuner, or use another name.")
    is_prefabs = prefabs is not None or old_kind == "prefabs"
    if merge and old_kind == "scene" and (ui is not None or objects is not None):
        added, kind = ("a ui root", "UI") if ui is not None else ("objects", "GameObjects")
        return (f"ERROR: view '{name}' is a scene Tuner, so merge cannot add {added} to it. Pass merge=False to "
                f"replace it with a {kind} Tuner, or use another name.")
    if merge and old_kind in ("ui", "objects") and scene_given:
        return (f"ERROR: view '{name}' is a {'UI' if old_kind == 'ui' else 'GameObjects'} Tuner, so merge cannot add "
                f"a scene to it. Pass merge=False to replace it with a scene Tuner, or use another name.")
    is_scene = scene_given or old_kind == "scene"
    is_ui = ui is not None or (old_kind == "ui" and objects is None)
    if merge and old_kind == "objects" and ui is not None:
        return (f"ERROR: view '{name}' is a GameObjects Tuner, so merge cannot add a ui root to it. Pass merge=False "
                f"to replace it with a UI Tuner, or use another name.")
    if merge and old_kind == "ui" and objects is not None:
        return (f"ERROR: view '{name}' is a UI Tuner, so merge cannot add objects to it. Pass merge=False to replace "
                f"it with a GameObjects Tuner, or use another name.")
    shared = len(clean) + len(clean_assets) + (1 if clean_ui else 0) + (1 if is_scene else 0) + len(clean_prefabs)
    if existing:
        shared += len(existing.get("objects") or []) + len(existing.get("assets") or []) + len(existing.get("prefabs") or [])
        shared += 1 if old_kind == "ui" else 0
    clean_states, state_problems = _clean_states(states, shared)
    problems.extend(state_problems)
    if is_ui:
        for i, st in enumerate(clean_states):
            if st["objects"]:
                problems.append(f"states[{i}].objects is not allowed in a UI Tuner: the ui root is shown in every "
                                f"state, so give the state only setup steps, or make a GameObjects Tuner")
    if is_ui and clean_animator:
        problems.append("animator is not allowed in a UI Tuner: open the object in a scene or GameObjects Tuner")
    if (clean_animator and not is_scene and not is_ui and objects is None and not (existing or {}).get("objects")
            and not any(st["objects"] for st in clean_states)):
        clean = [{"path": clean_animator["path"]}]
        shared += len(clean)
    if is_prefabs and clean_states:
        problems.append("states are not allowed in a prefab Tuner: states are moments of the running game, and a "
                        "prefab Tuner edits prefab assets")
    if is_prefabs and clean_animator:
        problems.append("animator is not allowed in a prefab Tuner: open the timeline in a scene or GameObjects Tuner")
    if is_scene:
        for i, st in enumerate(clean_states):
            if st["objects"]:
                problems.append(f"states[{i}].objects is not allowed in a scene Tuner: the whole scene is shown in "
                                f"every state, so give the state only setup steps, or make a GameObjects Tuner")
    cam, cam_err = _clean_camera(camera)
    if cam_err:
        problems.append(cam_err)
    view_mode = (mode or "").strip().lower()
    if view_mode not in ("", "2d", "3d"):
        problems.append(f"mode must be \"2d\", \"3d\" or empty, got {mode!r}")
    if not problems and not shared and not any(st["objects"] for st in clean_states):
        problems.append("the view shows nothing: give it objects, assets or states with objects")
    if problems:
        return "ERROR: invalid tuner view:\n" + "\n".join(f"  - {p}" for p in problems)
    named = [clean_scene] if isinstance(clean_scene, str) else []
    if clean_ui and isinstance(clean_ui.get("scene"), str):
        named.append(clean_ui["scene"])
    named += [o["scene"] for o in clean if isinstance(o.get("scene"), str)]
    missing = _unloaded_scenes(root, named)
    if missing:
        return missing

    base = existing or {}
    view = {
        "title": title or base.get("title") or name,
        "note": note or base.get("note") or "",
        "paneKey": os.environ.get("SATURA_PANE_KEY", "") or base.get("paneKey", ""),
        "kind": "prefabs" if is_prefabs else "scene" if is_scene else "ui" if is_ui else "objects",
    }
    if is_prefabs:
        view["prefabs"] = _merge_list(base.get("prefabs"), clean_prefabs, lambda p: p)
    elif is_scene:
        scene_name = clean_scene if scene_given else base.get("scene")
        if isinstance(scene_name, str) and scene_name:
            view["scene"] = scene_name
    elif is_ui:
        view["ui"] = clean_ui or base["ui"]
    else:
        view["objects"] = _merge_list(base.get("objects"), clean, lambda o: (o.get("path"), o.get("scene")))
    merged_assets = _merge_list(base.get("assets"), clean_assets, lambda a: a.get("path"))
    merged_buttons = _merge_list(base.get("buttons"), clean_buttons, lambda b: b.get("label"))
    merged_states = _merge_list(base.get("states"), clean_states, lambda st: st.get("name"))
    if merged_assets:
        view["assets"] = merged_assets
    if merged_buttons:
        view["buttons"] = merged_buttons
    if cam or base.get("camera"):
        view["camera"] = cam or base["camera"]
    if view_mode or base.get("mode"):
        view["mode"] = view_mode or base["mode"]
    if merged_states:
        view["states"] = merged_states
    if clean_animator or base.get("animator"):
        view["animator"] = clean_animator or base["animator"]
    ensure_sspace_for(d)
    d.mkdir(parents=True, exist_ok=True)
    tmp = d / f".{name}.{uuid.uuid4().hex}.tmp"
    tmp.write_text(json.dumps(view, indent=2), encoding="utf-8")
    os.replace(tmp, target)

    out = [f"{'Prefab ' if is_prefabs else 'Scene ' if is_scene else 'UI ' if is_ui else ''}Tuner view '{name}' {'updated' if existing else 'written'} at {target}"]

    def components_text(o: dict) -> str:
        if "components" in o:
            return ", ".join(_component_key(c) + _describe_filter(c) for c in o["components"]) or "header only"
        if o.get("exclude"):
            return "every component except " + ", ".join(o["exclude"])
        return "every component"

    def describe(objs: list[dict], indent: str) -> None:
        for o in objs:
            sub = ", plus everything under it with every component" if o.get("children") else ""
            if sub and ("components" in o or o.get("exclude")):
                sub += f". The filter covers only {o['path']} itself; to filter what's under it too, pass {{ path: '{o['path']}/**', components: [...] }}"
            where = f" ({o['scene']})" if o.get("scene") else ""
            out.append(f"{indent}{o['path']}{where}: {components_text(o)}{sub}")

    if is_prefabs:
        for p in view["prefabs"]:
            out.append(f"  prefab {p}: its whole hierarchy, edited on its own like Unity's prefab mode")
    elif is_scene:
        if view.get("scene"):
            out.append(f"  Scene {view['scene']}: every GameObject in it (and DontDestroyOnLoad in Play Mode), with every component.")
        else:
            out.append("  Whole scene: every GameObject in every loaded scene (and DontDestroyOnLoad in Play Mode), "
                       "with every component.")
        out.append("  The scene view draws only World Space canvases. Open a Screen Space canvas in a UI Tuner to tune it.")
    elif is_ui:
        u = view["ui"]
        out.append(f"  UI root {u['path']}{' (' + u['scene'] + ')' if u.get('scene') else ''}: {components_text(u)}, "
                   "plus everything under it with every component. The scene view draws its whole canvas.")
    else:
        describe(view["objects"], "  ")
    for a in merged_assets:
        out.append(f"  asset {a['path']}{' (' + a['label'] + ')' if a.get('label') else ''}{_describe_filter(a)}")
    for b in merged_buttons:
        owner = b.get("type") or b.get("asset") or f"{b.get('path')} {b.get('component')}"
        out.append(f"  button \"{b['label']}\": {owner}.{b['method']}()")
    animr = view.get("animator")
    if animr:
        apath = animr.get("path") or ((animr.get("cast") or [{}])[0] or {}).get("path", "?")
        out.append(f"  animation timeline: {apath}" + (f", clip {animr['clip']}" if animr.get("clip") else ""))
    for st in merged_states:
        steps = ", ".join(next(iter(s)) for s in st.get("setup") or [])
        extra = [f"setup: {steps}" if steps else "", "paused" if st.get("pause") else ""]
        extra_text = "; ".join(e for e in extra if e)
        own = st.get("objects") or []
        out.append(f"  state {st['name']}{' (' + extra_text + ')' if extra_text else ''}{':' if own else ', the objects above'}")
        describe(own, "    ")

    opened = False
    gone: list[dict] = []
    if open_panel and not orchestrator_present(str(root)):
        out.append(_not_managed())
    elif open_panel:
        r = await request_player_command(str(root), "open_tuner",
                                         extra={"view": name, "paneKey": view["paneKey"]}, timeout=20.0)
        if r.get("ok"):
            opened = True
            gone = [m for m in (r.get("missing") or []) if isinstance(m, dict) and m.get("path")]
            if gone:
                out.append(f"WARNING: {len(gone)} of the objects you named {'is' if len(gone) == 1 else 'are'} not in the "
                           "open scenes, so the Tuner shows them as missing rows:")
                for m in gone:
                    out.append(f"  - {m.get('error') or m['path']}")
                out.append("Fix the paths (call tuner.open() again with the same name) before you hand the Tuner to the user.")
        elif r.get("error") == "no_orchestrator":
            out.append(_not_managed())
        else:
            out.append(f"Could not open the panel: {r.get('error')}")
    others = _other_views(d, name)
    if others:
        out.append("Other tuner filters: " + ", ".join(others))
    if opened and not gone:
        out.append(f'The Tuner is filtered to "{view["title"]}" for the user. End your turn now. They can paste their '
                   "changes to you with Copy Changes; if they press Ask Drift you get their question or request.")
    return "\n".join(out)
