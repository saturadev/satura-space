using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;

namespace HotReloadPrototype.Editor {
    internal static class MethodMatcher {
        public struct Pair {
            public MethodBase live;
            public MethodInfo patch;
        }

        const BindingFlags All = BindingFlags.Instance | BindingFlags.Static |
                                 BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.DeclaredOnly;

        public static List<Pair> Match(Assembly patchAsm, Assembly liveAsm, IEnumerable<string> changedTypeNames, List<string> skipped) {
            var pairs = new List<Pair>();
            foreach (var typeName in changedTypeNames) {
                Type patchType = SafeGetType(patchAsm, typeName);
                Type liveType = SafeGetType(liveAsm, typeName);
                if (patchType == null || liveType == null) {
                    skipped?.Add($"{typeName} (type not found in {(patchType == null ? "patch" : "live")} assembly)");
                    continue;
                }

                var liveMethods = liveType.GetMethods(All);

                foreach (var pm in patchType.GetMethods(All)) {
                    if (!Patchable(pm)) continue;
                    var lm = liveMethods.FirstOrDefault(m => SignatureEquals(m, pm));
                    if (lm == null) { skipped?.Add($"{typeName}.{pm.Name} (no live match)"); continue; }
                    pairs.Add(new Pair { live = lm, patch = pm });
                }
            }
            return pairs;
        }

        static bool Patchable(MethodInfo m) {
            if (m.IsAbstract) return false;
            if (m.IsGenericMethodDefinition || m.ContainsGenericParameters) return false;
            var impl = m.GetMethodImplementationFlags();
            if ((impl & MethodImplAttributes.InternalCall) != 0) return false;
            if ((m.Attributes & MethodAttributes.PinvokeImpl) != 0) return false;
            return true;
        }

        static bool SignatureEquals(MethodInfo live, MethodInfo patch) {
            if (live.Name != patch.Name) return false;
            if (live.IsStatic != patch.IsStatic) return false;
            if (live.GetGenericArguments().Length != patch.GetGenericArguments().Length) return false;
            if (TypeKey(live.ReturnType) != TypeKey(patch.ReturnType)) return false;
            var lp = live.GetParameters();
            var pp = patch.GetParameters();
            if (lp.Length != pp.Length) return false;
            for (int i = 0; i < lp.Length; i++)
                if (TypeKey(lp[i].ParameterType) != TypeKey(pp[i].ParameterType)) return false;
            return true;
        }

        static string TypeKey(Type t) => t.FullName ?? t.Name;

        static Type SafeGetType(Assembly asm, string metadataName) {
            try { return asm.GetType(metadataName, throwOnError: false); } catch { return null; }
        }
    }
}
