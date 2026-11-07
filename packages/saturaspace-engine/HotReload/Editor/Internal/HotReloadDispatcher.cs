using System;
using System.Reflection;
using UnityEditor;
using UnityEngine;

namespace HotReloadPrototype.Editor {
    internal static class HotReloadDispatcher {
        const BindingFlags All = BindingFlags.Instance | BindingFlags.Static |
                                 BindingFlags.Public | BindingFlags.NonPublic;

        public static void Dispatch() {
            foreach (var m in TypeCache.GetMethodsWithAttribute<OnHotReload>()) {
                if (m.GetParameters().Length != 0) continue;
                try {
                    if (m.IsStatic) {
                        m.Invoke(null, null);
                    } else if (typeof(MonoBehaviour).IsAssignableFrom(m.DeclaringType)) {
                        var objs = UnityEngine.Object.FindObjectsByType(m.DeclaringType, FindObjectsSortMode.None);
                        foreach (var o in objs) m.Invoke(o, null);
                    }
                } catch (Exception e) {
                    Debug.LogWarning($"[HotReload] {m.DeclaringType?.Name}.{m.Name} [OnHotReload] threw: {e.InnerException ?? e}");
                }
            }
        }
    }
}
