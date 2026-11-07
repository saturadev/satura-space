using System;
using System.Collections.Generic;
using System.Globalization;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    const int TiCurveKeysMax = 64;

    static string TiJsonValue(SerializedProperty p)
    {
        try
        {
            switch (p.propertyType)
            {
                case SerializedPropertyType.Vector2:
                    return TiJsonXyzw(p.vector2Value.x, p.vector2Value.y);
                case SerializedPropertyType.Vector3:
                    return TiJsonXyzw(p.vector3Value.x, p.vector3Value.y, p.vector3Value.z);
                case SerializedPropertyType.Vector4:
                    return TiJsonXyzw(p.vector4Value.x, p.vector4Value.y, p.vector4Value.z, p.vector4Value.w);
                case SerializedPropertyType.Vector2Int:
                    return TiJsonXyzw(p.vector2IntValue.x, p.vector2IntValue.y);
                case SerializedPropertyType.Vector3Int:
                    return TiJsonXyzw(p.vector3IntValue.x, p.vector3IntValue.y, p.vector3IntValue.z);
                case SerializedPropertyType.Quaternion:
                {
                    var e = p.quaternionValue.eulerAngles;
                    return TiJsonXyzw(Wrap180(e.x), Wrap180(e.y), Wrap180(e.z));
                }
                case SerializedPropertyType.Color:
                    return TiJsonColor(p.colorValue);
                case SerializedPropertyType.Rect:
                {
                    var r = p.rectValue;
                    return TiJsonObj("x", r.x, "y", r.y, "width", r.width, "height", r.height);
                }
                case SerializedPropertyType.RectInt:
                {
                    var r = p.rectIntValue;
                    return TiJsonObj("x", r.x, "y", r.y, "width", r.width, "height", r.height);
                }
                case SerializedPropertyType.Bounds:
                {
                    var b = p.boundsValue;
                    return "{\"center\":" + TiJsonXyzw(b.center.x, b.center.y, b.center.z) + ",\"extent\":" + TiJsonXyzw(b.extents.x, b.extents.y, b.extents.z) + "}";
                }
                case SerializedPropertyType.BoundsInt:
                {
                    var b = p.boundsIntValue;
                    return "{\"position\":" + TiJsonXyzw(b.position.x, b.position.y, b.position.z) + ",\"size\":" + TiJsonXyzw(b.size.x, b.size.y, b.size.z) + "}";
                }
                case SerializedPropertyType.AnimationCurve:
                    return TiJsonCurve(p.animationCurveValue);
                case SerializedPropertyType.ObjectReference:
                {
                    var o = p.objectReferenceValue;
                    if (o == null) return "null";
                    var sb = new StringBuilder();
                    return TiStr(sb, string.IsNullOrEmpty(o.name) ? "unnamed " + ObjectNames.NicifyVariableName(o.GetType().Name) : o.name).ToString();
                }
                case SerializedPropertyType.Generic:
                {
                    var curve = TiTextureCurve(p);
                    if (curve != null) return TiJsonCurve(curve.animationCurveValue);
                    return p.isArray ? null : TiJsonStruct(p, 0);
                }
            }
        }
        catch
        {
        }
        return null;
    }

    const int TiStructFieldsMax = 24;
    const int TiStructDepthMax = 3;
    const int TiStructArrayMax = 16;
    const int TiStructJsonMax = 4000;

    static string TiStructKey(string name)
    {
        if (name.StartsWith("<", StringComparison.Ordinal) && name.EndsWith(">k__BackingField", StringComparison.Ordinal)) return name.Substring(1, name.Length - 17);
        if (name.Length > 2 && name.StartsWith("m_", StringComparison.Ordinal)) return char.ToLowerInvariant(name[2]) + name.Substring(3);
        return name;
    }

    static string TiStructNorm(string s)
    {
        s = s ?? "";
        if (s.StartsWith("m_", StringComparison.Ordinal)) s = s.Substring(2);
        var sb = new StringBuilder(s.Length);
        foreach (var ch in s)
            if (char.IsLetterOrDigit(ch)) sb.Append(char.ToLowerInvariant(ch));
        return sb.ToString();
    }

    static string TiJsonStruct(SerializedProperty p, int depth)
    {
        if (depth > TiStructDepthMax || TiEventValue(p) != null || TiMinMaxValue(p) != null) return null;
        var it = p.Copy();
        var end = p.GetEndProperty();
        if (!it.NextVisible(true) || SerializedProperty.EqualContents(it, end)) return null;
        var sb = new StringBuilder("{");
        int n = 0;
        do
        {
            if (n >= TiStructFieldsMax) return null;
            var v = TiJsonLeaf(it, depth + 1);
            if (v == null) continue;
            if (n++ > 0) sb.Append(',');
            TiStr(sb, TiStructKey(it.name)).Append(':').Append(v);
        }
        while (it.NextVisible(false) && !SerializedProperty.EqualContents(it, end));
        sb.Append('}');
        return n == 0 || sb.Length > TiStructJsonMax ? null : sb.ToString();
    }

    static string TiJsonLeaf(SerializedProperty c, int depth)
    {
        switch (c.propertyType)
        {
            case SerializedPropertyType.String:
                return JStr(c.stringValue ?? "");
            case SerializedPropertyType.Float:
                return TiJsonNum(c.doubleValue);
            case SerializedPropertyType.Boolean:
                return c.boolValue ? "true" : "false";
            case SerializedPropertyType.Integer:
            {
                var named = TiFlagsValue(c) ?? TiNativeEnum(c);
                return named != null ? JStr(named) : c.longValue.ToString(TiInv);
            }
            case SerializedPropertyType.Enum:
            {
                int i = c.enumValueIndex;
                var names = c.enumDisplayNames;
                return JStr(i >= 0 && i < names.Length ? names[i] : TiLeafValue(c) ?? "");
            }
            case SerializedPropertyType.Generic:
            {
                var mm = TiMinMaxValue(c);
                if (mm != null)
                {
                    double d;
                    return double.TryParse(mm, NumberStyles.Float, TiInv, out d) ? TiJsonNum(d) : JStr(mm);
                }
                if (c.isArray)
                {
                    if (c.arraySize > TiStructArrayMax || depth > TiStructDepthMax) return JStr(TiLeafValue(c) ?? "");
                    var sb = new StringBuilder("[");
                    for (int i = 0; i < c.arraySize; i++)
                    {
                        if (i > 0) sb.Append(',');
                        sb.Append(TiJsonLeaf(c.GetArrayElementAtIndex(i), depth + 1) ?? "null");
                    }
                    return sb.Append(']').ToString();
                }
                var curve = TiTextureCurve(c);
                if (curve != null) return TiJsonCurve(curve.animationCurveValue);
                return TiJsonStruct(c, depth) ?? JStr(TiLeafValue(c) ?? "");
            }
        }
        var v = TiJsonValue(c);
        if (v != null) return v;
        var text = TiLeafValue(c);
        return text == null ? null : JStr(text);
    }

    static object TiJsonParse(string s)
    {
        int i = 0;
        var v = TiJsonRead(s, ref i);
        TiJsonSkip(s, ref i);
        if (i != s.Length) throw new FormatException("unexpected text after the value at " + i.ToString(TiInv));
        return v;
    }

    static void TiJsonSkip(string s, ref int i)
    {
        while (i < s.Length && char.IsWhiteSpace(s[i])) i++;
    }

    static object TiJsonRead(string s, ref int i)
    {
        TiJsonSkip(s, ref i);
        if (i >= s.Length) throw new FormatException("the value ends early");
        char ch = s[i];
        if (ch == '{')
        {
            var d = new Dictionary<string, object>();
            i++;
            TiJsonSkip(s, ref i);
            if (i < s.Length && s[i] == '}') { i++; return d; }
            while (true)
            {
                TiJsonSkip(s, ref i);
                var key = TiJsonRead(s, ref i) as string;
                if (key == null) throw new FormatException("an object key must be a string");
                TiJsonSkip(s, ref i);
                if (i >= s.Length || s[i] != ':') throw new FormatException("expected ':' after \"" + key + "\"");
                i++;
                d[key] = TiJsonRead(s, ref i);
                TiJsonSkip(s, ref i);
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == '}') { i++; return d; }
                throw new FormatException("expected ',' or '}' in an object");
            }
        }
        if (ch == '[')
        {
            var l = new List<object>();
            i++;
            TiJsonSkip(s, ref i);
            if (i < s.Length && s[i] == ']') { i++; return l; }
            while (true)
            {
                l.Add(TiJsonRead(s, ref i));
                TiJsonSkip(s, ref i);
                if (i < s.Length && s[i] == ',') { i++; continue; }
                if (i < s.Length && s[i] == ']') { i++; return l; }
                throw new FormatException("expected ',' or ']' in a list");
            }
        }
        if (ch == '"')
        {
            var sb = new StringBuilder();
            i++;
            while (i < s.Length && s[i] != '"')
            {
                if (s[i] == '\\' && i + 1 < s.Length)
                {
                    i++;
                    switch (s[i])
                    {
                        case 'n': sb.Append('\n'); break;
                        case 't': sb.Append('\t'); break;
                        case 'r': sb.Append('\r'); break;
                        case 'b': sb.Append('\b'); break;
                        case 'f': sb.Append('\f'); break;
                        case 'u':
                            if (i + 4 >= s.Length) throw new FormatException("bad \\u escape");
                            sb.Append((char)int.Parse(s.Substring(i + 1, 4), NumberStyles.HexNumber, TiInv));
                            i += 4;
                            break;
                        default: sb.Append(s[i]); break;
                    }
                }
                else sb.Append(s[i]);
                i++;
            }
            if (i >= s.Length) throw new FormatException("a string is not closed");
            i++;
            return sb.ToString();
        }
        if (string.CompareOrdinal(s, i, "true", 0, 4) == 0) { i += 4; return true; }
        if (string.CompareOrdinal(s, i, "false", 0, 5) == 0) { i += 5; return false; }
        if (string.CompareOrdinal(s, i, "null", 0, 4) == 0) { i += 4; return null; }
        int start = i;
        while (i < s.Length && "+-0123456789.eE".IndexOf(s[i]) >= 0) i++;
        double num;
        if (i == start || !double.TryParse(s.Substring(start, i - start), NumberStyles.Float, TiInv, out num)) throw new FormatException("unexpected '" + ch + "'");
        return num;
    }

    static List<SerializedProperty> TiStructChildren(SerializedProperty p)
    {
        var list = new List<SerializedProperty>();
        var it = p.Copy();
        var end = p.GetEndProperty();
        if (!it.NextVisible(true) || SerializedProperty.EqualContents(it, end)) return list;
        do list.Add(it.Copy());
        while (it.NextVisible(false) && !SerializedProperty.EqualContents(it, end));
        return list;
    }

    static string TiApplyStruct(SerializedProperty p, Dictionary<string, object> obj, string where)
    {
        var kids = TiStructChildren(p);
        foreach (var kv in obj)
        {
            SerializedProperty hit = null;
            foreach (var c in kids)
                if (c.name == kv.Key || TiStructKey(c.name) == kv.Key) { hit = c; break; }
            if (hit == null)
            {
                var want = TiStructNorm(kv.Key);
                foreach (var c in kids)
                    if (TiStructNorm(c.name) == want || TiStructNorm(c.displayName) == want) { hit = c; break; }
            }
            if (hit == null)
            {
                var names = new List<string>();
                foreach (var c in kids) names.Add(TiStructKey(c.name));
                return where + " has no field '" + kv.Key + "'. Its fields are " + string.Join(", ", names) + ".";
            }
            var err = TiApplyJson(hit, kv.Value, where + "." + TiStructKey(hit.name));
            if (err != null) return err;
        }
        return null;
    }

    static bool TiJsonNumber(object v, out double d)
    {
        d = 0;
        if (v is double) { d = (double)v; return true; }
        var s = v as string;
        return s != null && double.TryParse(s.Trim(), NumberStyles.Float, TiInv, out d);
    }

    static string TiJsonFloats(object v, string[] keys, double[] cur, string[] alias, out double[] got)
    {
        got = (double[])cur.Clone();
        var list = v as List<object>;
        if (list != null)
        {
            if (list.Count != keys.Length) return "pass " + keys.Length.ToString(TiInv) + " numbers";
            for (int i = 0; i < keys.Length; i++)
                if (!TiJsonNumber(list[i], out got[i])) return "pass numbers";
            return null;
        }
        var d = v as Dictionary<string, object>;
        if (d == null) return "pass { " + string.Join(", ", keys) + " }";
        foreach (var kv in d)
        {
            int at = Array.IndexOf(keys, kv.Key);
            if (at < 0 && alias != null) at = Array.IndexOf(alias, kv.Key);
            if (at < 0) return "it has no '" + kv.Key + "', only " + string.Join(", ", keys);
            if (!TiJsonNumber(kv.Value, out got[at])) return kv.Key + " must be a number";
        }
        return null;
    }

    static string TiApplyJson(SerializedProperty c, object v, string where)
    {
        string err = null;
        double[] f;
        switch (c.propertyType)
        {
            case SerializedPropertyType.Float:
            case SerializedPropertyType.Integer:
            {
                double d;
                if (!TiJsonNumber(v, out d)) return where + " is a number: pass one, like 2";
                if (c.propertyType == SerializedPropertyType.Float) c.doubleValue = d;
                else c.longValue = (long)Math.Round(d);
                return null;
            }
            case SerializedPropertyType.Boolean:
                if (!(v is bool)) return where + " is a checkbox: pass true or false";
                c.boolValue = (bool)v;
                return null;
            case SerializedPropertyType.String:
                if (v != null && !(v is string) && !(v is double) && !(v is bool)) return where + " is text: pass a string";
                c.stringValue = v == null ? "" : v is double ? ((double)v).ToString(TiInv) : v is bool ? ((bool)v ? "true" : "false") : (string)v;
                return null;
            case SerializedPropertyType.Enum:
            {
                var names = c.enumDisplayNames;
                double d;
                if (v is double && TiJsonNumber(v, out d) && d >= 0 && d < names.Length) { c.enumValueIndex = (int)d; return null; }
                var s = v as string;
                if (s != null)
                {
                    var raw = c.enumNames;
                    for (int i = 0; i < names.Length; i++)
                        if (TiStructNorm(names[i]) == TiStructNorm(s) || (i < raw.Length && TiStructNorm(raw[i]) == TiStructNorm(s))) { c.enumValueIndex = i; return null; }
                }
                return where + " is a dropdown: pass one of " + string.Join(", ", names);
            }
            case SerializedPropertyType.Color:
            {
                var s = v as string;
                if (s != null)
                {
                    Color col;
                    if (!ColorUtility.TryParseHtmlString(s.Trim().StartsWith("#", StringComparison.Ordinal) ? s.Trim() : "#" + s.Trim(), out col)) return where + " is a color: pass '#FF8800' or { r, g, b, a }";
                    c.colorValue = col;
                    return null;
                }
                var k = c.colorValue;
                err = TiJsonFloats(v, new[] { "r", "g", "b", "a" }, new double[] { k.r, k.g, k.b, k.a }, null, out f);
                if (err != null) return where + " is a color: " + err;
                c.colorValue = new Color((float)f[0], (float)f[1], (float)f[2], (float)f[3]);
                return null;
            }
            case SerializedPropertyType.Vector2:
                err = TiJsonFloats(v, new[] { "x", "y" }, new double[] { c.vector2Value.x, c.vector2Value.y }, null, out f);
                if (err == null) c.vector2Value = new Vector2((float)f[0], (float)f[1]);
                break;
            case SerializedPropertyType.Vector3:
                err = TiJsonFloats(v, new[] { "x", "y", "z" }, new double[] { c.vector3Value.x, c.vector3Value.y, c.vector3Value.z }, null, out f);
                if (err == null) c.vector3Value = new Vector3((float)f[0], (float)f[1], (float)f[2]);
                break;
            case SerializedPropertyType.Vector4:
            {
                var q = c.vector4Value;
                err = TiJsonFloats(v, new[] { "x", "y", "z", "w" }, new double[] { q.x, q.y, q.z, q.w }, new[] { "r", "g", "b", "offset" }, out f);
                if (err == null) c.vector4Value = new Vector4((float)f[0], (float)f[1], (float)f[2], (float)f[3]);
                break;
            }
            case SerializedPropertyType.Vector2Int:
                err = TiJsonFloats(v, new[] { "x", "y" }, new double[] { c.vector2IntValue.x, c.vector2IntValue.y }, null, out f);
                if (err == null) c.vector2IntValue = new Vector2Int((int)Math.Round(f[0]), (int)Math.Round(f[1]));
                break;
            case SerializedPropertyType.Vector3Int:
                err = TiJsonFloats(v, new[] { "x", "y", "z" }, new double[] { c.vector3IntValue.x, c.vector3IntValue.y, c.vector3IntValue.z }, null, out f);
                if (err == null) c.vector3IntValue = new Vector3Int((int)Math.Round(f[0]), (int)Math.Round(f[1]), (int)Math.Round(f[2]));
                break;
            case SerializedPropertyType.Quaternion:
            {
                var e = c.quaternionValue.eulerAngles;
                err = TiJsonFloats(v, new[] { "x", "y", "z" }, new double[] { Wrap180(e.x), Wrap180(e.y), Wrap180(e.z) }, null, out f);
                if (err == null) c.quaternionValue = Quaternion.Euler((float)f[0], (float)f[1], (float)f[2]);
                break;
            }
            case SerializedPropertyType.Rect:
            {
                var r = c.rectValue;
                err = TiJsonFloats(v, new[] { "x", "y", "width", "height" }, new double[] { r.x, r.y, r.width, r.height }, null, out f);
                if (err == null) c.rectValue = new Rect((float)f[0], (float)f[1], (float)f[2], (float)f[3]);
                break;
            }
            case SerializedPropertyType.Bounds:
            {
                var b = c.boundsValue;
                var d = v as Dictionary<string, object>;
                if (d == null) return where + " is bounds: pass { center: { x, y, z }, extent: { x, y, z } }";
                double[] ce = { b.center.x, b.center.y, b.center.z }, ex = { b.extents.x, b.extents.y, b.extents.z };
                object o;
                if (d.TryGetValue("center", out o)) err = TiJsonFloats(o, new[] { "x", "y", "z" }, ce, null, out ce);
                if (err == null && d.TryGetValue("extent", out o)) err = TiJsonFloats(o, new[] { "x", "y", "z" }, ex, null, out ex);
                if (err == null) c.boundsValue = new Bounds(new Vector3((float)ce[0], (float)ce[1], (float)ce[2]), new Vector3((float)ex[0], (float)ex[1], (float)ex[2]) * 2f);
                break;
            }
            case SerializedPropertyType.AnimationCurve:
                return TiApplyJsonCurve(c, c, v, where);
            case SerializedPropertyType.ObjectReference:
                if (v == null) { c.objectReferenceValue = null; return null; }
                return where + " is an object reference: set it on its own, like tuner.field('" + c.displayName + "').set('Assets/Path.mat'), or pass null to clear it";
            case SerializedPropertyType.Generic:
            {
                var curve = TiTextureCurve(c);
                if (curve != null) return TiApplyJsonCurve(c, curve, v, where);
                if (c.isArray)
                {
                    var list = v as List<object>;
                    if (list == null) return where + " is a list: pass an array";
                    c.arraySize = list.Count;
                    for (int i = 0; i < list.Count; i++)
                    {
                        var e2 = TiApplyJson(c.GetArrayElementAtIndex(i), list[i], where + "[" + i.ToString(TiInv) + "]");
                        if (e2 != null) return e2;
                    }
                    return null;
                }
                var obj = v as Dictionary<string, object>;
                if (obj == null)
                {
                    var keys = new List<string>();
                    foreach (var k in TiStructChildren(c)) keys.Add(TiStructKey(k.name));
                    return where + " is a group of fields: pass an object with the ones to change, like { " + (keys.Count > 0 ? keys[0] : "name") + ": ... }";
                }
                return TiApplyStruct(c, obj, where);
            }
            default:
                return where + " is a " + ObjectNames.NicifyVariableName(c.propertyType.ToString()).ToLowerInvariant() + " the Tuner can't set inside a group. Set it on its own with tuner.field('" + c.displayName + "').set(v)";
        }
        return err == null ? null : where + " is a " + ObjectNames.NicifyVariableName(c.propertyType.ToString()).ToLowerInvariant() + ": " + err;
    }

    static string TiApplyJsonCurve(SerializedProperty owner, SerializedProperty curve, object v, string where)
    {
        var list = v as List<object>;
        var how = where + " is a curve: pass its keys, like [{ time: 0, value: 0 }, { time: 1, value: 1 }]";
        if (list == null) return how;
        var parts = new List<string>();
        foreach (var k in list)
        {
            double t, val, a, b;
            object ia = null, ob = null;
            var kl = k as List<object>;
            var kd = k as Dictionary<string, object>;
            if (kl != null && kl.Count >= 2 && TiJsonNumber(kl[0], out t) && TiJsonNumber(kl[1], out val))
            {
                if (kl.Count > 2) ia = kl[2];
                if (kl.Count > 3) ob = kl[3];
            }
            else if (kd != null && kd.ContainsKey("time") && kd.ContainsKey("value") && TiJsonNumber(kd["time"], out t) && TiJsonNumber(kd["value"], out val))
            {
                kd.TryGetValue("inTangent", out ia);
                kd.TryGetValue("outTangent", out ob);
            }
            else return how;
            if (ia == null && ob == null) { parts.Add(RawFloats((float)t, (float)val).Replace(',', ':') + ":auto:auto"); continue; }
            if (!TiJsonNumber(ia ?? ob, out a) || !TiJsonNumber(ob ?? ia, out b)) return how;
            parts.Add(RawFloats((float)t, (float)val, (float)a, (float)b).Replace(',', ':'));
        }
        var c = TiCurveFromRaw(string.Join(";", parts));
        curve.animationCurveValue = c;
        if (curve != owner)
        {
            var len = owner.FindPropertyRelative("<length>k__BackingField");
            if (len != null) len.intValue = c.length;
        }
        return null;
    }

    static SerializedProperty TiTextureCurve(SerializedProperty p)
    {
        if (p == null || p.propertyType != SerializedPropertyType.Generic || p.isArray) return null;
        var c = p.FindPropertyRelative("m_Curve");
        return c != null && c.propertyType == SerializedPropertyType.AnimationCurve && p.FindPropertyRelative("m_ZeroValue") != null ? c : null;
    }

    static string TiJsonNum(double v)
    {
        if (double.IsInfinity(v)) return v > 0 ? "\"Infinity\"" : "\"-Infinity\"";
        return double.IsNaN(v) ? "0" : TunerRound(v, 1000);
    }

    static string TiJsonXyzw(params double[] v)
    {
        var names = new[] { "x", "y", "z", "w" };
        var sb = new StringBuilder("{");
        for (int i = 0; i < v.Length; i++)
        {
            if (i > 0) sb.Append(',');
            sb.Append('"').Append(names[i]).Append("\":").Append(TiJsonNum(v[i]));
        }
        return sb.Append('}').ToString();
    }

    static string TiJsonObj(params object[] kv)
    {
        var sb = new StringBuilder("{");
        for (int i = 0; i + 1 < kv.Length; i += 2)
        {
            if (i > 0) sb.Append(',');
            sb.Append('"').Append((string)kv[i]).Append("\":").Append(TiJsonNum(Convert.ToDouble(kv[i + 1], TiInv)));
        }
        return sb.Append('}').ToString();
    }

    static string TiJsonColor(Color c)
    {
        if (c.r > 1.001f || c.g > 1.001f || c.b > 1.001f)
            return TiJsonObj("r", c.r, "g", c.g, "b", c.b, "a", c.a);
        Func<float, string> hex = v => Mathf.RoundToInt(Mathf.Clamp01(v) * 255f).ToString("X2", TiInv);
        var s = "#" + hex(c.r) + hex(c.g) + hex(c.b) + (c.a < 0.998f ? hex(c.a) : "");
        return "\"" + s + "\"";
    }

    static string TiJsonCurve(AnimationCurve c)
    {
        var keys = c == null ? new Keyframe[0] : c.keys;
        var sb = new StringBuilder("[");
        for (int i = 0; i < keys.Length && i < TiCurveKeysMax; i++)
        {
            var k = keys[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"time\":").Append(TiCurveNum(k.time))
              .Append(",\"value\":").Append(TiCurveNum(k.value))
              .Append(",\"inTangent\":").Append(TiCurveNum(k.inTangent))
              .Append(",\"outTangent\":").Append(TiCurveNum(k.outTangent)).Append('}');
        }
        return sb.Append(']').ToString();
    }

    static string TiCurveNum(float v)
    {
        if (float.IsInfinity(v)) return v > 0 ? "\"Infinity\"" : "\"-Infinity\"";
        if (float.IsNaN(v)) return "0";
        return TunerRound(v, 10000);
    }

    static string TiCurveRaw(AnimationCurve c)
    {
        if (c == null) return "";
        var keys = c.keys;
        var parts = new string[keys.Length];
        for (int i = 0; i < keys.Length; i++)
            parts[i] = RawFloats(keys[i].time, keys[i].value, keys[i].inTangent, keys[i].outTangent).Replace(',', ':');
        return string.Join(";", parts);
    }

    static AnimationCurve TiCurveFromRaw(string raw)
    {
        var c = new AnimationCurve();
        if (string.IsNullOrEmpty(raw)) return c;
        var list = new List<Keyframe>();
        var auto = new HashSet<float>();
        foreach (var part in raw.Split(';'))
        {
            var f = part.Split(':');
            if (f.Length != 4) throw new FormatException("a curve key needs time:value:inTangent:outTangent");
            float t = float.Parse(f[0], NumberStyles.Float, Inv);
            float v = float.Parse(f[1], NumberStyles.Float, Inv);
            bool smooth = f[2] == "auto" || f[3] == "auto";
            float a = smooth ? 0f : float.Parse(f[2], NumberStyles.Float, Inv);
            float b = smooth ? 0f : float.Parse(f[3], NumberStyles.Float, Inv);
            if (smooth) auto.Add(t);
            list.Add(new Keyframe(t, v, a, b));
        }
        list.Sort((x, y) => x.time.CompareTo(y.time));
        c.keys = list.ToArray();
        for (int i = 0; i < c.length; i++)
            if (auto.Contains(c.keys[i].time))
            {
                AnimationUtility.SetKeyLeftTangentMode(c, i, AnimationUtility.TangentMode.ClampedAuto);
                AnimationUtility.SetKeyRightTangentMode(c, i, AnimationUtility.TangentMode.ClampedAuto);
            }
        return c;
    }

    static string TiCurveDisplay(string raw)
    {
        if (string.IsNullOrEmpty(raw)) return "curve with no keys";
        var keys = raw.Split(';');
        if (keys.Length > 6) return "curve with " + keys.Length.ToString(Inv) + " keys";
        var parts = new List<string>();
        foreach (var k in keys)
        {
            var f = k.Split(':');
            if (f.Length < 2) return "curve with " + keys.Length.ToString(Inv) + " keys";
            parts.Add("(" + TunerRound(double.Parse(f[0], NumberStyles.Float, Inv), 1000) + ", " + TunerRound(double.Parse(f[1], NumberStyles.Float, Inv), 1000) + ")");
        }
        return "curve " + string.Join(" ", parts);
    }

    static string TiSetFieldValue(TiSession s, string section, string path, string value)
    {
        if (string.IsNullOrEmpty(path)) return "no field path";
        TiSection sec = null;
        foreach (var x in s.Sections)
            if (x.Kind == "component" && x.Key == section && x.Target != null) { sec = x; break; }
        if (sec == null) return "the inspector has no " + section + " section";
        UnityEngine.Object target = sec.Target;
        var prop = path;
        var cut = path.IndexOf('/');
        if (cut > 0)
        {
            var owner = path.Substring(0, cut);
            prop = path.Substring(cut + 1);
            target = null;
            var c = sec.Target as Component;
            if (c != null)
                foreach (var part in TunerProfileParts(c))
                    if (ObjectNames.NicifyVariableName(part.GetType().Name) == owner) { target = part; break; }
            if (target == null) return "the Volume profile has no " + owner + " override";
        }
        using (var so = new SerializedObject(target))
        {
            so.UpdateIfRequiredOrScript();
            var p = so.FindProperty(prop);
            if (p == null) return "no field " + prop;
            Undo.IncrementCurrentGroup();
            Undo.SetCurrentGroupName("Tuner set " + p.displayName);
            var curve = p.propertyType == SerializedPropertyType.AnimationCurve ? p : TiTextureCurve(p);
            if (p.propertyType == SerializedPropertyType.Generic && curve == null)
            {
                if (p.isArray) return p.displayName + " is a list: set its size with '" + p.displayName + ".Array.size' and its elements one by one";
                object parsed;
                try { parsed = TiJsonParse(value ?? ""); }
                catch (FormatException e) { return p.displayName + " got a value that isn't valid JSON: " + e.Message; }
                var err = TiApplyJson(p, parsed, p.displayName);
                if (err != null) return err;
            }
            else if (curve != null)
            {
                var c = TiCurveFromRaw(value);
                curve.animationCurveValue = c;
                if (curve != p)
                {
                    var len = p.FindPropertyRelative("<length>k__BackingField");
                    if (len != null) len.intValue = c.length;
                }
            }
            else
            {
                string err;
                if (p.propertyType == SerializedPropertyType.Quaternion)
                {
                    var e = Floats(value, 3);
                    p.quaternionValue = Quaternion.Euler(e[0], e[1], e[2]);
                    err = null;
                }
                else if (p.propertyType == SerializedPropertyType.ObjectReference) err = "set an object reference through its field";
                else err = SetTunerRaw(p, value);
                if (err != null) return err;
            }
            if (prop.EndsWith(".m_Value", StringComparison.Ordinal))
            {
                var over = so.FindProperty(prop.Substring(0, prop.Length - 8) + ".m_OverrideState");
                if (over != null && over.propertyType == SerializedPropertyType.Boolean) over.boolValue = true;
            }
            so.ApplyModifiedProperties();
            if (curve != null && curve != p) TiDirtyTextureCurve(target, prop);
            EditorUtility.SetDirty(target);
            Undo.IncrementCurrentGroup();
        }
        return null;
    }

    static string TiUndoGroup(string op, string value)
    {
        if (op == "mark")
        {
            Undo.IncrementCurrentGroup();
            return "\"group\":" + Undo.GetCurrentGroup().ToString(TiInv);
        }
        int g;
        if (op != "collapse" || !int.TryParse(value, NumberStyles.Integer, TiInv, out g)) return null;
        Undo.CollapseUndoOperations(g);
        Undo.IncrementCurrentGroup();
        return "\"group\":" + g.ToString(TiInv);
    }

    static void TiDirtyTextureCurve(UnityEngine.Object target, string prop)
    {
        try
        {
            object obj = target;
            foreach (var seg in prop.Split('.'))
            {
                if (obj == null) return;
                var t = obj.GetType();
                var name = seg == "m_Value" ? "value" : seg;
                FieldInfo fi = null;
                for (var tt = t; tt != null && fi == null; tt = tt.BaseType)
                    fi = tt.GetField(seg, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                if (fi != null) { obj = fi.GetValue(obj); continue; }
                var pi = t.GetProperty(name, BindingFlags.Instance | BindingFlags.Public | BindingFlags.NonPublic);
                obj = pi != null && pi.GetIndexParameters().Length == 0 ? pi.GetValue(obj) : null;
            }
            var dirty = obj == null ? null : obj.GetType().GetMethod("SetDirty", BindingFlags.Instance | BindingFlags.Public, null, Type.EmptyTypes, null);
            if (dirty != null) dirty.Invoke(obj, null);
        }
        catch
        {
        }
    }

    static string TiEditLabel(SerializedObject so, string field)
    {
        var path = field;
        var suffix = "";
        var value = path.IndexOf(".m_Value", StringComparison.Ordinal);
        if (value > 0 && (path.Length == value + 8 || path[value + 8] == '.')) path = path.Substring(0, value);
        else if (path.EndsWith(".m_OverrideState", StringComparison.Ordinal))
        {
            path = path.Substring(0, path.Length - 16);
            suffix = " override";
        }
        var p = so.FindProperty(path);
        var label = p != null ? p.displayName : ObjectNames.NicifyVariableName(path);
        return label + suffix;
    }
}
