using System.Reflection;
using SaturaSpace.Vendor.HarmonyLib;

namespace HotReloadPrototype.Editor {
    public sealed class ExecHarmony {
        readonly Harmony harmony;

        public ExecHarmony(string id) {
            harmony = new Harmony(id);
        }

        public void Patch(MethodBase original, MethodInfo prefix = null, MethodInfo finalizer = null) {
            harmony.Patch(original,
                prefix: prefix == null ? null : new HarmonyMethod(prefix),
                finalizer: finalizer == null ? null : new HarmonyMethod(finalizer));
        }

        public void UnpatchAll() {
            harmony.UnpatchAll(harmony.Id);
        }
    }
}
