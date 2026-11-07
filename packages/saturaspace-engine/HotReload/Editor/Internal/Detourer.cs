using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace HotReloadPrototype.Editor {
    internal static class Detourer {
        static readonly HashSet<MethodBase> patched = new HashSet<MethodBase>();
        static MethodInfo detourMethod;
        static bool resolved;

        static MethodInfo ResolveDetour() {
            if (resolved) return detourMethod;
            resolved = true;
            var harmony = typeof(SaturaSpace.Vendor.HarmonyLib.Harmony).Assembly;

            var argTypes = new[] { typeof(MethodBase), typeof(MethodBase) };
            const BindingFlags flags = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Static;

            foreach (var typeName in new[] { "SaturaSpace.Vendor.HarmonyLib.PatchTools", "SaturaSpace.Vendor.HarmonyLib.Memory" }) {
                var t = harmony.GetType(typeName);
                var m = t?.GetMethod("DetourMethod", flags, null, argTypes, null);
                if (m != null) return detourMethod = m;
            }
            Type[] types;
            try { types = harmony.GetTypes(); }
            catch (ReflectionTypeLoadException ex) { types = ex.Types.Where(t => t != null).ToArray(); }
            foreach (var t in types) {
                var m = t.GetMethod("DetourMethod", flags, null, argTypes, null);
                if (m != null) return detourMethod = m;
            }
            return null;
        }

        public static bool Apply(MethodBase live, MethodInfo patch, out string error) {
            error = null;
            var detour = ResolveDetour();
            if (detour == null) { error = "Harmony DetourMethod(MethodBase, MethodBase) not found in the vendored Harmony"; return false; }
            try {
                MonoInterop.DisableVisibilityChecks(patch);
                var ret = detour.Invoke(null, new object[] { live, patch });
                if (ret is string s && !string.IsNullOrEmpty(s)) { error = s; return false; }
                patched.Add(live);
                return true;
            } catch (TargetInvocationException tie) {
                error = (tie.InnerException ?? tie).Message;
                return false;
            } catch (Exception e) {
                error = e.Message;
                return false;
            }
        }


        public static void UndoAll() {
            patched.Clear();
        }
    }
}
