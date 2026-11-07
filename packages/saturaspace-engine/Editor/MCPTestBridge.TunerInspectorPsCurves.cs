using System;
using System.Collections;
using System.Collections.Generic;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;
using Debug = UnityEngine.Debug;

public static partial class MCPTestBridge
{
    const float TI_PSC_PRESETS_HEIGHT = 45f;
    static bool s_TiPscDrawing;
    static int s_TiPscUndoGroup = -1;
    static Type s_TiPscSelectionType;
    static MethodInfo s_TiPscOptimized;
    static bool s_TiPscOptimizedLooked;

    [Serializable]
    class TiPscCurveIn
    {
        public int id;
        public TunerPopupCurveIn curve;
    }

    [Serializable]
    class TiPscCommand
    {
        public string cmd;
        public bool begin;
        public int front;
        public bool hasSel;
        public int[] sel;
        public int[] ids;
        public float value;
        public TiPscCurveIn[] curves;
    }

    static object TiPscField(object o, string name)
    {
        for (var t = o?.GetType(); t != null; t = t.BaseType)
        {
            var f = t.GetField(name, TiInstance | BindingFlags.DeclaredOnly);
            if (f != null) return f.GetValue(o);
        }
        throw new MissingFieldException(o?.GetType().Name + "." + name);
    }

    static object TiPscCall(object o, string name, params object[] args)
    {
        for (var t = o.GetType(); t != null; t = t.BaseType)
            foreach (var m in t.GetMethods(TiInstance | BindingFlags.DeclaredOnly))
            {
                if (m.Name != name || m.GetParameters().Length != args.Length) continue;
                var ps = m.GetParameters();
                bool fits = true;
                for (int i = 0; i < ps.Length && fits; i++)
                {
                    var pt = ps[i].ParameterType.IsByRef ? ps[i].ParameterType.GetElementType() : ps[i].ParameterType;
                    fits = args[i] == null ? !pt.IsValueType : pt.IsInstanceOfType(args[i]);
                }
                if (fits) return m.Invoke(o, args);
            }
        throw new MissingMethodException(o.GetType().Name + "." + name);
    }

    static object TiPscEditorOf(Editor ed)
    {
        if (ed == null || ed.GetType().Name != "ParticleSystemInspector") return null;
        var ui = TiPscField(ed, "m_ParticleEffectUI");
        return ui == null ? null : TiPscCall(ui, "GetParticleSystemCurveEditor");
    }

    static bool TiPscPreviewGUI(TiSession s, TiSection sec, Editor ed, Rect area)
    {
        object psce;
        try { psce = TiPscEditorOf(ed); }
        catch (Exception e)
        {
            if (s.LoggedErrors.Add("psc-find:" + e.Message)) Debug.LogWarning("[tunerInspector] particle curves editor not reachable: " + e.Message);
            return false;
        }
        if (psce == null) return false;
        try
        {
            TiPscCall(psce, "Init");
            var stylesField = psce.GetType().GetField("s_Styles", TiStatic);
            var styles = stylesField.GetValue(null);
            if (styles == null)
            {
                styles = Activator.CreateInstance(stylesField.FieldType, true);
                stylesField.SetValue(null, styles);
            }
            var bg = TiPscField(styles, "curveEditorBackground") as GUIStyle;
            var ce = TiPscField(psce, "m_CurveEditor");
            var ceRect = new Rect(area.x, area.y, area.width, area.height - TI_PSC_PRESETS_HEIGHT);
            var presetRect = new Rect(area.x, area.y + ceRect.height, area.width, TI_PSC_PRESETS_HEIGHT);
            if (bg != null) GUI.Label(ceRect, GUIContent.none, bg);
            if (Event.current.type == EventType.Repaint) ce.GetType().GetProperty("rect", TiInstance)?.SetValue(ce, ceRect);
            s_TiPscDrawing = true;
            try
            {
                TiPscCall(psce, "DoLabelForTopMostCurve", new Rect(area.x + 4f, area.y, area.width - 160f, 20f));
                TiPscCall(psce, "DoRemoveSelectedButton", new Rect(ceRect.x, ceRect.y, ceRect.width, 24f));
                TiPscCall(psce, "DoOptimizeCurveButton", new Rect(ceRect.x, ceRect.y, ceRect.width, 24f));
                TiPscCall(psce, "PresetCurveButtons", presetRect, area);
                TiPscCall(psce, "SaveChangedCurves");
            }
            finally
            {
                s_TiPscDrawing = false;
            }
            TiPscApply(psce);
            if (TiVectorActive && s_TiDispatchSection == sec)
            {
                using (new TunerRectIdentity(null)) sec.PscRect = s_TiUnclipRect(ceRect);
                sec.PscC = s_TiDispatchIndex;
                sec.PscJson = TiPscStateJson(psce, ce);
            }
        }
        catch (Exception e)
        {
            if (TiIsExitGui(e)) GUIUtility.ExitGUI();
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            if (s.LoggedErrors.Add("psc:" + inner.Message)) Debug.LogWarning("[tunerInspector] particle curves failed: " + inner);
        }
        return true;
    }

    static IEnumerable<object> TiPscCurves(object psce)
    {
        if (TiPscField(psce, "m_AddedCurves") is IList added)
            foreach (var cd in added)
                if (cd != null) yield return cd;
    }

    static object TiPscData(object psce, int id)
    {
        if (id <= 0) return null;
        foreach (var cd in TiPscCurves(psce))
            if ((int)TiPscField(cd, "m_MaxId") == id || (int)TiPscField(cd, "m_MinId") == id) return cd;
        return null;
    }

    static SerializedProperty TiPscProp(object psce, int id)
    {
        var cd = TiPscData(psce, id);
        if (cd == null) return null;
        return (int)TiPscField(cd, "m_MaxId") == id ? TiPscField(cd, "m_Max") as SerializedProperty : TiPscField(cd, "m_Min") as SerializedProperty;
    }

    static void TiPscApply(object psce)
    {
        var done = new HashSet<SerializedObject>();
        foreach (var cd in TiPscCurves(psce))
        {
            var so = (TiPscField(cd, "m_Max") as SerializedProperty)?.serializedObject;
            if (so == null || !done.Add(so) || so.targetObject == null) continue;
            if (so.hasModifiedProperties) so.ApplyModifiedProperties();
        }
    }

    static bool TiPscOptimized(AnimationCurve c)
    {
        if (!s_TiPscOptimizedLooked)
        {
            s_TiPscOptimizedLooked = true;
            s_TiPscOptimized = typeof(AnimationUtility).GetMethod("IsValidOptimizedPolynomialCurve", TiStatic, null, new[] { typeof(AnimationCurve) }, null);
        }
        if (s_TiPscOptimized == null || c == null) return true;
        try { return (bool)s_TiPscOptimized.Invoke(null, new object[] { c }); }
        catch { return true; }
    }

    static Vector2 TiPscScalars(object cd)
    {
        if (TiPscField(cd, "m_GetAxisScalarsCallback") is Delegate get)
        {
            try { return (Vector2)get.DynamicInvoke(); }
            catch { }
        }
        return Vector2.one;
    }

    static string TiPscStateJson(object psce, object ce)
    {
        var sb = new StringBuilder(2048);
        var args = new object[] { -1 };
        bool hasTop = ce.GetType().GetMethod("GetTopMostCurveID", TiInstance) is MethodInfo gt && (bool)gt.Invoke(ce, args);
        sb.Append("\"inst\":").Append(System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(psce).ToString(TiInv));
        sb.Append(",\"top\":").Append((hasTop ? (int)args[0] : 0).ToString(TiInv));
        sb.Append(",\"order\":[");
        if (TiPscField(ce, "m_DrawOrder") is IList order)
            for (int i = 0; i < order.Count; i++)
            {
                if (i > 0) sb.Append(',');
                sb.Append(((int)order[i]).ToString(TiInv));
            }
        sb.Append("],\"curves\":[");
        bool first = true;
        bool signed = false;
        foreach (var cd in TiPscCurves(psce))
        {
            if (!(bool)TiPscField(cd, "m_Visible")) continue;
            var max = TiPscField(cd, "m_Max") as SerializedProperty;
            var min = TiPscField(cd, "m_Min") as SerializedProperty;
            if (max == null || max.hasMultipleDifferentValues || (min != null && min.hasMultipleDifferentValues)) continue;
            var maxCurve = max.animationCurveValue;
            var minCurve = min?.animationCurveValue;
            bool isSigned = (bool)TiPscField(cd, "m_SignedRange");
            signed |= isSigned;
            var scal = TiPscScalars(cd);
            var name = (TiPscField(cd, "m_DisplayName") as GUIContent)?.text ?? "";
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"id\":").Append(((int)TiPscField(cd, "m_MaxId")).ToString(TiInv));
            sb.Append(",\"minId\":").Append((min != null ? (int)TiPscField(cd, "m_MinId") : 0).ToString(TiInv));
            TiStr(sb.Append(",\"name\":"), name);
            sb.Append(",\"col\":\"").Append(TiHex((Color)TiPscField(cd, "m_Color"))).Append('"');
            sb.Append(",\"signed\":").Append(isSigned ? "true" : "false");
            sb.Append(",\"sx\":").Append(TunerPopupFloat(scal.x));
            sb.Append(",\"sy\":").Append(TunerPopupFloat(scal.y));
            sb.Append(",\"set\":").Append(TiPscField(cd, "m_SetAxisScalarsCallback") != null ? "true" : "false");
            sb.Append(",\"opt\":").Append(TiPscOptimized(maxCurve) && (minCurve == null || TiPscOptimized(minCurve)) ? "true" : "false");
            sb.Append(",\"max\":").Append(TunerPopupCurveJson(maxCurve));
            if (minCurve != null) sb.Append(",\"min\":").Append(TunerPopupCurveJson(minCurve));
            sb.Append('}');
        }
        sb.Append("],\"vmin\":").Append(signed ? "-1" : "0");
        sb.Append(",\"sel\":[");
        if (ce.GetType().GetProperty("selectedCurves", TiInstance)?.GetValue(ce) is IList sel)
            for (int i = 0; i < sel.Count; i++)
            {
                var cs = sel[i];
                if (i > 0) sb.Append(',');
                sb.Append(((int)TiPscField(cs, "curveID")).ToString(TiInv)).Append(',');
                sb.Append(((int)TiPscField(cs, "key")).ToString(TiInv));
            }
        sb.Append(']');
        return sb.ToString();
    }

    static void TiPscSelect(object ce, int[] sel)
    {
        if (s_TiPscSelectionType == null) s_TiPscSelectionType = typeof(Editor).Assembly.GetType("UnityEditor.CurveSelection", true);
        var list = (IList)Activator.CreateInstance(typeof(List<>).MakeGenericType(s_TiPscSelectionType));
        if (sel != null)
            for (int i = 0; i + 1 < sel.Length; i += 2)
                list.Add(Activator.CreateInstance(s_TiPscSelectionType, TiInstance, null, new object[] { sel[i], sel[i + 1] }, null));
        ce.GetType().GetProperty("selectedCurves", TiInstance).SetValue(ce, list);
    }

    static void TiPscBeginUndo(bool begin)
    {
        if (!begin && s_TiPscUndoGroup >= 0) return;
        Undo.IncrementCurrentGroup();
        s_TiPscUndoGroup = Undo.GetCurrentGroup();
    }

    static string TiPscInput(TiSession s, TunerInspectorInputArgs a)
    {
        TiSection sec = null;
        foreach (var x in s.Sections)
            if (x.Key == a.section) sec = x;
        if (sec == null) return "no section '" + a.section + "'";
        TiPscCommand c;
        try { c = JsonUtility.FromJson<TiPscCommand>(a.value ?? ""); }
        catch (Exception e) { return "bad particle curves command: " + e.Message; }
        if (c == null || string.IsNullOrEmpty(c.cmd)) return "a particle curves command needs a cmd";
        try
        {
            var psce = TiPscEditorOf(sec.Editor);
            if (psce == null) return "section '" + a.section + "' has no Particle System Curves editor";
            var ce = TiPscField(psce, "m_CurveEditor");
            bool changed = false;
            switch (c.cmd)
            {
                case "select":
                    break;
                case "set":
                    if (c.curves == null || c.curves.Length == 0) return "set needs curves";
                    TiPscBeginUndo(c.begin);
                    foreach (var cin in c.curves)
                    {
                        var prop = TiPscProp(psce, cin.id);
                        if (prop == null) return "no particle curve with id " + cin.id;
                        var curve = TunerPopupCurveFrom(cin.curve);
                        if (curve.length == 0) return "a particle curve needs at least one key";
                        prop.animationCurveValue = curve;
                    }
                    changed = true;
                    break;
                case "scalar":
                    if (c.ids == null || c.ids.Length == 0) return "scalar needs ids";
                    TiPscBeginUndo(c.begin);
                    foreach (var id in c.ids)
                    {
                        var cd = TiPscData(psce, id);
                        if (cd == null) return "no particle curve with id " + id;
                        if (!(TiPscField(cd, "m_SetAxisScalarsCallback") is Delegate set)) return "that curve has no editable axis";
                        var v = TiPscScalars(cd);
                        v.y = c.value;
                        set.DynamicInvoke(v);
                    }
                    changed = true;
                    break;
                default:
                    return "unknown particle curves command: " + c.cmd;
            }
            if (changed)
            {
                TiPscApply(psce);
                Undo.SetCurrentGroupName(c.cmd == "scalar" ? "Edit Curve Scale" : "Edit Curve");
                if (!c.begin && s_TiPscUndoGroup >= 0) Undo.CollapseUndoOperations(s_TiPscUndoGroup);
                TiPscCall(psce, "Refresh");
            }
            if (c.front > 0) TiPscCall(ce, "MoveCurveToFront", c.front);
            if (c.hasSel) TiPscSelect(ce, c.sel);
            return null;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            Debug.LogWarning("[tunerInspector] particle curves command '" + c.cmd + "' failed: " + inner);
            return "particle curves command failed: " + inner.Message;
        }
    }
}
