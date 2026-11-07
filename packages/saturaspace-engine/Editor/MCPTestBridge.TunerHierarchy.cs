using System;
using System.Collections.Generic;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

public static partial class MCPTestBridge
{
    [Serializable]
    class TunerHierarchyArgs
    {
        public string session;
        public string op;
        public string[] ids;
        public string parent;
        public string before;
        public string after;
        public string scene;
        public string kind;
        public string asset;
        public string name;
    }

    [Serializable]
    class TunerHierarchyCommand
    {
        public int id;
        public TunerHierarchyArgs args;
    }

    static bool HandleTunerHierarchy(int id, string cmd, string line, ControlClient from)
    {
        if (cmd != "tuner/hierarchy") return false;
        TunerHierarchyCommand parsed;
        try { parsed = JsonUtility.FromJson<TunerHierarchyCommand>(line); }
        catch (Exception e)
        {
            TunerResult(from, id, "bad arguments: " + e.Message, null);
            return true;
        }
        var a = parsed != null ? parsed.args : null;
        var s = a != null ? FindTuner(a.session) : null;
        if (s == null)
        {
            TunerResult(from, id, "no tuner session '" + (a != null ? a.session : "") + "'", null);
            return true;
        }
        var made = new List<GameObject>();
        var touched = new HashSet<Scene>();
        MarkTunerMemberIds(s, a.ids, a.parent);
        Undo.IncrementCurrentGroup();
        int group = Undo.GetCurrentGroup();
        string err;
        switch (a.op)
        {
            case "create":
                err = TunerHierCreate(s, a, made, touched);
                break;
            case "delete":
                err = TunerHierDelete(s, a, touched);
                break;
            case "duplicate":
                err = TunerHierDuplicate(s, a, made, touched);
                break;
            case "rename":
                err = TunerHierRename(s, a, made, touched);
                break;
            case "move":
                err = TunerHierMove(s, a, made, touched);
                break;
            default:
                TunerResult(from, id, "unknown hierarchy op: " + a.op, null);
                return true;
        }
        Undo.CollapseUndoOperations(group);
        TunerHierAfter(s, touched);
        var sb = new StringBuilder(256);
        sb.Append("\"ids\":[");
        var add = new StringBuilder();
        bool first = true;
        foreach (var go in made)
        {
            if (go == null) continue;
            bool opened;
            var oid = TunerHierEnsureId(s, go, out opened);
            if (oid == null) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append(JStr(oid));
            if (!opened || !TunerHierParentListed(s, go)) continue;
            if (add.Length > 0) add.Append(',');
            add.Append("{\"id\":").Append(JStr(oid)).Append(",\"path\":").Append(JStr(TunerObjectPath(go)))
               .Append(",\"scene\":").Append(JStr(TunerSceneKey(go.scene))).Append('}');
        }
        sb.Append("],\"add\":[").Append(add).Append(']');
        Debug.Log("[Tuner] hierarchy " + a.op + " in " + s.Name + ": " + (err ?? "ok") + " (" + made.Count + " objects)");
        sb.Append(",\"state\":").Append(DescribeTunerState(s));
        TunerResult(from, id, err, sb.ToString());
        return true;
    }

    static void TunerHierAfter(TunerSession s, HashSet<Scene> touched)
    {
        _tunerHierarchyGen++;
        _tunerStructureGen++;
        foreach (var t in _tuners.Values)
        {
            t.TracksStale = true;
            t.CacheDirty = true;
            t.Dirty = true;
            t.StatePending = true;
        }
        if (!EditorApplication.isPlaying)
        {
            foreach (var sc in touched)
                if (sc.IsValid() && sc.isLoaded && !sc.isDirty && TunerPrefabOfScene(sc) == null) EditorSceneManager.MarkSceneDirty(sc);
        }
        RebuildTunerMembers(s, true);
        _tunerUnsavedAt = -1;
        SignalEditorTick();
    }

    static string TunerHierEnsureId(TunerSession s, GameObject go, out bool opened)
    {
        opened = false;
        var known = TunerHierId(s, go);
        if (known != null) return known;
        var e = AddTunerOpenedEntry(s, TunerObjectPath(go), TunerSceneKey(go.scene));
        if (e == null) return null;
        e.Go = go;
        opened = true;
        return e.Id;
    }

    static string TunerHierId(TunerSession s, GameObject go)
    {
        TunerEntry m;
        if (s.MemberByGo.TryGetValue(go, out m)) return m.Id;
        foreach (var i in TunerActiveObjects(s))
            if (i < s.Objects.Length && s.Objects[i] == go) return "o" + i.ToString(Inv);
        foreach (var e in s.Entries)
            if (!e.Asset && e.Go == go) return e.Id;
        return null;
    }

    static bool TunerHierParentListed(TunerSession s, GameObject go)
    {
        var p = go.transform.parent;
        if (p == null) return false;
        if (s.MemberByGo.ContainsKey(p.gameObject)) return true;
        foreach (var i in TunerActiveObjects(s))
            if (i < s.Objects.Length && s.Objects[i] == p.gameObject) return true;
        return false;
    }

    static List<GameObject> TunerHierObjects(TunerSession s, string[] ids, out string err)
    {
        err = null;
        var list = new List<GameObject>();
        if (ids == null) return list;
        foreach (var oid in ids)
        {
            var go = string.IsNullOrEmpty(oid) ? null : TunerEntryObject(s, oid);
            if (go == null || EditorUtility.IsPersistent(go))
            {
                err = "no scene object '" + oid + "' in this Tuner";
                continue;
            }
            if (TunerEnvMember(go))
            {
                err = TunerEnvLocked(go);
                continue;
            }
            if (!list.Contains(go)) list.Add(go);
        }
        return list;
    }

    static List<GameObject> TunerHierTopmost(List<GameObject> gos)
    {
        var set = new HashSet<Transform>();
        foreach (var go in gos) set.Add(go.transform);
        var list = new List<GameObject>();
        foreach (var go in gos)
        {
            bool nested = false;
            for (var p = go.transform.parent; p != null && !nested; p = p.parent) nested = set.Contains(p);
            if (!nested) list.Add(go);
        }
        return list;
    }

    static string TunerHierLocked(GameObject go, bool restructure)
    {
        var p = TunerPrefabOfScene(go.scene);
        if (p != null && p.ReadOnly) return p.Path + " is read-only";
        if (p != null && p.Root == go) return go.name + " is the prefab root, so it can't be " + (restructure ? "moved" : "deleted");
        if (restructure && PrefabUtility.IsPartOfNonAssetPrefabInstance(go) && !PrefabUtility.IsOutermostPrefabInstanceRoot(go))
            return go.name + " is inside a Prefab instance, and Unity can't move objects there. Open the Prefab or unpack it first";
        return null;
    }

    static Scene TunerHierScene(TunerSession s, string key)
    {
        if (!string.IsNullOrEmpty(key))
        {
            foreach (var p in _tunerPrefabs.Values)
                if (p.Scene.IsValid() && p.Path == key) return p.Scene;
            foreach (var sc in TunerScenes())
                if (TunerSceneKey(sc) == key || sc.path == key) return sc;
        }
        var ap = ActiveTunerPrefab(s);
        if (ap != null) return ap.Scene;
        if (s.Scene)
        {
            var list = TunerSessionScenes(s);
            var active = SceneManager.GetActiveScene();
            if (list.Contains(active)) return active;
            if (list.Count > 0) return list[0];
        }
        return SceneManager.GetActiveScene();
    }

    static string TunerHierParent(TunerSession s, TunerHierarchyArgs a, out Transform parent, out Scene scene)
    {
        parent = null;
        var key = a.parent ?? "";
        if (key.Length > 0 && !key.StartsWith(TUNER_SCENE_PARENT, StringComparison.Ordinal))
        {
            var go = TunerEntryObject(s, key);
            if (go == null || EditorUtility.IsPersistent(go))
            {
                scene = default;
                return "no scene object '" + key + "' in this Tuner";
            }
            parent = go.transform;
            scene = go.scene;
            return TunerEnvMember(go) ? TunerEnvLocked(go) : null;
        }
        scene = TunerHierScene(s, key.Length > 0 ? key.Substring(TUNER_SCENE_PARENT.Length) : a.scene);
        if (!scene.IsValid() || !scene.isLoaded) return "the scene is not loaded";
        var prefab = TunerPrefabOfScene(scene);
        if (prefab != null)
        {
            if (prefab.Root == null) return "the prefab contents are gone";
            parent = prefab.Root.transform;
        }
        return null;
    }

    static GameObject TunerHierNew(string kind)
    {
        switch (string.IsNullOrEmpty(kind) ? "empty" : kind)
        {
            case "empty": return ObjectFactory.CreateGameObject("GameObject");
            case "cube": return ObjectFactory.CreatePrimitive(PrimitiveType.Cube);
            case "sphere": return ObjectFactory.CreatePrimitive(PrimitiveType.Sphere);
            case "capsule": return ObjectFactory.CreatePrimitive(PrimitiveType.Capsule);
            case "cylinder": return ObjectFactory.CreatePrimitive(PrimitiveType.Cylinder);
            case "plane": return ObjectFactory.CreatePrimitive(PrimitiveType.Plane);
            case "quad": return ObjectFactory.CreatePrimitive(PrimitiveType.Quad);
            case "camera": return ObjectFactory.CreateGameObject("Camera", typeof(Camera), typeof(AudioListener));
            case "light": return TunerHierLight("Directional Light", LightType.Directional);
            case "pointlight": return TunerHierLight("Point Light", LightType.Point);
            case "spotlight": return TunerHierLight("Spot Light", LightType.Spot);
        }
        return null;
    }

    static GameObject TunerHierLight(string name, LightType type)
    {
        var go = ObjectFactory.CreateGameObject(name, typeof(Light));
        var light = go.GetComponent<Light>();
        light.type = type;
        if (type == LightType.Directional)
        {
            light.shadows = LightShadows.Soft;
            go.transform.rotation = Quaternion.Euler(50f, -30f, 0f);
        }
        return go;
    }

    static GameObject TunerHierInstantiate(string path, out string err)
    {
        err = null;
        var src = AssetDatabase.LoadAssetAtPath<GameObject>(path);
        if (src == null)
        {
            err = "no prefab or model at " + path;
            return null;
        }
        var go = PrefabUtility.InstantiatePrefab(src) as GameObject;
        if (go == null)
        {
            err = "Unity could not add " + path + " to the scene";
            return null;
        }
        Undo.RegisterCreatedObjectUndo(go, "Create " + go.name);
        return go;
    }

    static string TunerHierCreate(TunerSession s, TunerHierarchyArgs a, List<GameObject> made, HashSet<Scene> touched)
    {
        Transform parent;
        Scene scene;
        GameObject anchor = null;
        if (!string.IsNullOrEmpty(a.after))
        {
            anchor = TunerEntryObject(s, a.after);
            if (anchor == null || EditorUtility.IsPersistent(anchor)) return "no scene object '" + a.after + "' in this Tuner";
            parent = anchor.transform.parent;
            scene = anchor.scene;
            if (parent != null && TunerEnvMember(parent.gameObject)) return TunerEnvLocked(parent.gameObject);
        }
        else
        {
            var err = TunerHierParent(s, a, out parent, out scene);
            if (err != null) return err;
        }
        var prefab = TunerPrefabOfScene(scene);
        if (prefab != null && prefab.ReadOnly) return prefab.Path + " is read-only";
        bool fromAsset = !string.IsNullOrEmpty(a.asset);
        string assetErr = null;
        var go = fromAsset ? TunerHierInstantiate(a.asset, out assetErr) : TunerHierNew(a.kind);
        if (go == null) return assetErr ?? "unknown object kind '" + a.kind + "'";
        var t = go.transform;
        if (parent != null)
        {
            var rot = t.localRotation;
            var scale = t.localScale;
            Undo.SetTransformParent(t, parent, "Reparenting");
            t.localPosition = Vector3.zero;
            t.localRotation = fromAsset || a.kind == "light" ? rot : Quaternion.identity;
            t.localScale = fromAsset ? scale : Vector3.one;
            go.layer = parent.gameObject.layer;
            if (parent.GetComponent<RectTransform>() != null && go.GetComponent<RectTransform>() == null) ObjectFactory.AddComponent<RectTransform>(go);
        }
        else
        {
            if (t.parent != null) Undo.SetTransformParent(t, null, "Reparenting");
            t.position = Vector3.zero;
            if (go.scene != scene) Undo.MoveGameObjectToScene(go, scene, "Create " + go.name);
        }
        if (anchor != null) t.SetSiblingIndex(anchor.transform.GetSiblingIndex() + 1);
        GameObjectUtility.EnsureUniqueNameForSibling(go);
        Undo.SetCurrentGroupName("Create " + go.name);
        touched.Add(go.scene);
        made.Add(go);
        return null;
    }

    static string TunerHierDelete(TunerSession s, TunerHierarchyArgs a, HashSet<Scene> touched)
    {
        string err;
        var gos = TunerHierTopmost(TunerHierObjects(s, a.ids, out err));
        var label = gos.Count == 1 ? "Delete " + gos[0].name : "Delete " + gos.Count + " objects";
        foreach (var go in gos)
        {
            var locked = TunerHierLocked(go, false);
            if (locked != null)
            {
                err = locked;
                continue;
            }
            var sc = go.scene;
            var name = go.name;
            try
            {
                Undo.DestroyObjectImmediate(go);
                touched.Add(sc);
            }
            catch (Exception e)
            {
                err = "could not delete " + name + ": " + e.Message;
            }
        }
        Undo.SetCurrentGroupName(label);
        return err;
    }

    static string TunerHierDuplicate(TunerSession s, TunerHierarchyArgs a, List<GameObject> made, HashSet<Scene> touched)
    {
        string err;
        var gos = TunerHierTopmost(TunerHierObjects(s, a.ids, out err));
        if (gos.Count == 0) return err ?? "nothing to duplicate";
        foreach (var go in gos)
        {
            var p = TunerPrefabOfScene(go.scene);
            if (p != null && p.ReadOnly) return p.Path + " is read-only";
            if (p != null && p.Root == go) return go.name + " is the prefab root, so it can't be duplicated";
        }
        try
        {
            foreach (var dup in GameObjectUtility.DuplicateGameObjects(gos.ToArray()))
                if (dup != null && !gos.Contains(dup)) made.Add(dup);
        }
        catch (Exception e)
        {
            Debug.LogWarning("[Tuner] duplicate failed, copying instead: " + e.Message);
            made.Clear();
        }
        if (made.Count == 0)
        {
            foreach (var go in gos)
            {
                var t = go.transform;
                var copy = UnityEngine.Object.Instantiate(go, t.parent);
                if (t.parent == null && copy.scene != go.scene) SceneManager.MoveGameObjectToScene(copy, go.scene);
                copy.name = go.name;
                Undo.RegisterCreatedObjectUndo(copy, "Duplicate");
                copy.transform.SetSiblingIndex(t.GetSiblingIndex() + 1);
                GameObjectUtility.EnsureUniqueNameForSibling(copy);
                made.Add(copy);
            }
        }
        foreach (var go in made) touched.Add(go.scene);
        Undo.SetCurrentGroupName("Duplicate");
        return err;
    }

    static string TunerHierRename(TunerSession s, TunerHierarchyArgs a, List<GameObject> made, HashSet<Scene> touched)
    {
        string err;
        var gos = TunerHierObjects(s, a.ids, out err);
        if (gos.Count == 0) return err ?? "nothing to rename";
        var name = (a.name ?? "").Trim();
        if (name.Length == 0) return "a name is required";
        foreach (var go in gos)
        {
            var p = TunerPrefabOfScene(go.scene);
            if (p != null && p.ReadOnly) return p.Path + " is read-only";
            Undo.RecordObject(go, "Rename " + go.name);
            go.name = name;
            touched.Add(go.scene);
            made.Add(go);
        }
        return err;
    }

    static List<Transform> TunerHierSiblings(Transform parent, Scene scene)
    {
        var list = new List<Transform>();
        if (parent != null)
        {
            for (int k = 0; k < parent.childCount; k++) list.Add(parent.GetChild(k));
            return list;
        }
        foreach (var root in scene.GetRootGameObjects())
            if (root != null) list.Add(root.transform);
        list.Sort((x, y) => x.GetSiblingIndex().CompareTo(y.GetSiblingIndex()));
        return list;
    }

    static string TunerHierMove(TunerSession s, TunerHierarchyArgs a, List<GameObject> made, HashSet<Scene> touched)
    {
        string err;
        var gos = TunerHierTopmost(TunerHierObjects(s, a.ids, out err));
        if (gos.Count == 0) return err ?? "nothing to move";
        Transform parent;
        Scene scene;
        var perr = TunerHierParent(s, a, out parent, out scene);
        if (perr != null) return perr;
        var targetPrefab = TunerPrefabOfScene(scene);
        if (targetPrefab != null && targetPrefab.ReadOnly) return targetPrefab.Path + " is read-only";
        var moving = new HashSet<Transform>();
        foreach (var go in gos) moving.Add(go.transform);
        Transform anchor = null;
        if (!string.IsNullOrEmpty(a.before))
        {
            var b = TunerEntryObject(s, a.before);
            var bt = b != null && !EditorUtility.IsPersistent(b) ? b.transform : null;
            if (bt != null && bt.parent == parent && (parent != null || bt.gameObject.scene == scene))
            {
                var sibs = TunerHierSiblings(parent, scene);
                for (int k = sibs.IndexOf(bt); k >= 0 && k < sibs.Count; k++)
                {
                    if (moving.Contains(sibs[k])) continue;
                    anchor = sibs[k];
                    break;
                }
            }
        }
        bool ordered = a.kind == "order";
        foreach (var go in gos)
        {
            var t = go.transform;
            if (parent != null && (parent == t || parent.IsChildOf(t)))
            {
                err = go.name + " can't become a child of itself";
                continue;
            }
            var locked = TunerHierLocked(go, true);
            if (locked != null)
            {
                err = locked;
                continue;
            }
            if (TunerPrefabOfScene(go.scene) != targetPrefab)
            {
                err = go.name + " can't move between a prefab and a scene";
                continue;
            }
            touched.Add(go.scene);
            if (t.parent != parent) Undo.SetTransformParent(t, parent, true, "Reparenting");
            if (parent == null && go.scene != scene) Undo.MoveGameObjectToScene(go, scene, "Move " + go.name);
            if (ordered)
            {
                int count = parent != null ? parent.childCount : scene.rootCount;
                int at;
                if (anchor != null)
                {
                    int ai = anchor.GetSiblingIndex();
                    at = t.GetSiblingIndex() < ai ? ai - 1 : ai;
                }
                else at = count - 1;
                if (at != t.GetSiblingIndex()) Undo.SetSiblingIndex(t, at, "Reorder " + go.name);
            }
            touched.Add(go.scene);
            made.Add(go);
        }
        Undo.SetCurrentGroupName(made.Count == 1 ? "Move " + made[0].name : "Move " + made.Count + " objects");
        return err;
    }
}
