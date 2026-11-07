#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEngine;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

public static class RemoteControlsGen
{
    public const string Dir = "ProjectSettings/SaturaRemote";
    public const string FileName = "controls.generated.json";
    const int MaxSticks = 2;
    const int MaxAxes = 2;
    const int MaxButtons = 8;
    const int MaxScanFiles = 400;
    const long MaxScanBytes = 24L * 1024 * 1024;

    public static string LastStatus = "";
    public static string LastError = "";
    public static string LastSummary = "";
    public static double LastAt;

    public static string ProjectRoot => Path.GetFullPath(Path.Combine(Application.dataPath, ".."));
    public static string FilePath => Path.Combine(ProjectRoot, Dir, FileName);

    public static bool IsClone()
    {
        return Array.IndexOf(Environment.GetCommandLineArgs(), "--virtual-project-clone") >= 0;
    }

    public static bool Run(string why, out bool changed, out string error)
    {
        changed = false;
        error = "";
        LastAt = EditorApplication.timeSinceStartup;
        if (IsClone())
        {
            LastStatus = "skipped: clone";
            return true;
        }
        string json;
        try { json = Build(out LastSummary); }
        catch (Exception e)
        {
            error = e.Message;
            LastError = error;
            LastStatus = "error";
            Debug.LogWarning("[RemoteControls] generating the phone controls failed: " + e);
            return false;
        }
        var path = FilePath;
        try
        {
            string old = File.Exists(path) ? File.ReadAllText(path) : null;
            if (old == json)
            {
                LastStatus = "unchanged";
                LastError = "";
                return true;
            }
            Directory.CreateDirectory(Path.GetDirectoryName(path));
            var tmp = path + ".tmp";
            File.WriteAllText(tmp, json, new UTF8Encoding(false));
            if (File.Exists(path)) File.Delete(path);
            File.Move(tmp, path);
            changed = true;
            LastStatus = "written";
            LastError = "";
            Debug.Log($"[RemoteControls] wrote {Dir}/{FileName} ({why}): {LastSummary}");
            return true;
        }
        catch (Exception e)
        {
            error = e.Message;
            LastError = error;
            LastStatus = "error";
            Debug.LogWarning("[RemoteControls] writing " + path + " failed: " + e.Message);
            return false;
        }
    }

    sealed class J
    {
        readonly StringBuilder sb = new StringBuilder(8192);
        int depth;
        readonly List<bool> first = new List<bool>();

        public override string ToString() => sb.ToString();

        void Indent()
        {
            sb.Append('\n');
            sb.Append(' ', depth * 2);
        }

        void Sep()
        {
            if (first.Count == 0) return;
            int i = first.Count - 1;
            if (!first[i]) sb.Append(',');
            first[i] = false;
            Indent();
        }

        public J Open(char c)
        {
            sb.Append(c);
            depth++;
            first.Add(true);
            return this;
        }

        public J Close(char c)
        {
            bool empty = first[first.Count - 1];
            first.RemoveAt(first.Count - 1);
            depth--;
            if (!empty) Indent();
            sb.Append(c);
            return this;
        }

        public J Key(string k)
        {
            Sep();
            Str(k);
            sb.Append(": ");
            return this;
        }

        public J Item()
        {
            Sep();
            return this;
        }

        public J Str(string s)
        {
            sb.Append('"');
            foreach (char c in s ?? "")
            {
                switch (c)
                {
                    case '"': sb.Append("\\\""); break;
                    case '\\': sb.Append("\\\\"); break;
                    case '\n': sb.Append("\\n"); break;
                    case '\r': sb.Append("\\r"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < 0x20) sb.Append("\\u").Append(((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            sb.Append('"');
            return this;
        }

        public J Raw(string s)
        {
            sb.Append(s);
            return this;
        }

        public J Prop(string k, string v) => Key(k).Str(v);
        public J Prop(string k, bool v) => Key(k).Raw(v ? "true" : "false");
        public J Prop(string k, int v) => Key(k).Raw(v.ToString(CultureInfo.InvariantCulture));
    }

    sealed class Output
    {
        public string type;
        public readonly List<KeyValuePair<string, string>> strs = new List<KeyValuePair<string, string>>();
        public readonly List<string> keys = new List<string>();
        public int num = int.MinValue;
        public string numName;

        public Output Set(string k, string v)
        {
            strs.Add(new KeyValuePair<string, string>(k, v));
            return this;
        }

        public void Write(J j)
        {
            j.Open('{');
            j.Prop("type", type);
            foreach (var kv in strs) j.Prop(kv.Key, kv.Value);
            if (keys.Count > 0)
            {
                j.Key("keys").Raw("[");
                for (int i = 0; i < keys.Count; i++) j.Raw(i > 0 ? ", " : "").Str(keys[i]);
                j.Raw("]");
            }
            if (numName != null) j.Prop(numName, num);
            j.Close('}');
        }
    }

    sealed class Alt
    {
        public string binding;
        public string text;
        public Output output;
    }

    sealed class Ctl
    {
        public string id, action, path, actionType, controlType, kind, behavior = "press", interactions = "", unavailable = "", label, hidden, joined;
        public int holdMs, taps, tapMs;
        public bool visible;
        public Alt main;
        public readonly List<Alt> alts = new List<Alt>();
        public Alt pad;
    }

    sealed class MapOut
    {
        public string id, name, asset;
        public bool ui;
        public readonly List<Ctl> controls = new List<Ctl>();
    }

    sealed class Player
    {
        public string where;
        public string assetPath;
        public string map;
        public string scheme;
        public bool open;
    }

#if ENABLE_INPUT_SYSTEM
    sealed class Src
    {
        public InputActionAsset asset;
        public string path;
        public bool projectWide;
        public string group = "";
        public string schemeName = "";
        public readonly List<string> players = new List<string>();
    }

    static string Build(out string summary)
    {
        var srcs = new List<Src>();
        var byPath = new Dictionary<string, Src>();
        var pw = InputScheme.ProjectWide();
        string pwPath = pw != null ? AssetDatabase.GetAssetPath(pw) : "";
        var paths = new List<string>();
        foreach (var guid in AssetDatabase.FindAssets("t:InputActionAsset"))
        {
            var p = AssetDatabase.GUIDToAssetPath(guid);
            if (string.IsNullOrEmpty(p) || p.StartsWith("Packages/", StringComparison.Ordinal) || paths.Contains(p)) continue;
            paths.Add(p);
        }
        paths.Sort(StringComparer.Ordinal);
        if (!string.IsNullOrEmpty(pwPath))
        {
            paths.Remove(pwPath);
            paths.Insert(0, pwPath);
        }
        foreach (var p in paths)
        {
            var a = AssetDatabase.LoadAssetAtPath<InputActionAsset>(p);
            if (a == null) continue;
            var s = new Src { asset = a, path = p, projectWide = p == pwPath };
            srcs.Add(s);
            byPath[p] = s;
        }

        var players = FindPlayers();
        foreach (var pl in players)
            if (byPath.TryGetValue(pl.assetPath ?? "", out var s))
            {
                var line = pl.where + (string.IsNullOrEmpty(pl.map) ? "" : $" map={MapName(s.asset, pl.map)}") + (string.IsNullOrEmpty(pl.scheme) ? "" : $" scheme={pl.scheme}");
                if (!s.players.Contains(line)) s.players.Add(line);
            }

        foreach (var s in srcs) PickScheme(s, players);

        var maps = new List<MapOut>();
        foreach (var s in srcs)
            foreach (var m in s.asset.actionMaps)
                maps.Add(BuildMap(s, m));

        string defaultMap = "", reason = "";
        foreach (var pl in players)
        {
            if (!byPath.TryGetValue(pl.assetPath ?? "", out var s) || string.IsNullOrEmpty(pl.map)) continue;
            var m = FindMap(s.asset, pl.map);
            if (m == null) continue;
            defaultMap = m.id.ToString();
            reason = "PlayerInput default map on " + pl.where;
            break;
        }
        if (defaultMap == "")
        {
            foreach (var mo in maps)
            {
                if (mo.ui || !HasControls(mo)) continue;
                defaultMap = mo.id;
                reason = (srcs.Count > 0 && srcs[0].projectWide && mo.asset == srcs[0].path ? "first gameplay map of the project-wide actions " : "first gameplay map in ") + mo.asset;
                break;
            }
        }
        if (defaultMap == "" && maps.Count > 0)
        {
            defaultMap = maps[0].id;
            reason = "the only maps are UI maps or have nothing to press; first map in " + maps[0].asset;
        }

        var j = new J();
        j.Open('{');
        j.Prop("format", "satura-remote-controls");
        j.Prop("version", 1);
        j.Prop("note", "Generated by Satura Space from the project's Input System assets on every import. Do not edit: put changes in controls.overrides.json next to this file.");
        j.Prop("inputSystem", true);
        j.Prop("defaultMap", defaultMap);
        j.Prop("defaultMapReason", reason);
        j.Key("assets").Open('[');
        foreach (var s in srcs)
        {
            j.Item().Open('{');
            j.Prop("path", s.path);
            j.Prop("name", s.asset.name);
            j.Prop("projectWide", s.projectWide);
            j.Prop("scheme", s.schemeName);
            j.Key("players").Open('[');
            foreach (var pl in s.players) j.Item().Str(pl);
            j.Close(']');
            j.Close('}');
        }
        j.Close(']');
        j.Key("maps").Open('[');
        int total = 0, shown = 0;
        var sum = new StringBuilder();
        foreach (var mo in maps)
        {
            j.Item().Open('{');
            j.Prop("id", mo.id);
            j.Prop("name", mo.name);
            j.Prop("asset", mo.asset);
            j.Prop("ui", mo.ui);
            j.Key("controls").Open('[');
            foreach (var c in mo.controls)
            {
                total++;
                if (c.visible && c.main != null) shown++;
                WriteControl(j, c);
            }
            j.Close(']');
            j.Close('}');
            if (sum.Length > 0) sum.Append("; ");
            sum.Append(mo.name).Append(mo.ui ? " (UI)" : "").Append(mo.id == defaultMap ? " (default)" : "").Append(':');
            foreach (var c in mo.controls)
                if (c.visible && c.main != null) sum.Append(' ').Append(c.action).Append('=').Append(c.kind);
        }
        j.Close(']');
        j.Close('}');
        summary = $"{srcs.Count} asset(s), {maps.Count} map(s), {total} action(s), {shown} on screen; {sum}";
        return j.ToString() + "\n";
    }

    static bool HasControls(MapOut m)
    {
        foreach (var c in m.controls)
            if (c.main != null && c.kind != "pointer") return true;
        return false;
    }

    static string MapName(InputActionAsset a, string nameOrId)
    {
        var m = FindMap(a, nameOrId);
        return m != null ? m.name : nameOrId;
    }

    static InputActionMap FindMap(InputActionAsset a, string nameOrId)
    {
        if (a == null || string.IsNullOrEmpty(nameOrId)) return null;
        foreach (var m in a.actionMaps)
            if (m.id.ToString() == nameOrId.Trim('{', '}') || string.Equals(m.name, nameOrId, StringComparison.OrdinalIgnoreCase)) return m;
        return null;
    }

    static void WriteControl(J j, Ctl c)
    {
        j.Item().Open('{');
        j.Prop("id", c.id);
        j.Prop("action", c.action);
        j.Prop("path", c.path);
        j.Prop("actionType", c.actionType);
        j.Prop("controlType", c.controlType);
        j.Prop("kind", c.kind);
        j.Prop("visible", c.visible);
        j.Prop("binding", c.main?.binding ?? "");
        j.Prop("bindingText", c.main?.text ?? "");
        j.Key("output");
        if (c.main != null) c.main.output.Write(j);
        else j.Raw("null");
        j.Prop("behavior", c.behavior);
        if (c.holdMs > 0) j.Prop("holdMs", c.holdMs);
        if (c.behavior == "multiTap") j.Prop("taps", c.taps);
        if (c.tapMs > 0) j.Prop("tapMs", c.tapMs);
        if (!string.IsNullOrEmpty(c.interactions)) j.Prop("interactions", c.interactions);
        j.Key("alternatives").Open('[');
        foreach (var a in c.alts)
        {
            j.Item().Open('{');
            j.Prop("binding", a.binding);
            j.Prop("bindingText", a.text);
            j.Key("output");
            a.output.Write(j);
            j.Close('}');
        }
        j.Close(']');
        j.Key("gamepad");
        if (c.pad != null) c.pad.output.Write(j);
        else j.Raw("null");
        j.Prop("gamepadBinding", c.pad?.binding ?? "");
        if (!string.IsNullOrEmpty(c.unavailable)) j.Prop("unavailable", c.unavailable);
        if (c.label != null) j.Prop("label", c.label);
        if (c.hidden != null) j.Prop("hidden", c.hidden);
        if (c.joined != null) j.Prop("joined", c.joined);
        j.Close('}');
    }

    static bool IsUiMap(InputActionMap m)
    {
        if (string.Equals(m.name, "UI", StringComparison.OrdinalIgnoreCase)) return true;
        return m.FindAction("Navigate") != null && m.FindAction("Submit") != null && m.FindAction("Point") != null;
    }

    static void PickScheme(Src s, List<Player> players)
    {
        foreach (var pl in players)
        {
            if (pl.assetPath != s.path || string.IsNullOrEmpty(pl.scheme)) continue;
            foreach (var cs in s.asset.controlSchemes)
                if (cs.name == pl.scheme && (Wants(cs, "Keyboard") || Wants(cs, "Mouse")))
                {
                    s.group = cs.bindingGroup;
                    s.schemeName = cs.name;
                    return;
                }
        }
        int best = 0;
        foreach (var cs in s.asset.controlSchemes)
        {
            int score = (Wants(cs, "Keyboard") ? 2 : 0) + (Wants(cs, "Mouse") ? 1 : 0);
            if (score <= best) continue;
            best = score;
            s.group = cs.bindingGroup;
            s.schemeName = cs.name;
        }
    }

    static bool Wants(InputControlScheme cs, string layout)
    {
        foreach (var r in cs.deviceRequirements)
        {
            var dev = InputControlPath.TryGetDeviceLayout(r.controlPath);
            if (string.IsNullOrEmpty(dev)) continue;
            if (dev == layout) return true;
            try { if (InputSystem.IsFirstLayoutBasedOnSecond(dev, layout)) return true; } catch { }
        }
        return false;
    }

    static bool InGroup(InputBinding b, string group)
    {
        if (string.IsNullOrEmpty(group) || string.IsNullOrEmpty(b.groups)) return true;
        foreach (var g in b.groups.Split(InputBinding.Separator))
            if (g.Trim() == group) return true;
        return false;
    }

    sealed class Part
    {
        public InputBinding b;
        public string name;
        public InputScheme.Binding r;
    }

    sealed class Comp
    {
        public InputBinding b;
        public string name;
        public readonly List<Part> parts = new List<Part>();
    }

    static InputScheme.Binding Resolve(InputBinding b)
    {
        var path = b.effectivePath ?? b.path ?? "";
        var row = new InputScheme.Binding { path = path };
        InputScheme.Resolve(path, row);
        if (row.dev != "Keyboard" && row.dev != "Mouse" && row.dev != "Gamepad" && !string.IsNullOrEmpty(row.dev))
        {
            try
            {
                if (InputSystem.IsFirstLayoutBasedOnSecond(row.dev, "Gamepad")) row.dev = "Gamepad";
                else if (InputSystem.IsFirstLayoutBasedOnSecond(row.dev, "Mouse")) row.dev = "Mouse";
                else if (InputSystem.IsFirstLayoutBasedOnSecond(row.dev, "Keyboard")) row.dev = "Keyboard";
            }
            catch { }
        }
        return row;
    }

    static string Text(InputBinding b)
    {
        var p = b.effectivePath ?? b.path ?? "";
        try { return InputControlPath.ToHumanReadableString(p, InputControlPath.HumanReadableStringOptions.None); }
        catch { return p; }
    }

    static MapOut BuildMap(Src s, InputActionMap m)
    {
        var mo = new MapOut { id = m.id.ToString(), name = m.name, asset = s.path, ui = IsUiMap(m) };
        foreach (var act in m.actions) mo.controls.Add(BuildControl(s, m, act));
        PairAxes(mo);
        bool debugMap = DebugName.IsMatch(Squash(m.name));
        foreach (var c in mo.controls)
            if (c.main != null && c.hidden == null && c.kind != "pointer") c.hidden = debugMap ? "debug map" : Unwanted(c);
        var pressedBy = new Dictionary<string, string>();
        foreach (var c in mo.controls)
            if (c.main != null && c.hidden == null && (c.kind == "stick" || c.kind == "axis"))
                foreach (var kv in c.main.output.strs)
                    if (!pressedBy.ContainsKey(kv.Value)) pressedBy[kv.Value] = $"the {c.label ?? c.action} {(c.kind == "stick" ? "stick" : "rocker")}";
        var seen = new Dictionary<string, string>();
        foreach (var c in mo.controls)
        {
            if (c.main == null || c.hidden != null || c.kind != "button") continue;
            var o = c.main.output;
            var sig = Sig(o);
            if (seen.TryGetValue(sig, out var first)) c.hidden = "same key as " + first;
            else if (o.type == "key" && pressedBy.TryGetValue(o.strs[0].Value, out var by)) c.hidden = by + " presses " + o.strs[0].Value;
            else seen[sig] = c.action;
        }
        int sticks = 0, axes = 0, buttons = 0;
        foreach (var c in mo.controls)
        {
            if (c.main == null) c.visible = c.pad != null;
            else if (c.kind == "pointer") c.visible = true;
            else if (c.hidden != null) c.visible = false;
            else if (c.kind == "stick") c.visible = sticks++ < MaxSticks;
            else if (c.kind == "axis") c.visible = axes++ < MaxAxes;
            else c.visible = buttons++ < MaxButtons;
        }
        return mo;
    }

    static readonly Regex DebugName = new Regex("debug|console|cheat|devmode|developer|godmode|noclip|profiler|screenshot|showfps|fpscounter", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex VoiceName = new Regex("voice|pushtotalk|^ptt$|microphone", RegexOptions.IgnoreCase | RegexOptions.Compiled);
    static readonly Regex AxisName = new Regex("^(.*?)[\\s_\\-]*([XY])$", RegexOptions.Compiled);
    static readonly Regex HvName = new Regex("^(.*?)[\\s_\\-]*(Horizontal|Vertical)[\\s_\\-]*(.*)$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    static string Squash(string s) => Regex.Replace(s ?? "", "[\\s_\\-]", "");

    static string Unwanted(Ctl c)
    {
        var n = Squash(c.action);
        if (DebugName.IsMatch(n)) return "debug action";
        if (VoiceName.IsMatch(n)) return "voice chat";
        var o = c.main.output;
        if (o.type == "key")
        {
            var k = o.strs[0].Value;
            if (k == "Backquote" || Regex.IsMatch(k, "^F\\d+$")) return "debug key " + k;
        }
        return null;
    }

    static string Sig(Output o)
    {
        var sb = new StringBuilder(o.type);
        foreach (var kv in o.strs) sb.Append('|').Append(kv.Key).Append('=').Append(kv.Value);
        foreach (var k in o.keys) sb.Append('+').Append(k);
        if (o.numName != null) sb.Append('#').Append(o.num);
        return sb.ToString();
    }

    static string KeyOf(Output o, string name)
    {
        foreach (var kv in o.strs)
            if (kv.Key == name) return kv.Value;
        return null;
    }

    static bool AxisOf(Ctl c, out string bas, out char axis)
    {
        var hv = HvName.Match(c.action);
        if (hv.Success)
        {
            bas = (hv.Groups[1].Value + hv.Groups[3].Value).Trim();
            axis = char.ToLowerInvariant(hv.Groups[2].Value[0]) == 'h' ? 'X' : 'Y';
            return true;
        }
        var xy = AxisName.Match(c.action);
        if (xy.Success && xy.Groups[1].Value.Length > 0)
        {
            bas = xy.Groups[1].Value.Trim();
            axis = xy.Groups[2].Value[0];
            return true;
        }
        var neg = KeyOf(c.main.output, "negative");
        var pos = KeyOf(c.main.output, "positive");
        bas = "";
        axis = (neg == "A" && pos == "D") || (neg == "LeftArrow" && pos == "RightArrow") ? 'X' : (neg == "S" && pos == "W") || (neg == "DownArrow" && pos == "UpArrow") ? 'Y' : ' ';
        return axis != ' ';
    }

    static void PairAxes(MapOut mo)
    {
        var axes = mo.controls.FindAll(c => c.kind == "axis" && c.main != null && c.main.output.type == "keys");
        foreach (var x in axes)
        {
            if (x.kind != "axis" || x.joined != null || !AxisOf(x, out var bx, out var ax) || ax != 'X') continue;
            Ctl y = null;
            foreach (var cand in axes)
                if (cand != x && cand.kind == "axis" && cand.joined == null && AxisOf(cand, out var by, out var ay) && ay == 'Y' && string.Equals(by, bx, StringComparison.OrdinalIgnoreCase)) { y = cand; break; }
            if (y == null) continue;
            var o = new Output { type = "keys" };
            void Dir(string dir, Output from, string part)
            {
                var k = KeyOf(from, part);
                if (k != null) o.Set(dir, k);
            }
            Dir("up", y.main.output, "positive");
            Dir("down", y.main.output, "negative");
            Dir("left", x.main.output, "negative");
            Dir("right", x.main.output, "positive");
            x.main = new Alt { binding = x.main.binding, text = x.main.text + " + " + y.main.text, output = o };
            x.kind = "stick";
            x.label = bx.Length > 0 ? bx : "Move";
            y.joined = x.id;
            y.hidden = $"joined into the {x.label} stick";
        }
    }

    static readonly Dictionary<string, string> PadButtons = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { "buttonSouth", "buttonSouth" }, { "a", "buttonSouth" }, { "cross", "buttonSouth" },
        { "buttonEast", "buttonEast" }, { "b", "buttonEast" }, { "circle", "buttonEast" },
        { "buttonWest", "buttonWest" }, { "x", "buttonWest" }, { "square", "buttonWest" },
        { "buttonNorth", "buttonNorth" }, { "y", "buttonNorth" }, { "triangle", "buttonNorth" },
        { "leftShoulder", "leftShoulder" }, { "rightShoulder", "rightShoulder" },
        { "start", "start" }, { "select", "select" },
        { "leftStickPress", "leftStickPress" }, { "rightStickPress", "rightStickPress" },
        { "dpad/up", "dpadUp" }, { "dpad/down", "dpadDown" }, { "dpad/left", "dpadLeft" }, { "dpad/right", "dpadRight" }
    };

    static string PadCtl(InputBinding b)
    {
        var p = b.effectivePath ?? b.path ?? "";
        int close = p.IndexOf('>');
        return close >= 0 && close + 2 <= p.Length ? p.Substring(Math.Min(p.Length, close + 2)) : "";
    }

    static Output PadOutput(InputBinding b, bool vector, bool axis)
    {
        var ctl = PadCtl(b);
        if (vector || axis)
        {
            if (ctl.StartsWith("leftStick", StringComparison.OrdinalIgnoreCase)) return new Output { type = "gamepad" }.Set("stick", "left");
            if (ctl.StartsWith("rightStick", StringComparison.OrdinalIgnoreCase) && !ctl.Equals("rightStickPress", StringComparison.OrdinalIgnoreCase)) return new Output { type = "gamepad" }.Set("stick", "right");
            if (ctl.Equals("dpad", StringComparison.OrdinalIgnoreCase)) return new Output { type = "gamepad" }.Set("stick", "dpad");
        }
        if (ctl.Equals("leftTrigger", StringComparison.OrdinalIgnoreCase)) return new Output { type = "gamepad" }.Set("trigger", "left");
        if (ctl.Equals("rightTrigger", StringComparison.OrdinalIgnoreCase)) return new Output { type = "gamepad" }.Set("trigger", "right");
        if (PadButtons.TryGetValue(ctl, out var btn)) return new Output { type = "gamepad" }.Set("button", btn);
        return null;
    }

    static Output MouseButton(InputScheme.Binding r)
    {
        var m = Regex.Match(r.ctl ?? "", "^button(\\d)$");
        if (m.Success) return new Output { type = "mouse", num = int.Parse(m.Groups[1].Value), numName = "button" };
        if (r.ctl == "scroll/up") return new Output { type = "wheel", num = 1, numName = "dir" };
        if (r.ctl == "scroll/down") return new Output { type = "wheel", num = -1, numName = "dir" };
        return null;
    }

    static Output PointerOutput(InputScheme.Binding r)
    {
        if (r.dev != "Mouse") return null;
        var ctl = r.ctl ?? "";
        if (ctl.StartsWith("delta", StringComparison.Ordinal)) return new Output { type = "mouseDelta" };
        if (ctl == "scroll" || ctl == "scroll/y" || ctl == "scroll/x") return new Output { type = "scroll" };
        if (ctl.StartsWith("position", StringComparison.Ordinal)) return new Output { type = "mousePosition" };
        return null;
    }

    static string Lower(string s) => string.IsNullOrEmpty(s) ? "" : s.ToLowerInvariant();

    static Ctl BuildControl(Src s, InputActionMap m, InputAction act)
    {
        var c = new Ctl
        {
            id = act.id.ToString(),
            action = act.name,
            path = s.asset.name + "/" + m.name + "/" + act.name,
            actionType = act.type.ToString(),
            controlType = act.expectedControlType ?? ""
        };
        var singles = new List<KeyValuePair<InputBinding, InputScheme.Binding>>();
        var comps = new List<Comp>();
        Comp cur = null;
        foreach (var b in act.bindings)
        {
            if (b.isComposite)
            {
                string name;
                try { name = b.GetNameOfComposite() ?? ""; } catch { name = b.path ?? ""; }
                cur = new Comp { b = b, name = name };
                comps.Add(cur);
                continue;
            }
            if (b.isPartOfComposite)
            {
                if (cur != null) cur.parts.Add(new Part { b = b, name = Lower(b.name), r = Resolve(b) });
                continue;
            }
            cur = null;
            singles.Add(new KeyValuePair<InputBinding, InputScheme.Binding>(b, Resolve(b)));
        }

        string ct = c.controlType;
        bool vector3 = ct == "Vector3" || comps.Exists(x => x.name.IndexOf("3DVector", StringComparison.OrdinalIgnoreCase) >= 0);
        bool vector = !vector3 && (ct == "Vector2" || ct == "Stick" || ct == "Dpad" || ct == "Delta" || comps.Exists(x => x.name == "2DVector" || x.name == "Dpad"));
        bool axis = !vector && !vector3 && (ct == "Axis" || comps.Exists(x => x.name == "1DAxis"));
        c.kind = vector ? "stick" : axis ? "axis" : "button";

        var cands = new List<KeyValuePair<bool, Alt>>();
        void Add(bool inGroup, string binding, string text, Output o)
        {
            if (o == null) return;
            cands.Add(new KeyValuePair<bool, Alt>(inGroup, new Alt { binding = binding, text = text, output = o }));
        }

        if (vector3)
        {
            c.unavailable = "Vector3 actions have no phone control";
        }
        else if (vector)
        {
            foreach (var x in comps)
            {
                if (x.name != "2DVector" && x.name != "Dpad") continue;
                var o = new Output { type = "keys" };
                bool any = false, group = InGroup(x.b, s.group);
                foreach (var dir in new[] { "up", "down", "left", "right" })
                {
                    var p = x.parts.Find(q => q.name == dir && q.r.dev == "Keyboard" && !string.IsNullOrEmpty(q.r.key));
                    if (p == null) continue;
                    o.Set(dir, p.r.key);
                    any = true;
                    if (!InGroup(p.b, s.group)) group = false;
                }
                if (any) Add(group, x.b.id.ToString(), CompText(x), o);
            }
            foreach (var kv in singles)
            {
                var o = PointerOutput(kv.Value);
                if (o != null) Add(InGroup(kv.Key, s.group), kv.Key.id.ToString(), Text(kv.Key), o);
            }
        }
        else if (axis)
        {
            foreach (var x in comps)
            {
                if (x.name != "1DAxis") continue;
                var o = new Output { type = "keys" };
                bool any = false, group = InGroup(x.b, s.group);
                foreach (var dir in new[] { "negative", "positive" })
                {
                    var p = x.parts.Find(q => q.name == dir && q.r.dev == "Keyboard" && !string.IsNullOrEmpty(q.r.key));
                    if (p == null) continue;
                    o.Set(dir, p.r.key);
                    any = true;
                    if (!InGroup(p.b, s.group)) group = false;
                }
                if (any) Add(group, x.b.id.ToString(), CompText(x), o);
            }
            foreach (var kv in singles)
            {
                var r = kv.Value;
                var o = PointerOutput(r) ?? (r.dev == "Keyboard" && !string.IsNullOrEmpty(r.key) ? new Output { type = "key" }.Set("key", r.key) : r.dev == "Mouse" ? MouseButton(r) : null);
                Add(InGroup(kv.Key, s.group), kv.Key.id.ToString(), Text(kv.Key), o);
            }
        }
        else
        {
            foreach (var kv in singles)
            {
                var r = kv.Value;
                Output o = null;
                if (r.dev == "Keyboard" && !string.IsNullOrEmpty(r.key)) o = new Output { type = "key" }.Set("key", r.key);
                else if (r.dev == "Mouse") o = MouseButton(r) ?? PointerOutput(r);
                Add(InGroup(kv.Key, s.group), kv.Key.id.ToString(), Text(kv.Key), o);
            }
            foreach (var x in comps)
            {
                bool two = x.name == "ButtonWithTwoModifiers" || x.name == "TwoModifiers";
                bool one = x.name == "ButtonWithOneModifier" || x.name == "OneModifier";
                if (!one && !two) continue;
                var keys = new List<string>();
                bool ok = true, group = InGroup(x.b, s.group);
                foreach (var part in two ? new[] { "modifier1", "modifier2" } : new[] { "modifier" })
                {
                    var p = x.parts.Find(q => q.name == part && q.r.dev == "Keyboard" && !string.IsNullOrEmpty(q.r.key));
                    if (p == null) { ok = false; break; }
                    keys.Add(p.r.key);
                    if (!InGroup(p.b, s.group)) group = false;
                }
                var main = x.parts.Find(q => (q.name == "button" || q.name == "binding") && q.r.dev == "Keyboard" && !string.IsNullOrEmpty(q.r.key));
                if (!ok || main == null) continue;
                if (!InGroup(main.b, s.group)) group = false;
                keys.Add(main.r.key);
                var o = new Output { type = "chord" };
                o.keys.AddRange(keys);
                Add(group, x.b.id.ToString(), CompText(x), o);
            }
        }

        foreach (var kv in cands)
            if (kv.Key) { c.main = kv.Value; break; }
        if (c.main == null && cands.Count > 0) c.main = cands[0].Value;
        foreach (var kv in cands)
            if (kv.Value != c.main) c.alts.Add(kv.Value);
        if (c.main != null && c.main.output.type is "mouseDelta" or "scroll" or "mousePosition") c.kind = "pointer";
        else if (c.main != null && c.main.output.type is "key" or "chord" or "mouse" or "wheel") c.kind = "button";

        foreach (var kv in singles)
        {
            if (kv.Value.dev != "Gamepad") continue;
            var o = PadOutput(kv.Key, vector, axis);
            if (o == null) continue;
            c.pad = new Alt { binding = kv.Key.id.ToString(), text = Text(kv.Key), output = o };
            break;
        }
        if (c.pad == null && vector)
            foreach (var x in comps)
            {
                if (x.name != "2DVector" && x.name != "Dpad") continue;
                if (x.parts.Exists(q => q.r.dev == "Gamepad" && PadCtl(q.b).StartsWith("dpad", StringComparison.OrdinalIgnoreCase)))
                {
                    c.pad = new Alt { binding = x.b.id.ToString(), text = CompText(x), output = new Output { type = "gamepad" }.Set("stick", "dpad") };
                    break;
                }
            }

        if (c.main == null && string.IsNullOrEmpty(c.unavailable))
        {
            var devs = new List<string>();
            foreach (var kv in singles)
                if (!string.IsNullOrEmpty(kv.Value.dev) && !devs.Contains(kv.Value.dev)) devs.Add(kv.Value.dev);
            foreach (var x in comps)
                foreach (var p in x.parts)
                    if (!string.IsNullOrEmpty(p.r.dev) && !devs.Contains(p.r.dev)) devs.Add(p.r.dev);
            c.unavailable = devs.Count == 0 ? "no bindings" : "no keyboard or mouse binding (" + string.Join(", ", devs) + ")";
        }

        Behavior(c, act);
        return c;
    }

    static string CompText(Comp x)
    {
        var sb = new StringBuilder(x.name);
        sb.Append(':');
        foreach (var p in x.parts) sb.Append(' ').Append(p.name).Append('=').Append(Text(p.b));
        return sb.ToString();
    }

    sealed class Interaction
    {
        public string name;
        public readonly Dictionary<string, float> args = new Dictionary<string, float>(StringComparer.OrdinalIgnoreCase);
    }

    static List<Interaction> ParseInteractions(string s)
    {
        var list = new List<Interaction>();
        if (string.IsNullOrEmpty(s)) return list;
        foreach (Match m in Regex.Matches(s, "([A-Za-z_][A-Za-z0-9_]*)\\s*(?:\\(([^)]*)\\))?"))
        {
            var it = new Interaction { name = m.Groups[1].Value };
            if (m.Groups[2].Success)
                foreach (var kv in m.Groups[2].Value.Split(','))
                {
                    var eq = kv.IndexOf('=');
                    if (eq <= 0) continue;
                    if (float.TryParse(kv.Substring(eq + 1).Trim(), NumberStyles.Float, CultureInfo.InvariantCulture, out var f)) it.args[kv.Substring(0, eq).Trim()] = f;
                }
            list.Add(it);
        }
        return list;
    }

    static void Behavior(Ctl c, InputAction act)
    {
        if (c.kind != "button") return;
        string raw = act.interactions ?? "";
        if (c.main != null)
            foreach (var b in act.bindings)
                if (b.id.ToString() == c.main.binding && !string.IsNullOrEmpty(b.interactions)) raw = string.IsNullOrEmpty(raw) ? b.interactions : raw + "," + b.interactions;
        c.interactions = raw;
        var list = ParseInteractions(raw);
        Interaction hold = null, slow = null, tap = null, multi = null;
        foreach (var it in list)
        {
            if (it.name.Equals("Hold", StringComparison.OrdinalIgnoreCase)) hold = hold ?? it;
            else if (it.name.Equals("SlowTap", StringComparison.OrdinalIgnoreCase)) slow = slow ?? it;
            else if (it.name.Equals("Tap", StringComparison.OrdinalIgnoreCase)) tap = tap ?? it;
            else if (it.name.Equals("MultiTap", StringComparison.OrdinalIgnoreCase)) multi = multi ?? it;
        }
        var st = InputSystem.settings;
        float defHold = st != null ? st.defaultHoldTime : 0.4f;
        float defSlow = st != null ? st.defaultSlowTapTime : 0.5f;
        float defTap = st != null ? st.defaultTapTime : 0.2f;
        int Ms(Interaction it, string key, float def) => Mathf.RoundToInt((it != null && it.args.TryGetValue(key, out var v) && v > 0 ? v : def) * 1000f);
        bool holdLike = hold != null || slow != null;
        bool tapLike = tap != null || multi != null;
        if (holdLike) c.holdMs = hold != null ? Ms(hold, "duration", defHold) : Ms(slow, "duration", defSlow);
        if (holdLike && !tapLike) c.behavior = "hold";
        else if (multi != null && !holdLike)
        {
            c.behavior = "multiTap";
            c.taps = multi.args.TryGetValue("tapCount", out var n) && n >= 1 ? Mathf.RoundToInt(n) : 2;
            c.tapMs = Mathf.Clamp(Ms(multi, "tapTime", defTap) / 3, 30, 80);
        }
        else if (tap != null && !holdLike)
        {
            c.behavior = "tap";
            c.tapMs = Mathf.Clamp(Ms(tap, "duration", defTap) / 3, 30, 80);
        }
        else c.behavior = "press";
    }

    static readonly Regex YamlActions = new Regex("m_Actions:\\s*\\{fileID:\\s*-?\\d+,\\s*guid:\\s*([0-9a-f]{32})", RegexOptions.Compiled);
    static readonly Regex YamlMap = new Regex("m_DefaultActionMap:\\s*(.*)$", RegexOptions.Compiled | RegexOptions.Multiline);
    static readonly Regex YamlScheme = new Regex("m_DefaultControlScheme:\\s*(.*)$", RegexOptions.Compiled | RegexOptions.Multiline);

    static List<Player> FindPlayers()
    {
        var list = new List<Player>();
        var seen = new HashSet<string>();
        try
        {
            foreach (var pi in UnityEngine.Object.FindObjectsByType<PlayerInput>(FindObjectsInactive.Include, FindObjectsSortMode.None))
            {
                if (pi == null || pi.actions == null) continue;
                var ap = AssetDatabase.GetAssetPath(pi.actions);
                if (string.IsNullOrEmpty(ap)) ap = PathByMaps(pi.actions);
                var scene = pi.gameObject.scene.path;
                list.Add(new Player { where = $"{pi.gameObject.name} in {(string.IsNullOrEmpty(scene) ? "the open scene" : scene)}", assetPath = ap, map = pi.defaultActionMap ?? "", scheme = pi.defaultControlScheme ?? "", open = true });
                if (!string.IsNullOrEmpty(scene)) seen.Add(scene);
            }
        }
        catch { }
        list.Sort((a, b) => string.CompareOrdinal(a.where, b.where));

        var files = new List<string>();
        try
        {
            var roots = new List<string>();
            foreach (var sc in EditorBuildSettings.scenes)
                if (sc != null && sc.enabled && !string.IsNullOrEmpty(sc.path) && !roots.Contains(sc.path)) roots.Add(sc.path);
            for (int i = 0; i < UnityEngine.SceneManagement.SceneManager.sceneCount; i++)
            {
                var p = UnityEngine.SceneManagement.SceneManager.GetSceneAt(i).path;
                if (!string.IsNullOrEmpty(p) && !roots.Contains(p)) roots.Add(p);
            }
            foreach (var r in roots)
            {
                if (files.Count >= MaxScanFiles) break;
                if (!files.Contains(r)) files.Add(r);
                foreach (var d in AssetDatabase.GetDependencies(r, true))
                {
                    if (files.Count >= MaxScanFiles) break;
                    if (d.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) && d.StartsWith("Assets/", StringComparison.Ordinal) && !files.Contains(d)) files.Add(d);
                }
            }
        }
        catch { }

        foreach (var f in files)
        {
            bool refs = false;
            try
            {
                foreach (var d in AssetDatabase.GetDependencies(f, false))
                    if (d.EndsWith(".inputactions", StringComparison.OrdinalIgnoreCase)) { refs = true; break; }
            }
            catch { }
            if (!refs) continue;
            string text;
            try
            {
                var full = Path.Combine(ProjectRoot, f);
                var info = new FileInfo(full);
                if (!info.Exists || info.Length > MaxScanBytes) continue;
                text = File.ReadAllText(full);
            }
            catch { continue; }
            if (!text.StartsWith("%YAML", StringComparison.Ordinal)) continue;
            var docs = text.Split(new[] { "\n--- " }, StringSplitOptions.None);
            foreach (var doc in docs)
            {
                if (!doc.Contains("m_DefaultActionMap:")) continue;
                var am = YamlActions.Match(doc);
                if (!am.Success) continue;
                var ap = AssetDatabase.GUIDToAssetPath(am.Groups[1].Value);
                if (string.IsNullOrEmpty(ap)) continue;
                var map = YamlMap.Match(doc);
                var sch = YamlScheme.Match(doc);
                if (seen.Contains(f) && list.Exists(p => p.open && p.assetPath == ap)) continue;
                list.Add(new Player { where = "PlayerInput in " + f, assetPath = ap, map = map.Success ? map.Groups[1].Value.Trim() : "", scheme = sch.Success ? sch.Groups[1].Value.Trim() : "" });
            }
        }
        return list;
    }

    static string PathByMaps(InputActionAsset a)
    {
        var key = InputScheme.KeyOf(a);
        foreach (var guid in AssetDatabase.FindAssets("t:InputActionAsset"))
        {
            var p = AssetDatabase.GUIDToAssetPath(guid);
            var x = AssetDatabase.LoadAssetAtPath<InputActionAsset>(p);
            if (x != null && InputScheme.KeyOf(x) == key) return p;
        }
        return "";
    }
#else
    static string Build(out string summary)
    {
        summary = "no Input System";
        return "{\n  \"format\": \"satura-remote-controls\",\n  \"version\": 1,\n  \"inputSystem\": false,\n  \"defaultMap\": \"\",\n  \"defaultMapReason\": \"\",\n  \"assets\": [],\n  \"maps\": []\n}\n";
    }
#endif
}
#endif
