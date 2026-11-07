#if SATURA_HOTRELOAD_DEV
using UnityEditor;

namespace HotReloadPrototype.Editor {
    internal static class HotReloadMenu {
        const string EnabledItem = "Tools/Hot Reload Prototype/Enabled";

        [MenuItem(EnabledItem, priority = 0)]
        static void ToggleEnabled() => HotReloadController.Enabled = !HotReloadController.Enabled;

        [MenuItem(EnabledItem, validate = true)]
        static bool ToggleEnabledValidate() {
            Menu.SetChecked(EnabledItem, HotReloadController.Enabled);
            return true;
        }

        [MenuItem("Tools/Hot Reload Prototype/Run Detour Self-Test", priority = 20)]
        static void RunSelfTest() => DetourSelfTest.Run();

        [MenuItem("Tools/Hot Reload Prototype/Undo All Patches", priority = 21)]
        static void UndoAll() => Detourer.UndoAll();
    }
}
#endif
