using UnityEngine;
using System;
using System.IO;
using System.Reflection;

public static partial class MCPTestBridge
{
    [Serializable]
    struct HotReloadTriggerData { public bool enabled; }

    [Serializable]
    struct HotReloadPatchData { public string[] files; }

    static void HandleHotReload(string json)
    {
        bool enabled = true;
        try { enabled = JsonUtility.FromJson<HotReloadTriggerData>(json).enabled; }
        catch { }

        var prop = FindHotReloadEnabledProperty();
        if (prop == null)
        {
            Debug.LogWarning("[HotReload] package not installed — cannot "
                + (enabled ? "enable" : "disable") + " hot reload.");
            return;
        }
        try
        {
            prop.SetValue(null, enabled);
            Debug.Log("[HotReload] orchestrator set Enabled=" + (enabled ? "true" : "false") + ".");
        }
        catch (Exception e)
        {
            Debug.LogWarning("[HotReload] failed to set Enabled: " + (e.InnerException ?? e).Message);
        }
    }

    static PropertyInfo FindHotReloadEnabledProperty()
    {
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type t;
            try { t = asm.GetType("HotReloadPrototype.Editor.HotReloadController"); }
            catch { continue; }
            if (t != null)
                return t.GetProperty("Enabled", BindingFlags.Public | BindingFlags.Static);
        }
        return null;
    }

    static void ApplyHotReloadPatch(string[] files)
    {
        if (files == null || files.Length == 0) return;
        var full = new System.Collections.Generic.List<string>();
        foreach (var f in files)
        {
            if (string.IsNullOrEmpty(f)) continue;
            full.Add(Path.IsPathRooted(f) ? f : Path.GetFullPath(Path.Combine(ProjectRoot, f)));
        }
        if (full.Count == 0) return;

        var method = FindHotReloadPatchMethod();
        if (method == null)
        {
            Debug.LogWarning("[HotReload] package not installed — cannot push live patch.");
            return;
        }
        try { method.Invoke(null, new object[] { full.ToArray() }); }
        catch (Exception e)
        {
            Debug.LogWarning("[HotReload] failed to push live patch: " + (e.InnerException ?? e).Message);
        }
    }

    static MethodInfo FindHotReloadPatchMethod()
    {
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            Type t;
            try { t = asm.GetType("HotReloadPrototype.Editor.HotReloadController"); }
            catch { continue; }
            if (t != null)
                return t.GetMethod("PatchFiles", BindingFlags.Public | BindingFlags.Static,
                    null, new[] { typeof(string[]) }, null);
        }
        return null;
    }
}
