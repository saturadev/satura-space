using System;
using System.Collections;
using System.Globalization;
using System.Reflection;
using System.Text;
using UnityEngine;

namespace SaturaSpace
{

static class SaturaJson
{
    const int MaxDepth = 5;
    const int MaxItems = 200;

    public static string ToJson(object value)
    {
        var sb = new StringBuilder();
        Write(sb, value);
        return sb.ToString();
    }

    public static void Write(StringBuilder sb, object v) => Write(sb, v, 0);

    static void Write(StringBuilder sb, object v, int depth)
    {
        switch (v)
        {
            case null:
                sb.Append("null");
                return;
            case string s:
                Quote(sb, s);
                return;
            case bool b:
                sb.Append(b ? "true" : "false");
                return;
            case char c:
                Quote(sb, c.ToString());
                return;
            case float f:
                Number(sb, f);
                return;
            case double d:
                Number(sb, d);
                return;
            case Enum e:
                Quote(sb, e.ToString());
                return;
            case IConvertible n when IsNumber(v):
                sb.Append(n.ToString(CultureInfo.InvariantCulture));
                return;
            case Vector2 v2:
                Floats(sb, v2.x, v2.y);
                return;
            case Vector3 v3:
                Floats(sb, v3.x, v3.y, v3.z);
                return;
            case Vector4 v4:
                Floats(sb, v4.x, v4.y, v4.z, v4.w);
                return;
            case Quaternion q:
                Floats(sb, q.x, q.y, q.z, q.w);
                return;
            case Color col:
                Floats(sb, col.r, col.g, col.b, col.a);
                return;
            case Vector2Int i2:
                sb.Append('[').Append(i2.x).Append(',').Append(i2.y).Append(']');
                return;
            case Vector3Int i3:
                sb.Append('[').Append(i3.x).Append(',').Append(i3.y).Append(',').Append(i3.z).Append(']');
                return;
            case UnityEngine.Object o:
                WriteUnityObject(sb, o);
                return;
        }
        if (depth >= MaxDepth)
        {
            Quote(sb, v.ToString());
            return;
        }
        if (v is IDictionary dict)
        {
            sb.Append('{');
            int n = 0;
            foreach (DictionaryEntry kv in dict)
            {
                if (n > 0) sb.Append(',');
                if (++n > MaxItems) { sb.Append("\"...\":\"").Append(dict.Count - MaxItems).Append(" more\""); break; }
                Quote(sb, Convert.ToString(kv.Key, CultureInfo.InvariantCulture));
                sb.Append(':');
                Write(sb, kv.Value, depth + 1);
            }
            sb.Append('}');
            return;
        }
        if (v is IEnumerable list)
        {
            sb.Append('[');
            int n = 0;
            foreach (var item in list)
            {
                if (n > 0) sb.Append(',');
                if (++n > MaxItems) { sb.Append("\"...\""); break; }
                Write(sb, item, depth + 1);
            }
            sb.Append(']');
            return;
        }
        WriteFields(sb, v, depth);
    }

    static void WriteFields(StringBuilder sb, object v, int depth)
    {
        var t = v.GetType();
        sb.Append('{');
        int n = 0;
        foreach (var f in t.GetFields(BindingFlags.Public | BindingFlags.Instance))
        {
            object fv;
            try { fv = f.GetValue(v); }
            catch { continue; }
            if (n++ > 0) sb.Append(',');
            Quote(sb, f.Name);
            sb.Append(':');
            Write(sb, fv, depth + 1);
        }
        foreach (var p in t.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (!p.CanRead || p.GetIndexParameters().Length > 0) continue;
            if (p.IsDefined(typeof(ObsoleteAttribute), true)) continue;
            object pv;
            try { pv = p.GetValue(v); }
            catch { continue; }
            if (n++ > 0) sb.Append(',');
            Quote(sb, p.Name);
            sb.Append(':');
            Write(sb, pv, depth + 1);
        }
        sb.Append('}');
    }

    static void WriteUnityObject(StringBuilder sb, UnityEngine.Object o)
    {
        if (o == null)
        {
            sb.Append("null");
            return;
        }
        if (o is GameObject go)
        {
            Quote(sb, PathOf(go.transform));
            return;
        }
        if (o is Component c)
        {
            Quote(sb, PathOf(c.transform) + " (" + c.GetType().Name + ")");
            return;
        }
        Quote(sb, o.name + " (" + o.GetType().Name + ")");
    }

    static string PathOf(Transform t)
    {
        var path = t.name;
        for (var p = t.parent; p != null; p = p.parent) path = p.name + "/" + path;
        return path;
    }

    static bool IsNumber(object v) =>
        v is int || v is long || v is short || v is byte || v is sbyte || v is uint || v is ulong || v is ushort || v is decimal;

    static void Number(StringBuilder sb, double d)
    {
        if (double.IsNaN(d) || double.IsInfinity(d)) Quote(sb, d.ToString(CultureInfo.InvariantCulture));
        else sb.Append(d.ToString("R", CultureInfo.InvariantCulture));
    }

    static void Number(StringBuilder sb, float f)
    {
        if (float.IsNaN(f) || float.IsInfinity(f)) Quote(sb, f.ToString(CultureInfo.InvariantCulture));
        else sb.Append(f.ToString("R", CultureInfo.InvariantCulture));
    }

    static void Floats(StringBuilder sb, params float[] values)
    {
        sb.Append('[');
        for (int i = 0; i < values.Length; i++)
        {
            if (i > 0) sb.Append(',');
            Number(sb, values[i]);
        }
        sb.Append(']');
    }

    static void Quote(StringBuilder sb, string s)
    {
        sb.Append('"');
        foreach (var ch in s)
        {
            switch (ch)
            {
                case '"': sb.Append("\\\""); break;
                case '\\': sb.Append("\\\\"); break;
                case '\n': sb.Append("\\n"); break;
                case '\r': sb.Append("\\r"); break;
                case '\t': sb.Append("\\t"); break;
                default:
                    if (ch < 0x20) sb.Append("\\u").Append(((int)ch).ToString("x4"));
                    else sb.Append(ch);
                    break;
            }
        }
        sb.Append('"');
    }
}
}
