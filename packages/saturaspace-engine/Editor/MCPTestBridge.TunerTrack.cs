using System;
using System.Collections.Generic;
using System.Globalization;
using TMPro;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;

public static partial class MCPTestBridge
{
    const double TUNER_TRACK_INTERVAL = 0.1;
    const double TUNER_SWEEP_INTERVAL = 1.0;
    const int TUNER_MAX_OVERRIDES = 2000;
    const string TUNER_EDIT_STATE = "@edit";
    const string TUNER_GO_KEY = "GameObject";
    const string TUNER_NEW = "(new)";

    class TunerEntry
    {
        public string Id;
        public bool Asset;
        public bool Opened;
        public string Path;
        public string Scene;
        public string Label;
        public GameObject Go;
        public UnityEngine.Object Main;
        public TunerAssetArgs Filter;
        public bool Member;
        public bool Touched;
        public string Parent;
        public string Name;
        public int Index;
        public bool Dup;
        public int Nth;
        public bool Active;
        public bool Ghost;
        public bool Env;
        public bool Runtime;
        public string Icon;
        public string Types;
        public string Prefab;
        public string PrefabAsset;
        public byte PrefabState;
        public bool Staging;
        public int Kids;
        public ulong Hash;
        public ulong BaseHash;
        public bool Filled;
        public int Depth;
        public int Size;
        public int Idx;
        public int Gen;
        public int ChildCount;
        public int Comps;
        public bool ActiveSelf;
        public Transform ParentT;
    }

    class TunerTrack
    {
        public string Entry;
        public string Key;
        public UnityEngine.Object Target;
        public bool Persistent;
        public Dictionary<string, string> Base;
        public bool Dirty;
        public bool All;
        public HashSet<string> Paths;
    }

    static readonly Dictionary<UnityEngine.Object, int> _tunerRefIds = new Dictionary<UnityEngine.Object, int>();
    static readonly List<UnityEngine.Object> _tunerRefs = new List<UnityEngine.Object> { null };

    [InitializeOnLoadMethod]
    static void InitTunerTracking()
    {
        if (Inert) return;
        Undo.postprocessModifications += OnTunerModifications;
        Undo.undoRedoPerformed += OnTunerUndoRedo;
        ObjectChangeEvents.changesPublished += OnTunerObjectChanges;
    }

    static UndoPropertyModification[] OnTunerModifications(UndoPropertyModification[] mods)
    {
        if (_tuners.Count == 0 || mods == null) return mods;
        try
        {
            foreach (var m in mods)
            {
                var pm = m.currentValue ?? m.previousValue;
                if (pm == null || pm.target == null) continue;
                NoteTunerChange(pm.target, pm.propertyPath);
            }
        }
        catch (Exception e) { Debug.LogException(e); }
        return mods;
    }

    static void OnTunerUndoRedo()
    {
        _tunerPrefabGen++;
        foreach (var s in _tuners.Values)
        {
            foreach (var t in s.Tracks.Values) MarkTunerTrack(t, null);
            DirtyTunerEdits(s, null);
            s.StatePending = true;
            s.Dirty = true;
        }
    }

    static void OnTunerObjectChanges(ref ObjectChangeEventStream stream)
    {
        if (_tuners.Count == 0) return;
        for (int i = 0; i < stream.length; i++)
        {
            switch (stream.GetEventType(i))
            {
                case ObjectChangeKind.UpdatePrefabInstances:
                    _tunerPrefabGen++;
                    _tunerPrefabUpdateGen++;
                    break;
                case ObjectChangeKind.ChangeGameObjectOrComponentProperties:
                {
                    _tunerPrefabGen++;
                    stream.GetChangeGameObjectOrComponentPropertiesEvent(i, out var e);
#if UNITY_6000_5_OR_NEWER
                    NoteTunerChangeById(e.entityId);
                    NoteTunerMemberTouched(EditorUtility.EntityIdToObject(e.entityId));
#else
                    var target = TunerChangeTarget(e);
                    if (target != null)
                    {
                        NoteTunerChangeById(target.GetInstanceID());
                        NoteTunerMemberTouched(target);
                    }
#endif
                    break;
                }
                case ObjectChangeKind.ChangeAssetObjectProperties:
                {
                    stream.GetChangeAssetObjectPropertiesEvent(i, out var e);
#if UNITY_6000_5_OR_NEWER
                    NoteTunerChangeById(e.entityId);
#else
                    var target = TunerChangeTarget(e);
                    if (target != null) NoteTunerChangeById(target.GetInstanceID());
#endif
                    break;
                }
                case ObjectChangeKind.ChangeGameObjectStructure:
                case ObjectChangeKind.ChangeGameObjectStructureHierarchy:
                case ObjectChangeKind.ChangeGameObjectParent:
                case ObjectChangeKind.CreateGameObjectHierarchy:
                case ObjectChangeKind.DestroyGameObjectHierarchy:
                    _tunerStructureGen++;
                    _tunerMemberStructGen++;
                    foreach (var s in _tuners.Values)
                    {
                        s.TracksStale = true;
                        s.StatePending = true;
                        s.Dirty = true;
                        s.CacheDirty = true;
                    }
                    break;
            }
        }
    }

    static void NoteTunerChange(UnityEngine.Object target, string path)
    {
        foreach (var s in _tuners.Values)
        {
            foreach (var t in s.Tracks.Values)
            {
                if (t.Target != target) continue;
                MarkTunerTrack(t, path);
                s.Dirty = true;
            }
            NoteTunerEditTarget(s, target);
        }
    }

#if !UNITY_6000_5_OR_NEWER
    static readonly Dictionary<Type, Func<object, UnityEngine.Object>> _tunerChangeTargets = new Dictionary<Type, Func<object, UnityEngine.Object>>();

    static UnityEngine.Object TunerChangeTarget<T>(T e) where T : struct
    {
        if (!_tunerChangeTargets.TryGetValue(typeof(T), out var read))
            _tunerChangeTargets[typeof(T)] = read = TunerChangeReader(typeof(T));
        return read(e);
    }

    static Func<object, UnityEngine.Object> TunerChangeReader(Type type)
    {
        var entity = type.GetProperty("entityId");
        var fromEntity = entity == null ? null : typeof(EditorUtility).GetMethod("EntityIdToObject", new[] { entity.PropertyType });
        if (fromEntity != null) return e => fromEntity.Invoke(null, new[] { entity.GetValue(e) }) as UnityEngine.Object;
        var instance = type.GetProperty("instanceId");
        var fromInstance = typeof(EditorUtility).GetMethod("InstanceIDToObject", new[] { typeof(int) });
        if (instance == null || fromInstance == null) return e => null;
        return e => fromInstance.Invoke(null, new[] { instance.GetValue(e) }) as UnityEngine.Object;
    }
#endif

#if UNITY_6000_5_OR_NEWER
    static void NoteTunerChangeById(EntityId id)
#else
    static void NoteTunerChangeById(int id)
#endif
    {
        foreach (var s in _tuners.Values)
        {
            NoteTunerEditId(s, id);
            foreach (var t in s.Tracks.Values)
            {
#if UNITY_6000_5_OR_NEWER
                if (t.Target == null || t.Target.GetEntityId() != id) continue;
#else
                if (t.Target == null || t.Target.GetHashCode() != id) continue;
#endif
                MarkTunerTrack(t, null);
                s.Dirty = true;
            }
        }
    }

    static void MarkTunerTrack(TunerTrack t, string path)
    {
        t.Dirty = true;
        if (path == null)
        {
            t.All = true;
            return;
        }
        if (t.Paths == null) t.Paths = new HashSet<string>();
        t.Paths.Add(TunerValuePath(t, path));
    }

    static string TunerValuePath(TunerTrack t, string leaf)
    {
        if (t.Base == null || string.IsNullOrEmpty(leaf) || t.Base.ContainsKey(leaf)) return leaf;
        var p = leaf;
        while (true)
        {
            int dot = p.LastIndexOf('.');
            if (dot <= 0) return leaf;
            p = p.Substring(0, dot);
            if (t.Base.ContainsKey(p)) return p;
        }
    }

    static bool TunerPathIn(HashSet<string> set, string path)
    {
        if (set.Contains(path)) return true;
        foreach (var c in set)
            if (path.StartsWith(c + ".", StringComparison.Ordinal)) return true;
        return false;
    }

    static string TunerEntryPath(TunerSession s, string id)
    {
        int i = TunerIndex(s, id);
        if (i >= 0) return TunerSpecPath(s.Specs[i]);
        var e = FindTunerEntry(s, id);
        if (e != null) return e.Path;
        string gone;
        return id != null && s.MemberPaths.TryGetValue(id, out gone) ? gone : "";
    }

    static TunerEntry FindTunerEntry(TunerSession s, string id)
    {
        if (string.IsNullOrEmpty(id)) return null;
        TunerEntry m;
        if (id[0] == 'm') return s.MemberById.TryGetValue(id, out m) ? m : null;
        foreach (var e in s.Entries)
            if (e.Id == id) return e;
        return null;
    }

    static GameObject TunerEntryObject(TunerSession s, string id)
    {
        int i = TunerIndex(s, id);
        if (i >= 0) return s.Objects[i];
        var e = FindTunerEntry(s, id);
        if (e == null) return null;
        return e.Asset ? e.Main as GameObject : e.Go;
    }

    static string TunerShortType(Type t)
    {
        return t == null ? "" : t.Name;
    }

    static List<KeyValuePair<string, Component>> TunerComponentKeys(GameObject go)
    {
        var list = new List<KeyValuePair<string, Component>>();
        if (go == null) return list;
        var counts = new Dictionary<Type, int>();
        foreach (var c in go.GetComponents<Component>())
        {
            if (c == null) continue;
            var t = c.GetType();
            int n;
            counts.TryGetValue(t, out n);
            counts[t] = n + 1;
            list.Add(new KeyValuePair<string, Component>(n > 0 ? t.Name + "#" + n.ToString(Inv) : t.Name, c));
        }
        return list;
    }

    static Component TunerComponentByKey(GameObject go, string key)
    {
        foreach (var kv in TunerComponentKeys(go))
            if (kv.Key == key) return kv.Value;
        return null;
    }

    static string TunerKeyOf(GameObject go, UnityEngine.Object comp)
    {
        foreach (var kv in TunerComponentKeys(go))
            if (kv.Value == comp) return kv.Key;
        return comp != null ? comp.GetType().Name : "";
    }

    static TunerComponentArgs TunerSpecFor(TunerObjectArgs spec, GameObject go, UnityEngine.Object comp)
    {
        if (spec == null || spec.components == null || go == null || comp == null) return null;
        foreach (var c in spec.components)
            if (c != null && !string.IsNullOrEmpty(c.type) && FindTunerComponent(go, c.type, c.index) == comp) return c;
        return null;
    }

    static bool TunerSpecAll(TunerObjectArgs spec)
    {
        return spec.all || spec.components == null;
    }

    static UnityEngine.Object TunerTrackTargetFor(TunerSession s, string entry, string key)
    {
        if (string.IsNullOrEmpty(key)) return null;
        int i = TunerIndex(s, entry);
        if (i >= 0)
        {
            var go = s.Objects[i];
            if (go == null) return null;
            if (key == TUNER_GO_KEY) return go;
            var byKey = TunerComponentByKey(go, key);
            if (byKey != null && (TunerSpecAll(s.Specs[i]) || TunerSpecFor(s.Specs[i], go, byKey) != null)) return byKey;
            var spec = FindTunerComponentSpec(s.Specs[i], key);
            if (spec != null) return FindTunerComponent(go, spec.type, spec.index);
            if (key == "Transform" || key == "RectTransform") return go.transform;
            return TunerSpecAll(s.Specs[i]) ? TunerMaterialByKey(go, key) : null;
        }
        var e = FindTunerEntry(s, entry);
        if (e == null) return null;
        if (e.Asset)
        {
            if (e.Main == null) return null;
            var ago = e.Main as GameObject;
            if (ago == null) return key == TunerShortType(e.Main.GetType()) ? e.Main : null;
            return key == TUNER_GO_KEY ? (UnityEngine.Object)ago : TunerComponentByKey(ago, key);
        }
        if (e.Go == null) return null;
        if (key == TUNER_GO_KEY) return e.Go;
        var comp = TunerComponentByKey(e.Go, key);
        return comp != null ? (UnityEngine.Object)comp : TunerMaterialByKey(e.Go, key);
    }

    static void AddTunerWanted(Dictionary<string, TunerTrack> want, string entry, string key, UnityEngine.Object target, bool persistent)
    {
        if (target == null) return;
        want[entry + "|" + key] = new TunerTrack { Entry = entry, Key = key, Target = target, Persistent = persistent };
    }

    static void AddTunerObjectTracks(Dictionary<string, TunerTrack> want, string entry, GameObject go, bool persistent)
    {
        AddTunerWanted(want, entry, TUNER_GO_KEY, go, persistent);
        foreach (var kv in TunerComponentKeys(go)) AddTunerWanted(want, entry, kv.Key, kv.Value, persistent);
    }

    static List<KeyValuePair<string, Material>> TunerMaterialKeys(GameObject go)
    {
        var list = new List<KeyValuePair<string, Material>>();
        if (go == null || EditorUtility.IsPersistent(go)) return list;
        var seen = new HashSet<Material>();
        foreach (var r in go.GetComponents<Renderer>())
        {
            if (r == null) continue;
            foreach (var m in r.sharedMaterials)
            {
                if (m == null || !seen.Add(m)) continue;
                int n = seen.Count - 1;
                var path = AssetDatabase.GetAssetPath(m);
                if (path.StartsWith("Assets/", StringComparison.Ordinal))
                    list.Add(new KeyValuePair<string, Material>(n == 0 ? "Material" : "Material#" + n.ToString(Inv), m));
            }
        }
        return list;
    }

    static Material TunerMaterialByKey(GameObject go, string key)
    {
        if (go == null || key == null || !key.StartsWith("Material", StringComparison.Ordinal)) return null;
        foreach (var kv in TunerMaterialKeys(go))
            if (kv.Key == key) return kv.Value;
        return null;
    }

    static void TunerTrackAll(TunerSession s)
    {
        s.TracksStale = false;
        var want = new Dictionary<string, TunerTrack>();
        bool track = EditorApplication.isPlaying && s.Prefabs == null;
        foreach (var i in track ? TunerActiveObjects(s) : TunerNoObjects)
        {
            var go = s.Objects[i];
            if (go == null) continue;
            var id = "o" + i.ToString(Inv);
            var spec = s.Specs[i];
            if (TunerSpecAll(spec))
            {
                AddTunerObjectTracks(want, id, go, false);
                continue;
            }
            foreach (var c in spec.components)
            {
                if (c == null || string.IsNullOrEmpty(c.type)) continue;
                var comp = FindTunerComponent(go, c.type, c.index);
                if (comp != null) AddTunerWanted(want, id, TunerKeyOf(go, comp), comp, false);
            }
        }
        if (track)
        {
            foreach (var e in s.Entries)
                if (!e.Asset && e.Go != null && !EditorSceneManager.IsPreviewSceneObject(e.Go)) AddTunerObjectTracks(want, e.Id, e.Go, false);
            foreach (var m in s.Members)
                if (m.Touched && m.Go != null) AddTunerObjectTracks(want, m.Id, m.Go, false);
        }
        var drop = new List<string>();
        foreach (var kv in s.Tracks)
        {
            TunerTrack w;
            if (!want.TryGetValue(kv.Key, out w) || w.Target != kv.Value.Target) drop.Add(kv.Key);
        }
        foreach (var k in drop) s.Tracks.Remove(k);
        foreach (var kv in want)
        {
            if (s.Tracks.ContainsKey(kv.Key) || !(kv.Value.Target is TMP_Text || kv.Value.Target is Canvas)) continue;
            Canvas.ForceUpdateCanvases();
            break;
        }
        foreach (var kv in want)
        {
            if (s.Tracks.ContainsKey(kv.Key)) continue;
            var t = kv.Value;
            t.Base = new Dictionary<string, string>();
            SnapshotTunerValues(t.Target, t.Base);
            var bucket = TunerBucket(s, t);
            if (bucket != null)
            {
                foreach (var o in bucket)
                {
                    if (o.Entry != t.Entry || o.Component != t.Key) continue;
                    if (string.IsNullOrEmpty(o.BeforeRaw)) t.Base.Remove(o.Field);
                    else t.Base[o.Field] = o.BeforeRaw;
                }
            }
            t.Dirty = true;
            t.All = true;
            s.Tracks[kv.Key] = t;
        }
    }

    static void DropTunerSceneTracks(TunerSession s)
    {
        var drop = new List<string>();
        foreach (var kv in s.Tracks)
            if (!kv.Value.Persistent) drop.Add(kv.Key);
        foreach (var k in drop) s.Tracks.Remove(k);
        s.TracksStale = true;
    }

    static List<TunerOverride> TunerBucket(TunerSession s, TunerTrack t)
    {
        return TunerBucketFor(s, t.Persistent);
    }

    static List<TunerOverride> TunerBucketFor(TunerSession s, bool persistent)
    {
        if (persistent || !EditorApplication.isPlaying) return null;
        return s.Active >= 0 && s.Active < s.States.Count ? s.States[s.Active].Overrides : null;
    }

    static TunerTrack FindTunerTrack(TunerSession s, string entry, string key)
    {
        TunerTrack t;
        return s.Tracks.TryGetValue(entry + "|" + key, out t) ? t : null;
    }

    static TunerTrack EnsureTunerTrack(TunerSession s, string entry, string key)
    {
        var t = FindTunerTrack(s, entry, key);
        if (t != null) return t;
        TunerTrackAll(s);
        return FindTunerTrack(s, entry, key);
    }

    static void TickTunerTracks(TunerSession s, double now)
    {
        if (s.TracksStale) TunerTrackAll(s);
        if (now < s.NextTrack) return;
        s.NextTrack = now + TUNER_TRACK_INTERVAL;
        if (now >= s.NextSweep)
        {
            s.NextSweep = now + TUNER_SWEEP_INTERVAL;
            if (!EditorApplication.isPlaying && !string.IsNullOrEmpty(s.Inspected)) DirtyTunerEdits(s, s.Inspected);
            if (s.EditBases.Count > 0) s.EditsDirty = true;
            if (!string.IsNullOrEmpty(s.Inspected) || s.WatchIds.Length > 0)
            {
                foreach (var t in s.Tracks.Values)
                    if ((t.Entry == s.Inspected || Array.IndexOf(s.WatchIds, t.Entry) >= 0) && (t.Persistent || !EditorApplication.isPlaying)) MarkTunerTrack(t, null);
            }
        }
        foreach (var t in s.Tracks.Values)
        {
            if (!t.Dirty || !(t.Target is TMP_Text)) continue;
            Canvas.ForceUpdateCanvases();
            break;
        }
        bool changed = false;
        foreach (var t in s.Tracks.Values)
        {
            if (!t.Dirty) continue;
            try
            {
                if (DiffTunerTrack(s, t)) changed = true;
            }
            catch (Exception e)
            {
                t.Dirty = false;
                Debug.LogException(e);
            }
        }
        if (changed)
        {
            s.StatePending = true;
            s.Dirty = true;
        }
    }

    static bool FlushTunerTracks(TunerSession s)
    {
        if (s.TracksStale) TunerTrackAll(s);
        bool changed = false;
        foreach (var t in s.Tracks.Values)
            if (t.Dirty && DiffTunerTrack(s, t)) changed = true;
        if (changed) s.StatePending = true;
        return changed;
    }

    static bool DiffTunerTrack(TunerSession s, TunerTrack t)
    {
        bool all = t.All;
        var paths = t.Paths;
        t.Dirty = false;
        t.All = false;
        t.Paths = null;
        if (t.Target == null) return false;
        var bucket = TunerBucket(s, t);
        if (bucket == null) return false;
        bool restrict = EditorApplication.isPlaying && !t.Persistent;
        HashSet<string> check = null;
        if (restrict || !all)
        {
            check = paths ?? new HashSet<string>();
            foreach (var o in bucket)
                if (o.Entry == t.Entry && o.Component == t.Key) check.Add(o.Field);
            if (check.Count == 0) return false;
        }
        var cur = new Dictionary<string, string>();
        SyncTunerRect(t.Target);
        SnapshotTunerValues(t.Target, cur);
        SerializedObject so = null;
        bool changed = false;
        try
        {
            for (int j = bucket.Count - 1; j >= 0; j--)
            {
                var o = bucket[j];
                if (o.Entry != t.Entry || o.Component != t.Key) continue;
                if (check != null && !TunerPathIn(check, o.Field)) continue;
                string c;
                cur.TryGetValue(o.Field, out c);
                if (c == null && TunerAnimatedNow(t.Target, o.Field)) continue;
                if (c == null || c == o.BeforeRaw)
                {
                    bucket.RemoveAt(j);
                    changed = true;
                    continue;
                }
                if (c != o.AfterRaw)
                {
                    if (so == null) so = new SerializedObject(t.Target);
                    o.AfterRaw = c;
                    o.After = TunerDisplayRaw(so, t.Target, o.Field, c);
                    changed = true;
                }
            }
            foreach (var kv in cur)
            {
                if (check != null && !TunerPathIn(check, kv.Key)) continue;
                string b;
                bool known = t.Base.TryGetValue(kv.Key, out b);
                if (known && b == kv.Value) continue;
                if (FindTunerOverride(bucket, t.Entry, t.Key, kv.Key) != null) continue;
                if (!known && !kv.Key.Contains(".Array.data[")) continue;
                if (bucket.Count >= TUNER_MAX_OVERRIDES) break;
                if (so == null) so = new SerializedObject(t.Target);
                bucket.Add(new TunerOverride
                {
                    Entry = t.Entry,
                    Component = t.Key,
                    Field = kv.Key,
                    Before = known ? TunerDisplayRaw(so, t.Target, kv.Key, b) : TUNER_NEW,
                    BeforeRaw = known ? b : "",
                    After = TunerDisplayRaw(so, t.Target, kv.Key, kv.Value),
                    AfterRaw = kv.Value,
                    Runtime = TunerOriginOf(TunerEntryObject(s, t.Entry))
                });
                changed = true;
            }
        }
        finally
        {
            if (so != null) so.Dispose();
        }
        return changed;
    }

    static bool TunerAnimatedNow(UnityEngine.Object target, string field)
    {
        if (!AnimationMode.InAnimationMode() || target == null || string.IsNullOrEmpty(field)) return false;
        return AnimationMode.IsPropertyAnimated(target, field) || AnimationMode.IsPropertyAnimated(target, field + ".x");
    }

    static void RebaseTunerTrack(TunerSession s, TunerTrack t, string field)
    {
        if (t == null || t.Target == null || string.IsNullOrEmpty(field)) return;
        var bucket = TunerBucket(s, t);
        if (bucket != null)
            foreach (var o in bucket)
                if (o.Entry == t.Entry && o.Component == t.Key && (o.Field == field || o.Field.StartsWith(field + ".", StringComparison.Ordinal)))
                    return;
        var cur = new Dictionary<string, string>();
        SyncTunerRect(t.Target);
        SnapshotTunerValues(t.Target, cur);
        foreach (var kv in cur)
            if (kv.Key == field || kv.Key.StartsWith(field + ".", StringComparison.Ordinal)) t.Base[kv.Key] = kv.Value;
    }

    static void SyncTunerRect(UnityEngine.Object target)
    {
        var rect = target as RectTransform;
        if (rect != null) rect.anchoredPosition = rect.anchoredPosition;
    }

    static void SnapshotTunerValues(UnityEngine.Object target, Dictionary<string, string> map)
    {
        if (target == null) return;
        using (var so = new SerializedObject(target))
        {
            so.UpdateIfRequiredOrScript();
            bool rect = target is RectTransform;
            var it = so.GetIterator();
            bool enter = true;
            while (it.NextVisible(enter))
            {
                enter = false;
                if (it.propertyPath == "m_Script") continue;
                if (rect && it.propertyPath == "m_LocalPosition")
                {
                    var z = so.FindProperty("m_LocalPosition.z");
                    if (z != null) map["m_LocalPosition.z"] = TunerValueRaw(z);
                    continue;
                }
                CollectTunerValues(it.Copy(), map, 0);
                if (map.Count >= TUNER_SNAPSHOT_MAX) break;
            }
        }
        if (target is Animator) map.Remove("m_WarningMessage");
        if (!AnimationMode.InAnimationMode()) return;
        List<string> animated = null;
        foreach (var key in map.Keys)
        {
            if (!AnimationMode.IsPropertyAnimated(target, key)) continue;
            if (animated == null) animated = new List<string>();
            animated.Add(key);
        }
        if (animated != null)
            foreach (var key in animated) map.Remove(key);
    }

    static void CollectTunerValues(SerializedProperty p, Dictionary<string, string> map, int depth)
    {
        if (map.Count >= TUNER_SNAPSHOT_MAX || depth > TUNER_MAX_DEPTH) return;
        if (p.propertyType == SerializedPropertyType.Generic)
        {
            if (p.isArray)
            {
                int n = p.arraySize;
                map[p.propertyPath + ".Array.size"] = n.ToString(Inv);
                for (int i = 0; i < n && map.Count < TUNER_SNAPSHOT_MAX; i++)
                    CollectTunerValues(p.GetArrayElementAtIndex(i), map, depth + 1);
                return;
            }
            var c = p.Copy();
            var end = p.GetEndProperty();
            if (c.NextVisible(true))
            {
                while (!SerializedProperty.EqualContents(c, end))
                {
                    CollectTunerValues(c.Copy(), map, depth + 1);
                    if (!c.NextVisible(false)) break;
                }
            }
            return;
        }
        var v = TunerValueRaw(p);
        if (v != null) map[p.propertyPath] = v;
    }

    static string TunerValueRaw(SerializedProperty p)
    {
        switch (p.propertyType)
        {
            case SerializedPropertyType.ObjectReference:
                return TunerRefToken(p.objectReferenceValue);
            case SerializedPropertyType.Rect:
            {
                var r = p.rectValue;
                return RawFloats(r.x, r.y, r.width, r.height);
            }
            case SerializedPropertyType.Bounds:
            {
                var b = p.boundsValue;
                return RawFloats(b.center.x, b.center.y, b.center.z, b.extents.x, b.extents.y, b.extents.z);
            }
            case SerializedPropertyType.Character:
                return p.intValue.ToString(Inv);
            case SerializedPropertyType.AnimationCurve:
                return TiCurveRaw(p.animationCurveValue);
            default:
                return TunerRawValue(p);
        }
    }

    static string TunerRefToken(UnityEngine.Object o)
    {
        if (o == null) return "@0";
        int id;
        if (!_tunerRefIds.TryGetValue(o, out id))
        {
            id = _tunerRefs.Count;
            _tunerRefs.Add(o);
            _tunerRefIds[o] = id;
        }
        return "@" + id.ToString(Inv);
    }

    static bool TunerRefFromToken(string raw, out UnityEngine.Object o)
    {
        o = null;
        int id;
        if (string.IsNullOrEmpty(raw) || raw[0] != '@' || !int.TryParse(raw.Substring(1), NumberStyles.Integer, Inv, out id)) return false;
        if (id < 0 || id >= _tunerRefs.Count) return false;
        o = _tunerRefs[id];
        return id == 0 || o != null;
    }

    static string TunerDisplayRaw(SerializedObject so, UnityEngine.Object target, string path, string raw)
    {
        if (raw == null) return "";
        const string sizeSuffix = ".Array.size";
        if (path.EndsWith(sizeSuffix, StringComparison.Ordinal))
            return raw + (raw == "1" ? " element" : " elements");
        var p = so.FindProperty(path);
        if (p == null) return raw;
        try
        {
            switch (p.propertyType)
            {
                case SerializedPropertyType.Float:
                    return TunerRound(double.Parse(raw, NumberStyles.Float, Inv), 10000);
                case SerializedPropertyType.String:
                    return JStr(raw);
                case SerializedPropertyType.Enum:
                {
                    Type ft;
                    ResolveTunerField(target.GetType(), path, out ft);
                    long v = long.Parse(raw, Inv);
                    if (ft != null && ft.IsEnum && ft.IsDefined(typeof(FlagsAttribute), false))
                    {
                        var names = new List<string>();
                        foreach (var e in Enum.GetValues(ft))
                        {
                            long n = Convert.ToInt64(e, Inv);
                            if (n == 0 || (n & (n - 1)) != 0 || (v & n) == 0) continue;
                            names.Add(ObjectNames.NicifyVariableName(Enum.GetName(ft, e)));
                        }
                        return names.Count > 0 ? string.Join(" | ", names) : "Nothing";
                    }
                    var opts = p.enumDisplayNames;
                    return v >= 0 && v < opts.Length ? opts[v] : raw;
                }
                case SerializedPropertyType.LayerMask:
                {
                    int v = int.Parse(raw, Inv);
                    var names = new List<string>();
                    for (int i = 0; i < 32; i++)
                    {
                        var n = LayerMask.LayerToName(i);
                        if (!string.IsNullOrEmpty(n) && (v & (1 << i)) != 0) names.Add(n);
                    }
                    return names.Count > 0 ? string.Join(" | ", names) : "Nothing";
                }
                case SerializedPropertyType.Quaternion:
                {
                    var f = Floats(raw, 4);
                    if (target is Transform && path == "m_LocalRotation")
                    {
                        var e = new Quaternion(f[0], f[1], f[2], f[3]).eulerAngles;
                        return TunerTuple(Wrap180(e.x), Wrap180(e.y), Wrap180(e.z));
                    }
                    return TunerTuple(f[0], f[1], f[2], f[3]);
                }
                case SerializedPropertyType.Color:
                {
                    var f = Floats(raw, 4);
                    var c = new Color(f[0], f[1], f[2], f[3]);
                    if (c.r > 1.001f || c.g > 1.001f || c.b > 1.001f) return TunerTuple(f[0], f[1], f[2], f[3]);
                    return TiJsonColor(c).Trim('"');
                }
                case SerializedPropertyType.Vector2:
                case SerializedPropertyType.Vector3:
                case SerializedPropertyType.Vector4:
                case SerializedPropertyType.Rect:
                case SerializedPropertyType.Bounds:
                case SerializedPropertyType.Vector2Int:
                case SerializedPropertyType.Vector3Int:
                {
                    var parts = raw.Split(',');
                    var d = new double[parts.Length];
                    for (int i = 0; i < parts.Length; i++) d[i] = double.Parse(parts[i], NumberStyles.Float, Inv);
                    return TunerTuple(d);
                }
                case SerializedPropertyType.ObjectReference:
                {
                    UnityEngine.Object o;
                    if (!TunerRefFromToken(raw, out o)) return "a missing object";
                    return o == null ? "None" : o.name + " (" + o.GetType().Name + ")";
                }
                case SerializedPropertyType.AnimationCurve:
                    return TiCurveDisplay(raw);
                default:
                    return raw;
            }
        }
        catch (Exception)
        {
            return raw;
        }
    }

    static string RestoreTunerValue(UnityEngine.Object target, string field, string raw)
    {
        if (target == null) return "the object is gone";
        if (string.IsNullOrEmpty(raw)) return null;
        using (var so = new SerializedObject(target))
        {
            so.UpdateIfRequiredOrScript();
            const string sizeSuffix = ".Array.size";
            string err;
            if (field.EndsWith(sizeSuffix, StringComparison.Ordinal))
            {
                var arr = so.FindProperty(field.Substring(0, field.Length - sizeSuffix.Length));
                int n;
                if (arr == null || !arr.isArray || !int.TryParse(raw, NumberStyles.Integer, Inv, out n)) return "cannot resize " + field;
                arr.arraySize = n;
                err = null;
            }
            else
            {
                var p = so.FindProperty(field);
                if (p == null) return "no field " + field;
                err = SetTunerRaw(p, raw);
            }
            if (err != null) return err;
            so.ApplyModifiedProperties();
        }
        return null;
    }

    static string SetTunerRaw(SerializedProperty p, string raw)
    {
        try
        {
            switch (p.propertyType)
            {
                case SerializedPropertyType.ObjectReference:
                {
                    UnityEngine.Object o;
                    if (!TunerRefFromToken(raw, out o)) return "the referenced object is gone";
                    p.objectReferenceValue = o;
                    return null;
                }
                case SerializedPropertyType.Rect:
                {
                    var v = Floats(raw, 4);
                    p.rectValue = new Rect(v[0], v[1], v[2], v[3]);
                    return null;
                }
                case SerializedPropertyType.Bounds:
                {
                    var v = Floats(raw, 6);
                    p.boundsValue = new Bounds(new Vector3(v[0], v[1], v[2]), new Vector3(v[3], v[4], v[5]) * 2f);
                    return null;
                }
                case SerializedPropertyType.Character:
                    p.intValue = int.Parse(raw, Inv);
                    return null;
                case SerializedPropertyType.AnimationCurve:
                    p.animationCurveValue = TiCurveFromRaw(raw);
                    return null;
                default:
                    return SetTunerValue(p, raw);
            }
        }
        catch (FormatException)
        {
            return "cannot parse '" + raw + "' for " + p.propertyPath;
        }
    }

    static void MarkTunerSceneDirty(UnityEngine.Object target)
    {
        if (target == null) return;
        var c = target as Component;
        var go = c != null ? c.gameObject : target as GameObject;
        if (go == null || EditorUtility.IsPersistent(go) || !go.scene.IsValid()) return;
        if (EditorSceneManager.IsPreviewSceneObject(go))
        {
            EditorUtility.SetDirty(target);
            return;
        }
        if (EditorApplication.isPlaying) return;
        if (PrefabUtility.IsPartOfPrefabInstance(target)) PrefabUtility.RecordPrefabInstancePropertyModifications(target);
        if (!go.scene.isDirty) Undo.FlushUndoRecordObjects();
        if (!go.scene.isDirty) EditorSceneManager.MarkSceneDirty(go.scene);
    }
}
