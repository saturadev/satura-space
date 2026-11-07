using System;
using System.Collections.Generic;
using System.Linq;
using System.Linq.Expressions;
using System.Reflection;
using UnityEditor;
using UnityEditor.UIElements;
using UnityEngine;
using UnityEngine.UIElements;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    static string s_TiReflectError;
    static bool s_TiReflectReady;
    static FieldInfo s_TiOnDrawField;
    static Delegate s_TiDrawHook;
    static Func<Rect, Rect> s_TiUnclipRect;
    static Func<Vector2, Vector2> s_TiUnclipVec;
    static Func<Rect> s_TiVisibleRect;
    static Func<Vector2> s_TiAbsoluteMouse;
    static Func<IMGUIContainer, Event, bool, bool> s_TiHandleEvent;
    static MethodInfo s_TiFindOrCreatePanel;
    static MethodInfo s_TiAddStyleSheets;
    static FieldInfo s_TiPopupInstance;
    static FieldInfo s_TiPopupSourceView;
    static ConstructorInfo s_TiInspectorElementCtor;
    static object s_TiFrameworkImgui;
    static MethodInfo s_TiGetHandler;
    static MethodInfo s_TiCanExpand;
    static MethodInfo s_TiEndEditing;
    static MethodInfo s_TiMenuGetItems;
    static MethodInfo s_TiMenuEnabledWithContext;
    static MethodInfo s_TiExecuteWithContext;
    static Type s_TiDelayedEditorType;

    static bool s_TiPatched;
    static string s_TiPatchError;

    static bool TiInitReflection()
    {
        if (s_TiReflectReady) return true;
        if (s_TiReflectError != null) return false;
        try
        {
            s_TiOnDrawField = typeof(GUIStyle).GetField("onDraw", TiStatic) ?? throw new MissingMemberException("GUIStyle.onDraw");
            var clip = TiType("UnityEngine.GUIClip");
            var unclipRect = clip.GetMethod("Unclip", TiStatic, null, new[] { typeof(Rect) }, null) ?? throw new MissingMethodException("GUIClip.Unclip(Rect)");
            s_TiUnclipRect = (Func<Rect, Rect>)Delegate.CreateDelegate(typeof(Func<Rect, Rect>), unclipRect);
            var unclipVec = clip.GetMethod("Unclip", TiStatic, null, new[] { typeof(Vector2) }, null) ?? throw new MissingMethodException("GUIClip.Unclip(Vector2)");
            s_TiUnclipVec = (Func<Vector2, Vector2>)Delegate.CreateDelegate(typeof(Func<Vector2, Vector2>), unclipVec);
            var visible = clip.GetProperty("visibleRect", TiStatic);
            if (visible != null) s_TiVisibleRect = (Func<Rect>)Delegate.CreateDelegate(typeof(Func<Rect>), visible.GetGetMethod(true));
            var abs = clip.GetMethod("Internal_GetAbsoluteMousePosition", TiStatic);
            if (abs != null) s_TiAbsoluteMouse = (Func<Vector2>)Delegate.CreateDelegate(typeof(Func<Vector2>), abs);
            var handle = typeof(IMGUIContainer).GetMethod("HandleIMGUIEvent", TiInstance, null, new[] { typeof(Event), typeof(bool) }, null)
                ?? throw new MissingMethodException("IMGUIContainer.HandleIMGUIEvent");
            s_TiHandleEvent = (Func<IMGUIContainer, Event, bool, bool>)Delegate.CreateDelegate(typeof(Func<IMGUIContainer, Event, bool, bool>), handle);
            s_TiFindOrCreatePanel = TiType("UnityEditor.UIElements.EditorPanel").GetMethod("FindOrCreate", TiStatic)
                ?? throw new MissingMethodException("EditorPanel.FindOrCreate");
            s_TiAddStyleSheets = TiType("UnityEditor.UIElements.UIElementsEditorUtility")
                .GetMethod("AddDefaultEditorStyleSheets", TiStatic, null, new[] { typeof(VisualElement) }, null)
                ?? throw new MissingMethodException("UIElementsEditorUtility.AddDefaultEditorStyleSheets");
            var popup = typeof(EditorGUI).GetNestedType("PopupCallbackInfo", BindingFlags.NonPublic | BindingFlags.Public);
            if (popup != null)
            {
                s_TiPopupInstance = popup.GetField("instance", TiStatic);
                s_TiPopupSourceView = popup.GetField("m_SourceView", TiInstance);
            }
            var framework = typeof(InspectorElement).GetNestedType("DefaultInspectorFramework", BindingFlags.NonPublic | BindingFlags.Public)
                ?? TiTypeOrNull("UnityEditor.UIElements.DefaultInspectorFramework");
            if (framework != null)
            {
                s_TiFrameworkImgui = Enum.Parse(framework, "IMGUI");
                s_TiInspectorElementCtor = typeof(InspectorElement).GetConstructor(TiInstance, null, new[] { typeof(Editor), framework }, null);
            }
            var sau = TiTypeOrNull("UnityEditor.ScriptAttributeUtility");
            if (sau != null) s_TiGetHandler = sau.GetMethod("GetHandler", TiStatic, null, new[] { typeof(SerializedProperty) }, null);
            s_TiCanExpand = typeof(Editor).GetMethod("CanBeExpandedViaAFoldout", TiInstance, null, Type.EmptyTypes, null);
            s_TiEndEditing = typeof(EditorGUI).GetMethod("EndEditingActiveTextField", TiStatic, null, Type.EmptyTypes, null);
            s_TiMenuGetItems = typeof(Menu).GetMethod("GetMenuItems", TiStatic, null, new[] { typeof(string), typeof(bool), typeof(bool) }, null);
            s_TiMenuEnabledWithContext = typeof(Menu).GetMethod("GetEnabledWithContext", TiStatic, null, new[] { typeof(string), typeof(Object[]) }, null);
            s_TiExecuteWithContext = typeof(EditorApplication).GetMethod("ExecuteMenuItemWithTemporaryContext", TiStatic, null, new[] { typeof(string), typeof(Object[]) }, null);
            s_TiDelayedEditorType = typeof(EditorGUI).GetNestedType("DelayedTextEditor", BindingFlags.NonPublic | BindingFlags.Public);
            s_TiDrawHook = TiMakeDrawHook();
            s_TiReflectReady = true;
            return true;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            s_TiReflectError = inner.GetType().Name + ": " + inner.Message;
            Debug.LogWarning("[tunerInspector] reflection failed: " + s_TiReflectError);
            return false;
        }
    }

    static Delegate TiMakeDrawHook()
    {
        var handlerType = s_TiOnDrawField.FieldType;
        var ps = handlerType.GetMethod("Invoke").GetParameters().Select(p => Expression.Parameter(p.ParameterType, p.Name)).ToArray();
        var statesType = ps[3].Type;
        Expression F<T>(string name)
        {
            var f = statesType.GetField(name, TiInstance);
            if (f == null || f.FieldType != typeof(T)) return Expression.Constant(default(T), typeof(T));
            return Expression.Field(ps[3], f);
        }
        var target = new Func<GUIStyle, Rect, GUIContent, int, bool, bool, bool, bool, bool, Vector2, Vector2, bool>(TiOnDraw).Method;
        var call = Expression.Call(target, ps[0], ps[1], ps[2],
            F<int>("controlId"), F<bool>("isHover"), F<bool>("isActive"), F<bool>("on"), F<bool>("hasKeyboardFocus"),
            F<bool>("hasTextInput"), F<Vector2>("cursorFirstPosition"), F<Vector2>("cursorLastPosition"));
        return Expression.Lambda(handlerType, call, ps).Compile();
    }

    static Type TiType(string fullName)
    {
        return TiTypeOrNull(fullName) ?? throw new TypeLoadException(fullName);
    }

    static Type TiTypeOrNull(string fullName)
    {
        foreach (var asm in AppDomain.CurrentDomain.GetAssemblies())
        {
            var t = asm.GetType(fullName, false);
            if (t != null) return t;
        }
        return null;
    }

    static void TiSetMember(object target, string name, object value)
    {
        for (var t = target.GetType(); t != null; t = t.BaseType)
        {
            var f = t.GetField(name, TiInstance | BindingFlags.DeclaredOnly);
            if (f != null)
            {
                f.SetValue(target, value);
                return;
            }
            var p = t.GetProperty(name, TiInstance | BindingFlags.DeclaredOnly);
            if (p != null && p.CanWrite)
            {
                p.SetValue(target, value);
                return;
            }
        }
    }

    static readonly Rect TiListVisibleAll = new Rect(-1e6f, -1e6f, 2e6f, 2e6f);

    struct TiListMark
    {
        public object List;
        public TiSection Section;
        public int Draws;
        public int Props;
        public int Cursors;
    }

    static readonly List<TiListMark> s_TiListMarks = new List<TiListMark>();

    static void TiListEnter(object list)
    {
        var sec = s_TiDispatchSection;
        if (!s_TiRecording || sec == null || Event.current == null || Event.current.type != EventType.Repaint) return;
        int top = s_TiListMarks.Count - 1;
        if (top >= 0 && ReferenceEquals(s_TiListMarks[top].List, list) && s_TiListMarks[top].Section == sec)
        {
            var m = s_TiListMarks[top];
            if (sec.Draws.Count > m.Draws) sec.Draws.RemoveRange(m.Draws, sec.Draws.Count - m.Draws);
            if (sec.Props.Count > m.Props) sec.Props.RemoveRange(m.Props, sec.Props.Count - m.Props);
            if (sec.Cursors.Count > m.Cursors) sec.Cursors.RemoveRange(m.Cursors, sec.Cursors.Count - m.Cursors);
        }
        s_TiListMarks.Add(new TiListMark { List = list, Section = sec, Draws = sec.Draws.Count, Props = sec.Props.Count, Cursors = sec.Cursors.Count });
    }

    static void TiListExit(object list)
    {
        int top = s_TiListMarks.Count - 1;
        if (top >= 0 && ReferenceEquals(s_TiListMarks[top].List, list)) s_TiListMarks.RemoveAt(top);
    }

    static void TiInvokeMember(object target, string name)
    {
        for (var t = target.GetType(); t != null; t = t.BaseType)
        {
            var m = t.GetMethod(name, TiInstance | BindingFlags.DeclaredOnly, null, Type.EmptyTypes, null);
            if (m != null)
            {
                m.Invoke(target, null);
                return;
            }
        }
        throw new MissingMethodException(target.GetType().Name + "." + name);
    }

    static void EnsureTunerInspectorPatches()
    {
        if (s_TiPatched || s_TiPatchError != null) return;
        try
        {
            var asm = FindHarmony();
            if (asm == null)
            {
                s_TiPatchError = "Harmony is not loaded";
                return;
            }
            var harmonyType = asm.GetType(HarmonyTypeName, true);
            var methodType = asm.GetType(HarmonyMethodTypeName, true);
            var harmony = Activator.CreateInstance(harmonyType, "com.saturaspace.tuner-inspector");
            var patch = harmonyType.GetMethods(BindingFlags.Instance | BindingFlags.Public)
                .First(m => m.Name == "Patch" && m.GetParameters().Length >= 3 && m.GetParameters()[0].ParameterType == typeof(MethodBase));
            var hmCtor = methodType.GetConstructor(new[] { typeof(MethodInfo) });
            var hooks = typeof(TunerInspectorHooks);
            object Hm(string name) => name == null ? null : hmCtor.Invoke(new object[] { hooks.GetMethod(name, TiStatic) ?? throw new MissingMethodException("TunerInspectorHooks." + name) });
            var failed = new List<string>();
            void Apply(MethodBase target, string label, string pre, string post, bool required)
            {
                if (target == null)
                {
                    if (required) throw new MissingMethodException("patch target not found: " + label);
                    failed.Add(label);
                    return;
                }
                var args = new object[patch.GetParameters().Length];
                args[0] = target;
                args[1] = Hm(pre);
                args[2] = Hm(post);
                try { patch.Invoke(harmony, args); }
                catch (Exception e)
                {
                    if (required) throw;
                    var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
                    failed.Add(label + " (" + inner.Message + ")");
                }
            }
            var textField = typeof(EditorGUI).GetMethods(TiStatic).FirstOrDefault(m => m.Name == "DoTextField" && m.GetParameters().Length == 12);
            Apply(textField, "EditorGUI.DoTextField", nameof(TunerInspectorHooks.TextPrefix), nameof(TunerInspectorHooks.TextPostfix), true);
            var doOnGui = typeof(IMGUIContainer).GetMethods(TiInstance).FirstOrDefault(m => m.Name == "DoOnGUI" && m.GetParameters().Length == 7);
            Apply(doOnGui, "IMGUIContainer.DoOnGUI", nameof(TunerInspectorHooks.DoOnGuiPrefix), null, true);
            var clip = typeof(GUI).Assembly.GetType("UnityEngine.GUIClip");
            var parentScope = clip?.GetNestedType("ParentClipScope", TiStatic);
            Apply(clip?.GetMethod("Push", TiStatic, null, new[] { typeof(Rect), typeof(Vector2), typeof(Vector2), typeof(bool) }, null), "GUIClip.Push", null, nameof(TunerInspectorHooks.ClipAppliedPostfix), false);
            Apply(clip?.GetMethod("Pop", TiStatic, null, Type.EmptyTypes, null), "GUIClip.Pop", null, nameof(TunerInspectorHooks.ClipAppliedPostfix), false);
            Apply(clip?.GetMethod("Internal_PushParentClip", TiStatic, null, new[] { typeof(Matrix4x4), typeof(Rect) }, null), "GUIClip.Internal_PushParentClip", null, nameof(TunerInspectorHooks.ClipAppliedPostfix), false);
            Apply(parentScope?.GetConstructor(TiInstance, null, new[] { typeof(Matrix4x4), typeof(Rect) }, null), "GUIClip.ParentClipScope", null, nameof(TunerInspectorHooks.ClipAppliedPostfix), false);
            Apply(parentScope?.GetMethod("Dispose", TiInstance), "GUIClip.ParentClipScope.Dispose", null, nameof(TunerInspectorHooks.ClipAppliedPostfix), false);
            Apply(typeof(GUI).GetMethod("EndGroup", TiStatic, null, Type.EmptyTypes, null), "GUI.EndGroup", null, nameof(TunerInspectorHooks.ClipAppliedPostfix), false);
            Apply(typeof(GUI).GetProperty("matrix", TiStatic)?.GetSetMethod(true), "GUI.matrix", null, nameof(TunerInspectorHooks.ClipAppliedPostfix), false);
            Apply(typeof(EditorUtility).GetMethod("Internal_DisplayCustomMenu", TiStatic), "EditorUtility.Internal_DisplayCustomMenu",
                nameof(TunerInspectorHooks.CustomMenuPrefix), null, true);
            Apply(typeof(EditorUtility).GetMethod("DisplayObjectContextPopupMenuWithExtraItems", TiStatic), "EditorUtility.DisplayObjectContextPopupMenuWithExtraItems",
                nameof(TunerInspectorHooks.ObjectMenuExtraPrefix), null, false);
            Apply(typeof(EditorUtility).GetMethod("DisplayObjectContextPopupMenu", TiStatic), "EditorUtility.DisplayObjectContextPopupMenu",
                nameof(TunerInspectorHooks.ObjectMenuPrefix), null, false);
            Apply(typeof(EditorUtility).GetMethod("Private_DisplayPopupMenu", TiStatic), "EditorUtility.Private_DisplayPopupMenu",
                nameof(TunerInspectorHooks.PathMenuPrefix), null, false);
            Apply(typeof(EditorGUIUtility).GetMethod("AddCursorRect", TiStatic, null, new[] { typeof(Rect), typeof(MouseCursor), typeof(int) }, null),
                "EditorGUIUtility.AddCursorRect", nameof(TunerInspectorHooks.CursorPrefix), null, true);
            Apply(typeof(GUIStyle).GetMethod("SetMouseTooltip", TiStatic, null, new[] { typeof(string), typeof(Rect) }, null),
                "GUIStyle.SetMouseTooltip", nameof(TunerInspectorHooks.TooltipPrefix), null, false);
            var drawTexture = typeof(GUI).GetMethods(TiStatic).FirstOrDefault(m => m.Name == "DrawTexture" && m.GetParameters().Length == 12);
            Apply(drawTexture, "GUI.DrawTexture", nameof(TunerInspectorHooks.DrawTexturePrefix), null, false);
            Apply(typeof(GUI).GetMethod("DrawTextureWithTexCoords", TiStatic, null, new[] { typeof(Rect), typeof(Texture), typeof(Rect), typeof(bool) }, null),
                "GUI.DrawTextureWithTexCoords", nameof(TunerInspectorHooks.DrawTexCoordsPrefix), null, false);
            Apply(typeof(Graphics).GetMethod("DrawTextureImpl", TiStatic), "Graphics.DrawTextureImpl", nameof(TunerInspectorHooks.GraphicsDrawPrefix), null, false);
            Apply(typeof(HandleUtility).GetMethod("Repaint", BindingFlags.Static | BindingFlags.Public, null, Type.EmptyTypes, null), "HandleUtility.Repaint",
                nameof(TunerInspectorHooks.HandleRepaintPrefix), null, false);
            Apply(typeof(Editor).GetMethod("Repaint", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null), "Editor.Repaint",
                null, nameof(TunerInspectorHooks.EditorRepaintPostfix), false);
            var popupShow = typeof(UnityEditor.PopupWindow).GetMethods(TiStatic).FirstOrDefault(m => m.Name == "Show" && m.GetParameters().Length == 4);
            Apply(popupShow, "PopupWindow.Show", nameof(TunerInspectorHooks.PopupWindowPrefix), null, false);
            var noFocus = TiTypeOrNull("UnityEditor.PopupWindowWithoutFocus");
            if (noFocus != null)
            {
                Apply(noFocus.GetMethods(TiStatic).FirstOrDefault(m => m.Name == "Show" && m.GetParameters().Length == 3), "PopupWindowWithoutFocus.Show",
                    nameof(TunerInspectorHooks.NoFocusShowPrefix), null, false);
                Apply(noFocus.GetMethod("Hide", TiStatic, null, Type.EmptyTypes, null), "PopupWindowWithoutFocus.Hide",
                    nameof(TunerInspectorHooks.NoFocusHidePrefix), null, false);
                Apply(noFocus.GetMethod("IsVisible", TiStatic, null, Type.EmptyTypes, null), "PopupWindowWithoutFocus.IsVisible",
                    null, nameof(TunerInspectorHooks.NoFocusVisiblePostfix), false);
            }
            foreach (var name in new[] { "ShowUtility", "ShowPopup", "ShowTooltip", "ShowAuxWindow", "ShowModal", "ShowModalUtility" })
                Apply(typeof(EditorWindow).GetMethod(name, TiInstance, null, Type.EmptyTypes, null), "EditorWindow." + name, nameof(TunerInspectorHooks.WindowShowPrefix), null, false);
            Apply(typeof(EditorWindow).GetMethod("Show", TiInstance, null, new[] { typeof(bool) }, null), "EditorWindow.Show(bool)", nameof(TunerInspectorHooks.WindowShowPrefix), null, false);
            var dropDown = typeof(EditorWindow).GetMethods(TiInstance).FirstOrDefault(m => m.Name == "ShowAsDropDown" && m.GetParameters().Length == 5);
            Apply(dropDown, "EditorWindow.ShowAsDropDown", nameof(TunerInspectorHooks.WindowDropDownPrefix), null, false);
            var openAsset = typeof(AssetDatabase).GetMethods(BindingFlags.Static | BindingFlags.Public)
                .Where(m => m.Name == "OpenAsset" && m.GetParameters().Length == 3 && m.GetParameters()[1].ParameterType == typeof(int) && m.GetParameters()[2].ParameterType == typeof(int)
                    && m.GetParameters()[0].ParameterType != typeof(Object))
                .OrderBy(m => m.GetParameters()[0].ParameterType == typeof(int) ? 1 : 0)
                .FirstOrDefault();
            Apply(openAsset, "AssetDatabase.OpenAsset", nameof(TunerInspectorHooks.OpenAssetPrefix), null, false);
            Apply(typeof(EditorGUIUtility).GetMethod("PingObject", BindingFlags.Static | BindingFlags.Public, null, new[] { typeof(Object) }, null),
                "EditorGUIUtility.PingObject(Object)", nameof(TunerInspectorHooks.PingPrefix), null, false);
            var pingId = typeof(EditorGUIUtility).GetMethods(BindingFlags.Static | BindingFlags.Public)
                .Where(m => m.Name == "PingObject" && m.GetParameters().Length == 1 && m.GetParameters()[0].ParameterType != typeof(Object))
                .OrderBy(m => m.GetParameters()[0].ParameterType == typeof(int) ? 1 : 0)
                .FirstOrDefault();
            Apply(pingId, "EditorGUIUtility.PingObject(id)", nameof(TunerInspectorHooks.PingIdPrefix), null, false);
            var stageUtility = TiTypeOrNull("UnityEditor.SceneManagement.PrefabStageUtility");
            if (stageUtility != null)
                foreach (var m in stageUtility.GetMethods(TiStatic).Where(m => m.Name == "OpenPrefab" && m.GetParameters().Length > 0 && m.GetParameters()[0].ParameterType == typeof(string)))
                    Apply(m, "PrefabStageUtility.OpenPrefab", nameof(TunerInspectorHooks.OpenPrefabPrefix), null, false);
            Apply(typeof(Selection).GetProperty("objects", BindingFlags.Static | BindingFlags.Public)?.GetSetMethod(), "Selection.objects",
                nameof(TunerInspectorHooks.SelectionObjectsPrefix), null, false);
            Apply(typeof(Selection).GetProperty("activeObject", BindingFlags.Static | BindingFlags.Public)?.GetSetMethod(), "Selection.activeObject",
                nameof(TunerInspectorHooks.SelectionActivePrefix), null, false);
            Apply(typeof(EditorGUIUtility).GetMethod("DrawCurveSwatchInternal", TiStatic), "EditorGUIUtility.DrawCurveSwatchInternal",
                nameof(TunerInspectorHooks.CurveSwatchPrefix), null, false);
            var handles = typeof(Handles);
            Apply(handles.GetMethod("DrawLine", TiStatic, null, new[] { typeof(Vector3), typeof(Vector3), typeof(bool) }, null), "Handles.DrawLine(dotted)",
                nameof(TunerInspectorHooks.HandlesLineDottedPrefix), null, false);
            Apply(handles.GetMethod("DrawLine", TiStatic, null, new[] { typeof(Vector3), typeof(Vector3), typeof(float) }, null), "Handles.DrawLine(thickness)",
                nameof(TunerInspectorHooks.HandlesLineThickPrefix), null, false);
            Apply(handles.GetMethod("DrawPolyLine", TiStatic, null, new[] { typeof(Vector3[]) }, null), "Handles.DrawPolyLine",
                nameof(TunerInspectorHooks.HandlesPolyLinePrefix), null, false);
            Apply(handles.GetMethod("DrawLines", TiStatic, null, new[] { typeof(Vector3[]) }, null), "Handles.DrawLines",
                nameof(TunerInspectorHooks.HandlesLinesPrefix), null, false);
            Apply(handles.GetMethod("DrawLines", TiStatic, null, new[] { typeof(Vector3[]), typeof(int[]) }, null), "Handles.DrawLines(indices)",
                nameof(TunerInspectorHooks.HandlesLinesIndexedPrefix), null, false);
            Apply(handles.GetMethod("DoDrawAAPolyLine", TiStatic), "Handles.DoDrawAAPolyLine", nameof(TunerInspectorHooks.HandlesAAPolyLinePrefix), null, false);
            Apply(handles.GetMethod("DoDrawAAConvexPolygon", TiStatic), "Handles.DoDrawAAConvexPolygon", nameof(TunerInspectorHooks.HandlesConvexPrefix), null, false);
            Apply(handles.GetMethod("DrawBezier", TiStatic), "Handles.DrawBezier", nameof(TunerInspectorHooks.HandlesBezierPrefix), null, false);
            Apply(handles.GetMethod("DrawWireDisc", TiStatic, null, new[] { typeof(Vector3), typeof(Vector3), typeof(float), typeof(float) }, null), "Handles.DrawWireDisc",
                nameof(TunerInspectorHooks.HandlesWireDiscPrefix), null, false);
            Apply(handles.GetMethod("DrawSolidDisc", TiStatic, null, new[] { typeof(Vector3), typeof(Vector3), typeof(float) }, null), "Handles.DrawSolidDisc",
                nameof(TunerInspectorHooks.HandlesSolidDiscPrefix), null, false);
            Apply(handles.GetMethod("DrawWireArc", TiStatic, null, new[] { typeof(Vector3), typeof(Vector3), typeof(Vector3), typeof(float), typeof(float), typeof(float) }, null),
                "Handles.DrawWireArc", nameof(TunerInspectorHooks.HandlesWireArcPrefix), null, false);
            Apply(handles.GetMethod("DrawSolidArc", TiStatic, null, new[] { typeof(Vector3), typeof(Vector3), typeof(Vector3), typeof(float), typeof(float) }, null),
                "Handles.DrawSolidArc", nameof(TunerInspectorHooks.HandlesSolidArcPrefix), null, false);
            Apply(handles.GetMethod("DrawSolidRectangleWithOutline", TiStatic, null, new[] { typeof(Vector3[]), typeof(Color), typeof(Color) }, null),
                "Handles.DrawSolidRectangleWithOutline", nameof(TunerInspectorHooks.HandlesRectOutlinePrefix), null, false);
            Apply(typeof(EditorGUILayout).GetMethod("EditorToolbarForTarget", TiStatic, null, new[] { typeof(GUIContent), typeof(Object) }, null),
                "EditorGUILayout.EditorToolbarForTarget", nameof(TunerInspectorHooks.ToolbarForTargetPrefix), null, false);
            Apply(typeof(EditorGUIUtility).GetMethod("CommandEvent", TiStatic, null, new[] { typeof(string) }, null), "EditorGUIUtility.CommandEvent",
                null, nameof(TunerInspectorHooks.CommandEventPostfix), false);
            Apply(typeof(MaterialEditor).GetMethod("EndProperty", BindingFlags.Static | BindingFlags.Public, null, Type.EmptyTypes, null), "MaterialEditor.EndProperty",
                nameof(TunerInspectorHooks.MaterialEndPropertyPrefix), null, false);
            var scrollView = typeof(GUI).GetMethods(TiStatic).FirstOrDefault(m => m.Name == "BeginScrollView" && m.GetParameters().Length == 8);
            Apply(scrollView, "GUI.BeginScrollView", nameof(TunerInspectorHooks.ScrollViewPrefix), nameof(TunerInspectorHooks.ScrollViewPostfix), false);
            Apply(typeof(UnityEditorInternal.ReorderableList).GetMethod("DoListElements", TiInstance, null, new[] { typeof(Rect), typeof(Rect) }, null), "ReorderableList.DoListElements",
                nameof(TunerInspectorHooks.ListElementsPrefix), nameof(TunerInspectorHooks.ListElementsPostfix), false);
            foreach (var editor in new[] { "UnityEditor.Rigidbody2DEditor", "UnityEditor.RigidbodyEditor" })
                Apply(TiTypeOrNull(editor)?.GetMethod("ConstraintToggle", TiInstance), editor + ".ConstraintToggle",
                    nameof(TunerInspectorHooks.ConstraintTogglePrefix), null, false);
            s_TiPatched = true;
            TunerPopupEnsurePatches();
            if (failed.Count > 0) SaturaDebug.Log("[tunerInspector] optional patches unavailable: " + string.Join(", ", failed));
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            s_TiPatchError = inner.GetType().Name + ": " + inner.Message;
            Debug.LogWarning("[tunerInspector] Harmony patch failed: " + s_TiPatchError);
        }
    }

    public static class TunerInspectorHooks
    {
        public static void TextPrefix(int id)
        {
            if (s_TiTextId != 0 && id == s_TiTextId) GUIUtility.keyboardControl = id;
        }

        public static void TextPostfix(object editor, int id, Rect position, string text, GUIStyle style, string allowedletters, bool multiline, bool passwordField, ref string __result, ref bool changed)
        {
            TiTextField(editor, id, position, text, style, allowedletters, multiline, passwordField, ref __result, ref changed);
        }

        public static void DoOnGuiPrefix(IMGUIContainer __instance, Event evt, ref Matrix4x4 parentTransform, ref Rect clippingRect)
        {
            TiShiftMouse(__instance, evt, ref parentTransform, ref clippingRect);
        }

        public static void ClipAppliedPostfix()
        {
            TiRestoreMouseDelta();
        }

        public static void ScrollViewPrefix(Rect position, out Rect __state)
        {
            __state = TiScrollViewBegin(position);
        }

        public static void ScrollViewPostfix(Rect position, Rect viewRect, bool alwaysShowHorizontal, bool alwaysShowVertical, GUIStyle horizontalScrollbar, GUIStyle verticalScrollbar, Vector2 __result, Rect __state)
        {
            TiScrollViewEnd(__state, position, viewRect, alwaysShowHorizontal, alwaysShowVertical, horizontalScrollbar, verticalScrollbar, __result);
        }

        public static bool CustomMenuPrefix(Rect screenPosition, string[] options, bool[] enabled, bool[] separator, int[] selected, EditorUtility.SelectMenuItemFunction callback, object userData)
        {
            return !TiCatchCustomMenu(screenPosition, options, enabled, separator, selected, callback, userData);
        }

        public static bool ObjectMenuExtraPrefix(Rect position, Object[] context, int contextUserData, string[] options, bool[] enabled, bool[] separator, int[] selected, EditorUtility.SelectMenuItemFunction callback, object userData)
        {
            return !TiCatchObjectMenu(position, context, options, enabled, separator, selected, callback, userData);
        }

        public static bool ObjectMenuPrefix(Rect position, Object[] context, int contextUserData)
        {
            return !TiCatchObjectMenu(position, context, null, null, null, null, null, null);
        }

        public static bool PathMenuPrefix(Rect position, string menuItemPath, Object context, int contextUserData)
        {
            return !TiCatchPathMenu(position, menuItemPath, context);
        }

        public static bool CursorPrefix(Rect position, MouseCursor mouse, int controlID)
        {
            return !TiRecordCursor(position, mouse);
        }

        public static bool TooltipPrefix(string tooltip, Rect screenRect)
        {
            return s_TiDispatch == null;
        }

        public static bool DrawTexturePrefix(Rect position, Texture image, ScaleMode scaleMode, bool alphaBlend, float imageAspect, Color leftColor, Color topColor, Color rightColor, Color bottomColor, Vector4 borderWidths, Vector4 borderRadiuses)
        {
            return !TiRecordTexture(position, image, scaleMode, imageAspect, leftColor, borderWidths, borderRadiuses, null, default, false);
        }

        public static bool DrawTexCoordsPrefix(Rect position, Texture image, Rect texCoords, bool alphaBlend)
        {
            return !TiRecordTexture(position, image, ScaleMode.StretchToFill, 0f, GUI.color, Vector4.zero, Vector4.zero, texCoords, default, false);
        }

        public static bool GraphicsDrawPrefix(Rect screenRect, Texture texture, Rect sourceRect, int leftBorder, int rightBorder, int topBorder, int bottomBorder, Color color, Material mat, int pass)
        {
            var slice = new Vector4(leftBorder, rightBorder, topBorder, bottomBorder);
            return !TiRecordTexture(screenRect, texture, ScaleMode.StretchToFill, 0f, color, Vector4.zero, Vector4.zero, sourceRect, slice, true);
        }

        public static bool OpenAssetPrefix(object[] __args, ref bool __result)
        {
            if (!TiCatchOpenAsset(__args != null && __args.Length > 0 ? __args[0] : null)) return true;
            __result = true;
            return false;
        }

        public static bool PingPrefix(Object obj)
        {
            return !TiCatchPing(obj);
        }

        public static bool PingIdPrefix(object[] __args)
        {
            return !TiCatchPingId(__args != null && __args.Length > 0 ? __args[0] : null);
        }

        public static bool OpenPrefabPrefix(object[] __args)
        {
            return !TiCatchOpenPrefab(__args != null && __args.Length > 0 ? __args[0] as string : null);
        }

        public static bool SelectionObjectsPrefix(Object[] value)
        {
            return !TiCatchSelection(value);
        }

        public static bool SelectionActivePrefix(Object value)
        {
            return !TiCatchSelection(value != null ? new[] { value } : null);
        }

        public static bool CurveSwatchPrefix(Rect position, AnimationCurve curve, AnimationCurve curve2, SerializedProperty property, SerializedProperty property2, Color color, Color bgColor, bool useCurveRanges, Rect curveRanges, Color topFillColor, Color bottomFillColor)
        {
            return !TiRecordCurve(position, curve, curve2, property, property2, color, bgColor, useCurveRanges, curveRanges, topFillColor, bottomFillColor);
        }

        public static bool HandlesLineDottedPrefix(Vector3 p1, Vector3 p2, bool dottedLine)
        {
            return !TiVectorLine(p1, p2, 1f, dottedLine);
        }

        public static bool HandlesLineThickPrefix(Vector3 p1, Vector3 p2, float thickness)
        {
            return !TiVectorLine(p1, p2, Mathf.Max(1f, thickness), false);
        }

        public static bool HandlesPolyLinePrefix(Vector3[] points)
        {
            return !TiVectorPoly('p', points, -1, Handles.color, 1f, Color.clear);
        }

        public static bool HandlesLinesPrefix(Vector3[] lineSegments)
        {
            return !TiVectorPoly('l', lineSegments, -1, Handles.color, 1f, Color.clear);
        }

        public static bool HandlesLinesIndexedPrefix(Vector3[] points, int[] segmentIndices)
        {
            if (points == null || segmentIndices == null) return true;
            var list = new Vector3[segmentIndices.Length];
            for (int i = 0; i < segmentIndices.Length; i++)
            {
                int k = segmentIndices[i];
                list[i] = k >= 0 && k < points.Length ? points[k] : Vector3.zero;
            }
            return !TiVectorPoly('l', list, -1, Handles.color, 1f, Color.clear);
        }

        public static bool HandlesAAPolyLinePrefix(Color[] colors, Vector3[] points, int actualNumberOfPoints, Texture2D lineTex, float width, float alpha)
        {
            var c = colors != null && colors.Length > 0 ? colors[0] : Handles.color;
            c.a *= alpha;
            return !TiVectorPoly('p', points, actualNumberOfPoints, c, Mathf.Max(1f, width), Color.clear);
        }

        public static bool HandlesConvexPrefix(Vector3[] points, int actualNumberOfPoints, float alpha)
        {
            var c = Handles.color;
            c.a *= alpha;
            return !TiVectorPoly('f', points, actualNumberOfPoints, Color.clear, 1f, c);
        }

        public static bool HandlesBezierPrefix(Vector3 startPosition, Vector3 endPosition, Vector3 startTangent, Vector3 endTangent, Color color, Texture2D texture, float width)
        {
            return !TiVectorPoly('p', TiBezier(startPosition, endPosition, startTangent, endTangent), -1, color, Mathf.Max(1f, width), Color.clear);
        }

        public static bool HandlesWireDiscPrefix(Vector3 center, Vector3 normal, float radius, float thickness)
        {
            return !TiVectorPoly('p', TiArc(center, normal, Vector3.zero, 360f, radius, false), -1, Handles.color, Mathf.Max(1f, thickness), Color.clear);
        }

        public static bool HandlesSolidDiscPrefix(Vector3 center, Vector3 normal, float radius)
        {
            return !TiVectorPoly('f', TiArc(center, normal, Vector3.zero, 360f, radius, false), -1, Color.clear, 1f, Handles.color);
        }

        public static bool HandlesWireArcPrefix(Vector3 center, Vector3 normal, Vector3 from, float angle, float radius, float thickness)
        {
            return !TiVectorPoly('p', TiArc(center, normal, from, angle, radius, false), -1, Handles.color, Mathf.Max(1f, thickness), Color.clear);
        }

        public static bool HandlesSolidArcPrefix(Vector3 center, Vector3 normal, Vector3 from, float angle, float radius)
        {
            return !TiVectorPoly('f', TiArc(center, normal, from, angle, radius, true), -1, Color.clear, 1f, Handles.color);
        }

        public static bool HandlesRectOutlinePrefix(Vector3[] verts, Color faceColor, Color outlineColor)
        {
            return !TiVectorPoly('f', verts, -1, outlineColor, 1f, faceColor);
        }

        public static bool ToolbarForTargetPrefix(GUIContent content, Object target)
        {
            return !TiDrawToolbar(content, target);
        }

        public static void CommandEventPostfix(string commandName)
        {
            TiCommandCreated(commandName);
        }

        public static void ListElementsPrefix(UnityEditorInternal.ReorderableList __instance, ref Rect visibleRect)
        {
            if (s_TiDispatch == null) return;
            visibleRect = TiListVisibleAll;
            TiListEnter(__instance);
        }

        public static void ListElementsPostfix(UnityEditorInternal.ReorderableList __instance)
        {
            if (s_TiDispatch != null) TiListExit(__instance);
        }

        public static void ConstraintTogglePrefix(object[] __args)
        {
            if (s_TiDispatch == null || __args == null || __args.Length < 4 || !(__args[0] is Rect r) || !(__args[3] is int bit) || __args[2] == null) return;
            TiRecordFlagToggle(r, "m_Constraints", __args[2].GetType(), bit, __args[1] as string);
        }

        public static void MaterialEndPropertyPrefix()
        {
            TiRecordMaterialProperty();
        }

        public static bool HandleRepaintPrefix()
        {
            var s = s_TiDispatch;
            if (s == null) return true;
            TiMarkDirty(s);
            return false;
        }

        public static void EditorRepaintPostfix(Editor __instance)
        {
            TiEditorRepainted(__instance);
        }

        public static bool PopupWindowPrefix(Rect activatorRect, PopupWindowContent windowContent)
        {
            return !TiCatchPopupWindow(activatorRect, windowContent);
        }

        public static bool NoFocusShowPrefix(Rect activatorRect, PopupWindowContent windowContent)
        {
            return !TunerPopupHostNested(activatorRect, windowContent);
        }

        public static void NoFocusHidePrefix()
        {
            TunerPopupCloseNested();
        }

        public static void NoFocusVisiblePostfix(ref bool __result)
        {
            if (TunerPopupNestedOpen()) __result = true;
        }

        public static bool WindowShowPrefix(EditorWindow __instance)
        {
            return !TiCatchWindow(__instance, null);
        }

        public static bool WindowDropDownPrefix(EditorWindow __instance, Rect buttonRect)
        {
            return !TiCatchWindow(__instance, buttonRect);
        }
    }
}
