using System;
using System.Collections.Generic;
using System.Globalization;
using System.Text;
using UnityEditor;
using UnityEngine;

public static partial class MCPTestBridge
{
    static readonly Dictionary<Transform, int> _tunerSameName = new Dictionary<Transform, int>();
    static bool _tunerSameNameHooked;

    static int TunerSameNameOrdinal(Transform t)
    {
        if (!_tunerSameNameHooked)
        {
            _tunerSameNameHooked = true;
            EditorApplication.hierarchyChanged += () => _tunerSameName.Clear();
        }
        int k;
        if (_tunerSameName.TryGetValue(t, out k)) return k;
        var counts = new Dictionary<string, int>(StringComparer.Ordinal);
        if (t.parent != null)
        {
            var p = t.parent;
            for (int i = 0; i < p.childCount; i++) TunerCountSameName(p.GetChild(i), counts);
        }
        else if (t.gameObject.scene.IsValid())
        {
            foreach (var r in t.gameObject.scene.GetRootGameObjects()) TunerCountSameName(r.transform, counts);
        }
        return _tunerSameName.TryGetValue(t, out k) ? k : 1;
    }

    static void TunerCountSameName(Transform c, Dictionary<string, int> counts)
    {
        int n;
        counts.TryGetValue(c.name, out n);
        counts[c.name] = ++n;
        _tunerSameName[c] = n;
    }

    static string TunerSeg(Transform t)
    {
        int k = TunerSameNameOrdinal(t);
        return k <= 1 ? t.name : t.name + "[" + k.ToString(CultureInfo.InvariantCulture) + "]";
    }

    internal static string TunerIndexedPath(Transform t)
    {
        var sb = new StringBuilder(TunerSeg(t));
        for (var p = t.parent; p != null; p = p.parent) sb.Insert(0, TunerSeg(p) + "/");
        return sb.ToString();
    }

    static bool TunerSegIs(Transform t, string seg)
    {
        return seg == t.name || TunerMatchHead(t, seg) == "";
    }

    static string TunerMatchHead(Transform t, string rest)
    {
        var n = t.name;
        if (rest == n) return "";
        if (rest.Length <= n.Length || !rest.StartsWith(n, StringComparison.Ordinal)) return null;
        if (rest[n.Length] == '/') return rest.Substring(n.Length + 1);
        if (rest[n.Length] != '[') return null;
        int close = rest.IndexOf(']', n.Length);
        int k;
        if (close <= n.Length + 1 || !int.TryParse(rest.Substring(n.Length + 1, close - n.Length - 1), NumberStyles.None, CultureInfo.InvariantCulture, out k)) return null;
        if (k != TunerSameNameOrdinal(t)) return null;
        if (close == rest.Length - 1) return "";
        return rest[close + 1] == '/' ? rest.Substring(close + 2) : null;
    }
}
