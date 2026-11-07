using System;
using System.Collections.Generic;
using System.Text;
using System.Text.RegularExpressions;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

public static partial class MCPTestBridge
{
    const int TUNER_MAX_EDIT_OBJECTS = 256;
    const int TUNER_MAX_EDIT_ROWS = 500;
    const double TUNER_EDIT_DIFF_INTERVAL = 0.25;

    class TunerEditBase
    {
        public GameObject Go;
        public string Path;
        public string Key;
        public UnityEngine.Object Target;
        public Dictionary<string, string> Base;
        public bool Dirty;
        public readonly List<TunerEditRow> Rows = new List<TunerEditRow>();
    }

    class TunerEditRow
    {
        public string Kind = TUNER_EDIT_FIELD;
        public string Path;
        public string Component;
        public string Field;
        public string Before;
        public string After;
        public bool Saved;
        public string Label;
        public string Type;
        public string Asset;
    }

    const string TUNER_EDIT_FIELD = "field";
    const int TUNER_MAX_STRUCT_OBJECTS = 60000;
    const double TUNER_STRUCT_DIFF_INTERVAL = 0.5;
    static readonly Regex TunerCopySuffix = new Regex(@"\s*\(\d+\)$");

    class TunerStructObj
    {
        public string Path;
        public string Name;
        public GameObject Parent;
        public Component[] Comps;
        public string Sig;
        public string Prefab;
    }

    class TunerStructScene
    {
        public string Path;
        public Scene Scene;
        public Dictionary<GameObject, TunerStructObj> Objs;
        public List<GameObject> Order;
        public readonly Dictionary<GameObject, TunerStructObj> CopyOf = new Dictionary<GameObject, TunerStructObj>();
        public readonly List<TunerEditRow> Rows = new List<TunerEditRow>();
    }

    class TunerEditTrail
    {
        public readonly List<TunerStructScene> Scenes = new List<TunerStructScene>();
        public readonly List<TunerEditRow> Saved = new List<TunerEditRow>();
        public int Gen = -1;
        public double NextDiff;
        public bool Dirty = true;
    }

    [InitializeOnLoadMethod]
    static void InitTunerEditTrail()
    {
        if (Inert) return;
        EditorSceneManager.sceneSaved += OnTunerEditSceneSaved;
    }

    static void OnTunerEditSceneSaved(Scene sc)
    {
        if (EditorApplication.isPlaying) return;
        foreach (var s in _tuners.Values) CommitTunerEdits(s, sc);
    }

    static void BaseTunerEdits(TunerSession s, string id)
    {
        if (EditorApplication.isPlaying || string.IsNullOrEmpty(id) || s.EditObjects.Count >= TUNER_MAX_EDIT_OBJECTS) return;
        var go = TunerEntryObject(s, id);
        if (go == null || EditorUtility.IsPersistent(go) || !s.EditObjects.Add(go)) return;
        var path = TunerEntryPath(s, id);
        if (string.IsNullOrEmpty(path)) path = go.name;
        AddTunerEditBase(s, go, path, TUNER_GO_KEY, go);
        foreach (var kv in TunerComponentKeys(go))
        {
            AddTunerEditBase(s, go, path, kv.Key, kv.Value);
            foreach (var part in TunerProfileParts(kv.Value)) AddTunerEditBase(s, go, path, kv.Key + "/" + ObjectNames.NicifyVariableName(part.GetType().Name), part);
        }
    }

    static List<UnityEngine.Object> TunerProfileParts(Component c)
    {
        var list = new List<UnityEngine.Object>();
        try
        {
            using (var so = new SerializedObject(c))
            {
                var profile = so.FindProperty("sharedProfile");
                if (profile == null || profile.propertyType != SerializedPropertyType.ObjectReference || profile.objectReferenceValue == null) return list;
                using (var pso = new SerializedObject(profile.objectReferenceValue))
                {
                    var comps = pso.FindProperty("components");
                    for (int i = 0; comps != null && comps.isArray && i < comps.arraySize && i < 64; i++)
                    {
                        var o = comps.GetArrayElementAtIndex(i).objectReferenceValue;
                        if (o != null) list.Add(o);
                    }
                }
            }
        }
        catch
        {
        }
        return list;
    }

    static void CarryTunerEdits(TunerSession from, TunerSession to)
    {
        if (from == null) return;
        to.Trail = from.Trail;
        to.Trail.Dirty = true;
        to.EditsDirty = true;
        if (from.EditBases.Count == 0) return;
        foreach (var b in from.EditBases)
        {
            if (b.Target == null || b.Go == null) continue;
            b.Dirty = true;
            to.EditBases.Add(b);
            to.EditObjects.Add(b.Go);
        }
    }

    static void AddTunerEditBase(TunerSession s, GameObject go, string path, string key, UnityEngine.Object target)
    {
        if (target == null) return;
        var b = new TunerEditBase { Go = go, Path = path, Key = key, Target = target, Base = new Dictionary<string, string>() };
        SyncTunerRect(target);
        SnapshotTunerValues(target, b.Base);
        s.EditBases.Add(b);
    }

    static void NoteTunerEditTarget(TunerSession s, UnityEngine.Object target)
    {
        foreach (var b in s.EditBases)
        {
            if (b.Target != target) continue;
            b.Dirty = true;
            s.EditsDirty = true;
        }
    }

#if UNITY_6000_5_OR_NEWER
    static void NoteTunerEditId(TunerSession s, EntityId id)
#else
    static void NoteTunerEditId(TunerSession s, int id)
#endif
    {
        foreach (var b in s.EditBases)
        {
            if (b.Target == null) continue;
#if UNITY_6000_5_OR_NEWER
            if (b.Target.GetEntityId() != id) continue;
#else
            if (b.Target.GetHashCode() != id) continue;
#endif
            b.Dirty = true;
            s.EditsDirty = true;
        }
    }

    static void DirtyTunerEdits(TunerSession s, string entry)
    {
        var go = entry != null ? TunerEntryObject(s, entry) : null;
        if (entry != null && go == null) return;
        if (entry == null) s.Trail.Dirty = true;
        foreach (var b in s.EditBases)
        {
            if (go != null && b.Go != go) continue;
            b.Dirty = true;
            s.EditsDirty = true;
        }
    }

    static void DiffTunerEditBase(TunerEditBase b, Dictionary<string, string> cur)
    {
        b.Dirty = false;
        b.Rows.Clear();
        cur.Clear();
        SyncTunerRect(b.Target);
        SnapshotTunerValues(b.Target, cur);
        SerializedObject so = null;
        try
        {
            foreach (var kv in cur)
            {
                string was;
                bool known = b.Base.TryGetValue(kv.Key, out was);
                if (known && was == kv.Value) continue;
                if (!known && !kv.Key.Contains(".Array.data[")) continue;
                bool part = b.Key.IndexOf('/') > 0;
                if (part && kv.Key.EndsWith(".<length>k__BackingField", StringComparison.Ordinal)) continue;
                if (so == null) so = new SerializedObject(b.Target);
                b.Rows.Add(new TunerEditRow
                {
                    Path = b.Path,
                    Component = b.Key,
                    Field = kv.Key,
                    Before = known ? TunerDisplayRaw(so, b.Target, kv.Key, was) : TUNER_NEW,
                    After = TunerDisplayRaw(so, b.Target, kv.Key, kv.Value),
                    Label = part ? TiEditLabel(so, kv.Key) : null,
                    Type = part ? b.Target.GetType().Name : null,
                    Asset = part ? AssetDatabase.GetAssetPath(b.Target) : null
                });
                if (b.Rows.Count >= TUNER_MAX_EDIT_ROWS) break;
            }
        }
        finally
        {
            if (so != null) so.Dispose();
        }
    }

    static void TickTunerEdits(TunerSession s, double now)
    {
        if (EditorApplication.isPlaying) return;
        var trail = s.Trail;
        if (trail.Gen != _tunerStructureGen + _tunerHierarchyGen)
        {
            trail.Gen = _tunerStructureGen + _tunerHierarchyGen;
            trail.Dirty = true;
        }
        if (trail.Dirty && now >= trail.NextDiff)
        {
            trail.Dirty = false;
            trail.NextDiff = now + TUNER_STRUCT_DIFF_INTERVAL;
            if (DiffTunerStructure(s)) s.EditsDirty = true;
        }
        if (!s.EditsDirty || now < s.NextEditDiff) return;
        s.EditsDirty = false;
        s.NextEditDiff = now + TUNER_EDIT_DIFF_INTERVAL;
        bool gone = false;
        var cur = new Dictionary<string, string>();
        foreach (var b in s.EditBases)
        {
            if (b.Target == null)
            {
                gone = true;
                continue;
            }
            if (!b.Dirty) continue;
            DiffTunerEditBase(b, cur);
        }
        if (gone)
        {
            s.EditBases.RemoveAll(b => b.Target == null);
            s.EditObjects.Clear();
            foreach (var b in s.EditBases)
                if (b.Go != null) s.EditObjects.Add(b.Go);
        }
        var rows = new List<TunerEditRow>();
        var sig = new StringBuilder();
        Action<TunerEditRow> add = r =>
        {
            if (rows.Count >= TUNER_MAX_EDIT_ROWS) return;
            rows.Add(r);
            sig.Append(r.Kind).Append('|').Append(r.Path).Append('|').Append(r.Component).Append('|').Append(r.Field).Append('|').Append(r.Before).Append('|').Append(r.After).Append('|').Append(r.Saved ? '1' : '0').Append('\n');
        };
        foreach (var r in s.Trail.Saved) add(r);
        foreach (var sc in s.Trail.Scenes)
            foreach (var r in sc.Rows) add(r);
        foreach (var b in s.EditBases)
            foreach (var r in b.Rows) add(r);
        var key = sig.ToString();
        if (key == s.EditSig) return;
        s.EditSig = key;
        s.EditRows = rows;
        s.StatePending = true;
    }

    static void AppendTunerEdits(StringBuilder sb, TunerSession s)
    {
        sb.Append(",\"edits\":[");
        bool first = true;
        foreach (var r in s.EditRows)
        {
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"kind\":").Append(JStr(r.Kind))
              .Append(",\"path\":").Append(JStr(r.Path))
              .Append(",\"component\":").Append(JStr(r.Component))
              .Append(",\"field\":").Append(JStr(r.Field))
              .Append(",\"before\":").Append(JStr(r.Before))
              .Append(",\"after\":").Append(JStr(r.After))
              .Append(r.Saved ? ",\"saved\":true" : "");
            if (r.Label != null) sb.Append(",\"label\":").Append(JStr(r.Label));
            if (r.Type != null) sb.Append(",\"type\":").Append(JStr(r.Type));
            if (!string.IsNullOrEmpty(r.Asset)) sb.Append(",\"asset\":").Append(JStr(r.Asset));
            sb.Append('}');
        }
        sb.Append(']');
    }

    static void CommitTunerEdits(TunerSession s, Scene sc)
    {
        if (!sc.IsValid()) return;
        var trail = s.Trail;
        DiffTunerStructure(s);
        var cur = new Dictionary<string, string>();
        bool any = false;
        foreach (var st in trail.Scenes)
        {
            if (st.Scene != sc) continue;
            foreach (var r in st.Rows) AddSavedTunerEdit(trail, r);
            any |= st.Rows.Count > 0;
            SnapshotTunerStructScene(st, sc);
        }
        foreach (var b in s.EditBases)
        {
            if (b.Target == null || b.Go == null || b.Go.scene != sc) continue;
            DiffTunerEditBase(b, cur);
            foreach (var r in b.Rows) AddSavedTunerEdit(trail, r);
            any |= b.Rows.Count > 0;
            b.Rows.Clear();
            b.Base.Clear();
            SnapshotTunerValues(b.Target, b.Base);
        }
        if (!any) return;
        s.EditSig = null;
        s.EditsDirty = true;
        s.NextEditDiff = 0;
    }

    static void AddSavedTunerEdit(TunerEditTrail trail, TunerEditRow r)
    {
        if (r.Kind == TUNER_EDIT_FIELD)
        {
            foreach (var old in trail.Saved)
            {
                if (old.Kind != TUNER_EDIT_FIELD || old.Path != r.Path || old.Component != r.Component || old.Field != r.Field) continue;
                old.After = r.After;
                if (old.Before == old.After) trail.Saved.Remove(old);
                return;
            }
        }
        if (trail.Saved.Count >= TUNER_MAX_EDIT_ROWS) return;
        trail.Saved.Add(new TunerEditRow { Kind = r.Kind, Path = r.Path, Component = r.Component, Field = r.Field, Before = r.Before, After = r.After, Saved = true, Label = r.Label, Type = r.Type, Asset = r.Asset });
    }

    static void ResetTunerStructure(TunerSession s)
    {
        s.Trail.Scenes.Clear();
        s.Trail.Dirty = true;
        s.Trail.NextDiff = 0;
        s.EditsDirty = true;
    }

    static bool DiffTunerStructure(TunerSession s)
    {
        if (EditorApplication.isPlaying) return false;
        var trail = s.Trail;
        var scenes = TunerSessionScenes(s);
        bool changed = false;
        for (int i = trail.Scenes.Count - 1; i >= 0; i--)
        {
            var st = trail.Scenes[i];
            bool live = false;
            foreach (var sc in scenes)
                if (sc == st.Scene && sc.path == st.Path) live = true;
            if (live) continue;
            changed |= st.Rows.Count > 0;
            trail.Scenes.RemoveAt(i);
        }
        foreach (var sc in scenes)
        {
            TunerStructScene st = null;
            foreach (var x in trail.Scenes)
                if (x.Scene == sc) st = x;
            if (st == null)
            {
                st = new TunerStructScene();
                SnapshotTunerStructScene(st, sc);
                trail.Scenes.Add(st);
                continue;
            }
            var cur = new Dictionary<GameObject, TunerStructObj>();
            var order = new List<GameObject>();
            WalkTunerStructure(sc, cur, order);
            var rows = new List<TunerEditRow>();
            DiffTunerStructScene(st, cur, order, rows);
            if (TunerEditRowsEqual(rows, st.Rows)) continue;
            st.Rows.Clear();
            st.Rows.AddRange(rows);
            changed = true;
        }
        return changed;
    }

    static bool TunerEditRowsEqual(List<TunerEditRow> a, List<TunerEditRow> b)
    {
        if (a.Count != b.Count) return false;
        for (int i = 0; i < a.Count; i++)
            if (a[i].Kind != b[i].Kind || a[i].Path != b[i].Path || a[i].Component != b[i].Component || a[i].Before != b[i].Before || a[i].After != b[i].After) return false;
        return true;
    }

    static void SnapshotTunerStructScene(TunerStructScene st, Scene sc)
    {
        st.Path = sc.path;
        st.Scene = sc;
        st.Objs = new Dictionary<GameObject, TunerStructObj>();
        st.Order = new List<GameObject>();
        st.CopyOf.Clear();
        st.Rows.Clear();
        WalkTunerStructure(sc, st.Objs, st.Order);
    }

    static bool TunerAutoComponent(Component c)
    {
        var n = c.GetType().Name;
        return n.StartsWith("UniversalAdditional", StringComparison.Ordinal) || n.StartsWith("HDAdditional", StringComparison.Ordinal);
    }

    static void WalkTunerStructure(Scene sc, Dictionary<GameObject, TunerStructObj> map, List<GameObject> order)
    {
        if (!sc.IsValid() || !sc.isLoaded) return;
        var stack = new List<KeyValuePair<Transform, string>>();
        var roots = sc.GetRootGameObjects();
        for (int i = roots.Length - 1; i >= 0; i--)
        {
            var root = roots[i];
            if (root == null || (root.hideFlags & (HideFlags.HideInHierarchy | HideFlags.DontSave)) != 0 || SaturaEngineObjects.Contains(root)) continue;
            stack.Add(new KeyValuePair<Transform, string>(root.transform, root.name));
        }
        var comps = new List<Component>();
        while (stack.Count > 0 && map.Count < TUNER_MAX_STRUCT_OBJECTS)
        {
            var top = stack[stack.Count - 1];
            stack.RemoveAt(stack.Count - 1);
            var t = top.Key;
            var go = t.gameObject;
            go.GetComponents(comps);
            var sig = new StringBuilder();
            int n = 0;
            foreach (var c in comps) if (c != null) n++;
            var arr = new Component[n];
            n = 0;
            foreach (var c in comps)
            {
                if (c == null) continue;
                arr[n++] = c;
                sig.Append(c.GetType().Name).Append(',');
            }
            string prefab = null;
            if (PrefabUtility.IsOutermostPrefabInstanceRoot(go)) prefab = PrefabUtility.GetPrefabAssetPathOfNearestInstanceRoot(go);
            map[go] = new TunerStructObj { Path = top.Value, Name = go.name, Parent = t.parent != null ? t.parent.gameObject : null, Comps = arr, Sig = sig.ToString(), Prefab = prefab };
            order.Add(go);
            for (int k = t.childCount - 1; k >= 0; k--)
            {
                var ch = t.GetChild(k);
                if ((ch.gameObject.hideFlags & (HideFlags.HideInHierarchy | HideFlags.DontSave)) != 0) continue;
                stack.Add(new KeyValuePair<Transform, string>(ch, top.Value + "/" + ch.name));
            }
        }
    }

    static void DiffTunerStructScene(TunerStructScene st, Dictionary<GameObject, TunerStructObj> cur, List<GameObject> order, List<TunerEditRow> rows)
    {
        foreach (var go in order)
        {
            var now = cur[go];
            TunerStructObj was;
            if (!st.Objs.TryGetValue(go, out was))
            {
                if (now.Parent != null && !st.Objs.ContainsKey(now.Parent)) continue;
                TunerStructObj src;
                if (!st.CopyOf.TryGetValue(go, out src))
                {
                    src = TunerCopySource(st, go, now);
                    st.CopyOf[go] = src;
                }
                if (src != null) rows.Add(new TunerEditRow { Kind = "duplicated", Path = now.Path, Before = src.Path });
                else rows.Add(new TunerEditRow { Kind = "added", Path = now.Path, After = now.Prefab != null ? "instance of " + now.Prefab : TunerCompList(now.Comps) });
                continue;
            }
            if (was.Parent != now.Parent) rows.Add(new TunerEditRow { Kind = "moved", Path = now.Path, Before = was.Path, After = now.Path });
            foreach (var c in now.Comps)
                if (Array.IndexOf(was.Comps, c) < 0 && !TunerAutoComponent(c)) rows.Add(new TunerEditRow { Kind = "componentAdded", Path = now.Path, Component = c.GetType().Name });
            foreach (var c in was.Comps)
                if (Array.IndexOf(now.Comps, c) < 0) rows.Add(new TunerEditRow { Kind = "componentRemoved", Path = now.Path, Component = c.GetType().Name });
        }
        foreach (var go in st.Order)
        {
            if (cur.ContainsKey(go)) continue;
            var was = st.Objs[go];
            if (was.Parent != null && !cur.ContainsKey(was.Parent)) continue;
            if (TunerHiddenTwin(was)) continue;
            rows.Add(new TunerEditRow { Kind = "deleted", Path = was.Path });
        }
    }

    static bool TunerHiddenTwin(TunerStructObj was)
    {
        if (was.Parent == null) return false;
        var t = was.Parent.transform;
        for (int i = 0; i < t.childCount; i++)
        {
            var ch = t.GetChild(i).gameObject;
            if (ch.name == was.Name && (ch.hideFlags & (HideFlags.HideInHierarchy | HideFlags.DontSave)) != 0) return true;
        }
        return false;
    }

    static TunerStructObj TunerCopySource(TunerStructScene st, GameObject go, TunerStructObj now)
    {
        var bare = TunerCopySuffix.Replace(now.Name, "");
        TunerStructObj best = null;
        int bestScore = -1;
        var t = go.transform;
        foreach (var kv in st.Objs)
        {
            var o = kv.Value;
            if (kv.Key == null || kv.Key == go || o.Sig != now.Sig || o.Prefab != now.Prefab) continue;
            if (TunerCopySuffix.Replace(o.Name, "") != bare) continue;
            var src = kv.Key.transform;
            int score = (o.Parent == now.Parent ? 4 : 0) + (src.localPosition == t.localPosition ? 2 : 0) + (src.localRotation == t.localRotation && src.localScale == t.localScale ? 1 : 0);
            if (score <= bestScore) continue;
            bestScore = score;
            best = o;
        }
        return best;
    }

    static string TunerCompList(Component[] comps)
    {
        var names = new List<string>();
        foreach (var c in comps)
            if (c != null && !(c is Transform)) names.Add(c.GetType().Name);
        return names.Count == 0 ? "empty" : string.Join(", ", names);
    }
}
