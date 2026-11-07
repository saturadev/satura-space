using System;
using UnityEditor;
using UnityEditor.IMGUI.Controls;
using UnityEngine;
using UnityEngine.UIElements;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    public static class TunerPopupHooks
    {
        public static bool TunerPopupDropdownPrefix(AdvancedDropdown __instance, Rect rect) => MCPTestBridge.TunerPopupDropdownPrefix(__instance, rect);
        public static bool TunerPopupColorShowPrefix(Action<Color> colorChangedCallback, Color col, bool showAlpha, bool hdr) => MCPTestBridge.TunerPopupColorShowPrefix(colorChangedCallback, col, showAlpha, hdr);
        public static bool TunerPopupColorGetPrefix(ref Color __result) => MCPTestBridge.TunerPopupColorGetPrefix(ref __result);
        public static bool TunerPopupSetCurvePrefix(AnimationCurve value, SerializedProperty property, Color color) => MCPTestBridge.TunerPopupSetCurvePrefix(value, property, color);
        public static bool TunerPopupShowCurvePrefix(Rect ranges) => MCPTestBridge.TunerPopupShowCurvePrefix(ranges);
        public static bool TunerPopupCurveGetPrefix(ref AnimationCurve __result) => MCPTestBridge.TunerPopupCurveGetPrefix(ref __result);
        public static bool TunerPopupGradientShowPrefix(Gradient newGradient, bool hdr, ColorSpace colorSpace, Action<Gradient> onGradientChanged, Action onClosed) => MCPTestBridge.TunerPopupGradientShowPrefix(newGradient, hdr, colorSpace, onGradientChanged, onClosed);
        public static bool TunerPopupGradientGetPrefix(ref Gradient __result) => MCPTestBridge.TunerPopupGradientGetPrefix(ref __result);
        public static bool TunerPopupObjectShowPropPrefix(Type[] requiredTypes, SerializedProperty property, bool allowSceneObjects, Action<Object> onObjectSelectorClosed, Action<Object> onObjectSelectedUpdated) => MCPTestBridge.TunerPopupObjectShowPropPrefix(requiredTypes, property, allowSceneObjects, onObjectSelectorClosed, onObjectSelectedUpdated);
        public static bool TunerPopupObjectShowObjPrefix(Object obj, Type[] requiredTypes, Object objectBeingEdited, bool allowSceneObjects, Action<Object> onObjectSelectorClosed, Action<Object> onObjectSelectedUpdated) => MCPTestBridge.TunerPopupObjectShowObjPrefix(obj, requiredTypes, objectBeingEdited, allowSceneObjects, onObjectSelectorClosed, onObjectSelectedUpdated);
        public static bool TunerPopupObjectGetPrefix(ref Object __result) => MCPTestBridge.TunerPopupObjectGetPrefix(ref __result);
        public static bool TunerPopupSearchPickerPrefix(UnityEditor.Search.SearchViewState args) => MCPTestBridge.TunerPopupSearchPickerPrefix(args);
        public static bool TunerPopupWindowClosePrefix(EditorWindow __instance) => MCPTestBridge.TunerPopupWindowClosePrefix(__instance);
        public static void TunerPopupMaskChangedPostfix() => MCPTestBridge.TunerPopupMaskChangedPostfix();
        public static bool TunerPopupGenericMenuPrefix(object __instance, Rect position, VisualElement targetElement) => MCPTestBridge.TunerPopupGenericMenuPrefix(__instance, position, targetElement);
        public static bool TunerUitkColorPrefix(VisualElement __instance) => MCPTestBridge.TunerUitkColorPrefix(__instance);
        public static bool TunerUitkEyeDropperPrefix(VisualElement __instance) => MCPTestBridge.TunerUitkEyeDropperPrefix(__instance);
        public static bool TunerUitkCurvePrefix(VisualElement __instance) => MCPTestBridge.TunerUitkCurvePrefix(__instance);
        public static bool TunerUitkGradientPrefix(VisualElement __instance) => MCPTestBridge.TunerUitkGradientPrefix(__instance);
        public static bool TunerUitkObjectPrefix(VisualElement __instance) => MCPTestBridge.TunerUitkObjectPrefix(__instance);
        public static bool TunerUitkMenuContextPrefix(GenericMenu __instance) => MCPTestBridge.TunerUitkMenuContextPrefix(__instance);
        public static bool TunerUitkDisplayMenuPrefix(string[] options, bool[] enabled, bool[] separator, int[] selected, EditorUtility.SelectMenuItemFunction callback, object userData) => MCPTestBridge.TunerUitkDisplayMenuPrefix(options, enabled, separator, selected, callback, userData);
    }
}
