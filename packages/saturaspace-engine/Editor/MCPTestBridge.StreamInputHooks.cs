using System;
using System.Linq;
using System.Reflection;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    public static class StreamInputHooks
    {
        public static void SetCursorPostfix(Texture2D texture, Vector2 hotspot) => StreamCursor.OnSetCursor(texture, hotspot);
        public static void BeginGUIPostfix(int skinMode) => StreamInput.ApplyRepaintMouse(skinMode);
        public static CursorLockMode GetLockState() => StreamCursor.LockState;
        public static void SetLockState(CursorLockMode value) => StreamCursor.LockState = value;
    }

    static bool s_StreamInputHooksPatched;
    static object[] s_CursorLockDetours;

    [InitializeOnLoadMethod]
    static void InstallStreamInputHooks()
    {
        if (s_StreamInputHooksPatched) return;
        if (!int.TryParse(Environment.GetEnvironmentVariable("MC_UDP_PORT"), out int port) || port <= 0) return;
        try
        {
            var asm = FindHarmony();
            if (asm == null) throw new TypeLoadException("Harmony is not loaded");
            var harmonyType = asm.GetType(HarmonyTypeName, true);
            var methodType = asm.GetType(HarmonyMethodTypeName, true);
            var harmony = Activator.CreateInstance(harmonyType, "com.saturaspace.stream-input");
            var patch = harmonyType.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .First(m => m.Name == "Patch" && m.GetParameters().Length >= 3 && m.GetParameters()[0].ParameterType == typeof(MethodBase));
            var target = typeof(Cursor).GetMethod("SetCursor", BindingFlags.Static | BindingFlags.Public, null, new[] { typeof(Texture2D), typeof(Vector2), typeof(CursorMode) }, null);
            if (target == null) throw new MissingMethodException("Cursor.SetCursor");
            var postfix = methodType.GetConstructor(new[] { typeof(MethodInfo) })
                .Invoke(new object[] { typeof(StreamInputHooks).GetMethod(nameof(StreamInputHooks.SetCursorPostfix), BindingFlags.Static | BindingFlags.Public) });
            var args = new object[patch.GetParameters().Length];
            args[0] = target;
            args[2] = postfix;
            patch.Invoke(harmony, args);
            var beginGui = typeof(GUIUtility).GetMethod("BeginGUI", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
            if (beginGui == null) throw new MissingMethodException("GUIUtility.BeginGUI");
            var guiArgs = new object[patch.GetParameters().Length];
            guiArgs[0] = beginGui;
            guiArgs[2] = methodType.GetConstructor(new[] { typeof(MethodInfo) })
                .Invoke(new object[] { typeof(StreamInputHooks).GetMethod(nameof(StreamInputHooks.BeginGUIPostfix), BindingFlags.Static | BindingFlags.Public) });
            patch.Invoke(harmony, guiArgs);
            s_StreamInputHooksPatched = true;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            Debug.LogWarning("[StreamInput] custom cursors and IMGUI hover stay off in the stream: " + inner.Message);
        }
        EmulateCursorLock();
    }

    static void SyncCursorLockEmulation(bool emulate)
    {
        if (s_CursorLockDetours == null || emulate == StreamCursor.LockEmulated) return;
        try
        {
            if (emulate)
            {
                var mode = Cursor.lockState;
                Cursor.lockState = CursorLockMode.None;
                foreach (var d in s_CursorLockDetours) InvokeDetour(d, "Apply");
                StreamCursor.LockState = mode;
            }
            else
            {
                var mode = StreamCursor.LockState;
                foreach (var d in s_CursorLockDetours) InvokeDetour(d, "Undo");
                Cursor.lockState = mode;
            }
            StreamCursor.LockEmulated = emulate;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            Debug.LogWarning("[StreamInput] couldn't switch Cursor.lockState " + (emulate ? "to the stream" : "back to Unity") + ": " + inner.Message);
        }
    }

    static void InvokeDetour(object detour, string name)
    {
        var m = detour.GetType().GetMethod(name, BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null)
            ?? detour.GetType().GetInterfaces().Select(i => i.GetMethod(name, Type.EmptyTypes)).FirstOrDefault(x => x != null);
        if (m == null) throw new MissingMethodException(detour.GetType().Name, name);
        m.Invoke(detour, null);
    }

    static void EmulateCursorLock()
    {
        if (s_CursorLockDetours != null) return;
        try
        {
            var asm = FindHarmony();
            if (asm == null) throw new TypeLoadException("Harmony is not loaded");
            var factoryType = asm.GetType("SaturaSpace.Vendor.MonoMod.Core.DetourFactory", true);
            var factory = factoryType.GetProperty("Current", BindingFlags.Static | BindingFlags.Public).GetValue(null);
            var create = factoryType.GetMethods(BindingFlags.Static | BindingFlags.Public)
                .First(m => m.Name == "CreateDetour" && m.GetParameters().Length == 4 && m.GetParameters()[1].ParameterType == typeof(MethodBase));
            var prop = typeof(Cursor).GetProperty("lockState", BindingFlags.Static | BindingFlags.Public);
            var hooks = typeof(StreamInputHooks);
            var getter = create.Invoke(null, new[] { factory, prop.GetGetMethod(), hooks.GetMethod(nameof(StreamInputHooks.GetLockState)), (object)true });
            var setter = create.Invoke(null, new[] { factory, prop.GetSetMethod(), hooks.GetMethod(nameof(StreamInputHooks.SetLockState)), (object)true });
            s_CursorLockDetours = new[] { getter, setter };
            StreamCursor.LockEmulated = true;
            EditorApplication.playModeStateChanged += state =>
            {
                if (state == PlayModeStateChange.ExitingPlayMode || state == PlayModeStateChange.EnteredEditMode) StreamCursor.LockState = CursorLockMode.None;
            };
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            Debug.LogWarning("[StreamInput] Cursor.lockState stays native, so Unity grabs the real mouse when a game locks it: " + inner.Message);
        }
    }
}
