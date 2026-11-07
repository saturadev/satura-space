"""Write-tracer tools — data-breakpoint-style tracing of who writes a component's properties.

One tool over the engine-side HotReloadPrototype.Editor.WriteTracer service (Harmony prefix
patches on component setters + PlayerLoop sampling for native writers). unity.trace()
installs the trace on a target GameObject via an exec snippet; report / peek read back
an ordered, aggregated log of every write with callstacks (which script, which line, what
order within the frame) plus native-writer attribution (Animator/physics/Timeline windows).

Trace state lives in editor statics: a domain reload (script recompile, or entering play mode
with default settings) wipes an active trace. The report detects and explains that case.
"""
import json
import re
from typing import Annotated, Literal

from pydantic import Field

from .helpers import tool_guard
from .multiplayer import player_label
from .params import Player, ProjectRoot
from .tools_bridge import _unity_exec, _unity_exec_each

_TRACE_MARKER = "TRACE_JSON:"
_MEMBER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$")
_TIMELINE_CAP = 48
_STACKS_CAP = 12


def _escape_verbatim(s: str) -> str:
    return s.replace('"', '""')


def _validate_target(target: str) -> str:
    t = (target or "").strip().strip("/")
    if not t or any(ord(c) < 32 for c in t):
        return ""
    return t


def _member_array(members: str) -> tuple[str, str]:
    specs = [m.strip() for m in (members or "").split(",") if m.strip()]
    if not specs:
        return "", "ERROR: members is empty — pass 'Transform' or e.g. 'Rigidbody.velocity'."
    for s in specs:
        if not _MEMBER_RE.match(s):
            return "", (
                f"ERROR: invalid member spec '{s}' — expected 'Transform' or 'Component.member' "
                "(letters, digits, underscores only)."
            )
    return "new string[] { " + ", ".join('@"' + s + '"' for s in specs) + " }", ""


def _build_start_code(path: str, member_array: str, max_events: int, seconds: float,
                      include_ancestors: bool) -> str:
    esc = _escape_verbatim(path)
    inc = "true" if include_ancestors else "false"
    return f'''GameObject _go = null;
var _segs = @"{esc}".Split('/');
var _named = new List<Transform>();
int _sceneCount = 0;
for (int _si = 0; _si < UnityEngine.SceneManagement.SceneManager.sceneCount; _si++)
{{
    var _scene = UnityEngine.SceneManagement.SceneManager.GetSceneAt(_si);
    if (!_scene.isLoaded) continue;
    _sceneCount++;
    var _stack = new Stack<Transform>();
    var _roots = _scene.GetRootGameObjects();
    for (int _ri = _roots.Length - 1; _ri >= 0; _ri--) _stack.Push(_roots[_ri].transform);
    while (_stack.Count > 0)
    {{
        var _t = _stack.Pop();
        if (_t.name == _segs[0]) _named.Add(_t);
        for (int _ci = _t.childCount - 1; _ci >= 0; _ci--) _stack.Push(_t.GetChild(_ci));
    }}
}}
System.Func<Transform, string> _fullPath = _tx =>
{{
    var _pb = new StringBuilder(_tx.name);
    for (var _p = _tx.parent; _p != null; _p = _p.parent) _pb.Insert(0, _p.name + "/");
    return _pb.ToString();
}};
var _matches = new List<string>();
foreach (var _cand in _named)
{{
    Transform _walk = _cand;
    for (int _i = 1; _i < _segs.Length && _walk != null; _i++) _walk = _walk.Find(_segs[_i]);
    if (_walk == null) continue;
    _matches.Add(_fullPath(_walk));
    if (_go == null) _go = _walk.gameObject;
}}
if (_go == null && _named.Count == 0)
    Print("TRACE_ERROR: GameObject not found in loaded scenes: no object named '" + _segs[0]
        + "' anywhere in the " + _sceneCount
        + " loaded scene(s) (searched the full hierarchy, including inactive objects). "
        + "Check the name with drift.look().");
else if (_go == null)
    Print("TRACE_ERROR: GameObject not found in loaded scenes: " + _named.Count
        + " object(s) named '" + _segs[0] + "' exist, but none matches the path '" + @"{esc}"
        + "'. Found at: " + string.Join(", ", _named.Take(5).Select(_fullPath))
        + ". Pass one of those full paths as object.");
else
{{
    if (_matches.Count > 1)
        Print("NOTE: " + _matches.Count + " objects match '" + @"{esc}" + "' — tracing the first: '"
            + _matches[0] + "'. Pass a full path to disambiguate (also at: "
            + string.Join(", ", _matches.Skip(1).Take(4)) + ").");
    Print(HotReloadPrototype.Editor.WriteTracer.Start(_go, {member_array}, {int(max_events)}, {float(seconds)}f, {inc}));
}}'''


def _build_report_code(stop: bool) -> str:
    flag = "true" if stop else "false"
    return f'Print("{_TRACE_MARKER}" + HotReloadPrototype.Editor.WriteTracer.ReportJson({flag}));'


_SAMPLING_ONLY_RE = re.compile(
    r"([A-Za-z_][\w.]*)\s+\((?:native icall setter; sampling only|no setter; sampling only|native icall; cannot patch)\)"
)


def _augment_start_result(result: str) -> str:
    """Append an explicit sampling-only NOTE when the engine's start report lists members whose
    setter cannot be (usefully) patched but does not carry its own NOTE (older engine builds)."""
    if "attributed by sampling windows" in result:
        return result
    members = list(dict.fromkeys(_SAMPLING_ONLY_RE.findall(result)))
    if not members:
        return result
    return result + (
        "\nNOTE: " + ", ".join(members) + " — native (icall) setter(s) Harmony cannot patch: "
        "writes will be attributed by sampling windows, not exact callstacks."
    )


def _explain_exec(result: str) -> str:
    if "HotReloadPrototype" in result and ("failed to compile" in result or "CS0" in result or "CS1" in result):
        return result + (
            "\n\nNOTE: if 'WriteTracer' or 'HotReloadPrototype' cannot be resolved, this project is "
            "running an OLDER injected Satura Space engine without the write tracer — relaunch the "
            "app (or re-inject the engine) and retry."
        )
    return result


_TRANSFORM_CHANNELS = {
    "Transform.position": ("position",),
    "Transform.localPosition": ("position",),
    "Transform.rotation": ("rotation",),
    "Transform.localRotation": ("rotation",),
    "Transform.eulerAngles": ("rotation",),
    "Transform.localEulerAngles": ("rotation",),
    "Transform.localScale": ("scale",),
    "Transform.SetPositionAndRotation": ("position", "rotation"),
    "Transform.SetLocalPositionAndRotation": ("position", "rotation"),
    "Transform.SetParent": ("position", "rotation", "scale"),
    "Transform.LookAt": ("rotation",),
    "Transform.Translate": ("position",),
    "Transform.Rotate": ("rotation",),
    "Transform.RotateAround": ("position", "rotation"),
}


def _member_channels(member: str) -> tuple:
    return _TRANSFORM_CHANNELS.get(member, (member,))


def _event_channels(e: dict) -> tuple:
    affects = e.get("affects") or ""
    if affects:
        return tuple(a for a in affects.split(",") if a)
    return _member_channels(e.get("member", ""))


def _labelled(value: str) -> list | None:
    parts = [p.split(": ", 1) for p in value.split("; ")] if ": " in value else []
    return parts if parts and all(len(p) == 2 for p in parts) else None


def _change_run(evs: list) -> str:
    firsts, lasts = {}, {}
    for e in evs:
        o, n = _labelled(e.get("oldValue", "")), _labelled(e.get("newValue", ""))
        if o is None or n is None:
            return _change(evs[0].get("oldValue", ""), evs[-1].get("newValue", ""))
        for label, v in o:
            firsts.setdefault(label, v)
        for label, v in n:
            lasts[label] = v
    order = [l for l in ("position", "position (parent moved)", "localPosition", "rotation", "rotation (parent moved)", "localRotation", "localScale") if l in lasts]
    order += [l for l in lasts if l not in order]
    return "; ".join(f"{l} {firsts[l]} -> {lasts[l]}" if l in firsts else f"{l} -> {lasts[l]}" for l in order)


def _change(old: str, new: str) -> str:
    o, n = _labelled(old), _labelled(new)
    if o is not None and n is not None:
        return _change_run([{"oldValue": old, "newValue": new}])
    if old:
        return f"{old} -> {new}"
    return f"-> {new}" if new else ""


_ACCUMULATE_MEMBERS = frozenset({
    "Transform.Translate", "Transform.Rotate", "Transform.RotateAround",
    "Rigidbody.AddForce", "Rigidbody.AddRelativeForce", "Rigidbody.AddForceAtPosition",
    "Rigidbody.AddExplosionForce", "Rigidbody.AddTorque", "Rigidbody.AddRelativeTorque",
    "Rigidbody2D.AddForce", "Rigidbody2D.AddRelativeForce", "Rigidbody2D.AddForceAtPosition",
    "Rigidbody2D.AddTorque", "CharacterController.Move", "CharacterController.SimpleMove",
})

def _member_semantics(member: str) -> str:
    """'assign' = the write replaces the value, so two writers in one frame really are
    last-writer-wins. 'accumulate' = each call adds its effect (Translate, AddForce); nothing is
    overwritten and claiming a winner would be a lie. The accumulate set is checked before
    _TRANSFORM_CHANNELS, whose remaining members (setters, SetPositionAndRotation, SetParent,
    LookAt) all assign. Property setters (camelCase last segment, the C#/Unity convention) assign
    by construction; unknown methods (PascalCase) default to accumulate because a false 'last
    writer wins' sends users hunting phantom overwrite bugs, while a missed conflict only
    under-reports."""
    if member in _ACCUMULATE_MEMBERS:
        return "accumulate"
    if member in _TRANSFORM_CHANNELS:
        return "assign"
    name = member.rsplit(".", 1)[-1]
    return "accumulate" if name[:1].isupper() else "assign"


def _group_frames(events: list) -> list:
    frames = []
    for e in events:
        if frames and frames[-1][0] == e.get("frame"):
            frames[-1][1].append(e)
        else:
            frames.append((e.get("frame"), [e]))
    return frames


def _find_conflicts(frames: list) -> tuple[dict, dict]:
    conflicts = {}
    mixed = {}
    native = {e.get("site", "") for _f, evs in frames for e in evs if e.get("origin") == "native"}
    for frame, evs in frames:
        per_channel = {}
        for e in evs:
            member = e.get("member", "")
            if _via_parent(e):
                continue
            sem = "assign" if e.get("origin") == "native" else _member_semantics(member)
            for ch in _event_channels(e):
                entries = per_channel.setdefault((e.get("instance", ""), ch), [])
                entry = (e.get("site", ""), member, sem)
                if not entries or entries[-1] != entry:
                    entries.append(entry)
        for (inst, ch), entries in per_channel.items():
            assign_sites = [en[0] for en in entries if en[2] == "assign"]
            if len(set(assign_sites)) >= 2 and set(assign_sites) - native:
                order = tuple(dict.fromkeys(assign_sites))
                key = (inst, ch, tuple(x for x in order if x not in native))
                c = conflicts.setdefault(key, {"count": 0, "first": frame, "last": frame, "wins": {}, "order": []})
                for x in order:
                    if x not in c["order"]:
                        at = next((c["order"].index(y) for y in order[order.index(x) + 1:] if y in c["order"]), len(c["order"]))
                        c["order"].insert(at, x)
                c["count"] += 1
                c["last"] = frame
                c["wins"][assign_sites[-1]] = c["wins"].get(assign_sites[-1], 0) + 1
            elif assign_sites and any(en[2] == "accumulate" for en in entries) \
                    and len({en[0] for en in entries}) >= 2:
                key = (inst, ch, tuple(dict.fromkeys(entries)))
                m = mixed.setdefault(key, {"count": 0, "first": frame, "last": frame})
                m["count"] += 1
                m["last"] = frame
    return conflicts, mixed


def _via_parent(e: dict) -> bool:
    new = e.get("newValue") or ""
    return e.get("origin") == "native" and "(parent moved)" in new and all(
        "(parent moved)" in part for part in new.split("; "))


def _conflict_hint(sites: tuple, wins: dict) -> str:
    natives = [s for s in sites if s.startswith("[native] ")]
    if any("physics" in s or "interpolation" in s for s in natives):
        return ("Unity's physics writes this Transform again from the Rigidbody every step, so a direct "
                "Transform write doesn't stick: move the body with Rigidbody.position or MovePosition, "
                "or make it kinematic.")
    if any("animation window" in s for s in natives):
        return ("The Animator writes it again after Update every frame: set it in LateUpdate, or remove "
                "that property's curve from the clip.")
    top = max(wins.items(), key=lambda kv: kv[1])[0] if wins else sites[-1]
    return f"The last write in a frame wins, usually {_writer_name(top)}."


def _writer_name(site: str) -> str:
    return _native_name(site) if site.startswith("[native] ") else site


def _render_conflicts(frames: list, lines: list):
    conflicts, mixed = _find_conflicts(frames)
    if conflicts:
        lines.append("")
        lines.append("CONFLICTS — several writers set the same value in one frame:")
        for (inst, ch, _own), c in sorted(conflicts.items(), key=lambda kv: -kv[1]["count"]):
            sites = tuple(c["order"])
            order = ", then ".join(_writer_name(s) for s in sites)
            span = f"frame {c['first']}" if c["first"] == c["last"] else f"frames {c['first']}..{c['last']}"
            lines.append(
                f"  ⚠ {ch} of '{inst}': {order} — in {c['count']}/{len(frames)} frames ({span}). "
                + _conflict_hint(sites, c["wins"])
            )
    if mixed:
        lines.append("")
        lines.append(
            "MIXED WRITERS — an accumulating call (each call ADDS its effect; nothing is "
            "overwritten and no writer 'wins') and a direct assignment hit the same value in one "
            "frame: the assignment discards whatever accumulators contributed before it, and "
            "accumulators after it add on top. In-frame order:"
        )
        for (inst, ch, entries), c in sorted(mixed.items(), key=lambda kv: -kv[1]["count"]):
            chain = " -> then ".join(f"{site} ({member}, {sem}s)" for site, member, sem in entries)
            lines.append(
                f"  ⚠ {ch} of '{inst}': {chain} — in {c['count']}/{len(frames)} frame(s) "
                f"(frames {c['first']}..{c['last']})."
            )


def _short_member(member: str) -> str:
    return member[len("Transform."):] if member.startswith("Transform.") else member


def _write_line(e: dict, prefix: str, change: str, note: str = "") -> str:
    phase = e.get("phase", "")
    if e.get("origin") == "native":
        site = e.get("site", "").replace("[native] ", "", 1)
        return f"    {prefix} [native] {site}: {change}{note}"
    val = f" {change}" if change else ""
    return f"    {prefix} [{phase}] {_short_member(e.get('member', ''))}{val}  ({e.get('site', '')}){note}"


def _event_line(e: dict, prefix: str) -> str:
    return _write_line(e, prefix, _change(e.get("oldValue", ""), e.get("newValue", "")))


def _frame_pattern(evs: list) -> dict:
    groups = {}
    for e in evs:
        groups.setdefault((e.get("member"), e.get("site"), e.get("origin")), []).append(e)
    return groups


def _render_timeline_collapsed(frames: list, lines: list):
    runs = []
    for frame, evs in frames:
        groups = _frame_pattern(evs)
        run = runs[-1] if runs else None
        if run is not None and (set(groups) <= set(run["keys"]) or set(run["keys"]) <= set(groups)):
            if not set(groups) <= set(run["keys"]):
                run["keys"] = list(groups) + [k for k in run["keys"] if k not in groups]
        else:
            run = {"keys": list(groups), "frames": []}
            runs.append(run)
        run["frames"].append((frame, groups))
    for run in runs:
        seen = run["frames"]
        per_key = {k: [(f, g[k]) for f, g in seen if k in g] for k in run["keys"]}
        if len(seen) == 1 and all(len(v[0][1]) == 1 for v in per_key.values()):
            lines.append(f"  frame {seen[0][0]}:")
            for k in run["keys"]:
                e = per_key[k][0][1][0]
                lines.append(_event_line(e, f"#{e.get('seq')}"))
            continue
        if len(seen) == 1:
            lines.append(f"  frame {seen[0][0]}:")
        else:
            lines.append(f"  frames {seen[0][0]}..{seen[-1][0]} ({len(seen)} frames, same writers):")
        for k in run["keys"]:
            hits = per_key[k]
            evs = [e for _f, g in hits for e in g]
            first_e = evs[0]
            note = ""
            if first_e.get("origin") != "native" and all(e.get("same") for e in evs):
                note = "  ⚠ redundant: wrote the same value every time"
            if len(seen) > 1 and len(hits) < len(seen):
                span = f"frame {hits[0][0]}" if len(hits) == 1 else f"{len(hits)} of the frames, {hits[0][0]}..{hits[-1][0]}"
                note += f"  ({span})"
            lines.append(_write_line(first_e, f"x{len(evs)}", _change_run(evs), note))


_NATIVE_NAMES = (
    ("physics/FixedUpdate", "physics"),
    ("Rigidbody interpolation", "Rigidbody interpolation"),
    ("animation window", "the Animator or Timeline"),
    ("late window", "native code after LateUpdate (constraints, IK or rendering)"),
    ("Update window", "native code before or during Update (CharacterController, NavMeshAgent or a native API)"),
    ("editor window", "the editor (inspector, undo or a tool)"),
)


def _native_name(site: str) -> str:
    for key, name in _NATIVE_NAMES:
        if key in site:
            return name
    return site.replace("[native] ", "", 1)


def _is_primary(member: str, members: str) -> bool:
    specs = [m.strip() for m in (members or "").split(",") if m.strip()]
    comp = member.split(".", 1)[0]
    return any(sp == member or sp == comp for sp in specs) or not specs


def _site_line(s: dict, phases: dict, members: str) -> str:
    cnt = s.get("count", 0)
    same = s.get("sameCount", 0)
    site = s.get("site", "")
    member = s.get("member", "")
    if site.startswith("[native] "):
        return f"  {cnt:>5}x  [native] {_native_name(site)}"
    phase = phases.get((member, site), "")
    extra = f" [{phase}]" if phase else ""
    if not _is_primary(member, members):
        extra += " (drives the body)"
    if same and cnt:
        warn = "⚠ " if same == cnt and cnt >= 10 else ""
        extra += f"  — {warn}{same}/{cnt} redundant (wrote the value already there)"
    return f"  {cnt:>5}x  {_short_member(member)} <- {site}{extra}"


def _verdict(data: dict, events: list, sites: list, phases: dict) -> list:
    if not sites:
        return []
    members = data.get("members", "")
    own = [s for s in sites if not s.get("site", "").startswith("[native] ") and _is_primary(s.get("member", ""), members)]
    own.sort(key=lambda s: s.get("sameCount", 0) >= s.get("count", 0) > 0)
    drivers = [s for s in sites if not s.get("site", "").startswith("[native] ") and not _is_primary(s.get("member", ""), members)]
    parent_only = {site for site in {e.get("site") for e in events if e.get("origin") == "native"}
                   if all(_via_parent(e) for e in events if e.get("site") == site)}
    native = [s for s in sites if s.get("site", "").startswith("[native] ") and s.get("site") not in parent_only]
    out = []
    if own:
        top = own[0]
        names = list(dict.fromkeys(s.get("site", "").split(" @ ")[0] for s in own[1:]))
        phase = phases.get((top.get("member", ""), top.get("site", "")), "")
        more = f"; also {', '.join(names[:3])}" + (f" and {len(names) - 3} more" if len(names) > 3 else "") if names else ""
        out.append(f"Answer: {top.get('site', '')} writes it ({_short_member(top.get('member', ''))}"
                   f" {top.get('count', 0)}x{' in ' + phase if phase else ''}){more}.")
    if native:
        kinds = list(dict.fromkeys(_native_name(s.get("site", "")) for s in native))
        lead = "Answer: " if not own else "Unity also writes it: "
        text = ", ".join(kinds)
        if not own:
            text = f"Unity moves it ({text}); no script writes it directly"
        out.append(f"{lead}{text}.")
    if drivers:
        calls = {}
        for s in drivers:
            calls.setdefault(s.get("site", "").split(" @ ")[0], []).append(_short_member(s.get("member", "")).split(".")[-1])
        names = [f"{who} ({', '.join(dict.fromkeys(what))})" for who, what in calls.items()]
        listed = ", ".join(names[:4]) + (f" and {len(names) - 4} more" if len(names) > 4 else "")
        if not own and not native:
            out.append(f"Answer: its Transform didn't change in this window. Scripts still drive its body: {listed}.")
        else:
            out.append(f"Scripts driving its body: {listed}.")
    elif data.get("drivers") and native and not own and any("physics" in s.get("site", "") for s in native) \
            and not any("parent moved" in (e.get("newValue") or "") for e in events):
        out.append("No script called its Rigidbody's velocity, force or Move API in this window: gravity, collisions or joints moved it.")
    if any("parent moved" in (e.get("newValue") or "") for e in events):
        if not own and not native and not drivers:
            out.insert(0, "Answer: its parent moves it; its own local values don't change. Trace the parent to see who moves it.")
        else:
            out.append("Its parent moves too (local values unchanged in those writes); trace the parent to see who moves it.")
    return out


_PRETTY = (
    (re.compile(r"<>c__DisplayClass\d+_\d+\.|<>c\."), ""),
    (re.compile(r"<(\w+)>g__(\w+)\|\d+_\d+"), r"\1.\2"),
    (re.compile(r"<(\w+)>b__\d+(?:_\d+)?"), r"\1 (lambda)"),
    (re.compile(r"<(\w+)>d__\d+\.MoveNext"), r"\1 (coroutine)"),
)


def _pretty(text: str) -> str:
    for rx, sub in _PRETTY:
        text = rx.sub(sub, text)
    return text


def _format_trace_report(data: dict, collapse: bool = True, timeline_cap: int = _TIMELINE_CAP) -> str:
    for item in (data.get("events") or []) + (data.get("sites") or []):
        for k in ("site", "stack"):
            if item.get(k):
                item[k] = _pretty(item[k])
    status = data.get("status", "")
    target = data.get("target", "")
    if status == "none":
        return (
            "ERROR: No write trace exists in this editor session. Start one with unity.trace(object). "
            "(A domain reload — script recompile or entering play mode — wipes an active trace.)"
        )
    if status == "wiped":
        return (
            f"ERROR: The write trace on '{target}' was WIPED by a domain reload (script recompile or "
            "play-mode enter) before it could be read — its buffer is gone (an active trace loses "
            "everything; a stopped-but-unread one loses its kept buffer the same way). Start the "
            "trace AFTER entering play mode (or after the last recompile), then report."
        )
    total = data.get("totalEvents", 0)
    events = data.get("events") or []
    sites = data.get("sites") or []
    head = f"WRITE TRACE — {target} [{data.get('members', '')}] — {status}, {total} write(s)"
    if events:
        f0, f1 = events[0].get("frame"), events[-1].get("frame")
        head += f" in frames {f0}..{f1}" if f0 != f1 else f" in frame {f0}"
    lines = [head]
    frames = _group_frames(events)
    phases = {}
    for e in events:
        phases.setdefault((e.get("member", ""), e.get("site", "")), e.get("phase", ""))
    lines.extend(_verdict(data, events, sites, phases))
    _render_conflicts(frames, lines)

    if sites:
        lines.append("")
        lines.append("Writers:" if total <= len(events) else
                     f"Writers (counts over all {total} writes; the timeline keeps the last {len(events)}):")
        for s in sites:
            lines.append(_site_line(s, phases, data.get("members", "")))

    if events:
        lines.append("")
        if collapse:
            lines.append("Timeline (oldest -> newest, identical frames collapsed; {collapse: false} for raw):")
            timeline = []
            _render_timeline_collapsed(frames, timeline)
            if len(timeline) > timeline_cap:
                hidden = len(timeline) - timeline_cap
                timeline = [f"  ... {hidden} earlier timeline line(s) hidden"] + timeline[-timeline_cap:]
            lines.extend(timeline)
        else:
            lines.append("Timeline (oldest -> newest, ordered within each frame):")
            shown = events[-timeline_cap:]
            if len(shown) < len(events):
                lines.append(f"  ... {len(events) - len(shown)} earlier event(s) hidden")
            frame = object()
            i = 0
            while i < len(shown):
                e = shown[i]
                if e.get("frame") != frame:
                    frame = e.get("frame")
                    lines.append(f"  frame {frame}:")
                body = _event_line(e, "")
                j = i + 1
                while j < len(shown) and shown[j].get("frame") == frame and _event_line(shown[j], "") == body:
                    j += 1
                lines.append(_event_line(e, f"#{e.get('seq')}"))
                if j - i > 2:
                    lines.append(
                        f"      ... x{j - i - 1} identical "
                        f"(#{shown[i + 1].get('seq')}..#{shown[j - 1].get('seq')})"
                    )
                    i = j
                else:
                    i += 1
        stacks = {}
        for e in events:
            site = e.get("site", "")
            st = e.get("stack", "")
            if st and site and site not in stacks and st != site:
                stacks[site] = st
        if stacks:
            lines.append("")
            lines.append("Callers (innermost first, one per writer):")
            for site, st in list(stacks.items())[:_STACKS_CAP]:
                lines.append(f"  {st}" if st.startswith(site) else f"  {site}: {st}")
            if len(stacks) > _STACKS_CAP:
                lines.append(f"  ... {len(stacks) - _STACKS_CAP} more writer(s) hidden")

    if not events and status in ("active", "stopped"):
        lines.append("")
        lines.append(
            "No writes recorded (yet). Either nothing wrote the traced members in the window, "
            "or the writers are native-only and no sampled value changed."
        )
    if status == "active":
        lines.append("")
        lines.append("Trace is still running; call unity.traceReport() to stop and finalize.")
    return "\n".join(lines)


async def _trace_writes_impl(target: str, members: str, project_root: str, max_events: int,
                             seconds: float, include_ancestors: bool, timeout_seconds: float,
                             player: str = "primary") -> str:
    path = _validate_target(target)
    if not path:
        return (
            "ERROR: object is required — a scene hierarchy path like 'Player' or "
            "'Level/Enemies/Boss' (as drift.look() shows)."
        )
    member_array, err = _member_array(members)
    if err:
        return err
    try:
        max_events = max(100, min(10000, int(max_events)))
    except (TypeError, ValueError):
        max_events = 2000
    try:
        seconds = max(1.0, min(600.0, float(seconds)))
    except (TypeError, ValueError):
        seconds = 30.0
    code = _build_start_code(path, member_array, max_events, seconds, bool(include_ancestors))
    result = await _unity_exec(project_root, code, timeout_seconds, target=player)
    return _explain_exec(_augment_start_result(result))


def _parse_report_text(text: str, collapse: bool, max_lines: int = _TIMELINE_CAP) -> str:
    marker_line = next(
        (line for line in text.splitlines() if line.startswith(_TRACE_MARKER)), None
    )
    if marker_line is None:
        return _explain_exec(text)
    try:
        data = json.loads(marker_line[len(_TRACE_MARKER):])
    except json.JSONDecodeError:
        return "ERROR: trace report payload was corrupted:\n" + text
    return _format_trace_report(data, collapse=collapse, timeline_cap=max_lines)


async def _trace_report_impl(project_root: str, stop: bool, timeout_seconds: float,
                             collapse: bool = True, player: str = "primary",
                             max_lines: int = _TIMELINE_CAP) -> str:
    try:
        max_lines = max(10, min(5000, int(max_lines)))
    except (TypeError, ValueError):
        max_lines = _TIMELINE_CAP
    out = await _unity_exec_each(
        project_root, _build_report_code(bool(stop)), timeout_seconds, target=player
    )
    if isinstance(out, str):
        return _explain_exec(out)
    sections = [(p, _parse_report_text(text, collapse, max_lines)) for p, text in out]
    if len(sections) == 1:
        return sections[0][1]
    return "\n\n".join(f"{player_label(p)}\n{body}" for p, body in sections)


@tool_guard
async def unity_trace(
    command: Annotated[Literal["start", "peek", "report"], Field(description="start a trace, peek at it, or report and stop.")],
    object: Annotated[str, Field(description="start: the GameObject's hierarchy path ('Level/Enemies/Boss'). A bare name matches anywhere, first match wins.")] = "",
    members: Annotated[str, Field(description='Comma-separated: "Transform", "Component.property" or "Component.Method".')] = "Transform",
    seconds: Annotated[float, Field(description="start: how long to trace, 1-600.")] = 30,
    include_ancestors: Annotated[bool, Field(description="Also trace parents. false also stops sampling world-space members.")] = True,
    player: Player = "primary",
    max_events: Annotated[int, Field(description="start: event cap, 100-10000.")] = 2000,
    collapse: Annotated[bool, Field(description="report/peek: fold frames with the same pattern. false gives the raw per-event log.")] = True,
    max_lines: Annotated[int, Field(description="report/peek: timeline cap, 10-5000. The oldest lines are hidden with a notice.")] = _TIMELINE_CAP,
    timeout_seconds: Annotated[float, Field(description="Seconds to wait for the editor.")] = 120,
    project_root: ProjectRoot = "",
) -> str:
    cmd = (command or "").strip().lower()
    if cmd == "start":
        return await _trace_writes_impl(
            object, members, project_root, max_events, seconds, include_ancestors, timeout_seconds,
            player,
        )
    if cmd in ("report", "peek"):
        return await _trace_report_impl(
            project_root, cmd == "report", timeout_seconds, collapse, player, max_lines
        )
    return f"ERROR: Unknown command {command!r}. Use start, report or peek."
