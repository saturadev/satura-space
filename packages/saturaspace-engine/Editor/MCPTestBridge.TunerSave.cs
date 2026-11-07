using System;
using System.Collections.Generic;
using System.IO;
using System.Reflection;
using System.Text;
using UnityEditor;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.SceneManagement;

public static partial class MCPTestBridge
{
    const double TUNER_UNSAVED_INTERVAL = 0.2;
    const double TUNER_PLAY_SAVE_DELAY = 0.3;
    const string TUNER_SAVE_STATE = "SaturaTunerSave";
    const double TUNER_PREFAB_LINGER = 8.0;

    sealed class TunerPrefab
    {
        public string Path;
        public Scene Scene;
        public GameObject Root;
        public int SavedDirty;
        public GameObject Light;
        public double ReleasedAt = -1;
        public readonly HashSet<string> Users = new HashSet<string>();
        public bool ReadOnly;
        public GameObject Env;
        public bool Ui;
        public bool EnvLit;
        public readonly List<UnityEngine.Object> Temp = new List<UnityEngine.Object>();
    }

    [Serializable]
    class TunerSaveSaved
    {
        public string[] touched = new string[0];
        public string[] created = new string[0];
        public string[] createdGuids = new string[0];
        public string[] playScenes = new string[0];
        public bool playing;
        public string[] prefabPaths = new string[0];
        public int[] prefabScenes = new int[0];
        public int[] prefabSaved = new int[0];
        public string[] prefabUsers = new string[0];
    }

    sealed class TunerAfterPlay
    {
        public bool Save;
        public int Id;
        public ControlClient From;
        public string Session;
    }

    static readonly Dictionary<string, List<UnityEngine.Object>> _tunerTouched = new Dictionary<string, List<UnityEngine.Object>>();
    static readonly List<string> _tunerCreated = new List<string>();
    static readonly Dictionary<string, string> _tunerCreatedGuids = new Dictionary<string, string>();
    const string TUNER_GLOBAL_SESSION = "_discard";
    static readonly Dictionary<string, TunerPrefab> _tunerPrefabs = new Dictionary<string, TunerPrefab>();
    static readonly Dictionary<string, double> _tunerPlaySaves = new Dictionary<string, double>();
    static readonly List<TunerAfterPlay> _tunerAfterPlay = new List<TunerAfterPlay>();
    static string[] _tunerPlayScenes;
    const string TUNER_UNSAVED_EMPTY = "{\"scenes\":[],\"prefabs\":[],\"assets\":[]}";
    const double TUNER_SCOPE_DEPS_TTL = 10;
    static double _tunerUnsavedAt = -1;
    static bool _tunerAgentEdit;
    static bool _tunerSaving;
    static PropertyInfo _tunerSceneDirtyId;
    static bool _tunerSceneDirtyIdLooked;

    [InitializeOnLoadMethod]
    static void InitTunerSave()
    {
        if (Inert) return;
        ObjectChangeEvents.changesPublished += OnTunerSaveChanges;
        Undo.postprocessModifications += OnTunerSaveModifications;
        EditorApplication.playModeStateChanged += OnTunerSavePlayMode;
        AssemblyReloadEvents.beforeAssemblyReload += StoreTunerSaveState;
        EditorApplication.update += TickTunerSave;
        RestoreTunerSaveState();
    }

    static bool TunerEditing => _tuners.Count > 0 || _tunerPrefabs.Count > 0;

    static void OnTunerSaveChanges(ref ObjectChangeEventStream stream)
    {
        if (!TunerEditing || _tunerSaving) return;
        for (int i = 0; i < stream.length; i++)
        {
            switch (stream.GetEventType(i))
            {
                case ObjectChangeKind.ChangeAssetObjectProperties:
                {
                    stream.GetChangeAssetObjectPropertiesEvent(i, out var e);
#if UNITY_6000_5_OR_NEWER
                    NoteTunerAssetPath(AssetDatabase.GetAssetPath(e.entityId), null);
#else
                    var target = TunerChangeTarget(e);
                    if (target != null) NoteTunerAssetPath(AssetDatabase.GetAssetPath(target), null);
#endif
                    break;
                }
                case ObjectChangeKind.CreateAssetObject:
                {
                    stream.GetCreateAssetObjectEvent(i, out var e);
#if UNITY_6000_5_OR_NEWER
                    NoteTunerAssetPath(AssetDatabase.GetAssetPath(e.entityId), null);
#else
                    var target = TunerChangeTarget(e);
                    if (target != null) NoteTunerAssetPath(AssetDatabase.GetAssetPath(target), null);
#endif
                    break;
                }
            }
        }
    }

    static UndoPropertyModification[] OnTunerSaveModifications(UndoPropertyModification[] mods)
    {
        if (!TunerEditing || mods == null || _tunerSaving) return mods;
        try
        {
            foreach (var m in mods)
            {
                var pm = m.currentValue ?? m.previousValue;
                if (pm == null || pm.target == null || !EditorUtility.IsPersistent(pm.target)) continue;
                NoteTunerAssetEdit(pm.target);
            }
        }
        catch (Exception e) { Debug.LogException(e); }
        return mods;
    }

    static void NoteTunerAssetEdit(UnityEngine.Object o)
    {
        if (o == null || !EditorUtility.IsPersistent(o)) return;
        NoteTunerAssetPath(AssetDatabase.GetAssetPath(o), o);
    }

    static void NoteTunerAssetPath(string path, UnityEngine.Object o)
    {
        if (string.IsNullOrEmpty(path) || !path.StartsWith("Assets/", StringComparison.Ordinal) || path.EndsWith(".unity", StringComparison.Ordinal)) return;
        if (EditorApplication.isPlaying)
        {
            if (!_tunerAgentEdit) _tunerPlaySaves[path] = EditorApplication.timeSinceStartup + TUNER_PLAY_SAVE_DELAY;
            return;
        }
        if (_tunerAgentEdit) return;
        if (!_tunerTouched.TryGetValue(path, out var list))
        {
            list = new List<UnityEngine.Object>();
            _tunerTouched[path] = list;
        }
        if (o != null && !list.Contains(o)) list.Add(o);
        _tunerUnsavedAt = -1;
    }

    static void TunerSaveAsset(UnityEngine.Object o)
    {
        if (o == null) return;
        if (EditorApplication.isPlaying || _tunerAgentEdit)
        {
            AssetDatabase.SaveAssetIfDirty(o);
            return;
        }
        NoteTunerAssetEdit(o);
    }

    static void NoteTunerCreatedAsset(string path)
    {
        if (string.IsNullOrEmpty(path) || EditorApplication.isPlaying || _tunerAgentEdit) return;
        if (!_tunerCreated.Contains(path)) _tunerCreated.Add(path);
        var guid = AssetDatabase.AssetPathToGUID(path);
        if (!string.IsNullOrEmpty(guid)) _tunerCreatedGuids[path] = guid;
        _tunerUnsavedAt = -1;
    }

    static void ForgetTunerCreated(int i)
    {
        _tunerCreatedGuids.Remove(_tunerCreated[i]);
        _tunerCreated.RemoveAt(i);
    }

    static string TrashTunerCreated(string path)
    {
        if (AssetDatabase.LoadMainAssetAtPath(path) == null) return null;
        _tunerCreatedGuids.TryGetValue(path, out var want);
        var have = AssetDatabase.AssetPathToGUID(path);
        if (string.IsNullOrEmpty(want) || want != have)
        {
            Debug.LogWarning("[Tuner] discard kept " + path + ": it is not the asset the Tuner created there (guid " + (string.IsNullOrEmpty(want) ? "unknown" : want) + ", now " + have + ")");
            return "kept " + path + " because it is no longer the asset the Tuner created";
        }
        return AssetDatabase.MoveAssetToTrash(path) ? "" : "could not move " + path + " to the Trash";
    }

    static bool ResolveTunerSaveSession(string name, out TunerSession s, out string err)
    {
        s = null;
        err = null;
        if (string.IsNullOrEmpty(name) || name == TUNER_GLOBAL_SESSION) return true;
        s = FindTuner(name);
        if (s != null) return true;
        err = "no Tuner session '" + name + "' in this editor, nothing was changed";
        Debug.LogWarning("[Tuner] " + err);
        return false;
    }

    static int TunerSceneDirtyId(Scene sc)
    {
        if (!_tunerSceneDirtyIdLooked)
        {
            _tunerSceneDirtyIdLooked = true;
            _tunerSceneDirtyId = typeof(Scene).GetProperty("dirtyID", BindingFlags.Instance | BindingFlags.NonPublic | BindingFlags.Public);
        }
        if (_tunerSceneDirtyId == null || !sc.IsValid()) return 0;
        try { return (int)_tunerSceneDirtyId.GetValue(sc); }
        catch { return 0; }
    }

    static bool TunerPrefabDirty(TunerPrefab p)
    {
        return !p.ReadOnly && p.Scene.IsValid() && TunerSceneDirtyId(p.Scene) != p.SavedDirty;
    }

    static bool TunerAssetDirty(string path, List<UnityEngine.Object> objs)
    {
        if (objs.Count == 0)
        {
            foreach (var o in AssetDatabase.LoadAllAssetsAtPath(path))
                if (o != null) objs.Add(o);
        }
        foreach (var o in objs)
            if (o != null && EditorUtility.IsDirty(o)) return true;
        return false;
    }

    static List<string> TunerDirtyScenes()
    {
        var list = new List<string>();
        if (EditorApplication.isPlaying)
        {
            if (_tunerPlayScenes != null) list.AddRange(_tunerPlayScenes);
            return list;
        }
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var sc = SceneManager.GetSceneAt(i);
            if (sc.IsValid() && sc.isLoaded && sc.isDirty) list.Add(string.IsNullOrEmpty(sc.path) ? (string.IsNullOrEmpty(sc.name) ? "Untitled" : sc.name) : sc.path);
        }
        return list;
    }

    static bool TunerScopeScene(TunerSession s, Scene sc)
    {
        if (s == null) return true;
        if (s.PrefabTuner) return false;
        if (s.Scene) return TunerSceneInFilter(s, sc);
        foreach (var go in s.Objects)
            if (go != null && go.scene == sc) return true;
        foreach (var e in s.Entries)
            if (!e.Asset && e.Go != null && e.Go.scene == sc) return true;
        return false;
    }

    static bool TunerScopeScenePath(TunerSession s, string path)
    {
        if (s == null) return true;
        if (s.PrefabTuner) return false;
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var sc = SceneManager.GetSceneAt(i);
            if (sc.path == path || (string.IsNullOrEmpty(sc.path) && sc.name == path)) return TunerScopeScene(s, sc);
        }
        return s.Scene && (s.SceneFilter == null || path == s.SceneFilter || Path.GetFileNameWithoutExtension(path) == s.SceneFilter);
    }

    static bool TunerScopePrefab(TunerSession s, TunerPrefab p)
    {
        return s == null || (s.Prefabs != null && Array.IndexOf(s.Prefabs, p.Path) >= 0);
    }

    static bool TunerScopeAsset(TunerSession s, string path, bool fresh)
    {
        if (s == null || (!s.PrefabTuner && !s.Scene)) return true;
        return TunerScopeDeps(s, fresh).Contains(path);
    }

    static HashSet<string> TunerScopeDeps(TunerSession s, bool fresh)
    {
        double now = EditorApplication.timeSinceStartup;
        if (!fresh && s.ScopeDeps != null && s.ScopeDepsGen == _tunerHierarchyGen && now - s.ScopeDepsAt < TUNER_SCOPE_DEPS_TTL) return s.ScopeDeps;
        var roots = new List<UnityEngine.Object>();
        if (s.PrefabTuner)
        {
            foreach (var path in s.Prefabs ?? new string[0])
                if (_tunerPrefabs.TryGetValue(path, out var p) && p.Root != null) roots.Add(p.Root);
        }
        else
        {
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var sc = SceneManager.GetSceneAt(i);
                if (!sc.IsValid() || !sc.isLoaded || !TunerScopeScene(s, sc)) continue;
                foreach (var go in sc.GetRootGameObjects()) roots.Add(go);
            }
        }
        var set = new HashSet<string>();
        if (roots.Count > 0)
            foreach (var o in EditorUtility.CollectDependencies(roots.ToArray()))
            {
                if (o == null || !EditorUtility.IsPersistent(o)) continue;
                var path = AssetDatabase.GetAssetPath(o);
                if (!string.IsNullOrEmpty(path)) set.Add(path);
            }
        s.ScopeDeps = set;
        s.ScopeDepsAt = now;
        s.ScopeDepsGen = _tunerHierarchyGen;
        return set;
    }

    static bool TunerScopeCreated(TunerSession s, string path, bool fresh)
    {
        return TunerScopeAsset(s, path, fresh);
    }

    static string BuildTunerUnsaved(TunerSession s)
    {
        var sb = new StringBuilder(256);
        sb.Append("{\"scenes\":[");
        bool first = true;
        foreach (var path in TunerDirtyScenes())
        {
            if (!TunerScopeScenePath(s, path)) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append(JStr(path));
        }
        sb.Append("],\"prefabs\":[");
        first = true;
        foreach (var p in _tunerPrefabs.Values)
        {
            if (!TunerPrefabDirty(p) || !TunerScopePrefab(s, p)) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append(JStr(p.Path));
        }
        sb.Append("],\"assets\":[");
        first = true;
        var listed = new HashSet<string>();
        foreach (var kv in _tunerTouched)
        {
            if (TunerPrefabEdits(kv.Key) || !TunerAssetDirty(kv.Key, kv.Value) || !TunerScopeAsset(s, kv.Key, false)) continue;
            if (!first) sb.Append(',');
            first = false;
            listed.Add(kv.Key);
            sb.Append("{\"path\":").Append(JStr(kv.Key));
            if (_tunerCreated.Contains(kv.Key)) sb.Append(",\"created\":true");
            sb.Append('}');
        }
        foreach (var path in _tunerCreated)
        {
            if (listed.Contains(path) || !TunerScopeCreated(s, path, false)) continue;
            if (!first) sb.Append(',');
            first = false;
            sb.Append("{\"path\":").Append(JStr(path)).Append(",\"created\":true}");
        }
        sb.Append("]");
        if (EditorApplication.isPlaying) sb.Append(",\"playing\":true");
        sb.Append('}');
        return sb.ToString();
    }

    static string TunerUnsavedJson(TunerSession s)
    {
        return s.UnsavedJson ?? TUNER_UNSAVED_EMPTY;
    }

    static void RefreshTunerUnsaved()
    {
        foreach (var s in _tuners.Values)
        {
            string json;
            try { json = BuildTunerUnsaved(s); }
            catch (Exception e)
            {
                Debug.LogException(e);
                continue;
            }
            if (json == s.UnsavedJson) continue;
            s.UnsavedJson = json;
            s.StatePending = true;
        }
    }

    static void TickTunerSave()
    {
        if (_tunerPlaySaves.Count > 0) FlushTunerPlaySaves(false);
        if (!TunerEditing) return;
        double now = EditorApplication.timeSinceStartup;
        if (_tunerPrefabs.Count > 0) SweepTunerPrefabs(now);
        if (EditorApplication.isPlaying) TickTunerPrefabPlaySaves();
        if (_tunerUnsavedAt >= 0 && now - _tunerUnsavedAt < TUNER_UNSAVED_INTERVAL) return;
        _tunerUnsavedAt = now;
        RefreshTunerUnsaved();
    }

    static void FlushTunerPlaySaves(bool all)
    {
        double now = EditorApplication.timeSinceStartup;
        List<string> due = null;
        foreach (var kv in _tunerPlaySaves)
            if (all || now >= kv.Value)
            {
                if (due == null) due = new List<string>();
                due.Add(kv.Key);
            }
        if (due == null) return;
        _tunerSaving = true;
        try
        {
            foreach (var path in due)
            {
                _tunerPlaySaves.Remove(path);
                var asset = AssetDatabase.LoadMainAssetAtPath(path);
                if (asset == null) continue;
                AssetDatabase.SaveAssetIfDirty(asset);
                Debug.Log("[Tuner] saved " + path + " (Play Mode asset edit)");
            }
        }
        catch (Exception e) { Debug.LogException(e); }
        finally { _tunerSaving = false; }
        _tunerUnsavedAt = -1;
    }

    static void TickTunerPrefabPlaySaves()
    {
        foreach (var p in _tunerPrefabs.Values)
        {
            if (!TunerPrefabDirty(p)) continue;
            double now = EditorApplication.timeSinceStartup;
            if (!_tunerPlaySaves.TryGetValue("prefab:" + p.Path, out var due))
            {
                _tunerPlaySaves["prefab:" + p.Path] = now + TUNER_PLAY_SAVE_DELAY;
                continue;
            }
            if (now < due) continue;
            _tunerPlaySaves.Remove("prefab:" + p.Path);
            string err = SaveTunerPrefab(p);
            if (err != null) Debug.LogWarning("[Tuner] could not save " + p.Path + ": " + err);
            else Debug.Log("[Tuner] saved " + p.Path + " (Play Mode prefab edit)");
        }
    }

    static void OnTunerSavePlayMode(PlayModeStateChange change)
    {
        if (change == PlayModeStateChange.ExitingEditMode)
        {
            _tunerPlayScenes = TunerDirtyScenes().ToArray();
            return;
        }
        if (change == PlayModeStateChange.ExitingPlayMode)
        {
            FlushTunerPlaySaves(true);
            return;
        }
        if (change == PlayModeStateChange.EnteredEditMode)
        {
            _tunerPlayScenes = null;
            _tunerUnsavedAt = -1;
            if (_tunerAfterPlay.Count == 0) return;
            var list = new List<TunerAfterPlay>(_tunerAfterPlay);
            _tunerAfterPlay.Clear();
            foreach (var ap in list)
            {
                string err;
                string summary = null;
                if (!ResolveTunerSaveSession(ap.Session, out var sap, out err))
                {
                    TunerSaveReply(null, ap.From, ap.Id, err, null);
                    continue;
                }
                try { err = ap.Save ? TunerSaveAll(sap, out summary) : TunerDiscardAll(sap, out summary); }
                catch (Exception e)
                {
                    err = e.GetType().Name + ": " + e.Message;
                    summary = null;
                }
                TunerSaveReply(sap, ap.From, ap.Id, err, summary);
            }
        }
    }

    static void StoreTunerSaveState()
    {
        DropTunerReadOnlyPrefabs();
        try
        {
            var saved = new TunerSaveSaved
            {
                touched = new List<string>(_tunerTouched.Keys).ToArray(),
                created = _tunerCreated.ToArray(),
                createdGuids = _tunerCreated.ConvertAll(c => _tunerCreatedGuids.TryGetValue(c, out var g) ? g : "").ToArray(),
                playScenes = _tunerPlayScenes ?? new string[0],
                playing = _tunerPlayScenes != null
            };
            var paths = new List<string>();
            var scenes = new List<int>();
            var dirty = new List<int>();
            var users = new List<string>();
            foreach (var p in _tunerPrefabs.Values)
            {
                if (!p.Scene.IsValid()) continue;
                paths.Add(p.Path);
                scenes.Add(p.Scene.GetHashCode());
                dirty.Add(p.SavedDirty);
                users.Add(string.Join("\n", p.Users));
            }
            saved.prefabPaths = paths.ToArray();
            saved.prefabScenes = scenes.ToArray();
            saved.prefabSaved = dirty.ToArray();
            saved.prefabUsers = users.ToArray();
            SessionState.SetString(TUNER_SAVE_STATE, JsonUtility.ToJson(saved));
        }
        catch (Exception e) { Debug.LogException(e); }
    }

    static void RestoreTunerSaveState()
    {
        var raw = SessionState.GetString(TUNER_SAVE_STATE, "");
        if (string.IsNullOrEmpty(raw)) return;
        SessionState.EraseString(TUNER_SAVE_STATE);
        try
        {
            var saved = JsonUtility.FromJson<TunerSaveSaved>(raw);
            foreach (var path in saved.touched)
                if (!string.IsNullOrEmpty(path) && !_tunerTouched.ContainsKey(path)) _tunerTouched[path] = new List<UnityEngine.Object>();
            var guids = saved.createdGuids ?? new string[0];
            for (int i = 0; i < saved.created.Length; i++)
            {
                var path = saved.created[i];
                if (string.IsNullOrEmpty(path)) continue;
                if (!_tunerCreated.Contains(path)) _tunerCreated.Add(path);
                if (i < guids.Length && !string.IsNullOrEmpty(guids[i])) _tunerCreatedGuids[path] = guids[i];
            }
            if (saved.playing) _tunerPlayScenes = saved.playScenes;
            if (saved.prefabPaths.Length > 0) ReattachTunerPrefabs(saved);
        }
        catch (Exception e) { Debug.LogException(e); }
    }

    static void ReattachTunerPrefabs(TunerSaveSaved saved)
    {
        var want = new Dictionary<int, int>();
        for (int i = 0; i < saved.prefabPaths.Length && i < saved.prefabScenes.Length; i++) want[saved.prefabScenes[i]] = i;
        foreach (var t in Resources.FindObjectsOfTypeAll<Transform>())
        {
            if (t == null || t.parent != null) continue;
            var go = t.gameObject;
            if (!EditorSceneManager.IsPreviewSceneObject(go)) continue;
            var sc = go.scene;
            if (!sc.IsValid() || !want.TryGetValue(sc.GetHashCode(), out var i)) continue;
            var path = saved.prefabPaths[i];
            if (sc.path != path) continue;
            if (!_tunerPrefabs.TryGetValue(path, out var p))
            {
                p = new TunerPrefab { Path = path, Scene = sc, SavedDirty = i < saved.prefabSaved.Length ? saved.prefabSaved[i] : 0 };
                if (i < saved.prefabUsers.Length)
                    foreach (var u in saved.prefabUsers[i].Split('\n'))
                        if (!string.IsNullOrEmpty(u)) p.Users.Add(u);
                _tunerPrefabs[path] = p;
            }
            if ((go.hideFlags & HideFlags.HideInHierarchy) != 0)
            {
                if (go.GetComponent<Light>() != null) p.Light = go;
                continue;
            }
            if (TunerEnvObject(go))
            {
                ReattachTunerEnv(p, go);
                if (p.Env == null) p.Env = go;
                if (go.name != TUNER_UI_ENV_CANVAS) p.EnvLit = true;
                continue;
            }
            p.Root = go;
        }
        foreach (var p in _tunerPrefabs.Values)
            if (p.Root != null) p.Ui = TunerIsUiPrefabRoot(p.Root);
        var lost = new List<string>();
        foreach (var kv in _tunerPrefabs)
            if (kv.Value.Root == null) lost.Add(kv.Key);
        foreach (var path in lost)
        {
            var p = _tunerPrefabs[path];
            if (p.Scene.IsValid()) EditorSceneManager.ClosePreviewScene(p.Scene);
            _tunerPrefabs.Remove(path);
        }
        if (_tunerPrefabs.Count > 0) Debug.Log("[Tuner] kept " + _tunerPrefabs.Count + " open prefab" + (_tunerPrefabs.Count == 1 ? "" : "s") + " across the script reload");
    }

    static string CleanTunerPrefabPath(string path)
    {
        var p = CleanTunerAssetPath(path);
        if (p == null || !File.Exists(Path.Combine(ProjectRoot, p))) return null;
        return p.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase) || TunerAssetPreviewable(p) ? p : null;
    }

    static TunerPrefab AcquireTunerPrefab(TunerSession s, string path, out string error)
    {
        error = null;
        var p0 = CleanTunerPrefabPath(path);
        if (p0 == null)
        {
            error = "no prefab asset at " + path;
            return null;
        }
        if (_tunerPrefabs.TryGetValue(p0, out var p) && p.Root != null && p.Scene.IsValid())
        {
            p.Users.Add(s.Name);
            p.ReleasedAt = -1;
            return p;
        }
        p = new TunerPrefab { Path = p0 };
        string err = LoadTunerPrefab(p);
        if (err != null)
        {
            error = err;
            return null;
        }
        p.Users.Add(s.Name);
        _tunerPrefabs[p0] = p;
        Debug.Log("[Tuner] opened " + (p.ReadOnly ? "read-only " + p0 : "prefab " + p0 + " for editing") + " in " + s.Name);
        return p;
    }

    static string LoadTunerPrefab(TunerPrefab p)
    {
        if (!p.Path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)) return LoadTunerAssetPreview(p);
        try
        {
            var root = PrefabUtility.LoadPrefabContents(p.Path);
            var fileName = Path.GetFileNameWithoutExtension(p.Path);
            if (root.name != fileName) root.name = fileName;
            if (PrefabUtility.IsOutermostPrefabInstanceRoot(root)) RenameTunerVariantRoot(root);
            p.Root = root;
            p.Scene = root.scene;
            SetTunerPrefabLighting(p.Scene);
            AddTunerRegularEnvironment(p);
            AddTunerUiEnvironment(p);
            p.SavedDirty = TunerSceneDirtyId(p.Scene);
            _tunerHierarchyGen++;
            return null;
        }
        catch (Exception e)
        {
            return "could not open " + p.Path + ": " + e.Message;
        }
    }

    static void RenameTunerVariantRoot(GameObject root)
    {
        var mods = new List<PropertyModification>(PrefabUtility.GetPropertyModifications(root) ?? new PropertyModification[0]);
        var source = PrefabUtility.GetCorrespondingObjectFromSource(root);
        bool found = false, changed = false;
        foreach (var m in mods)
            if (m != null && m.propertyPath == "m_Name" && m.target == source)
            {
                found = true;
                if (m.value == root.name) continue;
                m.value = root.name;
                changed = true;
            }
        if (!found && source != null)
        {
            mods.Add(new PropertyModification { target = source, propertyPath = "m_Name", value = root.name });
            changed = true;
        }
        if (changed) PrefabUtility.SetPropertyModifications(root, mods.ToArray());
    }

    static void UnloadTunerPrefab(TunerPrefab p)
    {
        try
        {
            if (p.Scene.IsValid()) EditorSceneManager.ClosePreviewScene(p.Scene);
        }
        catch (Exception e) { Debug.LogException(e); }
        DestroyTunerPreviewTemps(p);
        DropTunerUiEnvironment(p);
        p.Root = null;
        p.Light = null;
        p.Scene = default;
        _tunerHierarchyGen++;
    }

    static void OpenTunerPrefabs(TunerSession s, string[] paths)
    {
        var list = new List<string>();
        var errors = new List<string>();
        foreach (var path in paths ?? new string[0])
        {
            if (string.IsNullOrEmpty(path)) continue;
            var p = AcquireTunerPrefab(s, path, out var err);
            if (p == null)
            {
                errors.Add(err);
                continue;
            }
            if (!list.Contains(p.Path)) list.Add(p.Path);
        }
        foreach (var kv in _tunerPrefabs)
            if (!list.Contains(kv.Key) && kv.Value.Users.Remove(s.Name) && kv.Value.Users.Count == 0) kv.Value.ReleasedAt = EditorApplication.timeSinceStartup;
        s.Prefabs = list.ToArray();
        s.PrefabError = errors.Count > 0 ? string.Join("; ", errors) : null;
        _tunerUnsavedAt = -1;
    }

    static void ReleaseTunerPrefabs(TunerSession s, string reason)
    {
        if (reason == "domainReload" || reason == "restart") return;
        foreach (var kv in _tunerPrefabs)
            if (kv.Value.Users.Remove(s.Name) && kv.Value.Users.Count == 0) kv.Value.ReleasedAt = EditorApplication.timeSinceStartup;
        _tunerUnsavedAt = -1;
    }

    static void SweepTunerPrefabs(double now)
    {
        List<string> drop = null;
        foreach (var kv in _tunerPrefabs)
        {
            var p = kv.Value;
            if (p.Users.Count > 0 || p.ReleasedAt < 0 || now - p.ReleasedAt < TUNER_PREFAB_LINGER) continue;
            if (drop == null) drop = new List<string>();
            drop.Add(kv.Key);
        }
        if (drop == null) return;
        foreach (var path in drop)
        {
            var p = _tunerPrefabs[path];
            if (TunerPrefabDirty(p)) Debug.Log("[Tuner] closed prefab " + path + " without saving its changes");
            else Debug.Log("[Tuner] closed prefab " + path);
            UnloadTunerPrefab(p);
            _tunerPrefabs.Remove(path);
        }
        _tunerUnsavedAt = -1;
    }

    static List<Scene> TunerPrefabScenes(TunerSession s)
    {
        var list = new List<Scene>();
        if (s == null || s.Prefabs == null) return list;
        foreach (var path in s.Prefabs)
            if (_tunerPrefabs.TryGetValue(path, out var p) && p.Scene.IsValid() && p.Root != null) list.Add(p.Scene);
        return list;
    }

    static void AddTunerPrefabScenes(List<Scene> list)
    {
        foreach (var p in _tunerPrefabs.Values)
            if (p.Scene.IsValid() && p.Root != null && !list.Contains(p.Scene)) list.Add(p.Scene);
    }

    static string TunerSceneKey(Scene sc)
    {
        if (!sc.IsValid()) return "";
        return TunerPrefabOfScene(sc) != null ? sc.path : sc.name;
    }

    static TunerPrefab ActiveTunerPrefab(TunerSession s)
    {
        if (s == null || s.Prefabs == null || s.Prefabs.Length == 0) return null;
        var go = !string.IsNullOrEmpty(s.Inspected) ? TunerEntryObject(s, s.Inspected) : null;
        var hit = go != null ? TunerPrefabOfScene(go.scene) : null;
        if (hit != null && Array.IndexOf(s.Prefabs, hit.Path) >= 0)
        {
            s.ActivePrefab = hit.Path;
            return hit;
        }
        if (s.ActivePrefab != null && _tunerPrefabs.TryGetValue(s.ActivePrefab, out var last) && last.Root != null) return last;
        foreach (var path in s.Prefabs)
            if (_tunerPrefabs.TryGetValue(path, out var p) && p.Root != null) return p;
        return null;
    }

    static TunerPrefab TunerPrefabOfScene(Scene sc)
    {
        if (!sc.IsValid()) return null;
        foreach (var p in _tunerPrefabs.Values)
            if (p.Scene == sc) return p;
        return null;
    }

    static string SaveTunerPrefab(TunerPrefab p)
    {
        if (p.Root == null) return "the prefab contents are gone";
        bool ok;
        _tunerSaving = true;
        try
        {
            PrefabUtility.SaveAsPrefabAsset(p.Root, p.Path, out ok);
        }
        finally { _tunerSaving = false; }
        if (!ok) return "Unity could not write " + p.Path;
        if (p.Scene.IsValid()) ClearTunerSceneDirtiness(p.Scene);
        p.SavedDirty = TunerSceneDirtyId(p.Scene);
        foreach (var s in _tuners.Values) CommitTunerEdits(s, p.Scene);
        return null;
    }

    static MethodInfo _tunerClearDirtiness;
    static bool _tunerClearDirtinessKnown;

    static void ClearTunerSceneDirtiness(Scene scene)
    {
        if (!_tunerClearDirtinessKnown)
        {
            _tunerClearDirtinessKnown = true;
            _tunerClearDirtiness = typeof(EditorSceneManager).GetMethod("ClearSceneDirtiness", BindingFlags.Static | BindingFlags.NonPublic | BindingFlags.Public, null, new[] { typeof(Scene) }, null);
            if (_tunerClearDirtiness == null) Debug.LogWarning("[Tuner] EditorSceneManager.ClearSceneDirtiness was not found, edits after a prefab save may not show as unsaved");
        }
        if (_tunerClearDirtiness == null) return;
        try { _tunerClearDirtiness.Invoke(null, new object[] { scene }); }
        catch (Exception e) { Debug.LogWarning("[Tuner] could not clear the prefab scene's dirty flag: " + e.Message); }
    }

    static string TunerSaveAll(TunerSession s, out string summary)
    {
        summary = null;
        if (EditorApplication.isPlaying) return "Unity only saves scenes in Edit Mode. Leave Play Mode to save.";
        var saved = new List<string>();
        var errors = new List<string>();
        if (s != null) s.ScopeDeps = null;
        foreach (var p in _tunerPrefabs.Values)
        {
            if (!TunerPrefabDirty(p) || !TunerScopePrefab(s, p)) continue;
            var err = SaveTunerPrefab(p);
            if (err != null) errors.Add(err);
            else saved.Add(p.Path);
        }
        _tunerSaving = true;
        try
        {
            foreach (var kv in _tunerTouched)
            {
                if (TunerPrefabEdits(kv.Key) || !TunerAssetDirty(kv.Key, kv.Value) || !TunerScopeAsset(s, kv.Key, false)) continue;
                var asset = AssetDatabase.LoadMainAssetAtPath(kv.Key);
                if (asset == null) continue;
                AssetDatabase.SaveAssetIfDirty(asset);
                saved.Add(kv.Key);
            }
            for (int i = 0; i < SceneManager.sceneCount; i++)
            {
                var sc = SceneManager.GetSceneAt(i);
                if (!sc.IsValid() || !sc.isLoaded || !sc.isDirty || !TunerScopeScene(s, sc)) continue;
                if (string.IsNullOrEmpty(sc.path))
                {
                    errors.Add("the scene " + (string.IsNullOrEmpty(sc.name) ? "Untitled" : sc.name) + " has never been saved, save it in Unity first");
                    continue;
                }
                if (EditorSceneManager.SaveScene(sc)) saved.Add(sc.path);
                else errors.Add("Unity could not write " + sc.path);
            }
        }
        finally { _tunerSaving = false; }
        for (int i = _tunerCreated.Count - 1; i >= 0; i--)
        {
            var path = _tunerCreated[i];
            if (!TunerScopeCreated(s, path, false)) continue;
            if (!saved.Contains(path)) saved.Add(path);
            ForgetTunerCreated(i);
        }
        var keep = new List<string>();
        foreach (var kv in _tunerTouched)
            if (TunerAssetDirty(kv.Key, kv.Value)) keep.Add(kv.Key);
        var drop = new List<string>();
        foreach (var k in _tunerTouched.Keys)
            if (!keep.Contains(k)) drop.Add(k);
        foreach (var k in drop) _tunerTouched.Remove(k);
        _tunerUnsavedAt = -1;
        summary = saved.Count == 0 ? "nothing to save" : string.Join(", ", saved);
        Debug.Log("[Tuner] save" + (s != null ? " (" + s.Name + ")" : "") + ": " + summary + (errors.Count > 0 ? "; errors: " + string.Join("; ", errors) : ""));
        return errors.Count > 0 ? string.Join("; ", errors) : null;
    }

    static string TunerDiscardAll(TunerSession s, out string summary)
    {
        summary = null;
        if (EditorApplication.isPlaying) return "Leave Play Mode to discard the Edit Mode changes.";
        TunerAnimBeforeDiscard();
        var done = new List<string>();
        var errors = new List<string>();
        if (s != null) s.ScopeDeps = null;
        var reverted = new List<string>();
        foreach (var p in _tunerPrefabs.Values)
        {
            if (!TunerPrefabDirty(p) || !TunerScopePrefab(s, p)) continue;
            UnloadTunerPrefab(p);
            var err = LoadTunerPrefab(p);
            if (err != null) errors.Add(err);
            else done.Add(p.Path);
        }
        _tunerSaving = true;
        try
        {
            foreach (var kv in _tunerTouched)
            {
                if (TunerPrefabEdits(kv.Key) || _tunerCreated.Contains(kv.Key) || !TunerScopeAsset(s, kv.Key, false)) continue;
                reverted.Add(kv.Key);
                if (!TunerAssetDirty(kv.Key, kv.Value)) continue;
                var err = RevertTunerAsset(kv.Key);
                if (err != null) errors.Add(err);
                else done.Add(kv.Key);
            }
            for (int i = _tunerCreated.Count - 1; i >= 0; i--)
            {
                var path = _tunerCreated[i];
                if (!TunerScopeCreated(s, path, false)) continue;
                var trash = TrashTunerCreated(path);
                ForgetTunerCreated(i);
                if (trash == null) continue;
                if (trash.Length == 0) done.Add("moved " + path + " to the Trash");
                else errors.Add(trash);
            }
            if (s == null || !s.PrefabTuner) done.AddRange(RevertTunerScenes(s, errors));
        }
        finally { _tunerSaving = false; }
        foreach (var k in reverted) _tunerTouched.Remove(k);
        Undo.ClearAll();
        foreach (var t in _tuners.Values)
        {
            for (int i = 0; i < t.Objects.Length; i++) t.Objects[i] = null;
            foreach (var e in t.Entries) if (!e.Asset) e.Go = null;
            ResolveTunerObjects(t);
            ResolveTunerEntries(t);
            RebuildTunerMembers(t);
            t.TracksStale = true;
            t.CacheDirty = true;
            t.Dirty = true;
            t.StatePending = true;
            ResetTunerStructure(t);
        }
        _tunerHierarchyGen++;
        TunerAnimAfterDiscard();
        TiMarkAllDirty();
        _tunerUnsavedAt = -1;
        summary = done.Count == 0 ? "nothing to discard" : string.Join(", ", done);
        Debug.Log("[Tuner] discard: " + summary + (errors.Count > 0 ? "; errors: " + string.Join("; ", errors) : ""));
        return errors.Count > 0 ? string.Join("; ", errors) : null;
    }

    static List<string> RevertTunerScenes(TunerSession s, List<string> errors)
    {
        var done = new List<string>();
        var mine = new List<Scene>();
        bool others = false;
        for (int i = 0; i < SceneManager.sceneCount; i++)
        {
            var sc = SceneManager.GetSceneAt(i);
            if (!sc.IsValid() || !sc.isLoaded || !sc.isDirty || string.IsNullOrEmpty(sc.path)) continue;
            if (TunerScopeScene(s, sc)) mine.Add(sc);
            else others = true;
        }
        if (mine.Count == 0) return done;
        if (others && SceneManager.sceneCount > 1)
        {
            foreach (var sc in mine)
            {
                var path = sc.path;
                try
                {
                    if (SceneManager.GetActiveScene() == sc) continue;
                    EditorSceneManager.CloseScene(sc, true);
                    EditorSceneManager.OpenScene(path, OpenSceneMode.Additive);
                    done.Add(path);
                }
                catch (Exception e) { errors.Add("could not reload " + path + ": " + e.Message); }
            }
            if (done.Count < mine.Count) errors.Add("the active scene was not reverted because other open scenes have unsaved changes");
            return done;
        }
        var setup = EditorSceneManager.GetSceneManagerSetup();
        if (setup == null || setup.Length == 0) return done;
        foreach (var st in setup)
        {
            if (string.IsNullOrEmpty(st.path))
            {
                errors.Add("an unsaved new scene cannot be reverted");
                return done;
            }
        }
        string active = null;
        foreach (var st in setup)
        {
            if (st.isActive) active = st.path;
            var sc = SceneManager.GetSceneByPath(st.path);
            if (sc.IsValid() && sc.isDirty) done.Add(st.path);
        }
        try
        {
            EditorSceneManager.OpenScene(setup[0].path, OpenSceneMode.Single);
            for (int i = 1; i < setup.Length; i++)
                EditorSceneManager.OpenScene(setup[i].path, setup[i].isLoaded ? OpenSceneMode.Additive : OpenSceneMode.AdditiveWithoutLoading);
            if (active != null)
            {
                var sc = SceneManager.GetSceneByPath(active);
                if (sc.IsValid() && sc.isLoaded) SceneManager.SetActiveScene(sc);
            }
        }
        catch (Exception e)
        {
            errors.Add("could not reload the scene: " + e.Message);
        }
        return done;
    }

    static string RevertTunerAsset(string path)
    {
        var objs = AssetDatabase.LoadAllAssetsAtPath(path);
        bool hasGameObjects = false;
        foreach (var o in objs)
            if (o is GameObject || o is Component) hasGameObjects = true;
        try
        {
            if (hasGameObjects)
            {
                if (!path.EndsWith(".prefab", StringComparison.OrdinalIgnoreCase)) return "cannot revert " + path;
                var root = PrefabUtility.LoadPrefabContents(path);
                try { PrefabUtility.SaveAsPrefabAsset(root, path); }
                finally { PrefabUtility.UnloadPrefabContents(root); }
                return null;
            }
            foreach (var o in objs)
            {
                if (o == null) continue;
                EditorUtility.ClearDirty(o);
                Resources.UnloadAsset(o);
            }
            return null;
        }
        catch (Exception e)
        {
            return "could not revert " + path + ": " + e.Message;
        }
    }

    static bool HandleTunerSave(int id, string cmd, TunerArgs a, ControlClient from)
    {
        if (cmd == "tuner/newScene")
        {
            TunerResult(from, id, TunerNewScene(a.path), null);
            return true;
        }
        if (cmd != "tuner/save" && cmd != "tuner/discard") return false;
        bool save = cmd == "tuner/save";
        if (!ResolveTunerSaveSession(a.session, out var ss, out var unknown))
        {
            TunerSaveReply(null, from, id, unknown, null);
            return true;
        }
        if (EditorApplication.isPlaying)
        {
            if (a.op != "stopPlay")
            {
                TunerSaveReply(ss, from, id, save ? "Unity only saves scenes in Edit Mode. Leave Play Mode to save." : "Leave Play Mode to discard the Edit Mode changes.", null);
                return true;
            }
            _tunerAfterPlay.Add(new TunerAfterPlay { Save = save, Id = id, From = from, Session = a.session });
            Debug.Log("[Tuner] leaving Play Mode to " + (save ? "save" : "discard") + " the Edit Mode changes");
            EditorApplication.isPlaying = false;
            return true;
        }
        string summary;
        string err;
        try { err = save ? TunerSaveAll(ss, out summary) : TunerDiscardAll(ss, out summary); }
        catch (Exception e)
        {
            Debug.LogException(e);
            err = e.GetType().Name + ": " + e.Message;
            summary = null;
        }
        TunerSaveReply(ss, from, id, err, summary);
        return true;
    }

    static string TunerNewScene(string path)
    {
        if (EditorApplication.isPlaying) return "Leave Play Mode to create a scene.";
        if (string.IsNullOrEmpty(path) || !path.StartsWith("Assets/") || !path.EndsWith(".unity") || path.Contains("..")) return "invalid scene path";
        if (File.Exists(path)) return path + " already exists";
        var dir = Path.GetDirectoryName(path);
        if (!string.IsNullOrEmpty(dir)) Directory.CreateDirectory(dir);
        var sc = EditorSceneManager.NewScene(NewSceneSetup.DefaultGameObjects, NewSceneMode.Additive);
        bool ok = EditorSceneManager.SaveScene(sc, path);
        EditorSceneManager.CloseScene(sc, true);
        if (!ok) return "Unity could not write " + path;
        Debug.Log("[Tuner] created scene " + path);
        return null;
    }

    static void TunerSaveReply(TunerSession s, ControlClient from, int id, string err, string summary)
    {
        _tunerUnsavedAt = -1;
        foreach (var t in _tuners.Values) t.ScopeDeps = null;
        RefreshTunerUnsaved();
        foreach (var t in _tuners.Values) t.StatePending = true;
        TunerResult(from, id, err, (summary != null ? "\"summary\":" + JStr(summary) + "," : "") + "\"unsaved\":" + (s != null ? TunerUnsavedJson(s) : BuildTunerUnsaved(null)));
    }
}
