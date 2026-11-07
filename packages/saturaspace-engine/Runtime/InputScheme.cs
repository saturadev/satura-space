#if UNITY_EDITOR
using System;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
#if ENABLE_INPUT_SYSTEM
using UnityEngine.InputSystem;
#endif

public static class InputScheme
{
    [Serializable]
    public class Binding
    {
        public string id;
        public string path;
        public string display;
        public string dev;
        public string ctl;
        public string key;
        public string groups;
        public string interactions;
        public string processors;
        public string composite;
        public string part;
    }

    [Serializable]
    public class Act
    {
        public string id;
        public string name;
        public string type;
        public string control;
        public bool enabled;
        public string interactions;
        public string processors;
        public Binding[] bindings;
    }

    [Serializable]
    public class Map
    {
        public string id;
        public string name;
        public bool enabled;
        public Act[] actions;
    }

    [Serializable]
    public class Scheme
    {
        public string name;
        public string group;
        public string[] devices;
    }

    [Serializable]
    public class Asset
    {
        public string key;
        public string name;
        public string path;
        public string[] sources;
        public Scheme[] schemes;
        public Map[] maps;
    }

    [Serializable]
    public class Player
    {
        public string obj;
        public string asset;
        public string map;
        public string scheme;
        public string defaultScheme;
        public bool autoSwitch;
        public string behavior;
        public bool active;
        public int index;
    }

    [Serializable]
    public class Report
    {
        public int v = 2;
        public bool inputSystem;
        public bool gamepadModule;
        public bool sdk;
        public bool playing;
        public bool paused;
        public string sig;
        public int enabledCount;
        public Asset[] assets;
        public Player[] players;
        public Act[] loose;
    }

    public static int AssetsVersion;

    public const string GamepadModuleType = "SaturaSpace.Remote.SaturaRemoteGamepad, SaturaSpace.Sdk.RemoteGamepad";

    public static bool GamepadModulePresent()
    {
        try { return Type.GetType(GamepadModuleType, false) != null; }
        catch { return false; }
    }

    public static bool SdkPresent()
    {
        try { return Type.GetType("SaturaSpace.SaturaHandleAttribute, SaturaSpace.Sdk", false) != null; }
        catch { return false; }
    }

    public static void AssetsChanged()
    {
        AssetsVersion++;
    }

#if ENABLE_INPUT_SYSTEM
    static PropertyInfo projectWideProp;
    static bool projectWideResolved;

    public static InputActionAsset ProjectWide()
    {
        if (!projectWideResolved)
        {
            projectWideResolved = true;
            projectWideProp = typeof(InputSystem).GetProperty("actions", BindingFlags.Static | BindingFlags.Public);
        }
        if (projectWideProp == null) return null;
        try { return projectWideProp.GetValue(null) as InputActionAsset; }
        catch { return null; }
    }

    static readonly List<InputAction> enabledScratch = new List<InputAction>();

    public static string Signature()
    {
        var sb = new StringBuilder(256);
        sb.Append(EditorApplication.isPlaying ? 'P' : 'E').Append(EditorApplication.isPaused ? 'p' : '-').Append(AssetsVersion).Append('|');
        var pw = ProjectWide();
        sb.Append(pw != null ? pw.GetHashCode() : 0).Append('|');
        enabledScratch.Clear();
        try { InputSystem.ListEnabledActions(enabledScratch); } catch { }
        for (int i = 0; i < enabledScratch.Count; i++) sb.Append(enabledScratch[i].id.GetHashCode()).Append(',');
        sb.Append('|');
        try { sb.Append(Resources.FindObjectsOfTypeAll<InputActionAsset>().Length); } catch { }
        sb.Append('|');
        if (EditorApplication.isPlaying)
        {
            foreach (var pi in FindPlayers())
                sb.Append(pi.isActiveAndEnabled ? '1' : '0').Append(pi.currentActionMap?.name).Append(':').Append(pi.currentControlScheme).Append(';');
        }
        return Hash(sb.ToString());
    }

    static PlayerInput[] FindPlayers()
    {
        try { return UnityEngine.Object.FindObjectsByType<PlayerInput>(FindObjectsInactive.Include, FindObjectsSortMode.None); }
        catch { return Array.Empty<PlayerInput>(); }
    }

    class Group
    {
        public string key;
        public readonly List<InputActionAsset> members = new List<InputActionAsset>();
        public readonly List<string> sources = new List<string>();
        public string path = "";
        public string name = "";
    }

    public static string BuildJson(out string sig)
    {
        sig = Signature();
        var report = new Report { inputSystem = true, gamepadModule = GamepadModulePresent(), sdk = SdkPresent(), playing = EditorApplication.isPlaying, paused = EditorApplication.isPaused, sig = sig };
        var groups = new List<Group>();
        var byKey = new Dictionary<string, Group>();
        var seen = new HashSet<InputActionAsset>();

        void Add(InputActionAsset a, string source, string path)
        {
            if (a == null) return;
            string key = KeyOf(a);
            if (!byKey.TryGetValue(key, out var g))
            {
                g = new Group { key = key, name = a.name ?? "" };
                byKey[key] = g;
                groups.Add(g);
            }
            if (!string.IsNullOrEmpty(path) && string.IsNullOrEmpty(g.path)) { g.path = path; g.name = a.name ?? g.name; }
            if (!g.sources.Contains(source)) g.sources.Add(source);
            if (seen.Add(a)) g.members.Add(a);
        }

        var pw = ProjectWide();
        if (pw != null) Add(pw, "project", AssetDatabase.GetAssetPath(pw));
        try
        {
            foreach (var guid in AssetDatabase.FindAssets("t:InputActionAsset"))
            {
                var path = AssetDatabase.GUIDToAssetPath(guid);
                if (string.IsNullOrEmpty(path) || path.StartsWith("Packages/", StringComparison.Ordinal)) continue;
                var a = AssetDatabase.LoadAssetAtPath<InputActionAsset>(path);
                Add(a, "file", path);
            }
        }
        catch { }

        var players = new List<Player>();
        foreach (var pi in FindPlayers())
        {
            if (pi == null) continue;
            var a = pi.actions;
            if (a != null) Add(a, "player:" + pi.gameObject.name, AssetDatabase.GetAssetPath(a));
            players.Add(new Player
            {
                obj = pi.gameObject.name,
                asset = a != null ? KeyOf(a) : "",
                map = (EditorApplication.isPlaying ? pi.currentActionMap?.name : pi.defaultActionMap) ?? "",
                scheme = (EditorApplication.isPlaying ? pi.currentControlScheme : pi.defaultControlScheme) ?? "",
                defaultScheme = pi.defaultControlScheme ?? "",
                autoSwitch = !pi.neverAutoSwitchControlSchemes,
                behavior = pi.notificationBehavior.ToString(),
                active = pi.isActiveAndEnabled,
                index = EditorApplication.isPlaying ? pi.playerIndex : -1
            });
        }

        if (EditorApplication.isPlaying)
        {
            try
            {
                foreach (var a in Resources.FindObjectsOfTypeAll<InputActionAsset>())
                {
                    if (a == null || seen.Contains(a)) continue;
                    var path = AssetDatabase.GetAssetPath(a);
                    if (!string.IsNullOrEmpty(path) && path.StartsWith("Packages/", StringComparison.Ordinal)) continue;
                    Add(a, string.IsNullOrEmpty(path) ? "runtime" : "file", path);
                }
            }
            catch { }
        }

        var assets = new List<Asset>();
        int enabledCount = 0;
        foreach (var g in groups)
        {
            var first = g.members[0];
            var schemes = new List<Scheme>();
            foreach (var cs in first.controlSchemes)
            {
                var devs = new List<string>();
                foreach (var r in cs.deviceRequirements) devs.Add((r.isOptional ? "?" : "") + r.controlPath);
                schemes.Add(new Scheme { name = cs.name, group = cs.bindingGroup, devices = devs.ToArray() });
            }
            var maps = new List<Map>();
            foreach (var map in first.actionMaps)
            {
                var acts = new List<Act>();
                bool mapEnabled = false;
                foreach (var act in map.actions)
                {
                    bool on = false;
                    foreach (var m in g.members)
                    {
                        var twin = m.FindAction(act.id);
                        if (twin != null && twin.enabled) { on = true; break; }
                    }
                    if (on) { mapEnabled = true; enabledCount++; }
                    acts.Add(Describe(act, on));
                }
                foreach (var m in g.members)
                {
                    var twinMap = m.FindActionMap(map.id);
                    if (twinMap != null && twinMap.enabled) mapEnabled = true;
                }
                maps.Add(new Map { id = map.id.ToString(), name = map.name, enabled = mapEnabled, actions = acts.ToArray() });
            }
            assets.Add(new Asset { key = g.key, name = g.name, path = g.path, sources = g.sources.ToArray(), schemes = schemes.ToArray(), maps = maps.ToArray() });
        }

        var loose = new List<Act>();
        enabledScratch.Clear();
        try { InputSystem.ListEnabledActions(enabledScratch); } catch { }
        foreach (var act in enabledScratch)
        {
            if (act == null || act.actionMap != null) continue;
            loose.Add(Describe(act, true));
            enabledCount++;
        }

        report.assets = assets.ToArray();
        report.players = players.ToArray();
        report.loose = loose.ToArray();
        report.enabledCount = enabledCount;
        return JsonUtility.ToJson(report);
    }

    public static string KeyOf(InputActionAsset a)
    {
        var sb = new StringBuilder();
        foreach (var m in a.actionMaps) sb.Append(m.id.ToString("N"), 0, 8);
        return sb.Length > 0 ? sb.ToString() : "empty:" + (a.name ?? "");
    }

    static Act Describe(InputAction act, bool on)
    {
        var bindings = new List<Binding>();
        string composite = "";
        foreach (var b in act.bindings)
        {
            var path = b.effectivePath ?? b.path ?? "";
            if (b.isComposite)
            {
                composite = SafeCompositeName(b);
                bindings.Add(new Binding { id = b.id.ToString(), path = path, composite = composite, part = "", groups = b.groups ?? "", interactions = b.effectiveInteractions ?? "", processors = b.effectiveProcessors ?? "", dev = "", ctl = "", key = "", display = composite });
                continue;
            }
            if (!b.isPartOfComposite) composite = "";
            var row = new Binding
            {
                id = b.id.ToString(),
                path = path,
                groups = b.groups ?? "",
                interactions = b.effectiveInteractions ?? "",
                processors = b.effectiveProcessors ?? "",
                composite = b.isPartOfComposite ? composite : "",
                part = b.isPartOfComposite ? (b.name ?? "") : "",
                display = Human(path)
            };
            Resolve(path, row);
            bindings.Add(row);
        }
        return new Act
        {
            id = act.id.ToString(),
            name = act.name,
            type = act.type.ToString(),
            control = act.expectedControlType ?? "",
            enabled = on,
            interactions = act.interactions ?? "",
            processors = act.processors ?? "",
            bindings = bindings.ToArray()
        };
    }

    static string SafeCompositeName(InputBinding b)
    {
        try { return b.GetNameOfComposite() ?? ""; }
        catch { return b.path ?? ""; }
    }

    static string Human(string path)
    {
        if (string.IsNullOrEmpty(path)) return "";
        try { return InputControlPath.ToHumanReadableString(path, InputControlPath.HumanReadableStringOptions.OmitDevice); }
        catch { return path; }
    }

    static readonly Dictionary<string, string> PadNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { "buttonSouth", "South" }, { "a", "South" }, { "cross", "South" },
        { "buttonEast", "East" }, { "b", "East" }, { "circle", "East" },
        { "buttonWest", "West" }, { "x", "West" }, { "square", "West" },
        { "buttonNorth", "North" }, { "y", "North" }, { "triangle", "North" },
        { "leftShoulder", "LeftShoulder" }, { "rightShoulder", "RightShoulder" },
        { "leftTrigger", "LeftTrigger" }, { "rightTrigger", "RightTrigger" },
        { "start", "Start" }, { "select", "Select" },
        { "leftStickPress", "LeftStickPress" }, { "rightStickPress", "RightStickPress" },
        { "leftStick", "LeftStick" }, { "rightStick", "RightStick" },
        { "dpad", "Dpad" }, { "dpad/up", "DpadUp" }, { "dpad/down", "DpadDown" }, { "dpad/left", "DpadLeft" }, { "dpad/right", "DpadRight" },
        { "leftStick/up", "LeftStick/up" }, { "leftStick/down", "LeftStick/down" }, { "leftStick/left", "LeftStick/left" }, { "leftStick/right", "LeftStick/right" },
        { "rightStick/up", "RightStick/up" }, { "rightStick/down", "RightStick/down" }, { "rightStick/left", "RightStick/left" }, { "rightStick/right", "RightStick/right" },
        { "leftStick/x", "LeftStick/x" }, { "leftStick/y", "LeftStick/y" }, { "rightStick/x", "RightStick/x" }, { "rightStick/y", "RightStick/y" }
    };

    static readonly Dictionary<string, string> MouseNames = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
    {
        { "leftButton", "button0" }, { "press", "button0" }, { "rightButton", "button1" }, { "middleButton", "button2" },
        { "backButton", "button3" }, { "forwardButton", "button4" },
        { "delta", "delta" }, { "delta/x", "delta/x" }, { "delta/y", "delta/y" },
        { "scroll", "scroll" }, { "scroll/y", "scroll/y" }, { "scroll/x", "scroll/x" }, { "scroll/up", "scroll/up" }, { "scroll/down", "scroll/down" },
        { "position", "position" }, { "position/x", "position/x" }, { "position/y", "position/y" }
    };

    public static void Resolve(string path, Binding row)
    {
        row.dev = "";
        row.ctl = "";
        row.key = "";
        if (string.IsNullOrEmpty(path) || path[0] != '<') { row.dev = string.IsNullOrEmpty(path) ? "" : "Other"; return; }
        int close = path.IndexOf('>');
        if (close < 0) { row.dev = "Other"; return; }
        string layout = path.Substring(1, close - 1);
        string rest = close + 2 <= path.Length ? path.Substring(Math.Min(path.Length, close + 2)) : "";
        int brace = layout.IndexOfAny(new[] { '{', '(' });
        if (brace >= 0) layout = layout.Substring(0, brace);
        if (layout == "Keyboard")
        {
            row.dev = "Keyboard";
            row.ctl = rest;
            if (rest.Equals("anyKey", StringComparison.OrdinalIgnoreCase)) { row.key = "Space"; return; }
            string name = rest;
            if (name.StartsWith("#(", StringComparison.Ordinal) && name.EndsWith(")", StringComparison.Ordinal) && name.Length == 4)
                name = char.ToUpperInvariant(name[2]).ToString();
            if (name.Length == 1 && char.IsDigit(name[0])) { row.key = "Digit" + name; return; }
            if (name.Length > 0 && !char.IsDigit(name[0]) && Enum.TryParse(name, true, out Key k) && k != Key.None) row.key = k.ToString();
            return;
        }
        if (layout == "Mouse" || layout == "Pointer")
        {
            row.dev = "Mouse";
            row.ctl = MouseNames.TryGetValue(rest, out var m) ? m : rest;
            return;
        }
        if (layout == "Gamepad")
        {
            row.dev = "Gamepad";
            row.ctl = PadNames.TryGetValue(rest, out var p) ? p : rest;
            return;
        }
        row.dev = layout;
        row.ctl = rest;
    }
#else
    public static string Signature() => "none";

    public static string BuildJson(out string sig)
    {
        sig = "none";
        return JsonUtility.ToJson(new Report { inputSystem = false, gamepadModule = GamepadModulePresent(), sdk = SdkPresent(), playing = EditorApplication.isPlaying, paused = EditorApplication.isPaused, sig = sig, assets = new Asset[0], players = new Player[0], loose = new Act[0] });
    }
#endif

    static string Hash(string s)
    {
        unchecked
        {
            ulong h = 1469598103934665603UL;
            for (int i = 0; i < s.Length; i++) { h ^= s[i]; h *= 1099511628211UL; }
            return h.ToString("x16");
        }
    }
}
#endif
