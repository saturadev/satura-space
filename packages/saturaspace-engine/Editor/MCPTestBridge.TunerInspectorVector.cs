using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.EditorTools;
using UnityEngine;
using Debug = UnityEngine.Debug;
using Object = UnityEngine.Object;

public static partial class MCPTestBridge
{
    const int TI_CURVE_SAMPLES = 96;

    static bool TiVectorIntercept => s_TiDispatch != null && Camera.current == null && (s_TiDispatchSection == null || s_TiDispatchSection.Kind != "preview" || s_TiPscDrawing);

    static bool TiVectorActive
    {
        get
        {
            var e = Event.current;
            return s_TiRecording && s_TiDispatchSection != null && e != null && e.type == EventType.Repaint;
        }
    }

    static bool TiRecordCurve(Rect position, AnimationCurve curve, AnimationCurve curve2, SerializedProperty property, SerializedProperty property2, Color color, Color bgColor, bool useCurveRanges, Rect curveRanges, Color topFillColor, Color bottomFillColor)
    {
        if (!TiVectorIntercept) return false;
        if (!TiVectorActive) return true;
        if (property != null && property.hasMultipleDifferentValues) return false;
        AnimationCurve c1 = curve;
        AnimationCurve c2 = curve2;
        try
        {
            if (c1 == null && property != null) c1 = property.animationCurveValue;
            if (c2 == null && property2 != null) c2 = property2.animationCurveValue;
        }
        catch
        {
        }
        var sec = s_TiDispatchSection;
        var d = new TiDrawRec { K = 'c', C = s_TiDispatchIndex };
        using (new TunerRectIdentity(d)) d.R = s_TiUnclipRect(position);
        d.Bg = bgColor;
        if (TiDefaultCurveBg(bgColor)) d.Flags |= TI_FLAG_CHROME;
        d.Fg = color;
        d.Fill = topFillColor;
        d.Fill2 = bottomFillColor;
        if (!GUI.enabled) d.Flags |= TI_FLAG_OFF;
        Rect range;
        if (useCurveRanges) range = curveRanges;
        else range = TiCurveRange(c1, c2);
        d.Pts = TiSampleCurve(c1, range);
        d.Pts2 = c2 != null ? TiSampleCurve(c2, range) : null;
        using (new TunerRectIdentity(null)) d.Clip = TiClip(sec, TunerRectBounds(d));
        sec.Draws.Add(d);
        return true;
    }

    static Color? s_TiCurveBg;

    static bool TiDefaultCurveBg(Color c)
    {
        if (!s_TiCurveBg.HasValue)
        {
            var f = typeof(EditorGUI).GetField("kCurveBGColor", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
            s_TiCurveBg = f != null && f.FieldType == typeof(Color) ? (Color)f.GetValue(null) : new Color(0.337f, 0.337f, 0.337f, 1f);
        }
        var d = s_TiCurveBg.Value;
        return Mathf.Abs(c.r - d.r) < 0.004f && Mathf.Abs(c.g - d.g) < 0.004f && Mathf.Abs(c.b - d.b) < 0.004f && Mathf.Abs(c.a - d.a) < 0.004f;
    }

    static Rect TiCurveRange(AnimationCurve a, AnimationCurve b)
    {
        float t0 = float.MaxValue, t1 = float.MinValue, v0 = float.MaxValue, v1 = float.MinValue;
        foreach (var c in new[] { a, b })
        {
            if (c == null || c.length == 0) continue;
            t0 = Mathf.Min(t0, c.keys[0].time);
            t1 = Mathf.Max(t1, c.keys[c.length - 1].time);
        }
        if (t0 == float.MaxValue)
        {
            t0 = 0f;
            t1 = 1f;
        }
        if (t1 - t0 < 1e-5f) t1 = t0 + 1f;
        foreach (var c in new[] { a, b })
        {
            if (c == null || c.length == 0) continue;
            for (int i = 0; i <= TI_CURVE_SAMPLES; i++)
            {
                float v = c.Evaluate(t0 + (t1 - t0) * i / TI_CURVE_SAMPLES);
                v0 = Mathf.Min(v0, v);
                v1 = Mathf.Max(v1, v);
            }
        }
        if (v0 == float.MaxValue)
        {
            v0 = 0f;
            v1 = 1f;
        }
        if (v1 - v0 < 1e-5f)
        {
            v0 -= 0.5f;
            v1 += 0.5f;
        }
        return new Rect(t0, v0, t1 - t0, v1 - v0);
    }

    static float[] TiSampleCurve(AnimationCurve c, Rect range)
    {
        if (c == null || c.length == 0) return null;
        var pts = new float[(TI_CURVE_SAMPLES + 1) * 2];
        float w = Mathf.Abs(range.width) < 1e-6f ? 1f : range.width;
        float h = Mathf.Abs(range.height) < 1e-6f ? 1f : range.height;
        for (int i = 0; i <= TI_CURVE_SAMPLES; i++)
        {
            float x = (float)i / TI_CURVE_SAMPLES;
            float v = c.Evaluate(range.x + w * x);
            pts[i * 2] = x;
            pts[i * 2 + 1] = Mathf.Clamp01(1f - (v - range.y) / h);
        }
        return pts;
    }

    static void TiAddVector(char mode, IList<Vector3> points, int count, Color col, float width, Color fill, bool dotted)
    {
        if (points == null) return;
        if (count < 0 || count > points.Count) count = points.Count;
        if (count < 2 && mode != 'f') return;
        var sec = s_TiDispatchSection;
        var m = Handles.matrix;
        var local = new Vector2[count];
        var d = new TiDrawRec { K = 'v', C = s_TiDispatchIndex, Mode = mode, Dotted = dotted };
        var identity = new TunerRectIdentity(d);
        float x0 = float.MaxValue, y0 = float.MaxValue, x1 = float.MinValue, y1 = float.MinValue;
        for (int i = 0; i < count; i++)
        {
            var p = m.MultiplyPoint3x4(points[i]);
            var q = s_TiUnclipVec(new Vector2(p.x, p.y));
            local[i] = q;
            x0 = Mathf.Min(x0, q.x);
            y0 = Mathf.Min(y0, q.y);
            x1 = Mathf.Max(x1, q.x);
            y1 = Mathf.Max(y1, q.y);
        }
        if (count == 0)
        {
            identity.Dispose();
            return;
        }
        d.R = Rect.MinMaxRect(x0, y0, Mathf.Max(x1, x0 + 0.01f), Mathf.Max(y1, y0 + 0.01f));
        d.Pts = new float[count * 2];
        for (int i = 0; i < count; i++)
        {
            d.Pts[i * 2] = local[i].x - d.R.x;
            d.Pts[i * 2 + 1] = local[i].y - d.R.y;
        }
        d.Fg = col;
        d.Fill = fill;
        d.Width = width;
        d.Clip = TiClip(sec, TunerRectBounds(d));
        identity.Dispose();
        sec.Draws.Add(d);
    }

    static bool TiVectorLine(Vector3 p1, Vector3 p2, float width, bool dotted)
    {
        if (!TiVectorIntercept) return false;
        if (!TiVectorActive) return true;
        TiAddVector('l', new[] { p1, p2 }, 2, Handles.color, width, Color.clear, dotted);
        return true;
    }

    static bool TiVectorPoly(char mode, IList<Vector3> points, int count, Color col, float width, Color fill)
    {
        if (!TiVectorIntercept) return false;
        if (!TiVectorActive) return true;
        TiAddVector(mode, points, count, col, width, fill, false);
        return true;
    }

    static Vector3[] TiArc(Vector3 center, Vector3 normal, Vector3 from, float angle, float radius, bool closeToCenter)
    {
        if (normal.sqrMagnitude < 1e-8f) normal = Vector3.forward;
        if (from.sqrMagnitude < 1e-8f)
        {
            from = Vector3.Cross(normal, Vector3.up);
            if (from.sqrMagnitude < 1e-6f) from = Vector3.Cross(normal, Vector3.right);
        }
        from = from.normalized;
        int n = Mathf.Clamp(Mathf.CeilToInt(Mathf.Abs(angle) / 6f), 4, 90);
        var list = new List<Vector3>(n + 2);
        if (closeToCenter) list.Add(center);
        for (int i = 0; i <= n; i++)
        {
            var q = Quaternion.AngleAxis(angle * i / n, normal);
            list.Add(center + q * from * radius);
        }
        return list.ToArray();
    }

    static Vector3[] TiBezier(Vector3 a, Vector3 b, Vector3 ta, Vector3 tb)
    {
        const int n = 32;
        var pts = new Vector3[n + 1];
        for (int i = 0; i <= n; i++)
        {
            float t = (float)i / n;
            float u = 1f - t;
            pts[i] = u * u * u * a + 3f * u * u * t * ta + 3f * u * t * t * tb + t * t * t * b;
        }
        return pts;
    }

    static readonly Dictionary<Type, EditorTool> s_TiTools = new Dictionary<Type, EditorTool>();
    static List<Type> s_TiToolTypes;
    static MethodInfo s_TiToolbarMethod;
    static bool s_TiToolbarLooked;

    static bool TiDrawToolbar(GUIContent content, Object target)
    {
        if (s_TiDispatch == null || target == null) return false;
        try
        {
            Object[] editorTargets = null;
            if (target is Editor ed)
            {
                editorTargets = ed.targets;
                target = ed.target;
            }
            if (target == null) return false;
            if (!s_TiToolbarLooked)
            {
                s_TiToolbarLooked = true;
                s_TiToolTypes = TypeCache.GetTypesWithAttribute<EditorToolAttribute>().Where(t => typeof(EditorTool).IsAssignableFrom(t) && !t.IsAbstract).ToList();
                var generic = typeof(EditorGUILayout).GetMethods(TiStatic).FirstOrDefault(m => m.Name == "EditorToolbar" && m.IsGenericMethodDefinition && m.GetParameters().Length == 4);
                if (generic != null) s_TiToolbarMethod = generic.MakeGenericMethod(typeof(EditorTool));
            }
            if (s_TiToolbarMethod == null || s_TiToolTypes == null) return false;
            var targets = editorTargets != null && editorTargets.Length > 0 ? editorTargets : new[] { target };
            var tools = new List<EditorTool>();
            EditorTool selected = null;
            foreach (var t in s_TiToolTypes)
            {
                var attr = t.GetCustomAttributes(typeof(EditorToolAttribute), false).FirstOrDefault() as EditorToolAttribute;
                if (attr == null || attr.targetType == null || !attr.targetType.IsInstanceOfType(target)) continue;
                EditorTool tool;
                if (TunerToolMatches(t, target))
                {
                    tool = s_TunerTool;
                    selected = tool;
                }
                else if (!s_TiTools.TryGetValue(t, out tool) || tool == null)
                {
                    tool = ScriptableObject.CreateInstance(t) as EditorTool;
                    if (tool == null) continue;
                    tool.hideFlags = HideFlags.HideAndDontSave;
                    s_TiTools[t] = tool;
                }
                tools.Add(tool);
            }
            if (tools.Count == 0) return false;
            var args = new object[] { content, selected, tools, null };
            var clicked = s_TiToolbarMethod.Invoke(null, args) is bool b && b ? args[3] as EditorTool : null;
            if (clicked != null) ToggleTunerTool(clicked.GetType(), targets);
            return true;
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException && e.InnerException != null ? e.InnerException : e;
            if (TiIsExitGui(inner)) return true;
            var s = s_TiDispatch;
            if (s != null && s.LoggedErrors.Add("toolbar:" + inner.Message)) Debug.LogWarning("[tunerInspector] editor tool toolbar failed: " + inner.Message);
            return false;
        }
    }

    static void TiVectorJson(StringBuilder sb, TiDrawRec d)
    {
        if (d.K == 'c')
        {
            if ((d.Flags & TI_FLAG_CHROME) == 0) sb.Append(",\"bg\":\"").Append(TiHex(d.Bg)).Append('"');
            sb.Append(",\"col\":\"").Append(TiHex(d.Fg)).Append('"');
            if (d.Fill.a > 0.001f) sb.Append(",\"top\":\"").Append(TiHex(d.Fill)).Append('"');
            if (d.Fill2.a > 0.001f) sb.Append(",\"bot\":\"").Append(TiHex(d.Fill2)).Append('"');
            TiPoints(sb, "pts", d.Pts);
            TiPoints(sb, "pts2", d.Pts2);
            return;
        }
        sb.Append(",\"m\":\"").Append(d.Mode).Append('"');
        sb.Append(",\"col\":\"").Append(TiHex(d.Fg)).Append('"');
        if (d.Fill.a > 0.001f) sb.Append(",\"fill\":\"").Append(TiHex(d.Fill)).Append('"');
        if (d.Width > 1.01f) TiNum(sb.Append(",\"lw\":"), d.Width);
        if (d.Dotted) sb.Append(",\"dot\":1");
        TiPoints(sb, "pts", d.Pts);
    }

    static void TiPoints(StringBuilder sb, string key, float[] pts)
    {
        if (pts == null) return;
        sb.Append(",\"").Append(key).Append("\":[");
        for (int i = 0; i < pts.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append(pts[i].ToString("0.###", TiInv));
        }
        sb.Append(']');
    }
}
