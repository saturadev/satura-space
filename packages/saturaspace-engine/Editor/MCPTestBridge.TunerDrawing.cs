using System;
using System.Diagnostics;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

public static partial class MCPTestBridge
{
    static bool _tunerDrawingPatchTried;
    static bool _tunerDrawingPatched;
    static FieldInfo _tunerDrawingViewField;
    static bool? _tunerDrawingGizmos;

    static void EnsureTunerDrawingPatch()
    {
        if (_tunerDrawingPatchTried) return;
        _tunerDrawingPatchTried = true;
        _tunerDrawingViewField = typeof(SceneView).GetField("s_CurrentDrawingSceneView", BindingFlags.Static | BindingFlags.NonPublic);
        try
        {
            var asm = FindHarmony();
            if (asm == null) throw new TypeLoadException("Harmony is not loaded");
            var harmonyType = asm.GetType(HarmonyTypeName, true);
            var methodType = asm.GetType(HarmonyMethodTypeName, true);
            var harmony = Activator.CreateInstance(harmonyType, "com.saturaspace.tuner-drawing");
            var patch = harmonyType.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .First(m => m.Name == "Patch" && m.GetParameters().Length >= 3 && m.GetParameters()[0].ParameterType == typeof(MethodBase));
            var prefix = methodType.GetConstructor(new[] { typeof(MethodInfo) })
                .Invoke(new object[] { typeof(MCPTestBridge).GetMethod(nameof(TunerShouldRenderGizmosPrefix), BindingFlags.Static | BindingFlags.NonPublic) });
            var target = typeof(Handles).GetMethod("ShouldRenderGizmos", BindingFlags.Static | BindingFlags.Public, null, Type.EmptyTypes, null);
            if (target == null) throw new MissingMethodException("Handles.ShouldRenderGizmos");
            var args = new object[patch.GetParameters().Length];
            args[0] = target;
            args[1] = prefix;
            patch.Invoke(harmony, args);
            _tunerDrawingPatched = _tunerDrawingViewField != null;
            if (_tunerDrawingViewField == null) Debug.LogWarning("[Tuner] SceneView.s_CurrentDrawingSceneView was not found, so gizmo drawing libraries draw nothing in the Tuner");
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            Debug.LogWarning("[Tuner] could not patch Handles.ShouldRenderGizmos, so gizmo drawing libraries draw nothing in the Tuner: " + inner.Message);
        }
    }

    static SceneView BeginTunerThirdPartyDrawing(bool gizmos)
    {
        EnsureTunerDrawingPatch();
        if (!_tunerDrawingPatched || _tunerSceneHost == null) return null;
        var prev = SceneView.currentDrawingSceneView;
        _tunerDrawingViewField.SetValue(null, _tunerSceneHost);
        _tunerDrawingGizmos = gizmos;
        return prev;
    }

    static void EndTunerThirdPartyDrawing(SceneView prev)
    {
        if (!_tunerDrawingGizmos.HasValue) return;
        _tunerDrawingGizmos = null;
        _tunerDrawingViewField.SetValue(null, prev);
    }

    static bool TunerShouldRenderGizmosPrefix(ref bool __result)
    {
        if (!_tunerDrawingGizmos.HasValue) return true;
        __result = _tunerDrawingGizmos.Value && !TunerAskedByRenderPipeline();
        return false;
    }

    static bool TunerAskedByRenderPipeline()
    {
        var frames = new StackTrace(1, false).GetFrames();
        if (frames == null) return false;
        int seen = 0;
        foreach (var f in frames)
        {
            var m = f.GetMethod();
            var t = m != null ? m.DeclaringType : null;
            if (t == null || t == typeof(MCPTestBridge) || t == typeof(Handles)) continue;
            var name = t.Assembly.GetName().Name;
            if (name.StartsWith("Unity.RenderPipelines", StringComparison.Ordinal)) return true;
            if (++seen >= 2) return false;
        }
        return false;
    }
}
