using System.Collections.Generic;
using UnityEngine;

public static class SaturaEngineObjects
{
    static readonly HashSet<GameObject> s_Objects = new HashSet<GameObject>();

    public static void Mark(GameObject go)
    {
        if (go == null) return;
        s_Objects.RemoveWhere(x => x == null);
        s_Objects.Add(go);
    }

    public static bool Contains(GameObject go)
    {
        if (s_Objects.Count == 0 || go == null) return false;
        var root = go.transform.root.gameObject;
        return s_Objects.Contains(root) || s_Objects.Contains(go);
    }
}
