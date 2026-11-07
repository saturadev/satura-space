using System.Reflection;
using System.Runtime.CompilerServices;
using UnityEngine;

namespace HotReloadPrototype.Editor {
    internal static class DetourSelfTest {
        const BindingFlags All = BindingFlags.Instance | BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic;

        static int Original() => 1;
        static int Replacement() => 2;

        class A { public int M() => 10; }
        class B { public int M() => 20; }

        static int InlineHelper() => 100;
        static int InlineHelperPatched() => 200;

        [MethodImpl(MethodImplOptions.NoInlining)]
        static int InlineCaller() => InlineHelper() + 1;

        public static void Run() {
            bool d1 = Detourer.Apply(typeof(DetourSelfTest).GetMethod(nameof(Original), All),
                                     typeof(DetourSelfTest).GetMethod(nameof(Replacement), All), out var e1);
            int sv = Original();

            bool d2 = Detourer.Apply(typeof(A).GetMethod(nameof(A.M), All),
                                     typeof(B).GetMethod(nameof(B.M), All), out var e2);
            int iv = new A().M();

            if (d1 && d2 && sv == 2 && iv == 20) {
                Debug.Log($"[HotReload] Self-test PASSED. static={sv} (want 2), instance={iv} (want 20). Detours work here.");
            } else {
                Debug.LogError($"[HotReload] Self-test FAILED. static={sv} (want 2, err={e1}), instance={iv} (want 20, err={e2}).");
            }

            RunInlineVisibilityCheck();
        }

        static void RunInlineVisibilityCheck() {
            int warm = 0;
            for (int i = 0; i < 10000; i++) warm += InlineCaller();
            if (warm == 0) return;

            bool d3 = Detourer.Apply(typeof(DetourSelfTest).GetMethod(nameof(InlineHelper), All),
                                     typeof(DetourSelfTest).GetMethod(nameof(InlineHelperPatched), All), out var e3);
            int cv = InlineCaller();

            if (d3 && cv == 201) {
                Debug.Log("[HotReload] Inline-visibility check PASSED — patched helpers are visible to already-JIT'd callers (JIT inlining is off).");
            } else if (d3) {
                Debug.LogWarning("[HotReload] Inline-visibility check: JIT inlining is ACTIVE — patching a helper method will NOT affect callers that already inlined it. "
                    + "Launch the editor with MONO_INLINELIMIT=0 (the orchestrator and MCP do this automatically).");
            } else {
                Debug.LogWarning($"[HotReload] Inline-visibility check could not run: {e3}");
            }
        }
    }
}
