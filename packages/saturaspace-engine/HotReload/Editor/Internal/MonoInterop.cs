using System.Reflection;

namespace HotReloadPrototype.Editor {
    internal static unsafe class MonoInterop {
        const int MonoMethodFlagsOffset = 8 + sizeof(long) * 3;
        const ushort SkipVisibility = 1 << 13;

        public static void DisableVisibilityChecks(MethodBase method) {
            if (method == null) return;
            try {
                var ptr = (byte*)method.MethodHandle.Value.ToPointer();
                ushort* flags = (ushort*)(ptr + MonoMethodFlagsOffset);
                *flags |= SkipVisibility;
            } catch {
            }
        }
    }
}
