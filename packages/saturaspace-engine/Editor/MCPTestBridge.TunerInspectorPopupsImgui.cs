using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    sealed class TunerPopupSession
    {
        public bool Committed;
        public bool Touched;
        public int UndoGroup = -1;
        public int Keyboard;
        public object Original;
        public Action<Color> ColorCallback;
        public Action<Gradient> GradientCallback;
        public Action GradientClosed;
        public Action<Object> ObjectUpdated;
        public Action<Object> ObjectClosed;
        public Type ObjectType;
        public bool AllowScene;
    }

    static readonly Type s_TunerPopupColorPickerType = typeof(Editor).Assembly.GetType("UnityEditor.ColorPicker");
    static PropertyInfo s_TunerPopupOrigKeyboard;
    static int s_TunerPopupDelivering;
    static Color s_TunerPopupColor;
    static AnimationCurve s_TunerPopupCurve;
    static Gradient s_TunerPopupGradient;
    static Object s_TunerPopupObject;
    static AnimationCurve s_TunerPopupPendingCurve;
    static Color s_TunerPopupPendingCurveColor;

    static bool TunerPopupImguiActive => TunerInspectorDispatching;

    static Rect TunerPopupMouseRect()
    {
        var e = Event.current;
        return new Rect(e != null ? e.mousePosition : Vector2.zero, Vector2.zero);
    }

    static void TunerPopupBeginChange(TunerPopupSession st)
    {
        if (st.UndoGroup < 0) st.UndoGroup = Undo.GetCurrentGroup();
        st.Touched = true;
    }

    static void TunerPopupEndChange(TunerPopupSession st)
    {
        if (st.UndoGroup >= 0) Undo.CollapseUndoOperations(st.UndoGroup);
    }

    static void TunerPopupDeliver(TunerPopup p, string command, Action push)
    {
        s_TunerPopupDelivering++;
        try
        {
            push?.Invoke();
            if (command != null) TunerInspectorSendCommand(p, command);
        }
        finally
        {
            s_TunerPopupDelivering--;
        }
    }

    static string TunerPopupColorJson(Color c)
    {
        return "{\"r\":" + TunerPopupFloat(c.r) + ",\"g\":" + TunerPopupFloat(c.g) + ",\"b\":" + TunerPopupFloat(c.b) + ",\"a\":" + TunerPopupFloat(c.a) + "}";
    }

    static bool TunerPopupColorShowPrefix(Action<Color> colorChangedCallback, Color col, bool showAlpha, bool hdr)
    {
        if (!TunerPopupImguiActive) return true;
        var st = new TunerPopupSession { Original = col, Keyboard = GUIUtility.keyboardControl, ColorCallback = colorChangedCallback };
        var data = "{\"value\":" + TunerPopupColorJson(col) + ",\"hdr\":" + (hdr ? "true" : "false") + ",\"showAlpha\":" + (showAlpha ? "true" : "false") + "}";
        void Push(TunerPopup p, Color c)
        {
            TunerPopupDeliver(p, st.ColorCallback == null ? "ColorPickerChanged" : null, () =>
            {
                s_TunerPopupColor = c;
                TunerPopupSetOriginalKeyboard(st.Keyboard);
                st.ColorCallback?.Invoke(c);
            });
            TunerPopupSetOriginalKeyboard(0);
        }
        TunerInspectorAddPopup("color", TunerPopupMouseRect(), false, data, st, (p, action, raw) =>
        {
            if (string.IsNullOrEmpty(raw)) return "a color answer needs {r,g,b,a}";
            var v = JsonUtility.FromJson<TunerUitkColorValue>(raw);
            var c = new Color(v.r, v.g, v.b, showAlpha ? v.a : col.a);
            TunerPopupBeginChange(st);
            Push(p, c);
            TunerPopupEndChange(st);
            if (action == "commit") st.Committed = true;
            return null;
        }, p =>
        {
            if (st.Committed || !st.Touched) return;
            try
            {
                Push(p, col);
                TunerPopupEndChange(st);
            }
            catch (Exception e) { Debug.LogWarning("[tunerPopup] could not restore the color: " + e.Message); }
        });
        return false;
    }

    static void TunerPopupSetOriginalKeyboard(int id)
    {
        try
        {
            if (s_TunerPopupOrigKeyboard == null) s_TunerPopupOrigKeyboard = s_TunerPopupColorPickerType?.GetProperty("originalKeyboardControl", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic);
            s_TunerPopupOrigKeyboard?.GetSetMethod(true)?.Invoke(null, new object[] { id });
        }
        catch { }
    }

    static bool TunerPopupColorGetPrefix(ref Color __result)
    {
        if (s_TunerPopupDelivering == 0) return true;
        __result = s_TunerPopupColor;
        return false;
    }

    static bool TunerPopupSetCurvePrefix(AnimationCurve value, SerializedProperty property, Color color)
    {
        if (!TunerPopupImguiActive) return true;
        s_TunerPopupPendingCurve = property != null ? (property.hasMultipleDifferentValues ? new AnimationCurve() : property.animationCurveValue) : value;
        s_TunerPopupPendingCurveColor = color;
        return false;
    }

    static bool TunerPopupShowCurvePrefix(Rect ranges)
    {
        if (!TunerPopupImguiActive) return true;
        var original = s_TunerPopupPendingCurve ?? new AnimationCurve();
        original = new AnimationCurve(original.keys) { preWrapMode = original.preWrapMode, postWrapMode = original.postWrapMode };
        var st = new TunerPopupSession { Original = original };
        var sb = new StringBuilder(512);
        sb.Append("{\"value\":").Append(TunerPopupCurveJson(original));
        if (ranges.width > 0f && ranges.height > 0f && !float.IsInfinity(ranges.width) && !float.IsInfinity(ranges.height))
            sb.Append(",\"ranges\":{\"x\":").Append(TunerPopupFloat(ranges.x)).Append(",\"y\":").Append(TunerPopupFloat(ranges.y))
                .Append(",\"w\":").Append(TunerPopupFloat(ranges.width)).Append(",\"h\":").Append(TunerPopupFloat(ranges.height)).Append('}');
        var c32 = (Color32)s_TunerPopupPendingCurveColor;
        sb.Append(",\"color\":\"#").Append(c32.r.ToString("x2")).Append(c32.g.ToString("x2")).Append(c32.b.ToString("x2")).Append("\"}");
        s_TunerPopupPendingCurve = null;
        void Push(TunerPopup p, AnimationCurve c) => TunerPopupDeliver(p, "CurveChanged", () => s_TunerPopupCurve = c);
        TunerInspectorAddPopup("curve", TunerPopupMouseRect(), false, sb.ToString(), st, (p, action, raw) =>
        {
            if (string.IsNullOrEmpty(raw)) return "a curve answer needs {keys,preWrapMode,postWrapMode}";
            var c = TunerPopupParseCurve(raw);
            TunerPopupBeginChange(st);
            Push(p, c);
            TunerPopupEndChange(st);
            if (action == "commit") st.Committed = true;
            return null;
        }, p =>
        {
            if (st.Committed || !st.Touched) return;
            try
            {
                Push(p, original);
                TunerPopupEndChange(st);
            }
            catch (Exception e) { Debug.LogWarning("[tunerPopup] could not restore the curve: " + e.Message); }
        });
        return false;
    }

    static bool TunerPopupCurveGetPrefix(ref AnimationCurve __result)
    {
        if (s_TunerPopupDelivering == 0) return true;
        __result = s_TunerPopupCurve;
        return false;
    }

    static bool TunerPopupGradientShowPrefix(Gradient newGradient, bool hdr, ColorSpace colorSpace, Action<Gradient> onGradientChanged, Action onClosed)
    {
        if (!TunerPopupImguiActive) return true;
        var original = TunerUitkGradientCopy(newGradient ?? new Gradient());
        var shown = TunerUitkGradientCopy(original);
        shown.colorSpace = colorSpace;
        var st = new TunerPopupSession { Original = original, GradientCallback = onGradientChanged, GradientClosed = onClosed };
        var data = "{\"value\":" + JsonUtility.ToJson(TunerUitkGradientOut(shown)) + ",\"hdr\":" + (hdr ? "true" : "false") + "}";
        void Push(TunerPopup p, Gradient g) => TunerPopupDeliver(p, st.GradientCallback == null ? "GradientPickerChanged" : null, () =>
        {
            s_TunerPopupGradient = g;
            st.GradientCallback?.Invoke(g);
        });
        TunerInspectorAddPopup("gradient", TunerPopupMouseRect(), false, data, st, (p, action, raw) =>
        {
            if (string.IsNullOrEmpty(raw)) return "a gradient answer needs {mode,colorKeys,alphaKeys}";
            var g = TunerPopupParseGradient(raw);
            TunerPopupBeginChange(st);
            Push(p, g);
            TunerPopupEndChange(st);
            if (action == "commit")
            {
                st.Committed = true;
                st.GradientClosed?.Invoke();
            }
            return null;
        }, p =>
        {
            if (st.Committed) return;
            try
            {
                if (st.Touched)
                {
                    Push(p, original);
                    TunerPopupEndChange(st);
                }
                st.GradientClosed?.Invoke();
            }
            catch (Exception e) { Debug.LogWarning("[tunerPopup] could not restore the gradient: " + e.Message); }
        });
        return false;
    }

    static Gradient TunerPopupParseGradient(string raw)
    {
        var v = JsonUtility.FromJson<TunerUitkGradientValue>(raw);
        var g = new Gradient { mode = (GradientMode)v.mode, colorSpace = (ColorSpace)v.colorSpace };
        g.SetKeys(
            (v.colorKeys ?? new TunerUitkColorKey[0]).Select(k => new GradientColorKey(new Color(k.color.r, k.color.g, k.color.b, 1f), k.time)).ToArray(),
            (v.alphaKeys ?? new TunerUitkAlphaKey[0]).Select(k => new GradientAlphaKey(k.alpha, k.time)).ToArray());
        return g;
    }

    static bool TunerPopupGradientGetPrefix(ref Gradient __result)
    {
        if (s_TunerPopupDelivering == 0) return true;
        __result = s_TunerPopupGradient;
        return false;
    }

    static bool TunerPopupObjectShowPropPrefix(Type[] requiredTypes, SerializedProperty property, bool allowSceneObjects, Action<Object> onObjectSelectorClosed, Action<Object> onObjectSelectedUpdated)
    {
        if (!TunerPopupImguiActive || property == null) return true;
        var current = property.hasMultipleDifferentValues ? null : property.objectReferenceValue;
        var edited = property.serializedObject.targetObject;
        if (requiredTypes == null || requiredTypes.All(t => t == null)) requiredTypes = new[] { TunerPopupFieldType(property) };
        return !TunerPopupOpenObject(current, requiredTypes, edited, allowSceneObjects, onObjectSelectorClosed, onObjectSelectedUpdated, property.propertyPath);
    }

    static Type TunerPopupFieldType(SerializedProperty property)
    {
        var sau = typeof(Editor).Assembly.GetType("UnityEditor.ScriptAttributeUtility");
        var get = sau?.GetMethod("GetFieldInfoFromProperty", BindingFlags.Static | BindingFlags.Public | BindingFlags.NonPublic, null, new[] { typeof(SerializedProperty), typeof(Type).MakeByRefType() }, null);
        if (get != null)
        {
            var args = new object[] { property, null };
            try { get.Invoke(null, args); }
            catch { }
            if (args[1] is Type t && typeof(Object).IsAssignableFrom(t)) return t;
        }
        var m = System.Text.RegularExpressions.Regex.Match(property.type ?? "", @"^PPtr<\$?(.+)>$");
        if (!m.Success) return null;
        var name = m.Groups[1].Value;
        foreach (var t in TypeCache.GetTypesDerivedFrom<Object>())
            if (t.Name == name) return t;
        return null;
    }

    static bool TunerPopupObjectShowObjPrefix(Object obj, Type[] requiredTypes, Object objectBeingEdited, bool allowSceneObjects, Action<Object> onObjectSelectorClosed, Action<Object> onObjectSelectedUpdated)
    {
        if (!TunerPopupImguiActive) return true;
        return !TunerPopupOpenObject(obj, requiredTypes, objectBeingEdited, allowSceneObjects, onObjectSelectorClosed, onObjectSelectedUpdated, null);
    }

    static bool TunerPopupOpenObject(Object current, Type[] types, Object edited, bool allowScene, Action<Object> closed, Action<Object> updated, string property)
    {
        var type = types != null ? types.FirstOrDefault(t => t != null) : null;
        type = type ?? typeof(Object);
        if (edited != null && EditorUtility.IsPersistent(edited)) allowScene = false;
        var st = new TunerPopupSession { Original = current, ObjectUpdated = updated, ObjectClosed = closed, ObjectType = type, AllowScene = allowScene };
        var sb = new StringBuilder(256);
        sb.Append("{\"type\":").Append(TunerUitkStr(type.FullName));
        sb.Append(",\"typeName\":").Append(TunerUitkStr(type.Name));
        sb.Append(",\"allowSceneObjects\":").Append(allowScene ? "true" : "false");
        sb.Append(",\"current\":").Append(TunerPopupObjectRefJson(current));
        if (current != null) sb.Append(",\"currentName\":").Append(TunerUitkStr(current.name));
        if (!string.IsNullOrEmpty(property)) sb.Append(",\"property\":").Append(TunerUitkStr(property));
        sb.Append('}');
        void Push(TunerPopup p, Object o, bool close)
        {
            TunerPopupDeliver(p, "ObjectSelectorUpdated", () =>
            {
                s_TunerPopupObject = o;
                st.ObjectUpdated?.Invoke(o);
            });
            if (!close) return;
            TunerPopupDeliver(p, "ObjectSelectorClosed", () =>
            {
                s_TunerPopupObject = o;
                st.ObjectClosed?.Invoke(o);
            });
        }
        var popup = TunerInspectorAddPopup("object", TunerPopupMouseRect(), false, sb.ToString(), st, (p, action, raw) =>
        {
            Object picked = null;
            var trimmed = (raw ?? "null").Trim();
            if (trimmed != "null" && trimmed.Length > 0)
            {
                picked = TunerUitkResolveObject(TunerPopupParseObjectRef(trimmed), type);
                if (picked == null) return "could not find that object";
                if (!allowScene && !EditorUtility.IsPersistent(picked)) return "this field only takes assets";
            }
            TunerPopupBeginChange(st);
            Push(p, picked, action == "commit");
            TunerPopupEndChange(st);
            if (action == "commit") st.Committed = true;
            return null;
        }, p =>
        {
            if (st.Committed) return;
            try
            {
                if (st.Touched) Push(p, current, true);
                else st.ObjectClosed?.Invoke(current);
                TunerPopupEndChange(st);
            }
            catch (Exception e) { Debug.LogWarning("[tunerPopup] could not restore the object: " + e.Message); }
        });
        return popup != null;
    }

    static bool TunerPopupObjectGetPrefix(ref Object __result)
    {
        if (s_TunerPopupDelivering == 0) return true;
        __result = s_TunerPopupObject;
        return false;
    }
}
