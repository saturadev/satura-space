using System;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    struct TunerRectIdentity : IDisposable
    {
        readonly Matrix4x4 m_Matrix;
        readonly bool m_Active;

        public TunerRectIdentity(TiDrawRec d)
        {
            m_Matrix = GUI.matrix;
            m_Active = !m_Matrix.isIdentity;
            if (!m_Active) return;
            GUI.matrix = Matrix4x4.identity;
            if (d == null) return;
            d.HasMx = true;
            d.M00 = m_Matrix.m00;
            d.M01 = m_Matrix.m01;
            d.M10 = m_Matrix.m10;
            d.M11 = m_Matrix.m11;
            d.Tx = m_Matrix.m03;
            d.Ty = m_Matrix.m13;
        }

        public void Dispose()
        {
            if (m_Active) GUI.matrix = m_Matrix;
        }
    }

    static Rect TunerRectBounds(TiDrawRec d)
    {
        if (!d.HasMx) return d.R;
        float x0 = float.MaxValue, y0 = float.MaxValue, x1 = float.MinValue, y1 = float.MinValue;
        for (int i = 0; i < 4; i++)
        {
            float px = (i & 1) == 0 ? d.R.xMin : d.R.xMax;
            float py = (i & 2) == 0 ? d.R.yMin : d.R.yMax;
            float qx = d.M00 * px + d.M01 * py + d.Tx;
            float qy = d.M10 * px + d.M11 * py + d.Ty;
            x0 = Mathf.Min(x0, qx);
            y0 = Mathf.Min(y0, qy);
            x1 = Mathf.Max(x1, qx);
            y1 = Mathf.Max(y1, qy);
        }
        return Rect.MinMaxRect(x0, y0, x1, y1);
    }

    static void TunerRectShiftMatrix(TiDrawRec d, Vector2 o)
    {
        if (!d.HasMx || o == Vector2.zero) return;
        d.Tx += o.x - (d.M00 * o.x + d.M01 * o.y);
        d.Ty += o.y - (d.M10 * o.x + d.M11 * o.y);
    }

    static void TunerRectDrawJson(StringBuilder sb, TiDrawRec d)
    {
        if (d.HasMx)
        {
            TiNum(sb.Append(",\"mx\":["), d.M00);
            TiNum(sb.Append(','), d.M10);
            TiNum(sb.Append(','), d.M01);
            TiNum(sb.Append(','), d.M11);
            TiNum(sb.Append(','), d.Tx);
            TiNum(sb.Append(','), d.Ty).Append(']');
        }
        if (d.Role != null) sb.Append(",\"role\":\"").Append(d.Role).Append('"');
    }

    static Type s_TunerRectLayoutType;
    static FieldInfo s_TunerRectLayoutStyles;
    static bool s_TunerRectLayoutLooked;
    static TiSection s_TunerRectScopeSection;
    static bool s_TunerRectScopeValue;

    static bool TunerRectChromeScope(TiSection sec)
    {
        if (sec == null) return false;
        if (ReferenceEquals(sec, s_TunerRectScopeSection)) return s_TunerRectScopeValue;
        bool v = sec.TypeName == "UnityEditor.LayoutDropdownWindow"
            || (sec.Editor != null && sec.Editor.GetType().FullName == "UnityEditor.RectTransformEditor");
        s_TunerRectScopeSection = sec;
        s_TunerRectScopeValue = v;
        return v;
    }

    static object TunerRectLayoutStyles()
    {
        if (!s_TunerRectLayoutLooked)
        {
            s_TunerRectLayoutLooked = true;
            s_TunerRectLayoutType = typeof(Editor).Assembly.GetType("UnityEditor.LayoutDropdownWindow");
            if (s_TunerRectLayoutType != null) s_TunerRectLayoutStyles = s_TunerRectLayoutType.GetField("s_Styles", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public);
        }
        return s_TunerRectLayoutStyles != null ? s_TunerRectLayoutStyles.GetValue(null) : null;
    }

    static bool TunerRectStyleColor(object styles, string field, Color c)
    {
        var f = styles.GetType().GetField(field, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (f == null || f.FieldType != typeof(Color)) return false;
        var v = (Color)f.GetValue(styles);
        return Mathf.Abs(v.r - c.r) < 0.01f && Mathf.Abs(v.g - c.g) < 0.01f && Mathf.Abs(v.b - c.b) < 0.01f;
    }

    static string TunerRectRole(TiSection sec, Color tint, GUIStyle style, bool plainRect)
    {
        if (!TunerRectChromeScope(sec)) return null;
        var styles = TunerRectLayoutStyles();
        if (styles == null) return null;
        if (plainRect)
        {
            if (TunerRectStyleColor(styles, "tableHeaderColor", tint)) return "band";
            if (TunerRectStyleColor(styles, "tableLineColor", tint)) return "line";
            return null;
        }
        var ff = styles.GetType().GetField("frame", BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
        if (ff == null || !ReferenceEquals(ff.GetValue(styles), style)) return null;
        if (TunerRectStyleColor(styles, "parentColor", tint)) return "parent";
        if (TunerRectStyleColor(styles, "selfColor", tint)) return "self";
        if (tint.r > 0.99f && tint.g > 0.99f && tint.b > 0.99f) return "sel";
        return "frame";
    }
}
