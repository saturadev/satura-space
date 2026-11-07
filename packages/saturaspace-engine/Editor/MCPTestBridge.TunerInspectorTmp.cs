using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

public static partial class MCPTestBridge
{
    const string TI_TMP_SECTION_HEADER = "TMP SectionHeader";

    static bool s_TiTmpPatched;
    static RuntimeMethodHandle[] s_TiTmpEntryPoints;
    static int s_TiTmpImporterSkips;

    static string TiTmpStyleAlias(GUIStyle st)
    {
        var bg = st.normal.background;
        if (bg == null) return null;
        var n = bg.name;
        return n == "SectionHeader_Dark" || n == "SectionHeader_Light" ? TI_TMP_SECTION_HEADER : null;
    }

    static void TiTmpEnsure()
    {
        if (s_TiTmpPatched) return;
        s_TiTmpPatched = true;
        var targets = new List<MethodBase>();
        var settings = typeof(TMPro.TMP_Settings);
        var delayed = settings.GetMethod("DelayShowPackageImporterWindow", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
        if (delayed != null) targets.Add(delayed);
        foreach (var name in new[] { "TMPro.TMP_PackageResourceImporterWindow", "TMPro.TMP_ShaderPackageImporterWindow" })
        {
            var t = settings.Assembly.GetType(name);
            var show = t?.GetMethod("ShowPackageImporterWindow", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null, Type.EmptyTypes, null);
            if (show != null) targets.Add(show);
        }
        if (targets.Count == 0) return;
        try
        {
            var asm = FindHarmony();
            if (asm == null)
            {
                Debug.LogWarning("[tunerInspector] TMP importer guard unavailable: Harmony is not loaded");
                return;
            }
            var harmonyType = asm.GetType(HarmonyTypeName, true);
            var methodType = asm.GetType(HarmonyMethodTypeName, true);
            var harmony = Activator.CreateInstance(harmonyType, "com.saturaspace.tuner-tmp");
            var patch = harmonyType.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .First(m => m.Name == "Patch" && m.GetParameters().Length >= 3 && m.GetParameters()[0].ParameterType == typeof(MethodBase));
            var hook = typeof(TunerTmpHooks).GetMethod(nameof(TunerTmpHooks.ImporterPrefix), BindingFlags.Static | BindingFlags.Public);
            var prefix = methodType.GetConstructor(new[] { typeof(MethodInfo) }).Invoke(new object[] { hook });
            foreach (var target in targets)
            {
                var args = new object[patch.GetParameters().Length];
                args[0] = target;
                args[1] = prefix;
                patch.Invoke(harmony, args);
            }
            SaturaDebug.Log("[tunerInspector] TMP importer guard on (" + targets.Count + " entry points)");
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            Debug.LogWarning("[tunerInspector] TMP importer guard failed: " + inner.Message);
        }
    }

    public static class TunerTmpHooks
    {
        public static bool ImporterPrefix() => TiTmpImporterPrefix();

    }

    static bool TiTmpImporterPrefix()
    {
        if (!TiTmpFromTuner()) return true;
        s_TiTmpImporterSkips++;
        if (s_TiTmpImporterSkips == 1)
            Debug.Log("[tunerInspector] TextMesh Pro Essential Resources are missing or out of date, so the Tuner did not open TMP's importer window. Import them from Window > TextMeshPro > Import TMP Essential Resources.");
        return false;
    }

    static bool TiTmpFromTuner()
    {
        if (s_TiTmpEntryPoints == null)
            s_TiTmpEntryPoints = new[]
            {
                ((Action<int, string, string, ControlClient>)HandleTunerInspectorCommand).Method.MethodHandle,
                ((Action)TunerInspectorTick).Method.MethodHandle,
                ((Action<TiSession>)TiBuild).Method.MethodHandle
            };
        var frames = new StackTrace(1, false).GetFrames();
        if (frames == null) return false;
        foreach (var f in frames)
        {
            RuntimeMethodHandle h;
            try
            {
                var m = f.GetMethod();
                if (m == null) continue;
                h = m.MethodHandle;
            }
            catch
            {
                continue;
            }
            foreach (var e in s_TiTmpEntryPoints)
                if (h == e) return true;
        }
        return false;
    }
}
