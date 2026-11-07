using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEditor.Build;
using UnityEngine;

public static partial class MCPTestBridge
{
    const double SchemePollSeconds = 0.5;
    static readonly List<ControlClient> _schemeWatchers = new List<ControlClient>();
    static string _schemeSig;
    static double _schemeNextAt;

    static void HandleInputScheme(int id, string line, ControlClient from)
    {
        bool watch = line.IndexOf("\"watch\":true", StringComparison.Ordinal) >= 0;
        bool unwatch = line.IndexOf("\"watch\":false", StringComparison.Ordinal) >= 0;
        lock (_schemeWatchers)
        {
            if (watch && from != null && !_schemeWatchers.Contains(from)) _schemeWatchers.Add(from);
            if (unwatch) _schemeWatchers.Remove(from);
        }
        string json;
        try { json = InputScheme.BuildJson(out _schemeSig); }
        catch (Exception e)
        {
            CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"error\",\"error\":\"{CtrlEscape(e.Message)}\"}}");
            return;
        }
        CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"completed\",\"scheme\":{json}}}");
    }

    const string GamepadDefine = "SATURA_REMOTE_GAMEPAD";
    const double RegenDebounceSeconds = 0.6;
    static double _regenAt;
    static string _regenWhy;

    public static void ScheduleControlsRegen(string why)
    {
        _regenWhy = string.IsNullOrEmpty(_regenWhy) ? why : _regenWhy;
        _regenAt = EditorApplication.timeSinceStartup + RegenDebounceSeconds;
    }

    static void PollControlsRegen()
    {
        if (_regenAt <= 0 || EditorApplication.timeSinceStartup < _regenAt) return;
        if (EditorApplication.isCompiling || EditorApplication.isUpdating) return;
        string why = _regenWhy ?? "";
        _regenAt = 0;
        _regenWhy = null;
        RemoteControlsGen.Run(why, out _, out _);
    }

    static void HandleInputGenerate(int id, ControlClient from)
    {
        _regenAt = 0;
        _regenWhy = null;
        bool ok = RemoteControlsGen.Run("asked by the app", out bool changed, out string error);
        if (!ok)
        {
            CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"error\",\"error\":\"{CtrlEscape(error)}\"}}");
            return;
        }
        CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"completed\",\"changed\":{(changed ? "true" : "false")},\"state\":\"{CtrlEscape(RemoteControlsGen.LastStatus)}\",\"path\":\"{CtrlEscape(RemoteControlsGen.FilePath)}\",\"summary\":\"{CtrlEscape(RemoteControlsGen.LastSummary)}\",\"gamepadModule\":{(InputScheme.GamepadModulePresent() ? "true" : "false")}}}");
    }

    static bool GamepadModuleAsmdef()
    {
        try
        {
            var engine = UnityEditor.PackageManager.PackageInfo.FindForPackageName("com.saturaspace.engine");
            if (engine != null && System.IO.File.Exists(System.IO.Path.Combine(engine.resolvedPath, "Sdk", "RemoteGamepad", "SaturaSpace.Sdk.RemoteGamepad.asmdef"))) return true;
        }
        catch { }
        try { return AssetDatabase.FindAssets("SaturaSpace.Sdk.RemoteGamepad t:AssemblyDefinitionAsset").Length > 0; }
        catch { return false; }
    }

    static void HandleGamepadModule(int id, string line, ControlClient from)
    {
        bool on = line.IndexOf("\"on\":true", StringComparison.Ordinal) >= 0;
        bool off = line.IndexOf("\"on\":false", StringComparison.Ordinal) >= 0;
        string error = null;
        bool asmdef = GamepadModuleAsmdef();
        var targets = new List<NamedBuildTarget> { NamedBuildTarget.Standalone };
        try
        {
            var active = NamedBuildTarget.FromBuildTargetGroup(EditorUserBuildSettings.selectedBuildTargetGroup);
            if (active != NamedBuildTarget.Standalone) targets.Add(active);
        }
        catch { }
        bool changed = false;
        var states = new List<string>();
        if (on && !asmdef) error = "The Satura Space engine in this project has no Remote gamepad module (no SaturaSpace.Sdk.RemoteGamepad assembly). Reopen the project in Satura Space to restore Packages/com.saturaspace.engine.";
        else
        {
            foreach (var t in targets)
            {
                string defs;
                try { defs = PlayerSettings.GetScriptingDefineSymbols(t) ?? ""; }
                catch (Exception e) { error = e.Message; break; }
                var list = new List<string>(defs.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries));
                bool has = list.Contains(GamepadDefine);
                if (on && !has) { list.Add(GamepadDefine); changed = true; }
                if (off && has) { list.Remove(GamepadDefine); changed = true; }
                if ((on && !has) || (off && has))
                {
                    try { PlayerSettings.SetScriptingDefineSymbols(t, string.Join(";", list)); }
                    catch (Exception e) { error = e.Message; break; }
                }
                states.Add(t.TargetName + "=" + (list.Contains(GamepadDefine) ? "on" : "off"));
            }
        }
        if (changed)
        {
            Debug.Log($"[RemoteControls] gamepad module define {GamepadDefine} turned {(on ? "on" : "off")}: {string.Join(", ", states)}; scripts recompile");
        }
        if (error != null)
        {
            CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"error\",\"error\":\"{CtrlEscape(error)}\"}}");
            return;
        }
        CtrlReply(from, $"{{\"type\":\"result\",\"id\":{id},\"status\":\"completed\",\"changed\":{(changed ? "true" : "false")},\"present\":{(InputScheme.GamepadModulePresent() ? "true" : "false")},\"asmdef\":{(asmdef ? "true" : "false")},\"defines\":\"{CtrlEscape(string.Join(", ", states))}\"}}");
    }

    static void PollInputScheme()
    {
        PollControlsRegen();
        if (_ctrlPort == 0) return;
        double now = EditorApplication.timeSinceStartup;
        if (now < _schemeNextAt) return;
        _schemeNextAt = now + SchemePollSeconds;
        ControlClient[] watchers;
        lock (_schemeWatchers)
        {
            _schemeWatchers.RemoveAll(c => !CtrlClientAlive(c));
            if (_schemeWatchers.Count == 0) return;
            watchers = _schemeWatchers.ToArray();
        }
        string sig;
        try { sig = InputScheme.Signature(); }
        catch { return; }
        if (sig == _schemeSig) return;
        string json;
        try { json = InputScheme.BuildJson(out _schemeSig); }
        catch (Exception e)
        {
            Debug.LogWarning("[InputScheme] scheme report failed: " + e.Message);
            _schemeSig = sig;
            return;
        }
        var bytes = Encoding.UTF8.GetBytes($"{{\"type\":\"event\",\"event\":\"inputScheme\",\"scheme\":{json}}}\n");
        foreach (var c in watchers) CtrlSendTo(c, bytes);
    }
}

sealed class InputSchemeAssetWatch : AssetPostprocessor
{
    static void OnPostprocessAllAssets(string[] imported, string[] deleted, string[] moved, string[] movedFrom)
    {
        if (MCPTestBridge.Inert) return;
        bool actions = Touches(imported, ".inputactions") || Touches(deleted, ".inputactions") || Touches(moved, ".inputactions") || Touches(movedFrom, ".inputactions");
        if (actions) InputScheme.AssetsChanged();
        if (actions) MCPTestBridge.ScheduleControlsRegen("Input System asset imported");
        else if (Touches(imported, ".unity") || Touches(imported, ".prefab")) MCPTestBridge.ScheduleControlsRegen("scene or prefab imported");
    }

    static bool Touches(string[] paths, string ext)
    {
        if (paths == null) return false;
        for (int i = 0; i < paths.Length; i++)
            if (paths[i] != null && paths[i].EndsWith(ext, StringComparison.OrdinalIgnoreCase)) return true;
        return false;
    }
}

[InitializeOnLoad]
static class RemoteControlsOnLoad
{
    static RemoteControlsOnLoad()
    {
        if (MCPTestBridge.Inert) return;
        MCPTestBridge.ScheduleControlsRegen("editor loaded");
    }
}
